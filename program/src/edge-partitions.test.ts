import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import Fastify from "fastify";
import { afterEach, describe, expect, it, vi } from "vitest";

import { buildKnowledgeApp } from "./app.js";
import { createAttachmentResearchAuthority } from "./attachment-research-principal.js";
import { GBrainRuntime } from "./gbrain.js";
import { hindsightBankForPartition } from "./hindsight-client.js";
import type { KnowledgeServicePrincipal } from "./knowledge-principal.js";
import { registerOpenNotebookRoutes } from "./open-notebook-routes.js";
import { KnowledgeInstanceClaim } from "./instance-claim.js";
import {
  boundPartitionFor,
  grantReachesEdgePartitions,
  effectiveKnowledgePartition,
  knowledgePartitionSourceId,
  narrowPartitionSelector,
  parseEdgePartitionClaim,
} from "./partition-authority.js";
import { SqliteKnowledgePersistence } from "./persistence.js";
import { createPortalPrincipalResolver, portalPrincipalFromResponse, type PortalPrincipalResolver } from "./portal-principal.js";
import { KnowledgeStore, type KnowledgeStoreSnapshot } from "./store.js";
// @ts-expect-error - plain ESM edge module without type declarations
import { attachmentRoute, edgePartitionClaim } from "../../deploy/container/attachment-auth.mjs";

