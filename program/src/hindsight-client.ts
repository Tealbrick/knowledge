import { createHash } from "node:crypto";

import { normalizeKnowledgePartitionKey } from "./partition-authority.js";

/** Largest Hindsight response Knowledge accepts by default (also the bound of a merged contract 2 answer). */
export const HINDSIGHT_MAX_RESPONSE_BYTES = 8 * 1024 * 1024;

/**
 * Bank-isolated client for a private Hindsight API (vectorize-io/hindsight,
 * MIT) used as a Knowledge memory engine.
 *
 * Hindsight has no principals or per-bank access control and auto-creates
 * banks on retain, so isolation is owned here: every bank-scoped request
 * targets the bank derived from an already-authorized Knowledge partition.
 * `invoke` is the transport for the full native surface; which operations may
 * reach it, and with which argument guards, is decided by
 * hindsight-engine.ts / engine-exposure.ts. The shared tenant key stays
 * server-side.
 */
export interface HindsightClientOptions {
  /** Private base URL, e.g. http://hindsight.railway.internal:8888 */
  readonly baseUrl: string;
  /** HINDSIGHT_API_TENANT_API_KEY shared with the private sidecar. */
  readonly apiKey: string;
  readonly fetch?: typeof fetch;
  readonly timeoutMs?: number;
  readonly maxResponseBytes?: number;
}

export interface HindsightRetainItem {
  readonly content: string;
  readonly documentId: string;
  readonly context?: string;
  readonly timestamp?: string;
  readonly metadata?: Readonly<Record<string, string>>;
}

export class HindsightError extends Error {
  constructor(readonly code: "hindsight_unavailable" | "hindsight_rejected" | "hindsight_invalid_input" | "hindsight_invalid_response", readonly status?: number) {
    super(code);
  }
}

const DOCUMENT_ID = /^[A-Za-z0-9][A-Za-z0-9:._-]{0,199}$/u;

/** Deterministic, opaque bank for an authorized partition; never caller-supplied. */
export function hindsightBankForPartition(partitionKey: string): string {
  const partition = normalizeKnowledgePartitionKey(partitionKey);
  if (!partition) throw new HindsightError("hindsight_invalid_input");
  return `tb-${createHash("sha256").update(`knowledge-partition:${partition}`).digest("hex").slice(0, 32)}`;
}

export class HindsightClient {
  private readonly base: URL;
  private readonly fetcher: typeof fetch;
  private readonly timeoutMs: number;
  private readonly maxResponseBytes: number;

  constructor(private readonly options: HindsightClientOptions) {
    const base = new URL(options.baseUrl);
    if (!["http:", "https:"].includes(base.protocol) || base.username || base.password || base.search || base.hash || (base.pathname !== "/" && base.pathname !== "")) {
      throw new Error("Hindsight base URL must be a bare http(s) origin");
    }
    if (typeof options.apiKey !== "string" || !/^[\x21-\x7e]{32,1024}$/u.test(options.apiKey)) throw new Error("Hindsight API key must be 32-1024 printable characters");
    this.base = new URL(base.origin);
    this.fetcher = options.fetch ?? fetch;
    this.timeoutMs = options.timeoutMs ?? 120_000;
    this.maxResponseBytes = options.maxResponseBytes ?? HINDSIGHT_MAX_RESPONSE_BYTES;
  }

  private bankPath(partitionKey: string, suffix: string): URL {
    return new URL(`/v1/default/banks/${encodeURIComponent(hindsightBankForPartition(partitionKey))}${suffix}`, this.base);
  }

