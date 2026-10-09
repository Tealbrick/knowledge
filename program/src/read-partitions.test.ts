import Fastify, { type FastifyInstance } from "fastify";
import { MAX_READ_PARTITIONS as KIT_MAX_READ_PARTITIONS } from "@tealbrick/contract";
import { afterEach, describe, expect, it, vi } from "vitest";

import { buildKnowledgeApp } from "./app.js";
import { createAttachmentResearchAuthority } from "./attachment-research-principal.js";
import { mergeEngineResults, mergeNativeResults, mergeRankedLists } from "./brain-read-view.js";
import { GBrainRuntime } from "./gbrain.js";
import { hindsightBankForPartition } from "./hindsight-client.js";
import { registerOpenNotebookRoutes, type OpenNotebookRouteAdapter } from "./open-notebook-routes.js";
import { MAX_READ_PARTITIONS, edgeScopeFor, parseEdgeReadPartitionsClaim, parseReadPartitionKeys } from "./partition-authority.js";
import { portalPrincipalFromResponse, type PortalPrincipalResolver } from "./portal-principal.js";
import { createId, KnowledgeStore } from "./store.js";
import { startFakeHindsight } from "../scripts/fixtures/fake-engines.mjs";

/**
 * Partitions contract 2 (read-many / write-one) leak tests. Three edge partitions of one workspace:
 *   A = {write alpha, read [alpha, beta]}, B = {write beta, read [beta]}, C = {write gamma, read [gamma]}.
 * Every surface must give A alpha + beta and never gamma, never let A write into beta, never give B alpha, and answer
 * an id outside the caller's read set (write partition for writes) exactly like an id that does not exist.
 */
const companyId = "fixture-a";
const pa = `${companyId}/alpha`, pb = `${companyId}/beta`, pc = `${companyId}/gamma`;
const capabilities = ["knowledge:create", "knowledge:read", "brain:read", "knowledge:update", "knowledge:delete"];
const expected = { instanceId: "instance-1", companyId, portalOrgId: "org-1" };
const answer = (overrides: Record<string, unknown> = {}) => ({
  authorized: true, principalId: "tealbrick-agent:henry", agentId: "henry", orgId: "org-1", workspaceId: companyId, instanceId: "instance-1", companyId,
  actions: ["create", "read", "update", "delete"], capabilities, partitionGrants: [{ partitionKey: companyId, breadth: "exact", maxDepth: 0, capabilities }],
  capabilityRevision: 2, expiresAt: Date.now() + 60_000, ...overrides,
});
const principalFor = (overrides: Record<string, unknown> = {}) => portalPrincipalFromResponse(answer(overrides), expected, Date.now())?.principal ?? null;
const GRANTS: Record<string, Record<string, unknown>> = {
  A: { partitionKey: "alpha", readPartitionKeys: ["alpha", "beta"] },
  B: { partitionKey: "beta", readPartitionKeys: ["beta"] },
  C: { partitionKey: "gamma", readPartitionKeys: ["gamma"] },
  // Contract 1 spellings of B and of the workspace default, for byte-for-byte comparisons.
  B1: { partitionKey: "beta" },
  D1: {},
  D2: { readPartitionKeys: [null] },
};
function resolver(): PortalPrincipalResolver {
  const table = Object.fromEntries(Object.entries(GRANTS).map(([name, claim]) => [name, principalFor(claim)]));
  return { configured: true, resolve: async (token) => (token ? table[token.trim()] ?? null : null) };
}
const as = (grant: string) => ({ authorization: `Bearer ${grant}` });
const apps: FastifyInstance[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  for (const app of apps.splice(0)) await app.close();
});
async function knowledge(config: Record<string, unknown> = {}) {
  const app = await buildKnowledgeApp({ environment: "test", portalPrincipals: resolver(), config: { gbrainAutoStart: false, partitionAuthorizationRequired: false, ...config } });
  apps.push(app);
  return app;
}
type Seeded = { collection: { id: string }; document: { id: string } };
async function seed(app: FastifyInstance): Promise<Record<"A" | "B" | "C", Seeded>> {
  const out = {} as Record<"A" | "B" | "C", Seeded>;
  for (const name of ["A", "B", "C"] as const) {
    const collection = await app.inject({ method: "POST", url: `/api/companies/${companyId}/knowledge/collections`, headers: as(name), payload: { name: `${name} collection` } });
    expect(collection.statusCode, name).toBe(201);
    const document = await app.inject({ method: "POST", url: `/api/knowledge/collections/${collection.json().id}/documents`, headers: as(name),
      payload: { title: `${name} note`, body: `${name.toLowerCase()}-marker secret` } });
    expect(document.statusCode, name).toBe(201);
    out[name] = { collection: collection.json(), document: document.json() };
  }
  return out;
}
/** The full answer (status, content type, body) an id outside the read set must share with a missing id. */
async function snapshot(app: FastifyInstance, request: { method: string; url: string; headers: Record<string, string>; payload?: unknown }) {
  const response = await app.inject(request as never);
  return { status: response.statusCode, type: response.headers["content-type"], body: response.body };
}

