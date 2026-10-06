import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

// @ts-expect-error - plain ESM edge module without type declarations
import { attachmentRoute } from "../../deploy/container/attachment-auth.mjs";
import { engineCoverage, hindsightSampleArguments } from "../scripts/engine-coverage.js";
import { startFakeGBrainService, startFakeHindsight } from "../scripts/fixtures/fake-engines.mjs";
import { buildKnowledgeApp } from "./app.js";
import { gbrainServiceExposure, hindsightExposure, hindsightMcpTools, hindsightOperationSpecs, portalCapabilityForScope, type EngineExposure } from "./engine-exposure.js";
import { hindsightBankForPartition } from "./hindsight-client.js";
import { knowledgePartitionSourceId } from "./partition-authority.js";

/**
 * Coverage/parity: every operation of each pinned upstream engine is either
 * reachable by an agent (edge route -> Portal capability -> Program
 * authorization -> MemoryEngine boundary -> upstream call in the authorized
 * partition) or explicitly excluded with a reason. The Portal attachment edge
 * itself is exercised end to end in deploy/container/native-memory-edge.test.mjs.
 */
const partition = "fixture-a";
const hindsightKey = "hindsight-tenant-key-fixture-only-000000";
const gbrainAdmin = "gbrain-admin-token-fixture-0123456789abcd";
const principals = [
  { token: "fixture-reader", principalId: "reader", companyId: partition, capabilities: ["brain:read"] },
  { token: "fixture-crud", principalId: "crud", companyId: partition, capabilities: ["brain:read", "knowledge:create", "knowledge:update", "knowledge:delete"] },
  // What the edge mints for a Portal attachment holding only knowledge:brain:write.
  { token: "fixture-native-writer", principalId: "native-writer", companyId: partition, capabilities: ["brain:native:write"] },
];

describe.each([
  ["gbrain", gbrainServiceExposure],
  ["hindsight", hindsightExposure],
] as const)("%s upstream surface is 100% accounted for", (_engine, exposure) => {
  it("exposes or excludes (with a reason) every upstream operation, nothing else", () => {
    const coverage = engineCoverage(exposure());
    expect(coverage.unaccounted).toEqual([]);
    expect(coverage.inconsistent).toEqual([]);
    expect(coverage.exposed + coverage.excluded).toBe(coverage.upstream);
    for (const reason of exposure().excluded.values()) expect(reason.length).toBeGreaterThan(20);
  });

  it("maps every exposed operation to one Portal capability at the edge and refuses excluded ones before Portal", () => {
    const e: EngineExposure = exposure();
    const nativeOperationPolicy = (name: string) => e.exposed.get(name) ?? null;
    expect(attachmentRoute("GET", "/api/brain/native/tools", "Fixture-A", { nativeOperationPolicy })).toMatchObject({ capability: "knowledge:brain:read", native: true });
    for (const op of e.exposed.values()) {
      expect(attachmentRoute("POST", `/api/brain/native/${op.name}`, "Fixture-A", { nativeOperationPolicy }), op.name)
        .toMatchObject({ capability: portalCapabilityForScope(op.scope), native: true, bodyKind: "native" });
      expect(attachmentRoute("GET", `/api/brain/native/${op.name}`, "Fixture-A", { nativeOperationPolicy })).toBeNull();
    }
    for (const name of e.excluded.keys()) expect(attachmentRoute("POST", `/api/brain/native/${name}`, "Fixture-A", { nativeOperationPolicy }), name).toBeNull();
  });
});

it("accounts for every Hindsight MCP tool through the HTTP operation it wraps", () => {
  const tools = hindsightMcpTools();
  expect(tools).toHaveLength(39);
  const e = hindsightExposure();
  for (const tool of tools) expect(e.exposed.has(tool.operationId) || e.excluded.has(tool.operationId), tool.name).toBe(true);
});

