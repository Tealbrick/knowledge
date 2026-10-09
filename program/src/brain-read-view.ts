import { GBRAIN_MAX_RESPONSE_BYTES } from "./gbrain-transport.js";
import { HINDSIGHT_MAX_RESPONSE_BYTES } from "./hindsight-client.js";

/**
 * Contract 2 Brain reads over a read set: one engine call per read partition (its own GBrain source or Hindsight
 * bank, derived exactly as for a single partition), merged into one answer.
 *
 * Merge rule (deterministic): when every item carries a numeric engine score, items are ordered by score, highest
 * first, ties by read-set order (the write partition first) and then by the engine's own order; otherwise the lists
 * are interleaved by rank (first of each partition, then second of each, ...). Exact duplicates are dropped and the
 * result is capped at the requested limit. Only partitions of the caller's read set are ever queried.
 *
 * No silent drop: every fan-out answer carries `partitions`, one status per read partition (`{partition, ok, error?}`)
 * and `partial` (true when a partition failed). A failing or throwing partition never fails the whole answer while
 * another partition answered; only when every partition fails is the answer the engine's own error.
 */

export interface MergedList {
  readonly items: unknown[];
  /** Index into the read set of the partition each item came from (internal; never sent to a caller). */
  readonly scopes: number[];
}

const SCORE_FIELDS = ["score", "similarity", "relevance"] as const;

function scoreOf(item: unknown): number | null {
  if (!item || typeof item !== "object" || Array.isArray(item)) return null;
  for (const field of SCORE_FIELDS) {
    const value = (item as Record<string, unknown>)[field];
    if (typeof value === "number" && Number.isFinite(value)) return value;
  }
  return null;
}

/** Stable JSON (sorted object keys) for duplicate detection. */
function stableKey(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableKey).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value as Record<string, unknown>).sort().map((key) => `${JSON.stringify(key)}:${stableKey((value as Record<string, unknown>)[key])}`).join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

export function mergeRankedLists(lists: readonly (readonly unknown[])[], limit?: number): MergedList {
  const entries = lists.flatMap((list, scope) => list.map((item, rank) => ({ item, scope, rank, score: scoreOf(item) })));
  const scored = entries.length > 0 && entries.every((entry) => entry.score !== null);
  entries.sort((left, right) => scored
    ? (right.score! - left.score!) || (left.scope - right.scope) || (left.rank - right.rank)
    : (left.rank - right.rank) || (left.scope - right.scope));
  const seen = new Set<string>();
  const items: unknown[] = [];
  const scopes: number[] = [];
  const cap = typeof limit === "number" && Number.isFinite(limit) && limit > 0 ? Math.trunc(limit) : Number.POSITIVE_INFINITY;
  for (const entry of entries) {
    if (items.length >= cap) break;
    const key = stableKey(entry.item);
    if (seen.has(key)) continue;
    seen.add(key);
    items.push(entry.item);
    scopes.push(entry.scope);
  }
  return { items, scopes };
}

/** At most this many engine calls of one fan-out read run at the same time (a read set may hold 64 partitions). */
export const FAN_OUT_CONCURRENCY = 4;
/**
 * At most this many engine calls run at the same time for one principal, across all its requests: native operations
 * and the per-partition calls of contract 2 fan-out reads share it. Extra calls wait for a slot.
 */
export const MAX_ENGINE_CALLS_PER_PRINCIPAL = 4;

/** Per-principal bound on engine calls in flight (FIFO wait queue; a released slot passes to the next waiter). */
export class EngineCallLimiter {
  private readonly running = new Map<string, number>();
  private readonly waiting = new Map<string, Array<() => void>>();
  constructor(readonly max: number = MAX_ENGINE_CALLS_PER_PRINCIPAL) {}

  inFlight(principalId: string): number {
    return this.running.get(principalId) ?? 0;
  }