  private async request(url: URL, method: "GET" | "POST" | "DELETE", body?: unknown): Promise<unknown> {
    let response: Response;
    try {
      response = await this.fetcher(url, {
        method, redirect: "error", signal: AbortSignal.timeout(this.timeoutMs),
        headers: { authorization: `Bearer ${this.options.apiKey}`, accept: "application/json", ...(body === undefined ? {} : { "content-type": "application/json" }) },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
    } catch { throw new HindsightError("hindsight_unavailable"); }
    const chunks: Buffer[] = [];
    let bytes = 0;
    try {
      for await (const chunk of (response.body ?? []) as AsyncIterable<Uint8Array>) {
        bytes += chunk.byteLength;
        if (bytes > this.maxResponseBytes) throw new HindsightError("hindsight_invalid_response");
        chunks.push(Buffer.from(chunk));
      }
    } catch (error) { throw error instanceof HindsightError ? error : new HindsightError("hindsight_unavailable"); }
    if (!response.ok) throw new HindsightError(response.status >= 500 ? "hindsight_unavailable" : "hindsight_rejected", response.status);
    if (!bytes) return null;
    try { return JSON.parse(Buffer.concat(chunks, bytes).toString("utf8")); } catch { throw new HindsightError("hindsight_invalid_response"); }
  }

  /** Retain with stable document IDs so Knowledge deletes stay hard deletes. */
  async retain(partitionKey: string, items: readonly HindsightRetainItem[], operationId?: string, options: { readonly async?: boolean } = {}) {
    if (!items.length || items.length > 100) throw new HindsightError("hindsight_invalid_input");
    const payload = items.map((item) => {
      if (typeof item.content !== "string" || !item.content.trim() || item.content.length > 200_000 || !DOCUMENT_ID.test(item.documentId)) throw new HindsightError("hindsight_invalid_input");
      return {
        content: item.content, document_id: item.documentId, update_mode: "replace",
        ...(item.context ? { context: item.context } : {}), ...(item.timestamp ? { timestamp: item.timestamp } : {}),
        ...(item.metadata ? { metadata: item.metadata } : {}),
      };
    });
    if (operationId !== undefined && !DOCUMENT_ID.test(operationId)) throw new HindsightError("hindsight_invalid_input");
    return this.request(this.bankPath(partitionKey, "/memories"), "POST", { items: payload, ...(options.async ? { async: true } : {}), ...(operationId ? { operation_id: operationId } : {}) });
  }

  async recall(partitionKey: string, input: { readonly query: string; readonly maxTokens?: number; readonly budget?: "low" | "mid" | "high" }) {
    if (typeof input.query !== "string" || !input.query.trim() || input.query.length > 4000) throw new HindsightError("hindsight_invalid_input");
    return this.request(this.bankPath(partitionKey, "/memories/recall"), "POST", {
      query: input.query, ...(input.maxTokens ? { max_tokens: Math.min(Math.max(256, input.maxTokens), 32_000) } : {}), ...(input.budget ? { budget: input.budget } : {}),
    });
  }

  /** Model-backed synthesis; callers must report token cost and degraded results. */
  async reflect(partitionKey: string, input: { readonly query: string; readonly budget?: "low" | "mid" | "high" }) {
    if (typeof input.query !== "string" || !input.query.trim() || input.query.length > 4000) throw new HindsightError("hindsight_invalid_input");
    return this.request(this.bankPath(partitionKey, "/reflect"), "POST", { query: input.query, ...(input.budget ? { budget: input.budget } : {}) });
  }

  /** Hard delete of one retained document and its memory units. */
  async deleteDocument(partitionKey: string, documentId: string) {
    if (!DOCUMENT_ID.test(documentId)) throw new HindsightError("hindsight_invalid_input");
    return this.request(this.bankPath(partitionKey, `/documents/${encodeURIComponent(documentId)}`), "DELETE");
  }

  /** Bank path prefix for an authorized partition. */
  bankPrefix(partitionKey: string): string {
    return `/v1/default/banks/${encodeURIComponent(hindsightBankForPartition(partitionKey))}`;
  }

  /**
   * Raw bounded call for the native surface. Transport failures throw
   * `hindsight_unavailable` (an uncertain write must stay uncertain); upstream
   * status codes are returned to the caller for mapping.
   */
  async invoke(pathAndQuery: string, method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE", payload: { readonly json?: unknown; readonly form?: FormData } = {}, timeoutMs = this.timeoutMs): Promise<{ status: number; contentType: string | null; bytes: Buffer }> {
    const url = new URL(pathAndQuery, this.base);
    if (url.origin !== this.base.origin) throw new HindsightError("hindsight_invalid_input");
    let response: Response;
    try {
      response = await this.fetcher(url, {
        method, redirect: "error", signal: AbortSignal.timeout(timeoutMs),
        headers: { authorization: `Bearer ${this.options.apiKey}`, accept: "application/json, */*;q=0.5", ...(payload.json === undefined ? {} : { "content-type": "application/json" }) },
        ...(payload.json !== undefined ? { body: JSON.stringify(payload.json) } : payload.form ? { body: payload.form } : {}),
      });
    } catch { throw new HindsightError("hindsight_unavailable"); }
    const chunks: Buffer[] = [];
    let bytes = 0;
    try {
      for await (const chunk of (response.body ?? []) as AsyncIterable<Uint8Array>) {
        bytes += chunk.byteLength;
        if (bytes > this.maxResponseBytes) throw new HindsightError("hindsight_invalid_response");
        chunks.push(Buffer.from(chunk));
      }
    } catch (error) { throw error instanceof HindsightError ? error : new HindsightError("hindsight_unavailable"); }
    return { status: response.status, contentType: response.headers.get("content-type"), bytes: Buffer.concat(chunks, bytes) };
  }

  /** Readiness of the private API (database reachable). */
  async health(): Promise<boolean> {
    try { await this.request(new URL("/health", this.base), "GET"); return true; } catch { return false; }
  }

  /** Upstream API version (GET /version), null when unavailable. */
  async version(): Promise<string | null> {
    try {
      const value = await this.request(new URL("/version", this.base), "GET") as Record<string, unknown> | null;
      return typeof value?.api_version === "string" ? value.api_version : null;
    } catch { return null; }
  }
}