describe("agent path through the Program to a fake pinned upstream", () => {
  let dataDir: string;
  const fakes: Array<{ close: () => Promise<unknown> }> = [];
  beforeAll(() => { dataDir = mkdtempSync(path.join(os.tmpdir(), "engine-coverage-")); });
  afterAll(async () => { for (const fake of fakes) await fake.close(); rmSync(dataDir, { recursive: true, force: true }); });

  async function app(config: Record<string, unknown>) {
    return buildKnowledgeApp({ environment: "test", config: { dataDir, gbrainAutoStart: false, knowledgeServicePrincipals: principals, ...config } });
  }
  const call = (knowledge: Awaited<ReturnType<typeof app>>, token: string, op: string, args: Record<string, unknown>, write: boolean) => knowledge.inject({
    method: "POST", url: `/api/brain/native/${op}`,
    headers: { authorization: `Bearer ${token}`, ...(write ? { "idempotency-key": `${token}-${op}` } : {}) },
    payload: { partitionKey: partition, arguments: args },
  });

  it("reaches every exposed Hindsight operation in the partition's bank, with read/write authorization", async () => {
    const fake = await startFakeHindsight({ apiKey: hindsightKey });
    fakes.push(fake);
    const knowledge = await app({ memoryEngine: "hindsight", hindsightUrl: fake.baseUrl, hindsightApiKey: hindsightKey });
    const bank = hindsightBankForPartition(partition);
    const specs = hindsightOperationSpecs();
    try {
      const catalog = await knowledge.inject({ url: `/api/brain/native/tools?partitionKey=${partition}`, headers: { authorization: "Bearer fixture-crud" } });
      expect(catalog.json().data.tools.map((t: { name: string }) => t.name).sort()).toEqual([...hindsightExposure().exposed.keys()].sort());
      for (const op of hindsightExposure().exposed.values()) {
        const spec = specs.get(op.name)!;
        const args = hindsightSampleArguments(spec, partition);
        const write = op.scope === "write";
        if (write) {
          expect((await call(knowledge, "fixture-reader", op.name, args, true)).statusCode, `${op.name} reader`).toBe(403);
          const before = fake.calls.length;
          const viaAttachment = await call(knowledge, "fixture-native-writer", op.name, args, true);
          expect(viaAttachment.statusCode, `${op.name} ${viaAttachment.body}`).toBe(200);
          expect(fake.calls.length).toBe(before + 1);
        }
        const before = fake.calls.length;
        const response = await call(knowledge, write ? "fixture-crud" : "fixture-reader", op.name, args, write);
        expect(response.statusCode, `${op.name}: ${response.body}`).toBe(200);
        expect(response.json()).toMatchObject({ ok: true, engine: "hindsight", operation: op.name });
        expect(fake.calls.length, op.name).toBe(before + 1);
        const sent = fake.calls.at(-1)!;
        expect(sent.method, op.name).toBe(spec.method);
        if (spec.bankScoped) expect(sent.bank, op.name).toBe(bank);
        const expectedPath = spec.path.replace("{bank_id}", bank).replace(/\{([a-z_]+)\}/gu, (_m, name: string) => String(args[name]));
        expect(decodeURIComponent(sent.path), op.name).toBe(expectedPath);
      }
    } finally { await knowledge.close(); }
  });

  it("reaches every exposed GBrain service operation through a source-bound client", async () => {
    const fake = await startFakeGBrainService({ adminToken: gbrainAdmin, tools: [...gbrainServiceExposure().exposed.keys(), "sources_list", "whoami"] });
    fakes.push(fake);
    const knowledge = await app({ gbrainServiceUrl: fake.baseUrl, gbrainServiceAdminToken: gbrainAdmin });
    try {
      const catalog = await knowledge.inject({ url: `/api/brain/native/tools?partitionKey=${partition}`, headers: { authorization: "Bearer fixture-crud" } });
      const names = catalog.json().data.tools.map((t: { name: string }) => t.name);
      expect(names.sort()).toEqual([...gbrainServiceExposure().exposed.keys()].sort());
      expect(names).not.toContain("sources_list");
      for (const op of gbrainServiceExposure().exposed.values()) {
        const write = op.scope === "write";
        if (write) expect((await call(knowledge, "fixture-reader", op.name, {}, true)).statusCode, `${op.name} reader`).toBe(403);
        const response = await call(knowledge, write ? "fixture-native-writer" : "fixture-reader", op.name, {}, write);
        expect(response.statusCode, `${op.name}: ${response.body}`).toBe(200);
        const sent = fake.calls.at(-1)!;
        expect(sent).toMatchObject({ name: op.name, source: knowledgePartitionSourceId(partition), scopes: "read write" });
      }
      for (const name of gbrainServiceExposure().excluded.keys()) {
        expect((await call(knowledge, "fixture-crud", name, {}, true)).statusCode, name).toBe(404);
      }
    } finally { await knowledge.close(); }
  });
});
