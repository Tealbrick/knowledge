import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createResearchSource,
  getResearchSourceWriteReceipt,
  parseResearchSourceWriteReceipt,
  parseResearchSourceWriteResult,
  RESEARCH_SOURCE_CONTENT_MAX_BYTES,
  RESEARCH_SOURCE_TITLE_MAX_BYTES,
} from "./research-source-write-api";

const envelope = { provider: "open_notebook", contractBaseline: { version: "1.14.0" }, observedVersion: null };
const receipt = {
  idempotencyKey: "source-write-1",
  state: "succeeded",
  sourceId: "source:created-1",
  errorCode: null,
  createdAt: "2026-09-06T00:00:00Z",
  updatedAt: "2026-09-06T00:00:00Z",
};

afterEach(() => vi.unstubAllGlobals());

describe("Research source write transport", () => {
  it("sends only the fixed text body, CSRF token, and caller idempotency key", async () => {
    const fetch = vi.fn(async () => Response.json({ ...envelope, receipt, replayed: false }, { status: 201 }));
    vi.stubGlobal("fetch", fetch);
    await expect(createResearchSource("notebook-a", "Title", "Plain content", "csrf-1", "source-write-1")).resolves.toMatchObject({ receipt, replayed: false });
    const firstCall = fetch.mock.calls[0] as unknown as [string, RequestInit];
    expect(firstCall[0]).toBe("/api/research/notebooks/notebook-a/engine/sources");
    expect(firstCall[1]).toMatchObject({ method: "POST", credentials: "same-origin", redirect: "error", body: '{"title":"Title","content":"Plain content"}' });
    expect(firstCall[1].headers).toMatchObject({ "X-CSRF-Token": "csrf-1", "Idempotency-Key": "source-write-1" });
    expect(firstCall[1].headers).not.toHaveProperty("authorization");
  });

  it("accepts a successful replay and reads receipts with GET only", async () => {
    const replay = { ...receipt, replayed: true };
    const fetch = vi.fn()
      .mockResolvedValueOnce(Response.json({ ...envelope, receipt, replayed: true }, { status: 200 }))
      .mockResolvedValueOnce(Response.json({ ...envelope, receipt }));
    vi.stubGlobal("fetch", fetch);
    await expect(createResearchSource("notebook-a", "Title", "Plain content", "csrf-1", "source-write-1")).resolves.toMatchObject({ replayed: true });
    await expect(getResearchSourceWriteReceipt("notebook-a", "source-write-1")).resolves.toEqual(receipt);
    expect(fetch.mock.calls[1]?.[0]).toBe("/api/research/notebooks/notebook-a/engine/write-receipts/source-write-1");
    expect(fetch.mock.calls[1]?.[1]).toMatchObject({ method: "GET" });
    expect(replay.replayed).toBe(true);
  });

  it.each([
    [409, { ...receipt, state: "uncertain", sourceId: null, errorCode: "ambiguous_response" }, false],
    [409, { ...receipt, state: "pending", sourceId: null, errorCode: null }, false],
    [502, { ...receipt, state: "rejected", sourceId: null, errorCode: "upstream_rejected" }, false],
  ] as const)("preserves a validated %s receipt instead of retrying", async (status, stateReceipt, replayed) => {
    const fetch = vi.fn(async () => Response.json({ ...envelope, receipt: stateReceipt }, { status }));
    vi.stubGlobal("fetch", fetch);
    await expect(createResearchSource("notebook-a", "Title", "Plain content", "csrf-1", "source-write-1")).resolves.toMatchObject({ receipt: stateReceipt, replayed });
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("keeps an unconfirmed authentication or network error as an error without a retry", async () => {
    const fetch = vi.fn(async () => Response.json({ error: "authentication_required" }, { status: 401 }));
    vi.stubGlobal("fetch", fetch);
    await expect(createResearchSource("notebook-a", "Title", "Plain content", "csrf-1", "source-write-1")).rejects.toMatchObject({ status: 401, code: "authentication_required" });
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("rejects invalid input and malformed or mismatched receipt projections before accepting an outcome", async () => {
    const fetch = vi.fn();
    vi.stubGlobal("fetch", fetch);
    await expect(createResearchSource("notebook-a", " ", "content", "csrf-1", "source-write-1")).rejects.toMatchObject({ code: "invalid_research_request" });
    await expect(createResearchSource("notebook-a", "x".repeat(RESEARCH_SOURCE_TITLE_MAX_BYTES + 1), "content", "csrf-1", "source-write-1")).rejects.toMatchObject({ code: "invalid_research_request" });
    await expect(createResearchSource("notebook-a", "Title", "x".repeat(RESEARCH_SOURCE_CONTENT_MAX_BYTES + 1), "csrf-1", "source-write-1")).rejects.toMatchObject({ code: "invalid_research_request" });
    expect(fetch).not.toHaveBeenCalled();
    expect(() => parseResearchSourceWriteReceipt({ ...receipt, idempotencyKey: "foreign" }, "source-write-1")).toThrow("invalid_research_response");
    expect(() => parseResearchSourceWriteReceipt({ ...receipt, state: "succeeded", sourceId: null }, "source-write-1")).toThrow("invalid_research_response");
    expect(() => parseResearchSourceWriteResult({ ...envelope, receipt: { ...receipt, state: "rejected", sourceId: null, errorCode: null } }, "source-write-1")).toThrow("invalid_research_response");
  });

  it("does not accept a successful response with the wrong HTTP/replay semantics", () => {
    expect(() => parseResearchSourceWriteResult({ ...envelope, receipt, replayed: "yes" }, "source-write-1")).toThrow("invalid_research_response");
    expect(() => parseResearchSourceWriteResult({ ...envelope, receipt: { ...receipt, idempotencyKey: "other" }, replayed: false }, "source-write-1")).toThrow("invalid_research_response");
  });

  it("does not accept error-status receipts with impossible terminal or replay semantics", async () => {
    const rejected = { ...receipt, state: "rejected", sourceId: null, errorCode: "upstream_rejected" };
    for (const [status, body] of [
      [503, { ...envelope, receipt: rejected }],
      [502, { ...envelope, receipt: rejected, replayed: true }],
      [409, { ...envelope, receipt: rejected, replayed: false }],
    ] as const) {
      vi.stubGlobal("fetch", vi.fn(async () => Response.json(body, { status })));
      await expect(createResearchSource("notebook-a", "Title", "Text", "csrf", "source-write-1")).rejects.toMatchObject({ code: "invalid_research_response" });
    }
  });

  it("keeps network and non-JSON gateway failures unconfirmed and sends no retry", async () => {
    const fetch = vi.fn().mockRejectedValueOnce(new Error("private transport detail"))
      .mockResolvedValueOnce(new Response("<html>gateway unavailable</html>", { status: 503 }));
    vi.stubGlobal("fetch", fetch);
    await expect(createResearchSource("notebook-a", "Title", "Text", "csrf", "source-write-1")).rejects.toMatchObject({ code: "research_connection_interrupted" });
    await expect(createResearchSource("notebook-a", "Title", "Text", "csrf", "source-write-2")).rejects.toMatchObject({ code: "invalid_research_response" });
    expect(fetch).toHaveBeenCalledTimes(2);
  });
});
