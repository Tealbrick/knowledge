import { createHash, createPublicKey, verify } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { buildKnowledgeApp } from "./app.js";
import { KnowledgeInstanceClaim } from "./instance-claim.js";
import { createKnowledgePrincipalResolver } from "./knowledge-principal.js";
import { createPortalPrincipalResolver, portalPrincipalConfig, portalPrincipalFromResponse, PORTAL_INTROSPECT_PATH } from "./portal-principal.js";

const portal = "https://portal.fixture.invalid";
const companyId = "fixture-a";
const grant = `tbkg_${"g".repeat(43)}`;
const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

function claim() {
  const dir = mkdtempSync(path.join(os.tmpdir(), "knowledge-portal-principal-"));
  dirs.push(dir);
  return new KnowledgeInstanceClaim(dir);
}

const allCapabilities = ["knowledge:create", "knowledge:read", "brain:read", "knowledge:update", "knowledge:delete"];
function answer(instanceId: string, capabilities = allCapabilities, overrides: Record<string, unknown> = {}) {
  return { authorized: true, principalId: "tealbrick-agent:a-henry", agentId: "a-henry", orgId: "org-1", workspaceId: companyId, instanceId, companyId,
    actions: ["create", "read", "update", "delete"], capabilities, partitionGrants: [{ partitionKey: companyId, breadth: "exact", maxDepth: 0, capabilities }],
    capabilityRevision: 3, expiresAt: Date.now() + 60_000, ...overrides };
}

function portalFixture(instance: KnowledgeInstanceClaim, respond: () => { status: number; body: unknown } | Error) {
  const calls: Array<{ url: string; body: Record<string, string> }> = [];
  const fetcher = (async (url: string | URL, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body));
    calls.push({ url: String(url), body });
    const result = respond();
    if (result instanceof Error) throw result;
    return new Response(JSON.stringify(result.body), { status: result.status, headers: { "content-type": "application/json" } });
  }) as typeof fetch;
  const resolver = createPortalPrincipalResolver({ portal, companyId, portalOrgId: "org-1", signer: instance, fetch: fetcher });
  return { calls, resolver };
}

