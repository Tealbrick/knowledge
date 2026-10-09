import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { createAppGrantAuthority } from "./app-grants.js";
import { createContractAudit } from "./audit.js";
import { loadKnowledgeManifest } from "./manifest.js";
import { KIT_READ_PARTITIONS } from "./read-partitions.js";
import { PORTAL, fakePortalFetch, grantToken, type FakeGrant } from "./test-support.js";

const manifest = loadKnowledgeManifest();
const bearer = (letter: string) => ({ authorization: `Bearer ${grantToken(letter)}` });
const ALL = ["create", "read", "update", "delete"] as const;

function setup(grants: Record<string, FakeGrant>) {
  const directory = mkdtempSync(path.join(tmpdir(), "knowledge-grants-"));
  cleanup.push(directory);
  const audit = createContractAudit(path.join(directory, "audit.sqlite"));
  const portal = fakePortalFetch(manifest, grants);
  const authority = createAppGrantAuthority({ manifest, portal: { ...PORTAL }, fetch: portal.fetchImpl, audit });
  return { authority, portal, audit, directory };
}
const cleanup: string[] = [];
afterEach(() => { for (const directory of cleanup.splice(0)) rmSync(directory, { recursive: true, force: true }); });

const list = (letter: string) => ({ method: "GET", url: "/api/companies/ws-1/knowledge/collections", headers: bearer(letter) });