  async run<T>(principalId: string, task: () => Promise<T>): Promise<T> {
    await this.acquire(principalId);
    try { return await task(); } finally { this.release(principalId); }
  }

  private acquire(principalId: string): Promise<void> {
    const running = this.inFlight(principalId);
    if (running < this.max) { this.running.set(principalId, running + 1); return Promise.resolve(); }
    return new Promise((resolve) => {
      const queue = this.waiting.get(principalId) ?? [];
      queue.push(resolve);
      this.waiting.set(principalId, queue);
    });
  }

  private release(principalId: string): void {
    const queue = this.waiting.get(principalId);
    const next = queue?.shift();
    if (queue && queue.length === 0) this.waiting.delete(principalId);
    // The slot passes to the next waiter: the running count stays the same.
    if (next) { next(); return; }
    const left = this.inFlight(principalId) - 1;
    if (left > 0) this.running.set(principalId, left); else this.running.delete(principalId);
  }
}

export interface FanOutOptions {
  /** Shared per-principal bound; with `principalId`, every call takes one of the principal's slots. */
  readonly limiter?: EngineCallLimiter;
  readonly principalId?: string;
}

/**
 * Run one read per partition of the view, at most FAN_OUT_CONCURRENCY at a time (and within the principal's
 * MAX_ENGINE_CALLS_PER_PRINCIPAL when a limiter is given). Results keep read-set order.
 */
/** One partition's outcome: its value, or `thrown` when the call threw (the error itself is never kept). */
export type Settled<T> = { readonly partition: string; readonly value: T } | { readonly partition: string; readonly thrown: true };

export async function fanOut<T>(partitions: readonly string[], run: (partition: string) => Promise<T>, options: FanOutOptions = {}): Promise<Settled<T>[]> {
  const results = new Array<Settled<T>>(partitions.length);
  const call = (partition: string) => options.limiter && options.principalId ? options.limiter.run(options.principalId, () => run(partition)) : run(partition);
  let next = 0;
  const worker = async () => {
    while (next < partitions.length) {
      const index = next++;
      const partition = partitions[index]!;
      try {
        results[index] = { partition, value: await call(partition) };
      } catch {
        results[index] = { partition, thrown: true };
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(FAN_OUT_CONCURRENCY, partitions.length) }, worker));
  return results;
}

/** List-shaped fields of an engine answer object that can be merged across partitions. */
export const MERGEABLE_LIST_FIELDS = ["results", "memories", "facts", "items", "pages", "hits", "documents", "chunks"] as const;

/** One read partition's outcome in a fan-out answer. */
export interface PartitionStatus { readonly partition: string; readonly ok: boolean; readonly error?: string }

/** The per-partition statuses and the partial flag every fan-out answer carries. */
export interface FanOutReport { readonly partitions: PartitionStatus[]; readonly partial: boolean }

const MAX_ERROR_CODE = 200;
/** A short error code for a partition status (an engine code or message head; never a stack or a payload). */
function errorCode(error: unknown): string {
  const value = typeof error === "string" ? error
    : error && typeof error === "object" && typeof (error as Record<string, unknown>).error === "string" ? (error as Record<string, string>).error
    : "unavailable";
  return value.slice(0, MAX_ERROR_CODE) || "unavailable";
}

function report<T>(settled: readonly Settled<T>[], ok: (value: T) => boolean, error: (value: T) => unknown): FanOutReport {
  const partitions = settled.map((entry): PartitionStatus => "thrown" in entry ? { partition: entry.partition, ok: false, error: "unavailable" }
    : ok(entry.value) ? { partition: entry.partition, ok: true } : { partition: entry.partition, ok: false, error: errorCode(error(entry.value)) });
  return { partitions, partial: partitions.some((status) => !status.ok) };
}

interface EngineResult { readonly ok: boolean; readonly status?: unknown; readonly tool?: unknown; readonly data?: unknown; readonly error?: unknown; readonly retrieval?: unknown }