describe("Portal-validated runtime principals", () => {
  it("forwards only Portal-shaped grants, signed by the instance claim key, and caches the live answer", async () => {
    const instance = claim();
    const f = portalFixture(instance, () => ({ status: 200, body: answer(instance.instanceId) }));
    expect(await f.resolver.resolve("fixture-static-token")).toBeNull();
    expect(await f.resolver.resolve(null)).toBeNull();
    expect(f.calls).toHaveLength(0);
    const principal = await f.resolver.resolve(grant);
    expect(principal).toMatchObject({ kind: "service", principalId: "tealbrick-agent:a-henry", companyId, capabilities: allCapabilities });
    expect(principal?.partitionGrants).toEqual([{ partitionKey: companyId, breadth: "exact", maxDepth: 0, capabilities: allCapabilities }]);
    await f.resolver.resolve(grant);
    expect(f.calls).toHaveLength(1);
    const call = f.calls[0]!;
    expect(call.url).toBe(`${portal}${PORTAL_INTROSPECT_PATH}`);
    expect(Object.keys(call.body).sort()).toEqual(["companyId", "instanceId", "proof", "token"]);
    const [head, payload, signature] = call.body.proof!.split(".");
    expect(verify(null, Buffer.from(`${head}.${payload}`), createPublicKey({ key: instance.publicJwk, format: "jwk" }), Buffer.from(signature!, "base64url"))).toBe(true);
    const claims = JSON.parse(Buffer.from(payload!, "base64url").toString("utf8"));
    expect(claims).toMatchObject({ typ: "tealbrick-principal-introspection", version: 1, aud: portal, instanceId: instance.instanceId, companyId,
      tokenDigest: createHash("sha256").update(grant).digest("hex") });
    expect(claims.exp - claims.iat).toBe(60);
  });

  it("deduplicates concurrent lookups and fails closed without caching an outage", async () => {
    const instance = claim();
    let mode: "down" | "up" = "down";
    const f = portalFixture(instance, () => mode === "down" ? new Error("unreachable") : { status: 200, body: answer(instance.instanceId) });
    expect(await f.resolver.resolve(grant)).toBeNull();
    mode = "up";
    const [a, b] = await Promise.all([f.resolver.resolve(grant), f.resolver.resolve(grant)]);
    expect(a).not.toBeNull();
    expect(a).toBe(b);
    expect(f.calls).toHaveLength(2);
  });

  it("does not cache Portal errors or rate limits as denials", async () => {
    for (const status of [429, 500, 503]) {
      const instance = claim();
      const f = portalFixture(instance, () => ({ status, body: { error: "unavailable" } }));
      expect(await f.resolver.resolve(grant)).toBeNull();
      expect(await f.resolver.resolve(grant)).toBeNull();
      expect(f.calls).toHaveLength(2);
    }
  });

  it("bounds concurrent introspections and keeps denials from evicting live principals", async () => {
    const instance = claim();
    let release: () => void = () => undefined;
    const gate = new Promise<void>(resolve => { release = resolve; });
    let calls = 0;
    const slow = (async (_url: string | URL, init?: RequestInit) => {
      calls++;
      const body = JSON.parse(String(init?.body));
      if (body.token === grant) { await gate; return new Response(JSON.stringify(answer(instance.instanceId)), { status: 200 }); }
      return new Response("{}", { status: 403 });
    }) as typeof fetch;
    const capped = createPortalPrincipalResolver({ portal, companyId, portalOrgId: "org-1", signer: instance, fetch: slow, maxInflight: 1, maxEntries: 2 });
    const pending = capped.resolve(grant);
    expect(await capped.resolve(`tbkg_${"z".repeat(43)}`)).toBeNull();
    expect(calls).toBe(1);
    release();
    expect(await pending).not.toBeNull();
    for (const letter of "abcdef") expect(await capped.resolve(`tbkg_${letter.repeat(43)}`)).toBeNull();
    const before = calls;
    expect(await capped.resolve(grant)).not.toBeNull();
    expect(calls).toBe(before);
  });

  it("reserves the tealbrick-agent: identity for Portal principals", () => {
    expect(createKnowledgePrincipalResolver([{ token: "static-token-fixture-only-000000000", principalId: "tealbrick-agent:a-henry", companyId, capabilities: ["knowledge:read"] }]).configured).toBe(false);
  });

  it("negative-caches Portal denials briefly", async () => {
    const instance = claim();
    const f = portalFixture(instance, () => ({ status: 403, body: { error: "knowledge_principal_denied" } }));
    expect(await f.resolver.resolve(grant)).toBeNull();
    expect(await f.resolver.resolve(grant)).toBeNull();
    expect(f.calls).toHaveLength(1);
  });

  it.each([
    ["another instance", { instanceId: "other-instance" }],
    ["another company", { companyId: "fixture-b" }],
    ["another organization", { orgId: "org-2" }],
    ["an expired answer", { expiresAt: Date.now() - 1 }],
    ["an unknown field", { token: grant }],
    ["a non-agent principal", { principalId: "operator" }],
    ["research authority", { capabilities: ["knowledge:read", "research:write"] }],
    ["brain write authority", { capabilities: ["brain:write"] }],
    ["descendant breadth", { partitionGrants: [{ partitionKey: companyId, breadth: "descendants", maxDepth: null, capabilities: ["knowledge:read"] }] }],
    ["a foreign partition", { partitionGrants: [{ partitionKey: "fixture-b", breadth: "exact", maxDepth: 0, capabilities: ["knowledge:read"] }] }],
    ["a grant wider than the principal", { capabilities: ["knowledge:read"], partitionGrants: [{ partitionKey: companyId, breadth: "exact", maxDepth: 0, capabilities: ["knowledge:read", "knowledge:delete"] }] }],
    ["two grants", { partitionGrants: [{ partitionKey: companyId, breadth: "exact", maxDepth: 0, capabilities: ["knowledge:read"] }, { partitionKey: "fixture-b", breadth: "exact", maxDepth: 0, capabilities: ["knowledge:read"] }] }],
    ["not authorized", { authorized: false }],
  ])("rejects %s", (_name, overrides) => {
    const expected = { instanceId: "instance-1", companyId, portalOrgId: "org-1" };
    expect(portalPrincipalFromResponse(answer("instance-1", ["knowledge:read"], overrides), expected, Date.now())).toBeNull();
  });

  it("is enabled for Portal-provisioned instances and can be switched off", () => {
    const env = { TEALBRICK_PORTAL_URL: portal, KNOWLEDGE_COMPANY_ID: companyId, KNOWLEDGE_PORTAL_ORG_ID: "org-1" };
    expect(portalPrincipalConfig(env)).toEqual({ portal, companyId, portalOrgId: "org-1" });
    expect(portalPrincipalConfig({ ...env, KNOWLEDGE_PORTAL_PRINCIPALS: "off" })).toBeNull();
    expect(portalPrincipalConfig({})).toBeNull();
    expect(() => portalPrincipalConfig({ KNOWLEDGE_PORTAL_PRINCIPALS: "on" })).toThrow();
    expect(() => portalPrincipalConfig({ ...env, KNOWLEDGE_PORTAL_PRINCIPALS: "maybe" })).toThrow();
    expect(() => createPortalPrincipalResolver({ portal: "http://portal.example.com", companyId, portalOrgId: "org-1", signer: claim() })).toThrow();
  });
});