describe("Portal app grants (tbag_) on Knowledge", () => {
  it("recognises only a tbag_ bearer", () => {
    const { authority } = setup({});
    expect(authority.presented(bearer("a"))).toBe(true);
    expect(authority.presented({ authorization: "Bearer tbkg_" + "a".repeat(43) })).toBe(false);
    expect(authority.presented({ authorization: "Bearer something" })).toBe(false);
    expect(authority.presented({})).toBe(false);
  });

  it("admits a covered operation on the default partition and binds the agent", async () => {
    const { authority, portal } = setup({ [grantToken("a")]: { actions: ALL, agentId: "agent-a" } });
    const result = await authority.admit(list("a"));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.admitted).toMatchObject({ operation: "knowledge.collections.list", agentId: "agent-a", orgId: "org-1", partitionKey: null });
    // The kit sends exactly the Core wire: deployment, product, token and the instance proof.
    expect(portal.calls[0]!.url).toBe("https://portal.fixture.invalid/api/runtime/app-grant/introspect");
    expect(portal.calls[0]!.headers.get("x-tealbrick-instance-proof")).toBe(PORTAL.instanceProof);
  });

  it("binds a per-edge partition claim (from GrantResult.partitionKey) and validates it like an attachment", async () => {
    const { authority } = setup({
      [grantToken("p")]: { actions: ALL, extra: { partitionKey: "personal" } },
      [grantToken("u")]: { actions: ALL, extra: { partitionKey: "Personal" } },
      [grantToken("d")]: { actions: ALL, extra: { partitionKey: "default" } },
      [grantToken("t")]: { actions: ALL, extra: { partitionKey: "../x" } },
      [grantToken("s")]: { actions: ALL, extra: { partitionKey: "a/b" } },
    });
    const ok = await authority.admit(list("p"));
    expect(ok.ok && ok.admitted.partitionKey).toBe("personal");
    for (const letter of ["u", "d", "t", "s"]) {
      const denied = await authority.admit(list(letter));
      expect(denied, letter).toMatchObject({ ok: false, status: 403, error: "partition_claim_invalid" });
    }
  });

  it("tbag_ partition binding fails closed: a key binds, explicit null is the default scope, an absent key is refused", async () => {
    const { authority } = setup({
      [grantToken("k")]: { actions: ALL, extra: { partitionKey: "personal" } },
      [grantToken("n")]: { actions: ALL, extra: { partitionKey: null } },
      [grantToken("a")]: { actions: ALL, omitPartitionKey: true },
    });
    const keyed = await authority.admit(list("k"));
    expect(keyed.ok && keyed.admitted.partitionKey).toBe("personal");
    const explicitNull = await authority.admit(list("n"));
    expect(explicitNull.ok && explicitNull.admitted.partitionKey).toBe(null);
    // Absent: refused with its own code, never the default scope; recheck at dispatch refuses it too.
    expect(await authority.admit(list("a"))).toMatchObject({ ok: false, status: 403, error: "partition_binding_required" });
    if (!keyed.ok) throw new Error("expected the keyed grant to be admitted");
    expect(await authority.recheck({ headers: bearer("a") }, keyed.admitted)).toBeNull();
  });

  it("refuses an operation the grant's actions do not cover, and an owner operation even when Portal lists it", async () => {
    const owner = manifest.operations.filter((op) => op.audience === "owner").map((op) => op.id);
    const { authority } = setup({
      [grantToken("r")]: { actions: ["read"] },
      [grantToken("o")]: { actions: ALL, operations: [...owner, "knowledge.collections.list"] },
    });
    const create = { method: "POST", url: "/api/companies/ws-1/knowledge/collections", headers: bearer("r") };
    expect(await authority.admit(create)).toMatchObject({ ok: false, status: 403, error: "operation_not_granted" });
    const ownerOnly = { method: "PUT", url: "/api/knowledge/documents/doc-1/access", headers: bearer("o") };
    expect(await authority.admit(ownerOnly)).toMatchObject({ ok: false, status: 403, error: "operation_owner_only" });
    const owned = { method: "PUT", url: "/api/settings/models", headers: bearer("o") };
    expect(await authority.admit(owned)).toMatchObject({ ok: false, status: 403, error: "operation_owner_only" });
  });

  it("never contacts Portal for a route the manifest does not declare", async () => {
    const { authority, portal } = setup({ [grantToken("a")]: { actions: ALL } });
    for (const [method, url] of [["GET", "/api/status"], ["POST", "/api/bindings"], ["GET", "/api/knowledge/partitions"], ["DELETE", "/api/brain/entities"]] as const) {
      expect(await authority.admit({ method, url, headers: bearer("a") }), url).toMatchObject({ ok: false, status: 403, error: "operation_unknown" });
    }
    expect(portal.calls).toHaveLength(0);
  });

  it("denies a missing, unknown or revoked grant and fails closed when Portal is down", async () => {
    const { authority } = setup({ [grantToken("a")]: { actions: ALL } });
    expect(await authority.admit({ method: "GET", url: "/api/companies/ws-1/knowledge/collections", headers: {} })).toMatchObject({ ok: false, status: 401, error: "grant_required" });
    expect(await authority.admit(list("z"))).toMatchObject({ ok: false, status: 401, error: "grant_denied" });
    const down = createAppGrantAuthority({ manifest, portal: { ...PORTAL }, fetch: (async () => { throw new Error("offline"); }) as unknown as typeof fetch });
    expect(await down.admit(list("a"))).toMatchObject({ ok: false, status: 503, error: "grant_verification_unavailable" });
    const unconfigured = createAppGrantAuthority({ manifest, portal: null });
    expect(unconfigured.configured).toBe(false);
    expect(await unconfigured.admit(list("a"))).toMatchObject({ ok: false, status: 503, error: "portal_unconfigured" });
  });

  it("refuses an answer for another tenant or organisation", async () => {
    const { authority } = setup({
      [grantToken("t")]: { actions: ALL, overrides: { productTenantId: "other-workspace" } },
      [grantToken("o")]: { actions: ALL, overrides: { orgId: "other-org" } },
      [grantToken("w")]: { actions: ALL, overrides: { deploymentId: "dep-2" } },
    });
    for (const letter of ["t", "o", "w"]) expect((await authority.admit(list(letter))).ok, letter).toBe(false);
  });

  it("refuses an app (companion) principal: Knowledge has no companion operation", async () => {
    const { authority } = setup({
      [grantToken("c")]: { actions: ALL, overrides: { principalId: "tealbrick-app:inst-rules", principalKind: "app", callerProduct: "rules-approvals", agentId: undefined } },
    });
    expect(await authority.admit(list("c"))).toMatchObject({ ok: false, status: 403, error: "companion_not_declared" });
  });

  it("re-verifies live at dispatch: a revoked, re-scoped or other-agent grant no longer passes", async () => {
    const grants: Record<string, FakeGrant> = { [grantToken("a")]: { actions: ALL, agentId: "agent-a", extra: { partitionKey: "personal" } } };
    const { authority } = setup(grants);
    const admitted = await authority.admit(list("a"));
    if (!admitted.ok) throw new Error("expected admission");
    expect(await authority.recheck({ headers: bearer("a") }, admitted.admitted)).not.toBeNull();
    grants[grantToken("a")] = { actions: ALL, agentId: "agent-a", extra: { partitionKey: "work" } };
    expect(await authority.recheck({ headers: bearer("a") }, admitted.admitted), "partition edited mid-request").toBeNull();
    grants[grantToken("a")] = { actions: ALL, agentId: "agent-b", extra: { partitionKey: "personal" } };
    expect(await authority.recheck({ headers: bearer("a") }, admitted.admitted), "another agent").toBeNull();
    grants[grantToken("a")] = { actions: ["update"], agentId: "agent-a", extra: { partitionKey: "personal" } };
    expect(await authority.recheck({ headers: bearer("a") }, admitted.admitted), "narrowed").toBeNull();
    delete grants[grantToken("a")];
    expect(await authority.recheck({ headers: bearer("a") }, admitted.admitted), "revoked").toBeNull();
  });

  it("reports whether the same grant also covers another operation (native discovery)", async () => {
    const { authority } = setup({ [grantToken("a")]: { actions: ALL }, [grantToken("r")]: { actions: ["read"] } });
    const tools = { method: "GET", url: "/api/brain/native/tools" };
    const full = await authority.admit({ ...tools, headers: bearer("a") });
    const readOnly = await authority.admit({ ...tools, headers: bearer("r") });
    if (!full.ok || !readOnly.ok) throw new Error("expected admission");
    expect(authority.covers(full.admitted, "knowledge.engine.write")).toBe(true);
    expect(authority.covers(readOnly.admitted, "knowledge.engine.write")).toBe(false);
  });

  it("records metadata-only audit rows: operation, actor, partition, outcome, no token or path", async () => {
    const { authority, audit, directory } = setup({ [grantToken("a")]: { actions: ["read"], agentId: "agent-a", extra: { partitionKey: "personal" } } });
    await authority.admit(list("a"));
    await authority.admit({ method: "POST", url: "/api/companies/ws-1/knowledge/collections", headers: bearer("a") });
    audit.close();
    const { DatabaseSync } = await import("node:sqlite");
    const db = new DatabaseSync(path.join(directory, "audit.sqlite"));
    const rows = db.prepare("SELECT kind, operation, actor, partition_key, outcome, code FROM contract_audit ORDER BY rowid").all() as Record<string, unknown>[];
    db.close();
    expect(rows).toEqual([
      { kind: "grant", operation: "knowledge.collections.list", actor: "agent-a", partition_key: "personal", outcome: "admitted", code: null },
      { kind: "grant", operation: "knowledge.collections.create", actor: "tealbrick-agent:agent-a", partition_key: null, outcome: "denied", code: "operation_not_granted" },
    ]);
    expect(JSON.stringify(rows)).not.toContain("tbag_");
  });

  it(`contract 2: binds the read set (kit ${KIT_READ_PARTITIONS ? "0.1.0-alpha.5+" : "0.1.0-alpha.4 with the local mirror"}); [write] alone is contract 1`, async () => {
    const { authority } = setup({
      [grantToken("r")]: { actions: ALL, agentId: "agent-r", extra: { partitionKey: "alpha", readPartitionKeys: ["alpha", "beta", null] } },
      [grantToken("w")]: { actions: ALL, agentId: "agent-w", extra: { partitionKey: "beta", readPartitionKeys: ["beta"] } },
      [grantToken("c")]: { actions: ALL, agentId: "agent-c", extra: { partitionKey: "beta" } },
      [grantToken("n")]: { actions: ALL, agentId: "agent-n", extra: { partitionKey: null, readPartitionKeys: [null, "beta"] } },
    });
    const wide = await authority.admit(list("r"));
    expect(wide.ok && wide.admitted).toMatchObject({ partitionKey: "alpha", readPartitionKeys: ["alpha", "beta", null] });
    const narrow = await authority.admit(list("w"));
    const contract1 = await authority.admit(list("c"));
    if (!narrow.ok || !contract1.ok) throw new Error("expected both grants to be admitted");
    expect("readPartitionKeys" in narrow.admitted).toBe(false);
    const shape = ({ grant: _grant, auditId: _auditId, expiresAt: _expiresAt, agentId: _agentId, ...rest }: typeof narrow.admitted) => rest;
    expect(shape(narrow.admitted)).toEqual(shape(contract1.admitted));
    const defaultWrite = await authority.admit(list("n"));
    expect(defaultWrite.ok && defaultWrite.admitted).toMatchObject({ partitionKey: null, readPartitionKeys: [null, "beta"] });
    // The live recheck keeps the same read set; a changed one is a changed edge.
    if (!wide.ok) throw new Error("expected the wide grant to be admitted");
    expect(await authority.recheck({ headers: bearer("r") }, wide.admitted)).not.toBeNull();
    expect(await authority.recheck({ headers: bearer("w") }, wide.admitted)).toBeNull();
  });

  it("contract 2: refuses a read set without the write key, with a bad key, duplicates or too many entries", async () => {
    const grants: Record<string, FakeGrant> = {
      [grantToken("m")]: { actions: ALL, extra: { partitionKey: "alpha", readPartitionKeys: ["beta"] } },
      [grantToken("u")]: { actions: ALL, extra: { partitionKey: "alpha", readPartitionKeys: ["alpha", "Beta"] } },
      [grantToken("d")]: { actions: ALL, extra: { partitionKey: "alpha", readPartitionKeys: ["alpha", "default"] } },
      [grantToken("x")]: { actions: ALL, extra: { partitionKey: "alpha", readPartitionKeys: ["alpha", "alpha"] } },
      [grantToken("e")]: { actions: ALL, extra: { partitionKey: "alpha", readPartitionKeys: [] } },
      [grantToken("t")]: { actions: ALL, extra: { partitionKey: "alpha", readPartitionKeys: ["alpha", ...Array.from({ length: 64 }, (_, i) => `k${i}`)] } },
      [grantToken("s")]: { actions: ALL, extra: { partitionKey: "alpha", readPartitionKeys: "alpha" } },
    };
    const { authority } = setup(grants);
    for (const letter of ["m", "u", "d", "x", "e", "t", "s"]) {
      const denied = await authority.admit(list(letter));
      expect(denied.ok, letter).toBe(false);
      expect(denied.ok ? 0 : denied.status, letter).toBeGreaterThanOrEqual(401);
    }
  });
});