/** Bounds for a merged answer. Counts and token budgets are the caller's; bytes are the engine's response cap. */
export interface MergeBounds {
  /** At most this many items (the caller's limit). */
  readonly limit?: number;
  /** Token budget of the items (Hindsight `max_tokens`), estimated as UTF-8 bytes / 4 of each item's text. */
  readonly maxTokens?: number;
  /** The serialized answer stays at or under this many bytes; items are dropped from the end, `truncated: true`. */
  readonly maxBytes?: number;
}

/** The response cap of the engine a merged answer comes from: what one partition could at most have answered. */
export function engineResponseCap(engine: string): number {
  return engine === "hindsight" ? HINDSIGHT_MAX_RESPONSE_BYTES : GBRAIN_MAX_RESPONSE_BYTES;
}

const positive = (value: unknown) => typeof value === "number" && Number.isFinite(value) && value > 0 ? Math.trunc(value) : undefined;

/**
 * The caller's bounds in native arguments, wherever the engine takes them: `limit` / `max_results` at the top level
 * or in Hindsight's `body`, and Hindsight's `body.max_tokens`. The smallest count wins.
 */
export function nativeMergeBounds(args: Record<string, unknown>, maxBytes: number): MergeBounds {
  const body = args.body && typeof args.body === "object" && !Array.isArray(args.body) ? args.body as Record<string, unknown> : {};
  const counts = [args.limit, args.max_results, body.limit, body.max_results].map(positive).filter((value): value is number => value !== undefined);
  const maxTokens = positive(body.max_tokens) ?? positive(args.max_tokens);
  return { ...(counts.length ? { limit: Math.min(...counts) } : {}), ...(maxTokens ? { maxTokens } : {}), maxBytes };
}

function itemTokens(item: unknown): number {
  const record = item && typeof item === "object" && !Array.isArray(item) ? item as Record<string, unknown> : null;
  const text = record ? ["text", "content", "chunk_text", "compiled_truth"].map((field) => record[field]).find((value) => typeof value === "string") : undefined;
  return Math.ceil(Buffer.byteLength(typeof text === "string" ? text : JSON.stringify(item) ?? "", "utf8") / 4);
}

/** Keep items in order while their estimated tokens fit the budget (always at least the first item). */
function withinTokens(items: unknown[], scopes: number[], maxTokens: number | undefined): { items: unknown[]; scopes: number[] } {
  if (maxTokens === undefined) return { items, scopes };
  let used = 0, kept = 0;
  for (const item of items) {
    const tokens = itemTokens(item);
    if (kept > 0 && used + tokens > maxTokens) break;
    used += tokens;
    kept += 1;
  }
  return { items: items.slice(0, kept), scopes: scopes.slice(0, kept) };
}

interface MergedData { readonly items: unknown[]; readonly scopes: number[]; readonly build: (items: unknown[]) => unknown }

/** Merge list-shaped answers: arrays, or objects that share one list field (other fields from the first answer). */
function mergeData(datas: readonly unknown[], bounds: MergeBounds): MergedData | null {
  let merged: MergedList, build: (items: unknown[]) => unknown;
  if (datas.length && datas.every(Array.isArray)) {
    merged = mergeRankedLists(datas as unknown[][], bounds.limit);
    build = (items) => items;
  } else if (datas.length && datas.every((value) => value && typeof value === "object" && !Array.isArray(value))) {
    const field = MERGEABLE_LIST_FIELDS.find((name) => datas.every((value) => Array.isArray((value as Record<string, unknown>)[name])));
    if (!field) return null;
    merged = mergeRankedLists(datas.map((value) => (value as Record<string, unknown[]>)[field]!), bounds.limit);
    build = (items) => ({ ...(datas[0] as Record<string, unknown>), [field]: items });
  } else {
    return null;
  }
  const kept = withinTokens(merged.items, merged.scopes, bounds.maxTokens);
  return { items: kept.items, scopes: kept.scopes, build };
}

