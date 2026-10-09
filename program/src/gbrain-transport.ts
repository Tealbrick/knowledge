import { randomUUID } from "node:crypto";

const MAX_RESPONSE_BYTES = 2 * 1024 * 1024;
/** Upstream agent-output NOTICE_PREFIX: a model-facing notice block, never the tool result. */
const GBRAIN_NOTICE_PREFIX = "[gbrain notice ";

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function parseEnvelope(text: string): unknown {
  try { return JSON.parse(text); }
  catch { throw new Error("Invalid GBrain MCP JSON response"); }
}

function resultData(message: unknown, id: string, onMeta?: (meta: Record<string, unknown>) => void, onToolError?: (payload: unknown) => unknown): unknown {
  if (!record(message) || message.jsonrpc !== "2.0" || message.id !== id) {
    throw new Error("Invalid or mismatched GBrain MCP response");
  }
  if ("error" in message) throw new Error("GBrain MCP protocol error");
  const result = message.result;
  if (!record(result) || (result.isError !== undefined && typeof result.isError !== "boolean")) {
    throw new Error("Invalid GBrain MCP tool result");
  }
  if (result.isError && onToolError) {
    // Native protocol callers receive the structured upstream envelope; the
    // caller is responsible for redaction before it leaves Knowledge.
    const first = Array.isArray(result.content) ? result.content.find(item => record(item) && item.type === "text") : undefined;
    let payload: unknown = null;
    try { payload = record(first) && typeof first.text === "string" ? JSON.parse(first.text) : null; } catch { payload = null; }
    return onToolError(payload);
  }
  if (result.isError) {
    // Preserve only an allowlisted machine category, never an upstream message
    // (which can echo provider secrets, paths, or private source content).
    let code: unknown;
    try {
      const first = Array.isArray(result.content) ? result.content.find(item => record(item) && item.type === "text") : undefined;
      code = record(first) && typeof first.text === "string" ? JSON.parse(first.text).error : undefined;
    } catch { /* generic redacted error below */ }
    const safe = ["permission_denied", "scope_denied", "embedding_failed", "extraction_failed", "rate_limited", "invalid_params", "page_not_found", "revision_conflict", "write_outcome_unknown", "unavailable", "operation_failed"];
    throw new Error(`GBrain tool execution failed${typeof code === "string" && safe.includes(code) ? `: ${code}` : ""}`);
  }
  if (record(result._meta)) onMeta?.(result._meta);
  if ("structuredContent" in result) {
    if (!record(result.structuredContent)) throw new Error("Invalid GBrain structured content");
    return result.structuredContent;
  }
  if (!Array.isArray(result.content)) throw new Error("Missing GBrain tool content");
  const text = result.content.filter((item) => record(item) && item.type === "text");
  if (text.some((item) => typeof item.text !== "string")) throw new Error("Invalid GBrain text content");
  if (text.length === 1) {
    try { return JSON.parse(text[0].text as string); } catch { return text[0].text; }
  }
  // Upstream (v0.60.68+) keeps the JSON result in the first text block and appends model-facing
  // notice blocks (`[gbrain notice <code> ...]`, e.g. the one-time `behavior_changes` notice on an
  // upgraded brain) and retrieval evidence lines as extra text blocks. The same notices also
  // arrive structured in `_meta.gbrain_notices` (relayed through onMeta above).
  const body = text.filter((item) => !(item.text as string).startsWith(GBRAIN_NOTICE_PREFIX));
  if (body.length === 1 && body.length < text.length) {
    try { return JSON.parse(body[0].text as string); } catch { return body[0].text; }
  }
  if (body.length > 1) {
    try { return JSON.parse(body[0].text as string); } catch { /* not a JSON result: keep every part below */ }
  }
  // Preserve multi-part/non-text results instead of silently discarding all but one block.
  return result;
}