describe("read set parsing and principals", () => {
  it("accepts 1..64 unique keys or null that contain the write key; anything else fails closed", () => {
    // The edge grammar keeps the kit's read set bound (attachments and tbkg_ parse it here, not in the kit).
    expect(MAX_READ_PARTITIONS).toBe(KIT_MAX_READ_PARTITIONS);
    expect(parseReadPartitionKeys(["alpha", "beta"], "alpha")).toEqual(["alpha", "beta"]);
    expect(parseReadPartitionKeys([null, "beta"], null)).toEqual([null, "beta"]);
    expect(parseReadPartitionKeys(Array.from({ length: 64 }, (_, i) => i ? `k${i}` : "alpha"), "alpha")).toHaveLength(64);
    for (const [value, write] of [
      [["beta"], "alpha"], [[], "alpha"], [["alpha", "alpha"], "alpha"], [["alpha", "default"], "alpha"], [["alpha", "Beta"], "alpha"],
      [["alpha", "a/b"], "alpha"], [["alpha", 7], "alpha"], ["alpha", "alpha"], [null, "alpha"], [["beta"], null],
      [Array.from({ length: 65 }, (_, i) => i ? `k${i}` : "alpha"), "alpha"],
    ] as const) expect(parseReadPartitionKeys(value, write as string | null), JSON.stringify(value)).toBeNull();
    expect(parseEdgeReadPartitionsClaim({ partitionKey: "alpha" }, "alpha")).toEqual({ ok: true, readPartitionKeys: undefined });
    expect(parseEdgeReadPartitionsClaim({ readPartitionKeys: ["beta"] }, "alpha")).toEqual({ ok: false });
  });

  it("gives A exact write grants on alpha and read-only grants on beta; B and every contract 1 grant keep the contract 1 shape", () => {
    const a = principalFor(GRANTS.A!)!;
    expect(a.companyId).toBe(pa);
    expect(a.boundPartition).toEqual({ alias: companyId, partitionKey: pa, readPartitions: [pa, pb] });
    expect(a.partitionGrants).toEqual([
      { partitionKey: pa, breadth: "exact", maxDepth: 0, capabilities },
      { partitionKey: pb, breadth: "exact", maxDepth: 0, capabilities: ["knowledge:read", "brain:read"] },
    ]);
    // A read set that is exactly the write key is the contract 1 grant: the same principal, field for field.
    expect(principalFor(GRANTS.B!)).toEqual(principalFor(GRANTS.B1!));
    expect(principalFor(GRANTS.D2!)).toEqual(principalFor(GRANTS.D1!));
    expect(principalFor(GRANTS.D1!)).toEqual({ kind: "service", principalId: "tealbrick-agent:henry", companyId, capabilities,
      partitionGrants: [{ partitionKey: companyId, breadth: "exact", maxDepth: 0, capabilities }] });
    for (const bad of [{ partitionKey: "alpha", readPartitionKeys: ["beta"] }, { partitionKey: "alpha", readPartitionKeys: ["alpha", "Gamma"] }, { readPartitionKeys: [] }]) {
      expect(principalFor(bad), JSON.stringify(bad)).toBeNull();
    }
    // A default write partition with a wider read set binds too, so the workspace reads the whole view.
    expect(edgeScopeFor(companyId, null, [null, "beta"])).toMatchObject({ ok: true, write: companyId, bound: { alias: companyId, partitionKey: companyId, readPartitions: [companyId, pb] } });
  });
});

