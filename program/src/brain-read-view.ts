/**
 * Contract 2 Brain reads over a read set: one engine call per read partition (its own GBrain source or Hindsight
 * bank, derived exactly as for a single partition), merged into one answer.
 *
 * Merge rule (deterministic): when every item carries a numeric engine score, items are ordered by score, highest
 * first, ties by read-set order (the write partition first) and then by the engine's own order; otherwise the lists
 * are interleaved by rank (first of each partition, then second of each, ...). Exact duplicates are dropped and the
 * result is capped at the requested limit. The partition of each item is kept internally (`scopes`, parallel to
 * `items`) and is never added to an answer, and only partitions of the caller's read set are ever queried.
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
export async function fanOut<T>(partitions: readonly string[], run: (partition: string) => Promise<T>, options: FanOutOptions = {}): Promise<T[]> {
  const results = new Array<T>(partitions.length);
  const call = (partition: string) => options.limiter && options.principalId ? options.limiter.run(options.principalId, () => run(partition)) : run(partition);
  let next = 0;
  const worker = async () => {
    while (next < partitions.length) {
      const index = next++;
      results[index] = await call(partitions[index]!);
    }
  };
  await Promise.all(Array.from({ length: Math.min(FAN_OUT_CONCURRENCY, partitions.length) }, worker));
  return results;
}

/** List-shaped fields of an engine answer object that can be merged across partitions. */
export const MERGEABLE_LIST_FIELDS = ["results", "memories", "facts", "items", "pages", "hits", "documents", "chunks"] as const;

interface EngineResult { readonly ok: boolean; readonly status?: unknown; readonly tool?: unknown; readonly data?: unknown; readonly error?: unknown; readonly retrieval?: unknown }

/**
 * Merge per-partition engine results (Program surfaces: recall, query, listPages). The answer is `ok` only when every
 * partition answered; the data of the partitions that did answer is still merged. Array data merges as a list; an
 * object with the same list field in every answer merges that field (other fields come from the first answer).
 * Anything else cannot be merged and keeps the first answer (the write partition when it is in the view).
 */
export function mergeEngineResults<R extends EngineResult>(results: readonly R[], limit?: number): R & { readonly scopes?: number[] } {
  const answered = results.map((result, scope) => ({ result, scope })).filter(({ result }) => result.ok);
  const first = results.find((result) => !result.ok) ?? results[0]!;
  const base = answered[0]?.result ?? first;
  const datas = answered.map(({ result }) => result.data);
  let data: unknown = base.data;
  let scopes: number[] | undefined;
  if (datas.length && datas.every(Array.isArray)) {
    const merged = mergeRankedLists(datas as unknown[][], limit);
    data = merged.items;
    scopes = merged.scopes.map((index) => answered[index]!.scope);
  } else if (datas.length && datas.every((value) => value && typeof value === "object" && !Array.isArray(value))) {
    const field = MERGEABLE_LIST_FIELDS.find((name) => datas.every((value) => Array.isArray((value as Record<string, unknown>)[name])));
    if (field) {
      const merged = mergeRankedLists(datas.map((value) => (value as Record<string, unknown[]>)[field]!), limit);
      data = { ...(datas[0] as Record<string, unknown>), [field]: merged.items };
      scopes = merged.scopes.map((index) => answered[index]!.scope);
    }
  }
  const failed = results.find((result) => !result.ok);
  return {
    ...base,
    ok: failed === undefined,
    ...(failed ? { status: failed.status ?? base.status, error: failed.error } : {}),
    data,
    ...(scopes ? { scopes } : {}),
  };
}

/** Drop the internal per-item partition record before an answer leaves the Program. */
export function withoutScopes<R extends { readonly scopes?: number[] }>(result: R): Omit<R, "scopes"> {
  const { scopes: _scopes, ...rest } = result;
  return rest;
}

/**
 * Merge per-partition native operation answers (`{ok, data, ...}`). List-shaped data merges like
 * mergeEngineResults; anything else is a lookup and keeps the first partition that answered (read-set order, the
 * write partition first). With no answer at all, the first partition's error is the answer.
 */
export function mergeNativeResults(results: readonly Record<string, any>[], limit?: number): Record<string, any> {
  const answered = results.filter((result) => result?.ok === true);
  if (!answered.length) return results[0]!;
  const datas = answered.map((result) => result.data);
  if (datas.every(Array.isArray)) return { ...answered[0], data: mergeRankedLists(datas, limit).items };
  if (datas.every((value) => value && typeof value === "object" && !Array.isArray(value))) {
    const field = MERGEABLE_LIST_FIELDS.find((name) => datas.every((value) => Array.isArray(value[name])));
    if (field) return { ...answered[0], data: { ...datas[0], [field]: mergeRankedLists(datas.map((value) => value[field]), limit).items } };
  }
  return answered[0]!;
}
