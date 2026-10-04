/** Same-origin Research transport. No service or upstream credential belongs here. */
import { isSessionEndedResponse, markSessionEnded } from "./api";

export type BrowserResearchSession = {
  enabled: boolean;
  authenticated: boolean;
  principal: { principalId: string; companyId: string; capabilities: string[] } | null;
  csrfToken: string | null;
  expiresAt: string | null;
};
export type ChatMessage = { id: string; type: "human" | "ai" | "system"; content: string };
export type ChatReceipt = {
  operation: "session" | "message";
  idempotencyKey: string;
  state: "pending" | "uncertain" | "succeeded" | "rejected";
  sessionId: string | null;
  answer: ChatMessage | null;
  errorCode: string | null;
  createdAt: string;
  updatedAt: string;
};
export type ChatHistory = {
  session: { id: string; notebookId: string; title: string; createdAt: string; updatedAt: string };
  messages: ChatMessage[];
};
export class ResearchRequestError extends Error {
  constructor(readonly status: number, readonly code: string) {
    super(code); this.name = "ResearchRequestError";
  }
}
export type ResearchHttpResult = { readonly status: number; readonly body: unknown };
const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value);
const text = (value: unknown, max = 131072): value is string => typeof value === "string" && value.length <= max;
const id = (value: unknown): value is string => typeof value === "string" && /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,255}$/.test(value);
const malformed = () => new ResearchRequestError(0, "invalid_research_response");
function message(value: unknown): value is ChatMessage {
  return object(value) && text(value.id, 256) && ["human", "ai", "system"].includes(String(value.type)) && text(value.content);
}
function envelope(value: unknown): value is Record<string, unknown> {
  return object(value) && value.provider === "open_notebook" && object(value.contractBaseline);
}

