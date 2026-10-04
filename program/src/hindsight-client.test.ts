import { describe, expect, it } from "vitest";

import { HindsightClient, HindsightError, hindsightBankForPartition } from "./hindsight-client.js";
import { memoryEngineKind } from "./memory-engine.js";

const key = "hindsight-tenant-key-fixture-only-0000";
function fixture(status = 200, body: unknown = { ok: true }) {
  const calls: Array<{ url: string; method: string; headers: Record<string, string>; body?: unknown }> = [];
  const fetcher = (async (url: string | URL, init?: RequestInit) => {
    calls.push({ url: String(url), method: String(init?.method), headers: init?.headers as Record<string, string>, body: init?.body ? JSON.parse(String(init.body)) : undefined });
    return new Response(body === null ? null : JSON.stringify(body), { status });
  }) as typeof fetch;
  return { calls, client: new HindsightClient({ baseUrl: "http://hindsight.railway.internal:8888", apiKey: key, fetch: fetcher }) };
}

describe("Hindsight memory engine client", () => {
  it("derives an opaque, stable bank only from a normalized authorized partition", () => {
    const bank = hindsightBankForPartition("Workspace-A");
    expect(bank).toMatch(/^tb-[a-f0-9]{32}$/u);
    expect(hindsightBankForPartition("workspace-a")).toBe(bank);
    expect(hindsightBankForPartition("workspace-b")).not.toBe(bank);
    expect(bank).not.toContain("workspace");
    expect(() => hindsightBankForPartition("../other")).toThrow(HindsightError);
    expect(() => hindsightBankForPartition("")).toThrow(HindsightError);
  });

  it("builds only bank-scoped routes with the server-side tenant key", async () => {
    const f = fixture();
    const bank = hindsightBankForPartition("workspace-a");
    await f.client.retain("workspace-a", [{ content: "Henry drafts the meetup recap.", documentId: "knowledge-doc:doc-1" }], "op-1");
    await f.client.recall("workspace-a", { query: "meetup", maxTokens: 50 });
    await f.client.reflect("workspace-a", { query: "What changed?" });
    await f.client.deleteDocument("workspace-a", "knowledge-doc:doc-1");
    expect(f.calls.map(c => [c.method, new URL(c.url).pathname])).toEqual([
      ["POST", `/v1/default/banks/${bank}/memories`],
      ["POST", `/v1/default/banks/${bank}/memories/recall`],
      ["POST", `/v1/default/banks/${bank}/reflect`],
      ["DELETE", `/v1/default/banks/${bank}/documents/knowledge-doc%3Adoc-1`],
    ]);
    expect(f.calls.every(c => c.headers.authorization === `Bearer ${key}`)).toBe(true);
    expect(f.calls[0]!.body).toEqual({ items: [{ content: "Henry drafts the meetup recap.", document_id: "knowledge-doc:doc-1", update_mode: "replace" }], operation_id: "op-1" });
    expect(f.calls[1]!.body).toEqual({ query: "meetup", max_tokens: 256 });
  });

  it("rejects unsafe input before any request", async () => {
    const f = fixture();
    await expect(f.client.retain("workspace-a", [{ content: "x", documentId: "../escape" }])).rejects.toThrow("hindsight_invalid_input");
    await expect(f.client.retain("workspace-a", [])).rejects.toThrow("hindsight_invalid_input");
    await expect(f.client.recall("workspace-a", { query: " " })).rejects.toThrow("hindsight_invalid_input");
    await expect(f.client.deleteDocument("workspace-a", "a/b")).rejects.toThrow("hindsight_invalid_input");
    await expect(f.client.recall("Not A Partition!", { query: "x" })).rejects.toThrow("hindsight_invalid_input");
    expect(f.calls).toHaveLength(0);
  });

  it("maps upstream failures without echoing upstream bodies", async () => {
    await expect(fixture(503, { detail: "secret upstream" }).client.recall("workspace-a", { query: "x" })).rejects.toMatchObject({ code: "hindsight_unavailable", status: 503 });
    await expect(fixture(404, { detail: "secret upstream" }).client.recall("workspace-a", { query: "x" })).rejects.toMatchObject({ code: "hindsight_rejected", status: 404 });
    expect(await fixture(503).client.health()).toBe(false);
    expect(await fixture(200, { status: "healthy" }).client.health()).toBe(true);
  });

  it("refuses unsafe configuration", () => {
    expect(() => new HindsightClient({ baseUrl: "http://user:pw@hindsight:8888", apiKey: key })).toThrow();
    expect(() => new HindsightClient({ baseUrl: "http://hindsight:8888/v1", apiKey: key })).toThrow();
    expect(() => new HindsightClient({ baseUrl: "http://hindsight:8888", apiKey: "short" })).toThrow();
    expect(memoryEngineKind(undefined)).toBe("gbrain");
    expect(memoryEngineKind("hindsight")).toBe("hindsight");
    expect(() => memoryEngineKind("mem0")).toThrow();
  });
});