describe("documents, collections, search and revisions (runtime principal path)", () => {
  it("A sees alpha + beta, never gamma; B never sees alpha; nobody writes outside its write partition", async () => {
    const app = await knowledge();
    const s = await seed(app);
    expect([s.A.document, s.B.document, s.C.document].map((d) => (d as { companyId?: string }).companyId)).toEqual([pa, pb, pc]);
    const ids = async (grant: string, url: string) => (await app.inject({ url, headers: as(grant) })).json().map((item: { id: string }) => item.id);

    // Collections list (both list routes) and search.
    for (const url of [`/api/companies/${companyId}/knowledge/collections`, `/api/knowledge/collections?companyId=${companyId}`]) {
      expect((await ids("A", url)).sort(), url).toEqual([s.A.collection.id, s.B.collection.id].sort());
      expect(await ids("B", url), url).toEqual([s.B.collection.id]);
      expect(await ids("C", url), url).toEqual([s.C.collection.id]);
    }
    const search = async (grant: string, query = "") => (await app.inject({ url: `/api/companies/${companyId}/knowledge/search?q=marker${query}`, headers: as(grant) })).body;
    expect(await search("A")).toMatch(/a-marker/u);
    expect(await search("A")).toMatch(/b-marker/u);
    expect(await search("A")).not.toMatch(/c-marker/u);
    expect(await search("B")).toMatch(/b-marker/u);
    expect(await search("B")).not.toMatch(/a-marker|c-marker/u);
    expect(await search("C")).not.toMatch(/a-marker|b-marker/u);
    // One partition of the read set, by name or through one of its collections.
    expect(await ids("A", `/api/companies/${encodeURIComponent(pb)}/knowledge/collections`)).toEqual([s.B.collection.id]);
    expect(await search("A", `&collectionId=${s.B.collection.id}`)).toMatch(/b-marker/u);
    expect(await search("A", `&collectionId=${s.B.collection.id}`)).not.toMatch(/a-marker/u);
    // Outside the read set: a named partition is refused, a collection id looks absent.
    expect((await app.inject({ url: `/api/companies/${encodeURIComponent(pc)}/knowledge/collections`, headers: as("A") })).statusCode).toBe(403);
    const crossed = await app.inject({ url: `/api/companies/${companyId}/knowledge/search?q=marker&collectionId=${s.C.collection.id}`, headers: as("A") });
    expect([crossed.statusCode, crossed.json()]).toEqual([404, { error: "not_found" }]);

    // By id: documents, collections, trees and revisions.
    const readable = (grant: string, seeded: Seeded) => [
      `/api/knowledge/documents/${seeded.document.id}`, `/api/knowledge/documents/${seeded.document.id}/revisions`,
      `/api/knowledge/collections/${seeded.collection.id}`, `/api/knowledge/collections/${seeded.collection.id}/tree`,
    ].map((url) => ({ grant, url }));
    for (const { grant, url } of [...readable("A", s.A), ...readable("A", s.B), ...readable("B", s.B), ...readable("C", s.C)]) {
      expect((await app.inject({ url, headers: as(grant) })).statusCode, `${grant} ${url}`).toBe(200);
    }
    for (const { grant, url } of [...readable("A", s.C), ...readable("B", s.A), ...readable("B", s.C), ...readable("C", s.A), ...readable("C", s.B)]) {
      const response = await app.inject({ url, headers: as(grant) });
      expect([response.statusCode, response.json()], `${grant} ${url}`).toEqual([404, { error: "not_found" }]);
    }
    expect((await app.inject({ url: `/api/knowledge/documents/${s.B.document.id}`, headers: as("A") })).body).toMatch(/b-marker/u);

    // Writes bind to the write partition only: beta is readable for A but never writable.
    for (const request of [
      { method: "PATCH", url: `/api/knowledge/documents/${s.B.document.id}`, payload: { title: "forged" } },
      { method: "DELETE", url: `/api/knowledge/documents/${s.B.document.id}` },
      { method: "POST", url: `/api/knowledge/collections/${s.B.collection.id}/documents`, payload: { title: "forged" } },
      { method: "DELETE", url: `/api/knowledge/collections/${s.B.collection.id}` },
      { method: "POST", url: `/api/knowledge/collections/${s.A.collection.id}/documents`, payload: { title: "forged", parentDocumentId: s.B.document.id } },
    ]) {
      const response = await app.inject({ ...request, headers: as("A") } as never);
      expect([response.statusCode, response.json()], `${request.method} ${request.url}`).toEqual([404, { error: "not_found" }]);
    }
    const named = await app.inject({ method: "POST", url: `/api/companies/${encodeURIComponent(pb)}/knowledge/collections`, headers: as("A"), payload: { name: "forged" } });
    expect(named.statusCode).toBe(403);
    expect((await app.inject({ method: "POST", url: `/api/companies/${companyId}/knowledge/collections`, headers: as("A"), payload: { name: "Mine", companyId: pb } })).statusCode).toBe(400);
    expect((await app.inject({ url: `/api/knowledge/documents/${s.B.document.id}`, headers: as("B") })).json().title).toBe("B note");
    expect((await ids("B", `/api/companies/${companyId}/knowledge/collections`))).toEqual([s.B.collection.id]);
    // Its own writes still work and land in alpha.
    const own = await app.inject({ method: "PATCH", url: `/api/knowledge/documents/${s.A.document.id}`, headers: as("A"), payload: { title: "A edited" } });
    expect([own.statusCode, own.json().companyId]).toEqual([200, pa]);
    const created = await app.inject({ method: "POST", url: `/api/companies/${companyId}/knowledge/collections`, headers: as("A"), payload: { name: "A second" } });
    expect(created.json().companyId).toBe(pa);
    // Agents see their read set in their partition listing.
    expect((await app.inject({ url: "/api/knowledge/partitions", headers: as("A") })).json().partitions.map((p: { partitionKey: string }) => p.partitionKey)).toEqual([pa, pb]);
  });

  it("answers an id outside the read set (or write partition) exactly like an id that does not exist", async () => {
    const app = await knowledge();
    const s = await seed(app);
    const missingDocument = createId("kdoc"), missingCollection = createId("kcol");
    const pairs: Array<[string, (id: string) => { method: string; url: string; payload?: unknown }, string, string]> = [
      ["get document", (id) => ({ method: "GET", url: `/api/knowledge/documents/${id}` }), s.C.document.id, missingDocument],
      ["revisions", (id) => ({ method: "GET", url: `/api/knowledge/documents/${id}/revisions` }), s.C.document.id, missingDocument],
      ["get collection", (id) => ({ method: "GET", url: `/api/knowledge/collections/${id}` }), s.C.collection.id, missingCollection],
      ["update document (readable, not writable)", (id) => ({ method: "PATCH", url: `/api/knowledge/documents/${id}`, payload: { title: "x" } }), s.B.document.id, missingDocument],
      ["delete document (readable, not writable)", (id) => ({ method: "DELETE", url: `/api/knowledge/documents/${id}` }), s.B.document.id, missingDocument],
      ["create in collection (readable, not writable)", (id) => ({ method: "POST", url: `/api/knowledge/collections/${id}/documents`, payload: { title: "x" } }), s.B.collection.id, missingCollection],
      ["legacy sequential id", (id) => ({ method: "GET", url: `/api/knowledge/documents/${id}` }), s.C.document.id, "kdoc_0001"],
    ];
    for (const [label, request, foreign, missing] of pairs) {
      const a = await snapshot(app, { ...request(foreign), headers: as("A") });
      const b = await snapshot(app, { ...request(missing), headers: as("A") });
      expect(a, label).toEqual(b);
      expect(a.status, label).toBe(404);
      expect(JSON.parse(a.body), label).toEqual({ error: "not_found" });
    }
  });

  it("keeps contract 1 byte for byte: a read set equal to the write key answers exactly like no read set", async () => {
    const app = await knowledge();
    const s = await seed(app);
    for (const url of [`/api/companies/${companyId}/knowledge/collections`, `/api/companies/${companyId}/knowledge/search?q=marker`,
      `/api/knowledge/documents/${s.B.document.id}`, `/api/knowledge/documents/${s.A.document.id}`, `/api/knowledge/collections/${s.B.collection.id}`,
      "/api/knowledge/partitions"]) {
      const contract2 = await snapshot(app, { method: "GET", url, headers: as("B") });
      const contract1 = await snapshot(app, { method: "GET", url, headers: as("B1") });
      expect(contract2, url).toEqual(contract1);
    }
    const workspace = await snapshot(app, { method: "GET", url: `/api/companies/${companyId}/knowledge/collections`, headers: as("D2") });
    expect(workspace).toEqual(await snapshot(app, { method: "GET", url: `/api/companies/${companyId}/knowledge/collections`, headers: as("D1") }));
  });
});