/**
 * The answer `assemble(items)` builds, with as many merged items as fit `maxBytes` once serialized (largest prefix;
 * `truncated: true` when items were dropped). Never larger than the engine could have answered for one partition.
 */
function boundedAnswer<A extends object>(merged: MergedData, maxBytes: number | undefined, assemble: (data: unknown, truncated: boolean) => A): { answer: A; kept: number } {
  const size = (count: number) => Buffer.byteLength(JSON.stringify(assemble(merged.build(merged.items.slice(0, count)), count < merged.items.length)), "utf8");
  if (maxBytes === undefined || size(merged.items.length) <= maxBytes) {
    return { answer: assemble(merged.build(merged.items), false), kept: merged.items.length };
  }
  let low = 0, high = merged.items.length - 1;
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    if (size(middle) <= maxBytes) low = middle; else high = middle - 1;
  }
  return { answer: assemble(merged.build(merged.items.slice(0, low)), true), kept: low };
}

/**
 * Merge per-partition engine results (Program surfaces: recall, query, listPages). With at least one answer the
 * result is `ok` and carries the answered partitions' data plus `partitions`/`partial`; a failed or throwing
 * partition shows in its status. Data that cannot be merged keeps the first answer (the write partition when it
 * is in the view). When every partition fails, the answer is the first engine error, as for a single partition.
 */
export function mergeEngineResults<R extends EngineResult>(settled: readonly Settled<R>[], bounds: MergeBounds = {}): R & Partial<FanOutReport> & { readonly scopes?: number[]; readonly truncated?: boolean } {
  const answered = settled.flatMap((entry) => "thrown" in entry || !entry.value.ok ? [] : [entry.value]);
  if (!answered.length) {
    const failed = settled.find((entry): entry is { partition: string; value: R } => !("thrown" in entry));
    return failed ? failed.value : ({ ok: false, status: "unavailable", data: null, error: "unavailable" } as unknown as R);
  }
  const statuses = report(settled, (result) => result.ok, (result) => result.error);
  const merged = mergeData(answered.map((result) => result.data), bounds);
  if (!merged) return { ...answered[0]!, ok: true, ...statuses };
  const { answer, kept } = boundedAnswer(merged, bounds.maxBytes, (data, truncated) => ({ ...answered[0]!, ok: true, data, ...statuses, ...(truncated ? { truncated: true } : {}) }));
  return { ...answer, scopes: merged.scopes.slice(0, kept) };
}

/** Drop the internal per-item partition record before an answer leaves the Program. */
export function withoutScopes<R extends { readonly scopes?: number[] }>(result: R): Omit<R, "scopes"> {
  const { scopes: _scopes, ...rest } = result;
  return rest;
}

/**
 * Merge per-partition native operation answers (`{ok, data, ...}`). List-shaped data merges like
 * mergeEngineResults; anything else is a lookup and keeps the first partition that answered (read-set order, the
 * write partition first). Every merged answer carries `partitions`/`partial`. With no answer at all, the first
 * engine error is the answer; when every partition threw, this throws (the route answers 503 as for one partition).
 */
export function mergeNativeResults(settled: readonly Settled<Record<string, any>>[], bounds: MergeBounds = {}): Record<string, any> {
  const answered = settled.flatMap((entry) => "thrown" in entry || entry.value?.ok !== true ? [] : [entry.value]);
  if (!answered.length) {
    const failed = settled.find((entry): entry is { partition: string; value: Record<string, any> } => !("thrown" in entry));
    if (!failed) throw new Error("every read partition failed");
    return failed.value;
  }
  const statuses = report(settled, (result) => result?.ok === true, (result) => result?.error);
  const merged = mergeData(answered.map((result) => result.data), bounds);
  if (!merged) return { ...answered[0], ...statuses };
  return boundedAnswer(merged, bounds.maxBytes, (data, truncated) => ({ ...answered[0], data, ...statuses, ...(truncated ? { truncated: true } : {}) })).answer;
}