const companyId = "fixture-a";
const personal = "fixture-a/personal";
const dirs: string[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const capabilities = ["knowledge:create", "knowledge:read", "brain:read", "knowledge:update", "knowledge:delete"];
const expected = { instanceId: "instance-1", companyId, portalOrgId: "org-1" };
/** Portal's runtime-principal introspection answer (portal-core#38 shape). */
function answer(overrides: Record<string, unknown> = {}) {
  return { authorized: true, principalId: "tealbrick-agent:henry", agentId: "henry", orgId: "org-1", workspaceId: companyId, instanceId: "instance-1", companyId,
    actions: ["create", "read", "update", "delete"], capabilities, partitionGrants: [{ partitionKey: companyId, breadth: "exact", maxDepth: 0, capabilities }],
    capabilityRevision: 2, expiresAt: Date.now() + 60_000, ...overrides };
}
const principalFor = (overrides: Record<string, unknown> = {}) => portalPrincipalFromResponse(answer(overrides), expected, Date.now())?.principal ?? null;

const VALID = ["personal", "a", "team-1", "a".repeat(40)];
const INVALID: unknown[] = ["default", "a".repeat(41), "../", "..", "../x", "a/b", "personal/", "/personal", "Personal", "PERSONAL", "", " personal",
  "personal ", "1abc", "-a", "a_b", "a.b", "a%2Fb", null, 7, true, [], {}, ["personal"]];

describe("per-edge partition claim parsing", () => {
  it("accepts absent and valid keys and fails closed on everything else, identically at the edge and in the Program", () => {
    expect(parseEdgePartitionClaim({})).toEqual({ ok: true, partitionKey: null });
    expect(edgePartitionClaim({})).toEqual({ ok: true, partitionKey: null });
    for (const key of VALID) {
      expect(parseEdgePartitionClaim({ partitionKey: key }), key).toEqual({ ok: true, partitionKey: key });
      expect(edgePartitionClaim({ partitionKey: key }), key).toEqual({ ok: true, partitionKey: key });
    }
    for (const key of INVALID) {
      expect(parseEdgePartitionClaim({ partitionKey: key }), String(key)).toEqual({ ok: false });
      expect(edgePartitionClaim({ partitionKey: key }), String(key)).toEqual({ ok: false });
    }
    // Present-but-undefined is still present (never "absent = default").
    expect(parseEdgePartitionClaim({ partitionKey: undefined })).toEqual({ ok: false });
    for (const value of [null, "x", 3, []]) expect(parseEdgePartitionClaim(value)).toEqual({ ok: false });
  });

  it("derives the effective partition as normalize(`${companyId}/${partitionKey}`)", () => {
    expect(effectiveKnowledgePartition(companyId, null)).toBe(companyId);
    expect(effectiveKnowledgePartition("Fixture-A", null)).toBe(companyId);
    expect(effectiveKnowledgePartition(companyId, "personal")).toBe(personal);
    expect(effectiveKnowledgePartition("Fixture-A", "personal")).toBe(personal);
    for (const key of ["default", "../x", "a/b", "Personal", "a".repeat(41)]) expect(effectiveKnowledgePartition(companyId, key), key).toBeNull();
    expect(boundPartitionFor(companyId, null)).toBeNull();
    expect(boundPartitionFor("Fixture-A", "personal")).toEqual({ alias: companyId, partitionKey: personal });
  });

  it("narrows only the workspace selector; siblings, children and foreign keys are left to be denied", () => {
    const bound = boundPartitionFor(companyId, "personal")!;
    expect(narrowPartitionSelector("fixture-a", bound)).toBe(personal);
    expect(narrowPartitionSelector("Fixture-A", bound)).toBe(personal);
    for (const value of [personal, "fixture-a/other", "fixture-b", "", 7]) expect(narrowPartitionSelector(value, bound)).toBe(value);
    expect(narrowPartitionSelector("fixture-a", undefined)).toBe("fixture-a");
  });

  it("admits a workspace/key company path at the edge only as a candidate for a partitioned attachment", () => {
    expect(attachmentRoute("GET", "/api/companies/fixture-a/knowledge/collections", companyId)).not.toHaveProperty("companyRef");
    expect(attachmentRoute("GET", "/api/companies/fixture-a%2Fpersonal/knowledge/collections", companyId)).toMatchObject({ companyRef: personal, companyResource: "collections" });
    for (const ref of ["fixture-a%2Fdefault", "fixture-a%2F..", "fixture-a%2Fa%2Fb", "fixture-a%2FA_B", "fixture-b", "fixture-b%2Fpersonal", "fixture-a%2F"]) {
      expect(attachmentRoute("GET", `/api/companies/${ref}/knowledge/search`, companyId), ref).toBeNull();
    }
  });
});

describe("engine source/bank mapping per effective partition", () => {
  it("is distinct per partition, stable, and unchanged for existing default data", () => {
    // Golden values for the workspace partition: existing default data keeps its GBrain source and Hindsight bank.
    expect(knowledgePartitionSourceId(companyId)).toBe("kb-06ada57c26aa5cf429e9f2c0");
    expect(hindsightBankForPartition(companyId)).toBe("tb-2e4e4c993c5d55e13b6f56579fccf40a");
    expect(knowledgePartitionSourceId(personal)).toBe("kb-d7367f6c6b5b74ff3bc76b5e");
    expect(hindsightBankForPartition(personal)).toBe("tb-4ac7d3370620c603730812279433770b");
    const keys = [companyId, personal, "fixture-a/team", "fixture-b", "fixture-b/personal"];
    expect(new Set(keys.map(knowledgePartitionSourceId)).size).toBe(keys.length);
    expect(new Set(keys.map(hindsightBankForPartition)).size).toBe(keys.length);
    // Stable across calls and spellings of the same effective partition.
    expect(knowledgePartitionSourceId(effectiveKnowledgePartition("Fixture-A", "personal")!)).toBe(knowledgePartitionSourceId(personal));
    expect(hindsightBankForPartition(effectiveKnowledgePartition("Fixture-A", "personal")!)).toBe(hindsightBankForPartition(personal));
  });
});

describe("Portal runtime principal with a partitionKey claim", () => {
  it("is unchanged without a claim", () => {
    const principal = principalFor();
    expect(principal).toEqual({ kind: "service", principalId: "tealbrick-agent:henry", companyId, capabilities,
      partitionGrants: [{ partitionKey: companyId, breadth: "exact", maxDepth: 0, capabilities }] });
    expect(principal && "boundPartition" in principal).toBe(false);
  });

  it("narrows Portal's workspace grant to the exact workspace/key partition", () => {
    expect(principalFor({ partitionKey: "personal" })).toEqual({ kind: "service", principalId: "tealbrick-agent:henry", companyId: personal, capabilities,
      partitionGrants: [{ partitionKey: personal, breadth: "exact", maxDepth: 0, capabilities }], boundPartition: { alias: companyId, partitionKey: personal } });
  });

  it("denies a malformed claim instead of falling back to the default partition", () => {
    for (const partitionKey of INVALID) expect(principalFor({ partitionKey }), String(partitionKey)).toBeNull();
    // portal-core#38 keeps partitionGrants[0].partitionKey = companyId; anything else is a contract break.
    expect(principalFor({ partitionKey: "personal", partitionGrants: [{ partitionKey: personal, breadth: "exact", maxDepth: 0, capabilities }] })).toBeNull();
  });
});

function resolverFor(table: Record<string, KnowledgeServicePrincipal | null>): PortalPrincipalResolver {
  return { configured: true, resolve: async (token) => (token ? table[token.trim()] ?? null : null) };
}

describe("edge-partition isolation in the Program (runtime principal path)", () => {
  const agents = () => resolverFor({ "default-agent": principalFor(), "personal-agent": principalFor({ partitionKey: "personal" }), "other-agent": principalFor({ partitionKey: "other" }) });
  const as = (token: string) => ({ authorization: `Bearer ${token}` });

  it("keeps documents, collections and search apart in both directions, including by ID", async () => {
    const app = await buildKnowledgeApp({ environment: "test", portalPrincipals: agents(), config: { gbrainAutoStart: false, partitionAuthorizationRequired: false } });
    try {
      // The owner (no principal) seeds the workspace default partition.
      const owned = (await app.inject({ method: "POST", url: `/api/companies/${companyId}/knowledge/collections`, payload: { name: "Workspace" } })).json();
      const secret = (await app.inject({ method: "POST", url: `/api/knowledge/collections/${owned.id}/documents`, payload: { title: "Default secret", body: "polygonface-only" } })).json();
      expect(secret.companyId).toBe(companyId);

      // The personal agent addresses its workspace and lands in its own partition.
      const listed = await app.inject({ url: `/api/companies/${companyId}/knowledge/collections`, headers: as("personal-agent") });
      expect(listed.statusCode).toBe(200);
      expect(listed.json().map((c: { id: string }) => c.id)).not.toContain(owned.id);
      expect(listed.json().every((c: { companyId: string }) => c.companyId === personal)).toBe(true);
      const mine = await app.inject({ method: "POST", url: `/api/companies/${companyId}/knowledge/collections`, headers: as("personal-agent"), payload: { name: "Mine" } });
      expect(mine.statusCode).toBe(201);
      expect(mine.json().companyId).toBe(personal);
      const note = await app.inject({ method: "POST", url: `/api/knowledge/collections/${mine.json().id}/documents`, headers: as("personal-agent"), payload: { title: "Personal note", body: "personal-only secret" } });
      expect(note.statusCode).toBe(201);
      expect(note.json().companyId).toBe(personal);
      const noteId = note.json().id as string;
      // Its explicit partition path works too; a sibling does not.
      expect((await app.inject({ url: `/api/companies/${encodeURIComponent(personal)}/knowledge/collections`, headers: as("personal-agent") })).statusCode).toBe(200);
      expect((await app.inject({ url: `/api/companies/${encodeURIComponent("fixture-a/other")}/knowledge/collections`, headers: as("personal-agent") })).statusCode).toBe(403);

      // personal -> default: no read, write or delete by ID, no writes into a default collection.
      for (const request of [
        { method: "GET", url: `/api/knowledge/documents/${secret.id}` },
        { method: "PATCH", url: `/api/knowledge/documents/${secret.id}`, payload: { title: "x" } },
        { method: "DELETE", url: `/api/knowledge/documents/${secret.id}` },
        { method: "GET", url: `/api/knowledge/documents/${secret.id}/revisions` },
        { method: "GET", url: `/api/knowledge/collections/${owned.id}/tree` },
        { method: "POST", url: `/api/knowledge/collections/${owned.id}/documents`, payload: { title: "x" } },
        { method: "DELETE", url: `/api/knowledge/collections/${owned.id}` },
      ] as const) {
        const response = await app.inject({ ...request, headers: as("personal-agent") });
        expect(response.statusCode, `${request.method} ${request.url}`).toBe(403);
        expect(response.body).not.toContain("polygonface-only");
      }
      // default -> personal, and a sibling partition -> personal.
      for (const token of ["default-agent", "other-agent"]) {
        for (const request of [
          { method: "GET", url: `/api/knowledge/documents/${noteId}` },
          { method: "PATCH", url: `/api/knowledge/documents/${noteId}`, payload: { title: "x" } },
          { method: "DELETE", url: `/api/knowledge/documents/${noteId}` },
          { method: "POST", url: `/api/knowledge/collections/${mine.json().id}/documents`, payload: { title: "x" } },
          { method: "GET", url: `/api/companies/${encodeURIComponent(personal)}/knowledge/collections` },
        ] as const) {
          const response = await app.inject({ ...request, headers: as(token) });
          expect(response.statusCode, `${token} ${request.method} ${request.url}`).toBe(403);
          expect(response.body).not.toContain("personal-only");
        }
      }
      // Search is partition-exact; a foreign collection selector never widens it.
      const personalSearch = (await app.inject({ url: `/api/companies/${companyId}/knowledge/search?q=secret`, headers: as("personal-agent") })).json();
      expect(JSON.stringify(personalSearch)).toContain("personal-only");
      expect(JSON.stringify(personalSearch)).not.toContain("polygonface-only");
      const defaultSearch = (await app.inject({ url: `/api/companies/${companyId}/knowledge/search?q=secret`, headers: as("default-agent") })).json();
      expect(JSON.stringify(defaultSearch)).toContain("polygonface-only");
      expect(JSON.stringify(defaultSearch)).not.toContain("personal-only");
      const crossed = await app.inject({ url: `/api/companies/${companyId}/knowledge/search?q=secret&collectionId=${owned.id}`, headers: as("personal-agent") });
      expect(crossed.statusCode).not.toBe(200);
      expect(crossed.body).not.toContain("polygonface-only");
      // Its own partition still works by ID.
      expect((await app.inject({ url: `/api/knowledge/documents/${noteId}`, headers: as("personal-agent") })).statusCode).toBe(200);
      expect((await app.inject({ url: `/api/knowledge/documents/${secret.id}`, headers: as("default-agent") })).statusCode).toBe(200);
      // The owner keeps full access to both.
      expect((await app.inject({ url: `/api/knowledge/documents/${noteId}` })).statusCode).toBe(200);
      expect((await app.inject({ url: `/api/knowledge/documents/${secret.id}` })).statusCode).toBe(200);
      // Agents only see their own grant.
      expect((await app.inject({ url: "/api/knowledge/partitions", headers: as("personal-agent") })).json().partitions)
        .toEqual([{ partitionKey: personal, breadth: "exact", maxDepth: 0, capabilities }]);
    } finally { await app.close(); }
  });

  it("binds Brain recall/context/entities and native operations to the effective partition", async () => {
    const seen: Array<{ op: string; partitionKey: unknown }> = [];
    vi.spyOn(GBrainRuntime.prototype, "recall").mockImplementation(async (input) => { seen.push({ op: "recall", partitionKey: input.partitionKey }); return { ok: true, status: "ready", tool: "recall", data: [] }; });
    vi.spyOn(GBrainRuntime.prototype, "query").mockImplementation(async (input) => { seen.push({ op: "query", partitionKey: input.partitionKey }); return { ok: true, status: "ready", tool: "query", data: [] }; });
    vi.spyOn(GBrainRuntime.prototype, "listPages").mockImplementation(async (input) => { seen.push({ op: "list_pages", partitionKey: input?.partitionKey }); return { ok: true, status: "ready", tool: "list_pages", data: [] }; });
    vi.spyOn(GBrainRuntime.prototype, "nativeOperation").mockImplementation(async (op, _args, partitionKey) => {
      seen.push({ op: `native:${op}`, partitionKey });
      return op === "catalog" ? { ok: true, data: { tools: [{ name: "recall" }] } } : { ok: true, data: { protocol_version: 1 } };
    });
    const app = await buildKnowledgeApp({ environment: "test", portalPrincipals: agents(), config: { gbrainAutoStart: false, partitionAuthorizationRequired: false } });
    try {
      const recall = await app.inject({ method: "POST", url: "/api/brain/recall", headers: as("personal-agent"), payload: { scopeRef: companyId, query: "q" } });
      expect(recall.statusCode).toBe(200);
      expect(recall.json().scopeRef).toBe(personal);
      expect((await app.inject({ method: "POST", url: "/api/brain/context", headers: as("personal-agent"), payload: { scopeRef: companyId, partitionKey: companyId, query: "q" } })).statusCode).toBe(200);
      expect((await app.inject({ url: `/api/brain/entities?partitionKey=${companyId}`, headers: as("personal-agent") })).statusCode).toBe(200);
      expect((await app.inject({ method: "POST", url: "/api/brain/native/recall", headers: as("personal-agent"), payload: { partitionKey: companyId, arguments: { query: "q" } } })).statusCode).toBe(200);
      expect((await app.inject({ url: `/api/brain/native/tools?partitionKey=${companyId}`, headers: as("personal-agent") })).statusCode).toBe(200);
      expect(seen.map((call) => call.partitionKey)).toEqual(Array(seen.length).fill(personal));
      expect(seen.map((call) => call.op)).toEqual(["recall", "query", "list_pages", "native:recall", "native:catalog"]);
      // Sibling or child selectors are refused, never rewritten.
      const before = seen.length;
      for (const partitionKey of ["fixture-a/other", "fixture-a/personal/deeper", "fixture-b"]) {
        expect((await app.inject({ method: "POST", url: "/api/brain/recall", headers: as("personal-agent"), payload: { scopeRef: partitionKey, query: "q" } })).statusCode, partitionKey).toBe(403);
        expect((await app.inject({ method: "POST", url: "/api/brain/native/recall", headers: as("personal-agent"), payload: { partitionKey, arguments: {} } })).statusCode, partitionKey).toBe(403);
      }
      // The default agent cannot reach the personal partition's memory.
      expect((await app.inject({ method: "POST", url: "/api/brain/recall", headers: as("default-agent"), payload: { scopeRef: personal, query: "q" } })).statusCode).toBe(403);
      expect((await app.inject({ method: "POST", url: "/api/brain/native/recall", headers: as("default-agent"), payload: { partitionKey: personal, arguments: {} } })).statusCode).toBe(403);
      expect(seen.length).toBe(before);
      expect((await app.inject({ method: "POST", url: "/api/brain/recall", headers: as("default-agent"), payload: { scopeRef: companyId, query: "q" } })).statusCode).toBe(200);
      expect(seen.at(-1)).toEqual({ op: "recall", partitionKey: companyId });
    } finally { await app.close(); }
  });

  it("lists default plus storage and KNOWLEDGE_PARTITIONS keys for the owner selector only", async () => {
    const app = await buildKnowledgeApp({ environment: "test", portalPrincipals: agents(), config: { gbrainAutoStart: false, partitionAuthorizationRequired: false, knowledgePartitions: ["ops"] } });
    try {
      expect((await app.inject({ url: `/api/companies/${companyId}/knowledge/partitions` })).json()).toEqual({ companyId, defaultPartitionKey: companyId,
        partitions: [{ key: "ops", partitionKey: "fixture-a/ops" }] });
      await app.inject({ method: "POST", url: `/api/companies/${companyId}/knowledge/collections`, headers: as("personal-agent"), payload: { name: "Mine" } });
      await app.inject({ method: "POST", url: `/api/companies/${encodeURIComponent("fixture-a/team/deeper")}/knowledge/collections`, payload: { name: "Too deep" } });
      await app.inject({ method: "POST", url: `/api/companies/${encodeURIComponent("fixture-b/elsewhere")}/knowledge/collections`, payload: { name: "Foreign" } });
      expect((await app.inject({ url: `/api/companies/${companyId}/knowledge/partitions` })).json().partitions).toEqual([
        { key: "ops", partitionKey: "fixture-a/ops" }, { key: "personal", partitionKey: personal }]);
      expect((await app.inject({ url: `/api/companies/${companyId}/knowledge/partitions`, headers: as("default-agent") })).statusCode).toBe(403);
    } finally { await app.close(); }
  });
});

describe("Research scoping for a partitioned attachment", () => {
  it("mints partition-bound bearers and never maps another partition's notebook", async () => {
    const authority = createAttachmentResearchAuthority({ companyId, fallback: null });
    const grant = { agentId: "agent-1", orgId: "org-1", capabilities: ["knowledge:research:read"], expiresAt: Date.now() + 60_000 };
    const app = Fastify();
    registerOpenNotebookRoutes(app, {
      adapter: null,
      principals: { configured: false, resolve: () => null },
      researchPrincipalProvider: authority.provider,
      bindings: [
        { knowledgeNotebookId: "nb-default", companyId, externalNotebookId: "upstream-default" },
        { knowledgeNotebookId: "nb-personal", companyId: personal, externalNotebookId: "upstream-personal" },
      ],
      resolveNotebookCompany: (id) => ({ "nb-default": companyId, "nb-personal": personal } as Record<string, string>)[id] ?? null,
      resolveNotebookSummary: (id) => ({ id, name: id, description: "" }),
    });
    try {
      const discover = async (token: string) => (await app.inject({ url: "/api/research/engine/notebooks", headers: { authorization: `Bearer ${token}` } })).json().notebooks.map((n: { id: string }) => n.id);
      const personalToken = authority.issue({ ...grant, partitionKey: "personal" })!;
      const defaultToken = authority.issue(grant)!;
      expect(await authority.provider({ headers: { authorization: `Bearer ${personalToken}` } } as never, "research:read"))
        .toMatchObject({ companyId: personal, boundPartition: { alias: companyId, partitionKey: personal } });
      expect(await discover(personalToken)).toEqual(["nb-personal"]);
      expect(await discover(defaultToken)).toEqual(["nb-default"]);
      const read = (token: string, id: string) => app.inject({ url: `/api/research/notebooks/${id}/engine`, headers: { authorization: `Bearer ${token}` } });
      expect((await read(personalToken, "nb-default")).json()).toEqual({ error: "notebook_scope_denied" });
      expect((await read(defaultToken, "nb-personal")).json()).toEqual({ error: "notebook_scope_denied" });
      // An invalid key mints nothing rather than a default-partition bearer.
      for (const partitionKey of ["default", "a/b", "Personal", "../x"]) expect(authority.issue({ ...grant, partitionKey }), partitionKey).toBeNull();
    } finally { await app.close(); }
  });
});

describe("existing rows after the upgrade", () => {
  it("belong to the workspace default partition without any rewrite", async () => {
    const dataDir = mkdtempSync(path.join(os.tmpdir(), "knowledge-edge-partition-migration-"));
    dirs.push(dataDir);
    const knowledgeDatabasePath = path.join(dataDir, "knowledge.sqlite");
    // A pre-partition (0.4.1) database: rows keyed only by companyId.
    const seeding = new SqliteKnowledgePersistence(knowledgeDatabasePath);
    const legacy = new KnowledgeStore(seeding);
    const collection = legacy.createKnowledgeCollection(companyId, { name: "Legacy" });
    const document = legacy.createKnowledgeDocument(collection.id, { title: "Legacy doc", body: "legacy body" })!;
    const before = seeding.load() as KnowledgeStoreSnapshot;
    seeding.close();
    expect(JSON.stringify(before)).not.toContain("partition");

    const app = await buildKnowledgeApp({ environment: "test", portalPrincipals: resolverFor({ "default-agent": principalFor(), "personal-agent": principalFor({ partitionKey: "personal" }) }),
      config: { gbrainAutoStart: false, partitionAuthorizationRequired: false, dataDir, knowledgeDatabasePath } });
    try {
      const as = (token: string) => ({ authorization: `Bearer ${token}` });
      expect((await app.inject({ url: `/api/knowledge/documents/${document.id}`, headers: as("default-agent") })).statusCode).toBe(200);
      expect((await app.inject({ url: `/api/knowledge/documents/${document.id}`, headers: as("personal-agent") })).statusCode).toBe(403);
      expect((await app.inject({ url: `/api/companies/${companyId}/knowledge/collections`, headers: as("default-agent") })).json().map((c: { id: string }) => c.id)).toContain(collection.id);
      expect((await app.inject({ url: `/api/companies/${companyId}/knowledge/partitions` })).json().partitions).toEqual([]);
    } finally { await app.close(); }
    const after = new SqliteKnowledgePersistence(knowledgeDatabasePath);
    try {
      const reloaded = after.load()!;
      // Forward-only and lossless: the legacy rows are byte-identical after an upgrade boot.
      expect(reloaded.collections.find((c) => c.id === collection.id)).toEqual(before.collections.find((c) => c.id === collection.id));
      expect(reloaded.documents).toEqual(before.documents);
    } finally { after.close(); }
  });
});

describe("security review follow-ups", () => {
  const as = (token: string) => ({ authorization: `Bearer ${token}` });

  it("advertises the edge-partition contract on /healthz, /api/status and /bootstrap.json (Portal rollout gate)", async () => {
    const app = await buildKnowledgeApp({ environment: "test", config: { gbrainAutoStart: false } });
    try {
      for (const url of ["/healthz", "/api/status", "/bootstrap.json"]) {
        const body = (await app.inject({ url })).json();
        expect(body.partitionContract, url).toBe(1);
        expect(body.capabilities.edgePartitions, url).toBe(true);
      }
      expect((await app.inject({ url: "/healthz" })).json()).toEqual({ ok: true, service: "knowledge", capabilities: { edgePartitions: true }, partitionContract: 1 });
    } finally { await app.close(); }
  });

  it("refuses to start when a static descendants grant reaches the edge workspace's partitions", async () => {
    const principal = (partitionKey: string, breadth: "exact" | "descendants", maxDepth: number | null) =>
      ({ token: "fleet-token-for-tests", principalId: "fleet", companyId: "org", capabilities: ["knowledge:read"], partitionGrants: [{ partitionKey, breadth, maxDepth }] });
    expect(grantReachesEdgePartitions({ partitionKey: "org/ws", breadth: "descendants", maxDepth: 1 }, "org/ws")).toBe(true);
    expect(grantReachesEdgePartitions({ partitionKey: "Org", breadth: "descendants", maxDepth: null }, "org/ws")).toBe(true);
    expect(grantReachesEdgePartitions({ partitionKey: "org", breadth: "descendants", maxDepth: 2 }, "org/ws")).toBe(true);
    expect(grantReachesEdgePartitions({ partitionKey: "org", breadth: "descendants", maxDepth: 1 }, "org/ws")).toBe(false);
    expect(grantReachesEdgePartitions({ partitionKey: "org/ws", breadth: "exact", maxDepth: 0 }, "org/ws")).toBe(false);
    expect(grantReachesEdgePartitions({ partitionKey: "org/other", breadth: "descendants", maxDepth: null }, "org/ws")).toBe(false);
    vi.stubEnv("KNOWLEDGE_COMPANY_ID", "org/ws");
    await expect(buildKnowledgeApp({ environment: "test", config: { gbrainAutoStart: false, knowledgeServicePrincipals: [principal("org", "descendants", null)] } }))
      .rejects.toThrow(/principal fleet holds a descendants grant on org .*share the workspace\/key namespace/u);
    for (const allowed of [principal("org/ws", "exact", 0), principal("org", "descendants", 1), principal("org/other", "descendants", null)]) {
      const app = await buildKnowledgeApp({ environment: "test", config: { gbrainAutoStart: false, knowledgeServicePrincipals: [allowed] } });
      await app.close();
    }
  });

  it("lists only edge-key partitions for the owner, not Fleet or deeper sub-partitions", async () => {
    const fleet = { token: "fleet-token-for-tests", principalId: "fleet", companyId, capabilities: ["knowledge:read"],
      partitionGrants: [{ partitionKey: "fixture-a/fleet-project", breadth: "exact" as const, maxDepth: 0 }] };
    const app = await buildKnowledgeApp({ environment: "test", config: { gbrainAutoStart: false, knowledgeServicePrincipals: [fleet] } });
    try {
      for (const scope of ["fixture-a/personal", "fixture-a/fleet-project", "fixture-a/personal/deeper", "fixture-a/Bad_Key"]) {
        await app.inject({ method: "POST", url: `/api/companies/${encodeURIComponent(scope)}/knowledge/collections`, payload: { name: scope } });
      }
      expect((await app.inject({ url: `/api/companies/${companyId}/knowledge/partitions` })).json().partitions).toEqual([{ key: "personal", partitionKey: personal }]);
    } finally { await app.close(); }
  });

  it("caches a runtime principal for at most 5 seconds, so a partition edit lands within that bound", async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "knowledge-edge-partition-cache-"));
    dirs.push(dir);
    const signer = new KnowledgeInstanceClaim(dir);
    let now = 1_000_000, partitionKey: string | undefined = "personal", calls = 0;
    const fetcher = (async () => {
      calls++;
      return Response.json({ ...answer({ instanceId: signer.instanceId, expiresAt: now + 60_000 }), ...(partitionKey ? { partitionKey } : {}) });
    }) as unknown as typeof fetch;
    const resolver = createPortalPrincipalResolver({ portal: "https://portal.fixture.invalid", companyId, portalOrgId: "org-1", signer, fetch: fetcher, now: () => now });
    const token = `tbkg_${"p".repeat(43)}`;
    expect((await resolver.resolve(token))?.companyId).toBe(personal);
    partitionKey = "other";
    now += 4_999;
    expect((await resolver.resolve(token))?.companyId).toBe(personal);
    expect(calls).toBe(1);
    now += 2;
    expect((await resolver.resolve(token))?.companyId).toBe("fixture-a/other");
    expect(calls).toBe(2);
  });

  it("canonicalises owner workspace/key scopes so owner and agent rows agree", async () => {
    const app = await buildKnowledgeApp({ environment: "test", portalPrincipals: resolverFor({ "personal-agent": principalFor({ partitionKey: "personal" }) }),
      config: { gbrainAutoStart: false } });
    try {
      const owned = await app.inject({ method: "POST", url: `/api/companies/${encodeURIComponent("Fixture-A/Personal")}/knowledge/collections`, payload: { name: "Owner" } });
      expect(owned.json().companyId).toBe(personal);
      const agent = (await app.inject({ method: "POST", url: `/api/companies/${companyId}/knowledge/collections`, headers: as("personal-agent"), payload: { name: "Agent" } })).json();
      const ownerView = (await app.inject({ url: `/api/companies/${encodeURIComponent("FIXTURE-A/personal")}/knowledge/collections` })).json().map((c: { id: string }) => c.id);
      expect(ownerView).toEqual(expect.arrayContaining([owned.json().id, agent.id]));
      expect((await app.inject({ url: `/api/companies/${companyId}/knowledge/collections`, headers: as("personal-agent") })).json().map((c: { id: string }) => c.id))
        .toEqual(expect.arrayContaining([owned.json().id, agent.id]));
      // Top-level company ids are untouched (byte-identical default behaviour).
      expect((await app.inject({ method: "POST", url: "/api/companies/Fixture-A/knowledge/collections", payload: { name: "Top" } })).json().companyId).toBe("Fixture-A");
    } finally { await app.close(); }
  });
});