describe("Brain recall, context, entities and native reads", () => {
  it("fan out once per read partition on the repository's fake Hindsight, merge, and never touch gamma", async () => {
    const apiKey = "hindsight-tenant-key-fixture-only-000000";
    const bank = { [hindsightBankForPartition(pa)]: "alpha", [hindsightBankForPartition(pb)]: "beta", [hindsightBankForPartition(pc)]: "gamma" };
    const fake = await startFakeHindsight({ apiKey, answer: (call) => call.bank && call.path.endsWith("/memories/recall")
      ? { results: [1, 2].map((rank) => ({ id: `${bank[call.bank!]}-${rank}`, text: `${bank[call.bank!]} memory ${rank}`, type: "world" })) } : undefined });
    try {
      const app = await knowledge({ memoryEngine: "hindsight", hindsightUrl: fake.baseUrl, hindsightApiKey: apiKey });
      const banks = (from: number) => [...new Set(fake.calls.slice(from).filter((call) => call.bank).map((call) => bank[call.bank!]))].sort();
      const recall = async (grant: string, extra: Record<string, unknown> = {}) => {
        const from = fake.calls.length;
        const response = await app.inject({ method: "POST", url: "/api/brain/recall", headers: as(grant), payload: { query: "q", scopeRef: companyId, ...extra } });
        return { response, banks: banks(from) };
      };
      const a = await recall("A");
      expect(a.response.statusCode).toBe(200);
      expect(a.banks).toEqual(["alpha", "beta"]);
      // No scores from this engine: interleaved by rank, write partition first.
      expect(a.response.json().memories.results.map((m: { id: string }) => m.id)).toEqual(["alpha-1", "beta-1", "alpha-2", "beta-2"]);
      expect(a.response.body).not.toMatch(/gamma/u);
      expect(a.response.body).not.toContain(pb);
      expect((await recall("B")).banks).toEqual(["beta"]);
      expect((await recall("B")).response.body).not.toMatch(/alpha/u);
      expect((await recall("C")).banks).toEqual(["gamma"]);
      // One read partition by name; outside the read set is refused before the engine.
      expect((await recall("A", { scopeRef: pb, partitionKey: pb })).banks).toEqual(["beta"]);
      const refused = await recall("A", { scopeRef: pc, partitionKey: pc });
      expect([refused.response.statusCode, refused.banks]).toEqual([403, []]);
      // Context (query) fans out the same way.
      let from = fake.calls.length;
      expect((await app.inject({ method: "POST", url: "/api/brain/context", headers: as("A"), payload: { query: "q", scopeRef: companyId } })).statusCode).toBe(200);
      expect(banks(from)).toEqual(["alpha", "beta"]);
      // Entities (document listing) over the read set.
      from = fake.calls.length;
      expect((await app.inject({ url: `/api/brain/entities?kind=all&partitionKey=${companyId}`, headers: as("A") })).statusCode).toBe(200);
      expect(banks(from)).toEqual(["alpha", "beta"]);
      // Native reads: lookups and lists fan out; stateful or model reads stay in one partition; writes only in alpha.
      from = fake.calls.length;
      const native = await app.inject({ method: "POST", url: "/api/brain/native/recall_memories", headers: as("A"), payload: { partitionKey: companyId, arguments: { body: { query: "q" } } } });
      expect(native.statusCode).toBe(200);
      expect(banks(from)).toEqual(["alpha", "beta"]);
      expect(native.json().data.results.map((m: { id: string }) => m.id)).toEqual(["alpha-1", "beta-1", "alpha-2", "beta-2"]);
      from = fake.calls.length;
      expect((await app.inject({ method: "POST", url: "/api/brain/native/reflect", headers: as("A"), payload: { partitionKey: companyId, arguments: { body: { query: "q" } } } })).statusCode).toBe(200);
      expect(banks(from)).toEqual(["alpha"]);
      from = fake.calls.length;
      expect((await app.inject({ method: "POST", url: "/api/brain/native/reflect", headers: as("A"), payload: { partitionKey: pb, arguments: { body: { query: "q" } } } })).statusCode).toBe(200);
      expect(banks(from)).toEqual(["beta"]);
      from = fake.calls.length;
      const write = await app.inject({ method: "POST", url: "/api/brain/native/retain_memories", headers: { ...as("A"), "idempotency-key": "k-1" },
        payload: { partitionKey: companyId, arguments: { body: { items: [{ content: "x" }] } } } });
      expect(write.statusCode).toBe(200);
      expect(banks(from)).toEqual(["alpha"]);
      from = fake.calls.length;
      for (const partitionKey of [pb, pc]) {
        const denied = await app.inject({ method: "POST", url: "/api/brain/native/retain_memories", headers: { ...as("A"), "idempotency-key": `k-${partitionKey}` },
          payload: { partitionKey, arguments: { body: { items: [{ content: "x" }] } } } });
        expect(denied.statusCode, partitionKey).toBe(403);
      }
      expect((await app.inject({ method: "POST", url: "/api/brain/extract-facts", headers: as("A"), payload: { text: "fact", partitionKey: pb } })).statusCode).toBe(403);
      expect(banks(from)).toEqual([]);
      for (const partitionKey of [pa, pc]) {
        const denied = await app.inject({ method: "POST", url: "/api/brain/native/recall_memories", headers: as("B"), payload: { partitionKey, arguments: { body: { query: "q" } } } });
        expect(denied.statusCode, partitionKey).toBe(403);
      }
      expect(banks(from)).toEqual([]);
    } finally { await fake.close(); }
  });

  it("orders scored memories by score across partitions, dedupes, caps to the limit and keeps entity reads in one partition", async () => {
    const seen: Array<{ op: string; partitionKey: unknown }> = [];
    const memories: Record<string, Array<{ slug: string; score: number }>> = {
      [pa]: [{ slug: "a-1", score: 0.9 }, { slug: "a-2", score: 0.3 }],
      [pb]: [{ slug: "b-1", score: 0.8 }, { slug: "b-2", score: 0.5 }],
      [pc]: [{ slug: "c-1", score: 0.99 }],
    };
    vi.spyOn(GBrainRuntime.prototype, "recall").mockImplementation(async (input) => {
      seen.push({ op: "recall", partitionKey: input.partitionKey });
      return { ok: true, status: "ready", tool: "recall", data: memories[String(input.partitionKey)] ?? [] };
    });
    vi.spyOn(GBrainRuntime.prototype, "query").mockImplementation(async (input) => {
      seen.push({ op: "query", partitionKey: input.partitionKey });
      return { ok: true, status: "ready", tool: "query", data: (memories[String(input.partitionKey)] ?? []).map((m) => ({ ...m, chunk_text: m.slug })) };
    });
    vi.spyOn(GBrainRuntime.prototype, "getPage").mockImplementation(async (input) => {
      seen.push({ op: "get_page", partitionKey: input.partitionKey });
      return input.partitionKey === pb ? { ok: true, status: "ready", tool: "get_page", data: { slug: input.slug, title: "beta page" } }
        : { ok: false, status: "degraded", tool: "get_page", data: null, error: "page_not_found" };
    });
    vi.spyOn(GBrainRuntime.prototype, "nativeOperation").mockImplementation(async (op, _args, partitionKey) => {
      seen.push({ op: `native:${op}`, partitionKey });
      return op === "get_page" ? (partitionKey === pb ? { ok: true, data: { slug: "x", found: "beta" } } : { ok: false, error: { error: "page_not_found" } })
        : { ok: true, data: memories[partitionKey] ?? [] };
    });
    const app = await knowledge();
    const recall = await app.inject({ method: "POST", url: "/api/brain/recall", headers: as("A"), payload: { query: "q", scopeRef: companyId, limit: 3 } });
    expect(recall.json().memories.map((m: { slug: string }) => m.slug)).toEqual(["a-1", "b-1", "b-2"]);
    expect(seen.filter((c) => c.op === "recall").map((c) => c.partitionKey)).toEqual([pa, pb]);
    const context = await app.inject({ method: "POST", url: "/api/brain/context", headers: as("A"), payload: { query: "q", scopeRef: companyId, limit: 2 } });
    expect(context.json().citations.map((c: { slug: string }) => c.slug)).toEqual(["a-1", "b-1"]);
    // B and the contract 1 spelling of B: one partition, identical answers.
    const b = await app.inject({ method: "POST", url: "/api/brain/recall", headers: as("B"), payload: { query: "q", scopeRef: companyId } });
    const b1 = await app.inject({ method: "POST", url: "/api/brain/recall", headers: as("B1"), payload: { query: "q", scopeRef: companyId } });
    expect(b.body).toEqual(b1.body);
    expect(b.json().memories.map((m: { slug: string }) => m.slug)).toEqual(["b-1", "b-2"]);
    // Entity by slug: read from the read partition that has it, all six reads in that one partition.
    seen.length = 0;
    vi.spyOn(GBrainRuntime.prototype, "getEntityCard").mockImplementation(async (input) => { seen.push({ op: "entity", partitionKey: input.partitionKey }); return { ok: true, status: "ready", tool: "entity", data: {} }; });
    expect((await app.inject({ url: `/api/brain/entities?slug=people/x&partitionKey=${companyId}`, headers: as("A") })).json().profile).toEqual({ slug: "people/x", title: "beta page" });
    expect(seen.find((c) => c.op === "entity")?.partitionKey).toBe(pb);
    expect(seen.every((c) => c.partitionKey === pa || c.partitionKey === pb)).toBe(true);
    // Native: a list merges by score; a lookup takes the first partition that has the answer.
    seen.length = 0;
    const search = await app.inject({ method: "POST", url: "/api/brain/native/search", headers: as("A"), payload: { partitionKey: companyId, arguments: { query: "q", limit: 2 } } });
    expect(search.json().data.map((m: { slug: string }) => m.slug)).toEqual(["a-1", "b-1"]);
    const page = await app.inject({ method: "POST", url: "/api/brain/native/get_page", headers: as("A"), payload: { partitionKey: companyId, arguments: { slug: "x" } } });
    expect(page.json().data).toEqual({ slug: "x", found: "beta" });
    seen.length = 0;
    await app.inject({ method: "POST", url: "/api/brain/native/delta", headers: as("A"), payload: { partitionKey: companyId, arguments: {} } });
    expect(seen.map((c) => c.partitionKey)).toEqual([pa]);
    expect(JSON.stringify(seen)).not.toContain(pc);
  });

  it("merges deterministically", () => {
    expect(mergeRankedLists([[{ id: 1, score: 0.5 }, { id: 2, score: 0.1 }], [{ id: 3, score: 0.5 }, { id: 1, score: 0.5 }]], 10).items)
      .toEqual([{ id: 1, score: 0.5 }, { id: 3, score: 0.5 }, { id: 2, score: 0.1 }]);
    expect(mergeRankedLists([["a1", "a2", "a3"], ["b1"]]).items).toEqual(["a1", "b1", "a2", "a3"]);
    expect(mergeRankedLists([["a1", "a2"], ["b1"]], 2)).toEqual({ items: ["a1", "b1"], scopes: [0, 1] });
    const partial = mergeEngineResults([{ ok: true, status: "ready", tool: "recall", data: ["a"] }, { ok: false, status: "degraded", tool: "recall", data: null, error: "down" }]);
    expect(partial).toMatchObject({ ok: false, status: "degraded", error: "down", data: ["a"] });
    expect(mergeNativeResults([{ ok: false, error: { error: "page_not_found" } }, { ok: false, error: { error: "unavailable" } }])).toEqual({ ok: false, error: { error: "page_not_found" } });
  });
});