async function request(
  url: string,
  method = "GET",
  body?: unknown,
  csrf?: string,
  key?: string,
  signal?: AbortSignal,
  allowHttpErrors = false,
): Promise<unknown> {
  let response: Response;
  try {
    const requestSignal = signal
      ? AbortSignal.any([signal, AbortSignal.timeout(45000)])
      : AbortSignal.timeout(45000);
    response = await fetch(url, {
      method, credentials: "same-origin", cache: "no-store", redirect: "error",
      signal: requestSignal,
      headers: { accept: "application/json", ...(body !== undefined ? { "content-type": "application/json" } : {}),
        ...(csrf ? { "X-CSRF-Token": csrf } : {}), ...(key ? { "Idempotency-Key": key } : {}) },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
  } catch {
    if (signal?.aborted) throw new ResearchRequestError(0, "research_request_aborted");
    throw new ResearchRequestError(0, "research_connection_interrupted");
  }
  // Bound body consumption as well as the request deadline. A broken gateway
  // must not stream unbounded history/error text into the browser.
  let value: unknown = null;
  const reader = response.body?.getReader();
  try {
    if (!(response.headers.get("content-type") ?? "").toLowerCase().includes("application/json")) throw malformed();
    const chunks: Uint8Array[] = []; let size = 0;
    if (reader) while (true) {
      const chunk = await reader.read(); if (chunk.done) break;
      size += chunk.value.byteLength;
      if (size > 4 * 1024 * 1024) throw malformed();
      chunks.push(chunk.value);
    }
    const bytes = new Uint8Array(size); let offset = 0;
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
    value = JSON.parse(new TextDecoder().decode(bytes));
  } catch { throw malformed(); }
  finally { if (reader) { await reader.cancel().catch(() => undefined); reader.releaseLock(); } }
  // Do not reflect arbitrary upstream/server errors into the UI or retain their bodies.
  if (!response.ok) {
    if (isSessionEndedResponse(response.status, value)) markSessionEnded();
    const code = object(value) && typeof value.error === "string" && /^[a-z_]{1,80}$/.test(value.error)
      ? value.error : "research_request_failed";
    if (allowHttpErrors) return { status: response.status, body: value } satisfies ResearchHttpResult;
    throw new ResearchRequestError(response.status, code);
  }
  if (allowHttpErrors) return { status: response.status, body: value } satisfies ResearchHttpResult;
  return value;
}

/** Read-only same-origin transport for other authenticated Research panels. */
export const researchRequest = request;
export const researchRequestWithStatus = async (
  url: string,
  method = "GET",
  body?: unknown,
  csrf?: string,
  key?: string,
  signal?: AbortSignal,
): Promise<ResearchHttpResult> => request(url, method, body, csrf, key, signal, true) as Promise<ResearchHttpResult>;
function session(value: unknown): BrowserResearchSession {
  if (!object(value) || typeof value.enabled !== "boolean" || typeof value.authenticated !== "boolean") throw malformed();
  if (!value.authenticated) return { enabled: value.enabled, authenticated: false, principal: null, csrfToken: null, expiresAt: null };
  const p = value.principal;
  if (!value.enabled || !object(p) || !text(p.principalId, 128) || !text(p.companyId, 128) ||
    !Array.isArray(p.capabilities) || !p.capabilities.every(c => text(c, 128)) ||
    !text(value.csrfToken, 256) || !value.csrfToken || !text(value.expiresAt, 64) || !Number.isFinite(Date.parse(value.expiresAt))) throw malformed();
  return { enabled: true, authenticated: true, principal: { principalId: p.principalId, companyId: p.companyId,
    capabilities: p.capabilities as string[] }, csrfToken: value.csrfToken, expiresAt: value.expiresAt };
}
export const researchBrowserStatus = async () => session(await request("/api/research/browser-session"));
export const researchBrowserLogin = async (secret: string) => session(await request("/api/research/browser-session", "POST", { secret }));
export const researchBrowserLogout = async (csrf: string) => { await request("/api/research/browser-session", "DELETE", undefined, csrf); };
const base = (notebook: string) => `/api/research/notebooks/${encodeURIComponent(notebook)}/engine/chat`;

export function parseChatReceipt(value: unknown, key: string, operation?: ChatReceipt["operation"], sessionId?: string): ChatReceipt {
  if (!envelope(value) || !object(value.receipt)) throw malformed();
  const r = value.receipt;
  if (r.idempotencyKey !== key || !["session", "message"].includes(String(r.operation)) ||
    (operation && r.operation !== operation) || !["pending", "uncertain", "succeeded", "rejected"].includes(String(r.state)) ||
    !(r.sessionId === null || id(r.sessionId)) || (sessionId && r.sessionId !== sessionId) ||
    !(r.answer === null || message(r.answer)) || !(r.errorCode === null || text(r.errorCode, 128)) ||
    !text(r.createdAt, 64) || !text(r.updatedAt, 64)) throw malformed();
  if (r.state === "succeeded" && (!id(r.sessionId) || r.errorCode !== null ||
    (r.operation === "message" && (!message(r.answer) || r.answer.type !== "ai")) ||
    (r.operation === "session" && r.answer !== null))) throw malformed();
  if (r.state !== "succeeded" && r.answer !== null) throw malformed();
  return r as ChatReceipt;
}
export async function researchChatCreate(notebook: string, csrf: string, key: string) {
  return parseChatReceipt(await request(`${base(notebook)}/sessions`, "POST", {}, csrf, key), key, "session");
}
export async function researchChatSend(notebook: string, sessionId: string, content: string, csrf: string, key: string) {
  return parseChatReceipt(await request(`${base(notebook)}/sessions/${encodeURIComponent(sessionId)}/messages`, "POST", { message: content }, csrf, key), key, "message", sessionId);
}
export async function researchChatReceipt(notebook: string, key: string, operation: ChatReceipt["operation"], sessionId?: string) {
  return parseChatReceipt(await request(`${base(notebook)}/receipts/${encodeURIComponent(key)}`), key, operation, sessionId);
}
export async function researchChatHistory(notebook: string, sessionId: string): Promise<ChatHistory> {
  const value = await request(`${base(notebook)}/sessions/${encodeURIComponent(sessionId)}`);
  if (!envelope(value) || !object(value.session) || value.session.id !== sessionId || value.session.notebookId !== notebook ||
    !text(value.session.title, 4096) || !text(value.session.createdAt, 64) || !text(value.session.updatedAt, 64) ||
    !Array.isArray(value.messages) || value.messages.length > 200 || !value.messages.every(message)) throw malformed();
  return { session: value.session as ChatHistory["session"], messages: value.messages };
}
