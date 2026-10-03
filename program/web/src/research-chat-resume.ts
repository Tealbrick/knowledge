import type { ChatReceipt } from "./research-chat-api";
export type Pending = { key: string; operation: ChatReceipt["operation"]; sessionId?: string };
export type Resume = { sessionId: string | null; pending: Pending | null };
const validId = (value: unknown): value is string => typeof value === "string" && /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,255}$/.test(value);
export function loadChatResume(storage: Pick<Storage, "getItem">, key: string): Resume {
  const raw = storage.getItem(key);
  if (!raw) return { sessionId: null, pending: null };
  const value: unknown = JSON.parse(raw);
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("invalid_resume");
  const r = value as Record<string, unknown>;
  if (r.sessionId !== null && !validId(r.sessionId)) throw new Error("invalid_resume");
  let pending: Pending | null = null;
  if (r.pending !== null) {
    if (!r.pending || typeof r.pending !== "object" || Array.isArray(r.pending)) throw new Error("invalid_resume");
    const p = r.pending as Record<string, unknown>;
    if (!validId(p.key) || !["session", "message"].includes(String(p.operation)) ||
      (p.operation === "message" && (!validId(p.sessionId) || p.sessionId !== r.sessionId)) ||
      (p.operation === "session" && p.sessionId !== undefined)) throw new Error("invalid_resume");
    pending = { key: p.key, operation: p.operation as Pending["operation"], ...(p.operation === "message" ? { sessionId: p.sessionId as string } : {}) };
  }
  // Only references survive reload. They are never identity or authorization.
  return { sessionId: r.sessionId as string | null, pending };
}