/** Bounded stateless GBrain MCP call. Never retries a possibly executed write. */
export async function callGBrainTool(input: {
  baseUrl: string;
  token: string;
  name: string;
  args: Record<string, unknown>;
  timeoutMs?: number;
  onMeta?: (meta: Record<string, unknown>) => void;
  /** Return upstream's structured tool error instead of throwing a redacted code. */
  onToolError?: (payload: unknown) => unknown;
}): Promise<unknown> {
  const id = randomUUID();
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), input.timeoutMs ?? 30_000);
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  try {
    const response = await fetch(`${input.baseUrl.replace(/\/+$/u, "")}/mcp`, {
      method: "POST",
      redirect: "error",
      signal: controller.signal,
      headers: {
        accept: "application/json, text/event-stream",
        authorization: `Bearer ${input.token}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ jsonrpc: "2.0", id, method: "tools/call", params: { name: input.name, arguments: input.args } }),
    });
    if (!response.ok) {
      await response.body?.cancel();
      throw new Error(`GBrain HTTP ${response.status}`);
    }
    const contentType = response.headers.get("content-type")?.split(";")[0]?.trim();
    const sse = contentType === "text/event-stream";
    if (!sse && contentType !== "application/json") {
      await response.body?.cancel();
      throw new Error("Unsupported GBrain MCP response content type");
    }
    if (!response.body) throw new Error("Missing GBrain MCP response body");
    reader = response.body.getReader();
    const decoder = new TextDecoder();
    let bytes = 0;
    let buffer = "";
    while (true) {
      const { value, done } = await reader.read();
      if (value) {
        bytes += value.byteLength;
        if (bytes > MAX_RESPONSE_BYTES) throw new Error("GBrain MCP response exceeds 2 MiB");
      }
      buffer += decoder.decode(value, { stream: !done });
      if (sse) {
        let separator: RegExpExecArray | null;
        while ((separator = /\r?\n\r?\n/u.exec(buffer))) {
          const event = buffer.slice(0, separator.index);
          buffer = buffer.slice(separator.index + separator[0].length);
          const data = event.split(/\r?\n/u).filter((line) => line.startsWith("data:"))
            .map((line) => line.slice(5).replace(/^ /u, "")).join("\n");
          if (!data) continue;
          const message = parseEnvelope(data);
          // Progress notifications may precede the matching result on an open stream.
          if (record(message) && message.jsonrpc === "2.0" && !("id" in message) && typeof message.method === "string") continue;
          return resultData(message, id, input.onMeta, input.onToolError);
        }
      }
      if (done) break;
    }
    if (sse) throw new Error("GBrain MCP stream ended without a result");
    return resultData(parseEnvelope(buffer), id, input.onMeta, input.onToolError);
  } finally {
    clearTimeout(timeout);
    controller.abort();
    await reader?.cancel().catch(() => undefined);
  }
}

/** Stateless MCP tools/list (catalog discovery). Bounded like tool calls. */
export async function listGBrainTools(input: { baseUrl: string; token: string; timeoutMs?: number }): Promise<readonly Record<string, unknown>[]> {
  const id = randomUUID();
  const response = await fetch(`${input.baseUrl.replace(/\/+$/u, "")}/mcp`, {
    method: "POST", redirect: "error", signal: AbortSignal.timeout(input.timeoutMs ?? 30_000),
    headers: { accept: "application/json, text/event-stream", authorization: `Bearer ${input.token}`, "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id, method: "tools/list", params: {} }),
  });
  if (!response.ok) { await response.body?.cancel(); throw new Error(`GBrain HTTP ${response.status}`); }
  const text = await response.text();
  if (text.length > MAX_RESPONSE_BYTES) throw new Error("GBrain MCP response exceeds 2 MiB");
  const data = text.split(/\r?\n/u).filter(line => line.startsWith("data:")).map(line => line.slice(5).replace(/^ /u, "")).join("\n") || text;
  const message = parseEnvelope(data);
  if (!record(message) || message.id !== id || !record(message.result) || !Array.isArray(message.result.tools)) throw new Error("Invalid GBrain MCP tools/list response");
  return message.result.tools.filter(record);
}