const admin = { token: "fixture-admin", principalId: "operator", companyId, capabilities: ["knowledge:write", "knowledge:read"],
  partitionGrants: [{ partitionKey: companyId, breadth: "exact" as const, maxDepth: 0 }] };
const headers = { authorization: "Bearer fixture-admin" };

describe("Program enforces the live Portal grant like any service principal", () => {
  it.each([
    [["knowledge:read", "brain:read"], { create: 403, read: 200, update: 403, remove: 403 }],
    [["knowledge:create", "knowledge:read", "brain:read"], { create: 201, read: 200, update: 403, remove: 403 }],
    [allCapabilities, { create: 201, read: 200, update: 200, remove: 200 }],
  ])("capabilities %j", async (capabilities, expected) => {
    const instance = claim();
    let current = capabilities;
    const f = portalFixture(instance, () => ({ status: 200, body: answer(instance.instanceId, current) }));
    const app = await buildKnowledgeApp({ environment: "test", portalPrincipals: f.resolver,
      config: { gbrainAutoStart: false, partitionAuthorizationRequired: true, knowledgeServicePrincipals: [admin] } });
    try {
      const collection = (await app.inject({ method: "POST", url: `/api/companies/${companyId}/knowledge/collections`, headers, payload: { name: "Fixture" } })).json();
      const seed = (await app.inject({ method: "POST", url: `/api/knowledge/collections/${collection.id}/documents`, headers, payload: { title: "Seed", body: "seed-body" } })).json();
      const agent = { authorization: `Bearer ${grant}` };
      const create = await app.inject({ method: "POST", url: `/api/knowledge/collections/${collection.id}/documents`, headers: agent, payload: { title: "Created" } });
      expect(create.statusCode).toBe(expected.create);
      if (expected.create === 201) expect(create.json().createdByAgentId).toBe("tealbrick-agent:a-henry");
      expect((await app.inject({ method: "GET", url: `/api/knowledge/documents/${seed.id}`, headers: agent })).statusCode).toBe(expected.read);
      expect((await app.inject({ method: "PATCH", url: `/api/knowledge/documents/${seed.id}`, headers: agent, payload: { title: "Changed" } })).statusCode).toBe(expected.update);
      expect((await app.inject({ method: "DELETE", url: `/api/knowledge/documents/${seed.id}`, headers: agent })).statusCode).toBe(expected.remove);
      // Unknown bearers are not Portal grants and never reach Portal.
      const before = f.calls.length;
      expect((await app.inject({ method: "GET", url: `/api/knowledge/documents/${seed.id}`, headers: { authorization: "Bearer junk" } })).statusCode).toBe(401);
      expect(f.calls.length).toBe(before);
      current = capabilities;
    } finally { await app.close(); }
  });

  it("does not let a Portal grant reach another partition", async () => {
    const instance = claim();
    const f = portalFixture(instance, () => ({ status: 200, body: answer(instance.instanceId) }));
    const wide = { ...admin, partitionGrants: [companyId, "fixture-b"].map(partitionKey => ({ partitionKey, breadth: "exact" as const, maxDepth: 0 })) };
    const app = await buildKnowledgeApp({ environment: "test", portalPrincipals: f.resolver,
      config: { gbrainAutoStart: false, partitionAuthorizationRequired: true, knowledgeServicePrincipals: [wide] } });
    try {
      const foreign = (await app.inject({ method: "POST", url: "/api/companies/fixture-b/knowledge/collections", headers, payload: { name: "Foreign" } })).json();
      const agent = { authorization: `Bearer ${grant}` };
      expect((await app.inject({ method: "GET", url: "/api/companies/fixture-b/knowledge/collections", headers: agent })).statusCode).toBe(403);
      expect((await app.inject({ method: "POST", url: `/api/knowledge/collections/${foreign.id}/documents`, headers: agent, payload: { title: "x" } })).statusCode).toBe(404);
    } finally { await app.close(); }
  });
});
