import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { crossValidateUnlocks, validateManifest, type Manifest } from "@tealbrick/contract";

import { buildKnowledgeApp } from "../app.js";
import { loadKnowledgeManifest } from "./manifest.js";

const read = (relative: string) => JSON.parse(readFileSync(new URL(relative, import.meta.url), "utf8"));
const manifest = loadKnowledgeManifest();

describe("tealbrick.app.json (tealbrick.miniapp/v1)", () => {
  it("validates with no errors and no warnings", () => {
    const result = validateManifest(read("../../../tealbrick.app.json"));
    expect(result).toMatchObject({ ok: true, errors: [], warnings: [] });
  });

  it("is one release with the program package and the legacy descriptor", () => {
    expect(manifest.app.version).toBe(read("../../package.json").version);
    expect(manifest.app.version).toBe(read("../../../manifest.json").version);
    expect(read("../../../manifest.json").contract).toMatchObject({ status: "legacy-descriptor", authoritative: "tealbrick.app.json" });
    expect(manifest).toMatchObject({ kind: "bridge", app: { id: "knowledge", major: 1 }, licence: { product: "knowledge", major: 1 } });
    expect(manifest.upstream).toEqual({ name: "GBrain", repo: "https://github.com/garrytan/gbrain", license: "MIT", pinnedVersion: expect.stringMatching(/^\d+\.\d+\.\d+\.\d+$/u) });
    // The pinned upstream is the vendored GBrain the notices and the sidecar carry.
    expect(manifest.upstream!.pinnedVersion).toBe(readFileSync(new URL("../../../sidecars/gbrain/VERSION", import.meta.url), "utf8").trim());
    expect(readFileSync(new URL("../../../THIRD_PARTY_NOTICES.md", import.meta.url), "utf8")).toContain(`GBrain, version ${manifest.upstream!.pinnedVersion}`);
  });

  it("declares the Portal registration surface and no secret, URL or tenant", () => {
    expect(manifest.runtime).toMatchObject({
      claim: "/.well-known/tealbrick/claim", tenantEnv: "TEALBRICK_TENANT_ID", instanceAuthEnv: "TEALBRICK_INSTANCE_TOKEN",
      principalsEnv: "TEALBRICK_SERVICE_PRINCIPALS", health: "/healthz", port: 5310,
    });
    const allow = manifest.runtime.env!.allow!;
    for (const name of ["TEALBRICK_PORTAL_URL", "TEALBRICK_DEPLOYMENT_ID", "TEALBRICK_PORTAL_ORG_ID", "TEALBRICK_PORTAL_INSTANCE_PROOF", "TEALBRICK_EMERGENCY_CODE",
      "KNOWLEDGE_INSTANCE_TOKEN", "KNOWLEDGE_COMPANY_ID", "KNOWLEDGE_PORTAL_ORG_ID", "KNOWLEDGE_SERVICE_PRINCIPALS", "KNOWLEDGE_OPEN_NOTEBOOK_BASE_URL", "KNOWLEDGE_OPEN_NOTEBOOK_TOKEN"]) {
      expect(allow, name).toContain(name);
    }
    expect(JSON.stringify(manifest)).not.toMatch(/tb[a-z]{0,6}_[A-Za-z0-9_-]{20,}|BEGIN [A-Z ]+KEY|ws_[a-f0-9]{8}/u);
    // Open Notebook and SurrealDB stay outside the manifest until the contract can share one generated secret.
    expect(manifest.runtime.sidecars).toBeUndefined();
  });

  it("classifies every operation, owner operations stay owner-only and none is external", () => {
    const agents = manifest.operations.filter((op) => (op.audience ?? "agent") === "agent");
    const owners = manifest.operations.filter((op) => op.audience === "owner");
    expect({ total: manifest.operations.length, agents: agents.length, owners: owners.length }).toEqual({ total: 31, agents: 24, owners: 7 });
    expect(owners.map((op) => op.id).sort()).toEqual([
      "knowledge.collections.delete", "knowledge.documents.access-update", "knowledge.documents.delete", "knowledge.documents.update",
      "knowledge.models.update", "knowledge.research-notebooks.delete", "knowledge.research-sources.delete",
    ]);
    expect(owners.every((op) => op.crud.every((action) => action !== "create" && action !== "read"))).toBe(true);
    expect(manifest.operations.every((op) => op.effects !== "external-effects")).toBe(true);
    // Reads that use POST are declared read-only, so a read-only edge may use them.
    for (const id of ["knowledge.brain.context", "knowledge.brain.recall", "knowledge.engine.read"]) {
      expect(manifest.operations.find((op) => op.id === id), id).toMatchObject({ method: "POST", crud: ["read"], effects: "read-only" });
    }
    expect(manifest.operations.find((op) => op.id === "knowledge.engine.write")).toMatchObject({ crud: ["create", "update", "delete"], idempotency: "required" });
  });

  it("maps to routes the Program really serves (the engine write alias lives on the edge)", async () => {
    const app = await buildKnowledgeApp({ environment: "test", config: { gbrainAutoStart: false, gbrainBaseUrl: null, gbrainToken: null, rulesBaseUrl: null, rulesAuthToken: null, openNotebookBaseUrl: null, openNotebookToken: null, knowledgeServicePrincipals: [], openNotebookBindings: [] } });
    try {
      for (const op of manifest.operations) {
        if (op.id === "knowledge.engine.write") continue;
        const url = op.path.replace(/\{([^}]+)\}/gu, ":$1");
        expect(app.hasRoute({ method: op.method, url }), `${op.id} ${op.method} ${op.path}`).toBe(true);
      }
    } finally { await app.close(); }
  });

  it("declares Rules as a soft companion with one unlock that the Rules manifest satisfies", () => {
    expect(manifest.companions).toEqual([{ app: "rules-approvals", relation: "enhances" }]);
    expect(manifest.unlocks).toHaveLength(1);
    const rules = {
      schema: "tealbrick.miniapp/v1", kind: "suite", app: { id: "rules-approvals", major: 1 },
      operations: [{ id: "rules-approvals.gateway.evaluate", crud: ["create", "read"] }],
    } as unknown as Manifest;
    expect(crossValidateUnlocks(manifest, [rules])).toEqual([]);
    const tooLow = { ...rules, operations: [{ id: "rules-approvals.gateway.evaluate", crud: ["create", "read"], audience: "owner" }] } as unknown as Manifest;
    expect(crossValidateUnlocks(manifest, [tooLow]).length).toBeGreaterThan(0);
  });

  it("offers the settings the owner UI has, with labels, and no secret literal", () => {
    const fields = manifest.settings!.groups.flatMap((group) => group.fields);
    expect(fields.every((field) => typeof field.label === "string" && field.label.length > 0)).toBe(true);
    const keys = fields.map((field) => field.key);
    for (const key of ["chat.provider", "chat.baseUrl", "chat.model", "chat.apiKey", "chat.reasoningEffort", "embedding.provider", "embedding.dimensions", "embedding.apiKey", "reranker.model", "reranker.apiKey", "providers.openaiApiKey"]) {
      expect(keys, key).toContain(key);
    }
    expect(fields.filter((field) => field.type === "secret").every((field) => field.default === undefined)).toBe(true);
    expect(fields.find((field) => field.key === "providers.openaiApiKey")).toMatchObject({ destination: "provider-env", env: "OPENAI_API_KEY", source: "account" });
    expect(fields.find((field) => field.key === "chat.apiKey")).toMatchObject({ type: "secret" });
    expect(manifest.frontend).toMatchObject({ routes: { home: "/?view=library", settings: "/?view=settings" }, launch: "ticket-v1", embed: { allowed: false } });
  });
});
