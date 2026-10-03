import { afterEach, describe, expect, it, vi } from "vitest";
import { researchBrowserLogin, researchBrowserStatus, researchChatCreate, researchChatSend, researchChatReceipt, researchChatHistory, parseChatReceipt } from "./research-chat-api";
import { loadChatResume } from "./research-chat-resume";

const envelope = { provider: "open_notebook", contractBaseline: { version: "1.14.0" }, observedVersion: null };
const receipt = { operation: "message", idempotencyKey: "key-1", state: "succeeded", sessionId: "local-1",
  answer: { id: "ai-1", type: "ai", content: "Answer" }, errorCode: null, createdAt: "now", updatedAt: "now" };
afterEach(() => vi.unstubAllGlobals());
describe("Research browser transport", () => {
  it("sends only a separate login secret and receives bounded server-attested metadata", async () => {
    const fetch = vi.fn(async () => Response.json({ enabled: true, authenticated: true,
      principal: { principalId: "p1", companyId: "c1", capabilities: ["research:read", "research:write"] }, csrfToken: "csrf", expiresAt: "2026-09-07T00:00:00Z", serviceToken: "must-not-retain" }));
    vi.stubGlobal("fetch", fetch);
    const result = await researchBrowserLogin("operator-login-secret");
    expect(result).not.toHaveProperty("serviceToken");
    expect(fetch.mock.calls[0]).toMatchObject(["/api/research/browser-session", { method: "POST", credentials: "same-origin", cache: "no-store", redirect: "error", body: '{"secret":"operator-login-secret"}' }]);
  });
  it("uses exact engine routes, cookie credentials, CSRF and caller-retained keys without authority selectors", async () => {
    const fetch = vi.fn(async () => Response.json({ ...envelope, receipt })); vi.stubGlobal("fetch", fetch);
    await researchChatSend("notebook-a", "local-1", "Question", "csrf", "key-1");
    const [url, init] = fetch.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("/api/research/notebooks/notebook-a/engine/chat/sessions/local-1/messages");
    expect(init).toMatchObject({ credentials: "same-origin", body: '{"message":"Question"}', headers: { "X-CSRF-Token": "csrf", "Idempotency-Key": "key-1" } });
    expect(init.headers).not.toHaveProperty("authorization");
    await researchChatReceipt("notebook-a", "key-1", "message", "local-1");
    expect(fetch.mock.calls[1]).toMatchObject(["/api/research/notebooks/notebook-a/engine/chat/receipts/key-1", { method: "GET" }]);
  });
  it("never retries an ambiguous write or reflects the server error body", async () => {
    const fetch = vi.fn(async () => Response.json({ error: "reconciliation_required", detail: "secret-provider-url" }, { status: 503 })); vi.stubGlobal("fetch", fetch);
    await expect(researchChatSend("nb", "local-1", "Q", "csrf", "key-1")).rejects.toMatchObject({ status: 503, code: "reconciliation_required" });
    expect(fetch).toHaveBeenCalledTimes(1);
    fetch.mockRejectedValueOnce(new Error("raw-secret"));
    await expect(researchChatCreate("nb", "csrf", "key-2")).rejects.toMatchObject({ code: "research_connection_interrupted" });
    expect(fetch).toHaveBeenCalledTimes(2);
  });
  it("rejects mismatched receipt, session, operation and assistant semantics", () => {
    for (const change of [{ idempotencyKey: "other" }, { sessionId: "foreign" }, { operation: "session" }, { answer: { id: "human", type: "human", content: "Not an answer" } }, { state: "uncertain" }]) {
      expect(() => parseChatReceipt({ ...envelope, receipt: { ...receipt, ...change } }, "key-1", "message", "local-1")).toThrow("invalid_research_response");
    }
  });
  it("does not display a foreign notebook or session history", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({ ...envelope, session: { id: "local-1", notebookId: "foreign", title: "Wrong", createdAt: "now", updatedAt: "now" }, messages: [] })));
    await expect(researchChatHistory("nb", "local-1")).rejects.toThrow("invalid_research_response");
  });
  it("bounds oversized and non-JSON response bodies without retrying", async () => {
    const fetch = vi.fn(async () => new Response("x".repeat(4 * 1024 * 1024 + 1), { headers: { "content-type": "application/json" } }));
    vi.stubGlobal("fetch", fetch);
    await expect(researchBrowserStatus()).rejects.toThrow("invalid_research_response");
    fetch.mockResolvedValueOnce(new Response("<html>unexpected proxy</html>"));
    await expect(researchChatCreate("nb", "csrf", "key")).rejects.toThrow("invalid_research_response");
    expect(fetch).toHaveBeenCalledTimes(2);
  });
  it("strips unauthenticated session metadata and rejects malformed authenticated status", async () => {
    const fetch = vi.fn(async () => Response.json({ enabled: true, authenticated: false, csrfToken: "stale", principal: { companyId: "stale" } })); vi.stubGlobal("fetch", fetch);
    await expect(researchBrowserStatus()).resolves.toMatchObject({ authenticated: false, csrfToken: null, principal: null });
    fetch.mockResolvedValueOnce(Response.json({ enabled: true, authenticated: true, principal: null }));
    await expect(researchBrowserStatus()).rejects.toThrow("invalid_research_response");
  });
  it("restores only scoped reference state and rejects mismatched pending session references", () => {
    const getItem = vi.fn(() => JSON.stringify({ sessionId: "local-1", pending: { key: "key-1", operation: "message", sessionId: "local-1" } }));
    expect(loadChatResume({ getItem }, "scoped-key").pending?.key).toBe("key-1");
    expect(getItem).toHaveBeenCalledWith("scoped-key");
    getItem.mockReturnValueOnce(JSON.stringify({ sessionId: "local-1", pending: { key: "key-1", operation: "message", sessionId: "foreign" } }));
    expect(() => loadChatResume({ getItem }, "scoped-key")).toThrow("invalid_resume");
  });
});