describe("Research notebooks, sources, notes, context, writes and chat receipts", () => {
  it("A reads alpha and beta notebooks, never gamma, and writes only alpha; B never reaches alpha", async () => {
    const authority = createAttachmentResearchAuthority({ companyId, fallback: null });
    const base = { agentId: "agent-1", orgId: "org-1", capabilities: ["knowledge:research:read", "knowledge:research:write"], expiresAt: Date.now() + 60_000 };
    const token = (claim: Record<string, unknown>) => authority.issue({ ...base, ...claim } as never)!;
    const tokens = { A: token(GRANTS.A!), B: token(GRANTS.B!), C: token(GRANTS.C!) };
    const scope: Record<string, string> = { "nb-alpha": pa, "nb-beta": pb, "nb-gamma": pc };
    const adapter: OpenNotebookRouteAdapter = {
      async getNotebook(id) { return { id, name: `${id} name`, description: "", archived: false, created: "2026-10-09T00:00:00Z", updated: "2026-10-09T00:00:00Z", sourceCount: 1, noteCount: 1 }; },
      async listNotebookSources(id) { return [{ id: `${id}-source`, title: `${id} source`, topics: [], asset: null, embedded: true, embeddedChunks: 1, insightsCount: 0, fileAvailable: false, created: null, updated: null, commandId: null, status: "ready" } as never]; },
      async listNotebookNotes(id) { return [{ id: `${id}-note`, title: `${id} note`, content: `${id} note content`, noteType: "human", created: null, updated: null, commandId: null } as never]; },
      async getNotebookSource(id, sourceId) { return { id: sourceId, title: `${id} source`, topics: [], asset: null, fullText: `${id} text`, embedded: true, embeddedChunks: 1, insightsCount: 0, fileAvailable: false, created: null, updated: null, commandId: null, status: "ready" } as never; },
      async getNotebookNote(id, noteId) { return { id: noteId, title: `${id} note`, content: `${id} note content`, noteType: "human", created: null, updated: null, commandId: null } as never; },
      async getNotebookContext(id) { return { sources: [], notes: [], tokenCount: 0, charCount: id.length } as never; },
    };
    const app = Fastify();
    apps.push(app);
    registerOpenNotebookRoutes(app, {
      adapter, principals: { configured: false, resolve: () => null }, researchPrincipalProvider: authority.provider,
      bindings: Object.entries(scope).map(([id, companyId]) => ({ knowledgeNotebookId: id, companyId, externalNotebookId: `upstream-${id.slice(3)}` })),
      resolveNotebookCompany: (id) => scope[id] ?? null,
      resolveNotebookSummary: (id) => ({ id, name: id, description: "" }),
    });
    await app.ready();
    const call = (who: keyof typeof tokens, method: "GET" | "POST", url: string, extra: Record<string, string> = {}, payload?: Record<string, unknown>) =>
      app.inject({ method, url, headers: { authorization: `Bearer ${tokens[who]}`, ...extra }, ...(payload === undefined ? {} : { payload }) });
    const discover = async (who: keyof typeof tokens) => (await call(who, "GET", "/api/research/engine/notebooks")).json().notebooks.map((n: { id: string }) => n.id);
    expect(await discover("A")).toEqual(["nb-alpha", "nb-beta"]);
    expect(await discover("B")).toEqual(["nb-beta"]);
    expect(await discover("C")).toEqual(["nb-gamma"]);

    const reads = (nb: string) => [`/api/research/notebooks/${nb}/engine`, `/api/research/notebooks/${nb}/engine/sources`, `/api/research/notebooks/${nb}/engine/notes`,
      `/api/research/notebooks/${nb}/engine/context`, `/api/research/notebooks/${nb}/engine/sources/s1`, `/api/research/notebooks/${nb}/engine/notes/n1`];
    for (const url of [...reads("nb-alpha"), ...reads("nb-beta")]) expect((await call("A", "GET", url)).statusCode, `A ${url}`).toBe(200);
    expect((await call("A", "GET", "/api/research/notebooks/nb-beta/engine/notes")).body).toContain("upstream-beta note content");
    const hidden = async (who: keyof typeof tokens, method: "GET" | "POST", url: string, missingUrl: string, extra: Record<string, string> = {}, payload?: Record<string, unknown>) => {
      const foreign = await call(who, method, url, extra, payload), missing = await call(who, method, missingUrl, extra, payload);
      expect([foreign.statusCode, foreign.body], `${who} ${method} ${url}`).toEqual([missing.statusCode, missing.body]);
      expect([foreign.statusCode, foreign.json()], `${who} ${method} ${url}`).toEqual([404, { error: "not_found" }]);
    };
    for (const url of reads("nb-gamma")) await hidden("A", "GET", url, url.replace("nb-gamma", "nb-missing"));
    for (const url of reads("nb-alpha")) await hidden("B", "GET", url, url.replace("nb-alpha", "nb-missing"));
    // Writes and write receipts in beta: readable for A, never writable.
    const idem = { "idempotency-key": "same-key" };
    for (const [method, path, payload] of [
      ["POST", "engine/sources", { title: "x", content: "y" }],
      ["GET", "engine/write-receipts/same-key", undefined],
      ["POST", "engine/chat/sessions", {}],
      ["GET", "engine/chat/receipts/same-key", undefined],
      ["POST", "engine/chat/sessions/s1/messages", { message: "x" }],
    ] as const) {
      await hidden("A", method, `/api/research/notebooks/nb-beta/${path}`, `/api/research/notebooks/nb-missing/${path}`, idem, payload);
      // Its own notebook passes authorization (this fixture has no write ledger or chat engine).
      const own = await call("A", method, `/api/research/notebooks/nb-alpha/${path}`, idem, payload);
      expect([403, 404], `A ${method} alpha ${path}`).not.toContain(own.statusCode);
    }
    // Chat sessions of beta are readable for A (read capability), so the read check passes there.
    expect((await call("A", "GET", "/api/research/notebooks/nb-beta/engine/chat/sessions/s1")).statusCode).not.toBe(404);
  });
});

describe("random, unguessable ids", () => {
  it("creates new ids from 20 CSPRNG base32 characters and keeps sequential ids valid", () => {
    const ids = Array.from({ length: 2000 }, () => createId("kdoc"));
    expect(new Set(ids).size).toBe(ids.length);
    for (const id of ids.slice(0, 50)) expect(id).toMatch(/^kdoc_[a-z2-7]{20}$/u);
    const store = new KnowledgeStore(null);
    const collection = store.createKnowledgeCollection(companyId, { name: "c" });
    const document = store.createKnowledgeDocument(collection.id, { title: "d", body: "b" })!;
    const notebook = store.createResearchNotebook({ companyId, title: "n" });
    for (const [prefix, id] of [["kcol", collection.id], ["kdoc", document.id], ["notebook", notebook.id]] as const) {
      expect(id).toMatch(new RegExp(`^${prefix}_[a-z2-7]{20}$`, "u"));
    }
    // Revisions of the new document are random too; nothing reveals how many objects other partitions created.
    expect(store.listKnowledgeDocumentRevisions(document.id).every((revision: { id: string }) => /^krev_[a-z2-7]{20}$/u.test(revision.id))).toBe(true);
  });
});
