import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import { startFakeHindsight } from "../scripts/fixtures/fake-engines.mjs";
import { loadConfig } from "./config.js";
import { GBrainRuntime } from "./gbrain.js";
import { HindsightClient, hindsightBankForPartition } from "./hindsight-client.js";
import { HINDSIGHT_LONG_OPERATIONS, HindsightMemoryEngine } from "./hindsight-engine.js";
import { createMemoryEngine } from "./memory-engine.js";
import type { KnowledgeDocument } from "./types.js";

const key = "hindsight-tenant-key-fixture-only-000000";
let fake: Awaited<ReturnType<typeof startFakeHindsight>>;
beforeAll(async () => { fake = await startFakeHindsight({ apiKey: key }); });
afterAll(async () => { await fake.close(); });
afterEach(() => { vi.unstubAllEnvs(); });

async function engine() {
  const runtime = new HindsightMemoryEngine(loadConfig({ environment: "test", config: { memoryEngine: "hindsight", hindsightUrl: fake.baseUrl, hindsightApiKey: key } }));
  await runtime.start();
  return runtime;
}
const native = (runtime: HindsightMemoryEngine, op: string, args: Record<string, unknown>, partition = "workspace-a") => runtime.nativeOperation(op, args, partition, "agent-henry");

describe("memory engine selection", () => {
  it("defaults to GBrain so existing deployments are unchanged", () => {
    vi.stubEnv("KNOWLEDGE_MEMORY_ENGINE", "");
    const config = loadConfig({ environment: "test" });
    expect(config.memoryEngine).toBe("gbrain");
    expect(createMemoryEngine(config)).toBeInstanceOf(GBrainRuntime);
    expect(createMemoryEngine(config).engine).toBe("gbrain");
  });

  it("selects Hindsight per deployment and refuses unknown engines at startup", () => {
    vi.stubEnv("KNOWLEDGE_MEMORY_ENGINE", "hindsight");
    vi.stubEnv("KNOWLEDGE_HINDSIGHT_URL", "http://hindsight.railway.internal:8888");
    vi.stubEnv("KNOWLEDGE_HINDSIGHT_API_KEY", key);
    const config = loadConfig({ environment: "test" });
    expect(config).toMatchObject({ memoryEngine: "hindsight", hindsightUrl: "http://hindsight.railway.internal:8888", hindsightApiKey: key });
    expect(createMemoryEngine(config)).toBeInstanceOf(HindsightMemoryEngine);
    vi.stubEnv("KNOWLEDGE_MEMORY_ENGINE", "mem0");
    expect(() => loadConfig({ environment: "test" })).toThrow("KNOWLEDGE_MEMORY_ENGINE must be gbrain or hindsight");
  });

  it("reports an unconfigured or unreachable Hindsight explicitly instead of falling back", async () => {
    const missing = new HindsightMemoryEngine(loadConfig({ environment: "test", config: { memoryEngine: "hindsight", hindsightUrl: null, hindsightApiKey: null } }));
    await missing.start();
    expect(missing.status()).toMatchObject({ status: "degraded", runtime: "hindsight", topology: "hindsight-service" });
    expect(missing.status().detail).toContain("KNOWLEDGE_HINDSIGHT_URL");
    expect(await native(missing, "recall_memories", { body: { query: "x" } })).toMatchObject({ ok: false, error: { error: "unavailable" } });
    const online = await engine();
    expect(online.status()).toMatchObject({ status: "online", observedVersion: "0.10.2", factsVisibility: "partition_private" });
    expect(JSON.stringify(online.status())).not.toContain(key);
  });
});

describe("Hindsight partition scoping", () => {
  it("targets only the bank derived from the authorized partition", async () => {
    const runtime = await engine();
    await native(runtime, "list_memories", {}, "workspace-a");
    await native(runtime, "list_memories", {}, "Workspace-B");
    expect(fake.calls.slice(-2).map(call => call.bank)).toEqual([hindsightBankForPartition("workspace-a"), hindsightBankForPartition("workspace-b")]);
    expect(await native(runtime, "list_memories", {}, "../other")).toMatchObject({ ok: false, error: { error: "scope_denied" } });
  });

  it("refuses bank selection, traversal and cross-bank identifiers before any upstream call", async () => {
    const runtime = await engine();
    const bank = hindsightBankForPartition("workspace-a");
    const other = hindsightBankForPartition("workspace-b");
    const before = fake.calls.length;
    for (const [op, args] of [
      ["list_memories", { bank_id: other }],
      ["recall_memories", { body: { query: "x" }, bank_id: other }],
      ["get_memory", { memory_id: "../../" + other + "/memories/x" }],
      ["get_memory", { memory_id: ".." }],
      ["get_document", { document_id: "a/../../b" }],
      ["get_chunk", { chunk_id: `${other}_doc_0` }],
      ["download_file", { key: `banks/${other}/exports/a.zip` }],
      ["download_file", { key: `tenants/public/banks/${other}/exports/a.zip` }],
    ] as const) {
      expect(await native(runtime, op, args as Record<string, unknown>), `${op} ${JSON.stringify(args)}`).toMatchObject({ ok: false, error: { error: "argument_refused" } });
    }
    for (const args of [{ unknown: 1 }, { limit: { nested: true } }]) {
      expect(await native(runtime, "list_memories", args)).toMatchObject({ ok: false, error: { error: "invalid_params" } });
    }
    expect(fake.calls.length).toBe(before);
    // A chunk whose content says it belongs to another bank is withheld even if the id matched.
    expect(await native(runtime, "get_chunk", { chunk_id: `${bank}_doc_0` })).toMatchObject({ ok: true });
    expect(await native(runtime, "list_banks", {})).toMatchObject({ ok: false, error: { error: "scope_denied" } });
    expect(await native(runtime, "delete_bank", {})).toMatchObject({ ok: false, error: { error: "scope_denied" } });
    // Restore inserts archive rows with their own bank_id: excluded outright.
    expect(await native(runtime, "import_bank_transfer", { mode: "merge", body: { file: { contentBase64: "UEs=" } } })).toMatchObject({ ok: false, error: { error: "scope_denied" } });
  });

  it("refuses overwriting imports and audit-log changes, and keeps exports as writes", async () => {
    const runtime = await engine();
    const archive = { file: { filename: "a.zip", contentBase64: "UEs=" } };
    const before = fake.calls.length;
    for (const [op, args] of [
      ["import_documents", { on_conflict: "replace", body: archive }],
      ["import_documents", { on_conflict: "REPLACE", body: archive }],
      ["update_bank_config", { body: { updates: { audit_log_enabled: false } } }],
      ["update_bank_config", { body: { updates: { HINDSIGHT_API_AUDIT_LOG_ENABLED: "false" } } }],
      ["import_bank_template", { body: { version: "1", bank: { audit_log_enabled: false } } }],
    ] as const) {
      expect(await native(runtime, op, args as Record<string, unknown>), `${op} ${JSON.stringify(args)}`).toMatchObject({ ok: false, error: { error: "argument_refused" } });
    }
    expect(fake.calls.length).toBe(before);
    for (const mode of ["skip", "new-id"]) expect(await native(runtime, "import_documents", { on_conflict: mode, body: archive })).toMatchObject({ ok: true });
    expect(await native(runtime, "update_bank_config", { body: { updates: { retain_chunk_size: 800 } } })).toMatchObject({ ok: true });
    expect(runtime.nativeOperationPolicy("export_documents")?.scope).toBe("write");
    expect(runtime.nativeOperationPolicy("export_bank_transfer")?.scope).toBe("write");
  });

  it("bounds upstream time: 60 s for ordinary operations, 300 s only for documented long ones", async () => {
    const runtime = await engine();
    const invoke = vi.spyOn(HindsightClient.prototype, "invoke");
    try {
      await native(runtime, "list_memories", {});
      await native(runtime, "recall_memories", { body: { query: "x" } });
      await native(runtime, "reflect", { body: { query: "x" } });
      await native(runtime, "retain_memories", { body: { items: [{ content: "x", document_id: "agent-timeout" }] } });
      expect(invoke.mock.calls.map(call => call[3])).toEqual([60_000, 60_000, 300_000, 300_000]);
      expect([...HINDSIGHT_LONG_OPERATIONS].every(name => runtime.nativeOperationPolicy(name))).toBe(true);
    } finally { invoke.mockRestore(); }
  });

  it("protects Knowledge's canonical projections from agent rewrites and deletes", async () => {
    const runtime = await engine();
    for (const [op, args] of [
      ["delete_document", { document_id: "knowledge-doc:doc-1" }],
      ["update_document", { document_id: "knowledge-research:src-1", body: { tags: [] } }],
      ["retain_memories", { body: { items: [{ content: "x", document_id: "knowledge-doc:doc-1" }] } }],
      ["file_retain", { body: { files: [{ contentBase64: "eA==" }], request: JSON.stringify({ files_metadata: [{ document_id: "knowledge-doc:doc-1" }] }) } }],
    ] as const) {
      expect(await native(runtime, op, args as Record<string, unknown>), op).toMatchObject({ ok: false, error: { error: "argument_refused" } });
    }
    expect(await native(runtime, "get_document", { document_id: "knowledge-doc:doc-1" })).toMatchObject({ ok: true });
    expect(await native(runtime, "retain_memories", { body: { items: [{ content: "Henry drafts the recap", document_id: "agent-note-1" }] } })).toMatchObject({ ok: true });
  });

  it("builds multipart uploads and returns binary results base64-encoded", async () => {
    const runtime = await engine();
    expect(await native(runtime, "file_retain", { body: { files: [{ filename: "a.txt", contentBase64: Buffer.from("hello").toString("base64"), contentType: "text/plain" }], request: "{}" } })).toMatchObject({ ok: true });
    expect(fake.calls.at(-1)!.contentType).toMatch(/^multipart\/form-data; boundary=/u);
    const bank = hindsightBankForPartition("workspace-a");
    const attachment = await native(runtime, "get_bank_attachment", { attachment_id: "att-1" });
    expect(attachment).toMatchObject({ ok: true, data: { encoding: "base64", data: Buffer.from([0x50, 0x4b, 0x03, 0x04]).toString("base64") } });
    expect(await native(runtime, "download_file", { key: `banks/${bank}/exports/a.zip` })).toMatchObject({ ok: true, data: { encoding: "base64" } });
  });

  it("maps upstream failures without leaking credentials and freezes writes for a migration", async () => {
    const failing = new HindsightMemoryEngine(loadConfig({ environment: "test", config: { memoryEngine: "hindsight", hindsightUrl: "http://hindsight.invalid:8888", hindsightApiKey: key } }), {
      fetch: (async (url: string | URL) => {
        const path = new URL(String(url)).pathname;
        if (path === "/health" || path === "/version") return Response.json({ status: "healthy", api_version: "0.10.2" });
        if (path.endsWith("/reflect")) return Response.json({ detail: "boom" }, { status: 503 });
        return Response.json({ detail: [{ msg: `bad field near ${key}` }] }, { status: 422 });
      }) as typeof fetch,
    });
    await failing.start();
    const rejected = await failing.nativeOperation("recall_memories", { body: { query: "x" } }, "workspace-a", "agent");
    expect(rejected).toMatchObject({ ok: false, error: { error: "invalid_params", status: 422 } });
    expect(JSON.stringify(rejected)).not.toContain(key);
    expect(await failing.nativeOperation("reflect", { body: { query: "x" } }, "workspace-a", "agent")).toMatchObject({ ok: false, error: { error: "unavailable", status: 503 } });
    vi.stubEnv("KNOWLEDGE_BRAIN_WRITES", "paused");
    const runtime = await engine();
    expect(await native(runtime, "retain_memories", { body: { items: [{ content: "x" }] } })).toMatchObject({ ok: false, error: { error: "unavailable" } });
    expect(await native(runtime, "list_memories", {})).toMatchObject({ ok: true });
  });
});

describe("Hindsight Program surfaces", () => {
  it("projects canonical records into the partition bank by stable document id and hard-deletes them", async () => {
    const runtime = await engine();
    const document = { id: "doc-1", companyId: "workspace-a", collectionId: "c", title: "Recap", summary: null, body: "Henry drafts the recap.", status: "published",
      createdAt: "2026-10-06T00:00:00.000Z", updatedAt: "2026-10-06T00:00:00.000Z" } as unknown as KnowledgeDocument;
    expect(await runtime.projectDocument(document)).toMatchObject({ ok: true, tool: "retain" });
    const retained = fake.calls.at(-1)!;
    expect(retained).toMatchObject({ method: "POST", bank: hindsightBankForPartition("workspace-a") });
    expect(retained.body).toMatchObject({ async: true, items: [{ document_id: "knowledge-doc:doc-1", update_mode: "replace" }] });
    expect((retained.body as { operation_id: string }).operation_id).toMatch(/^[0-9a-f-]{36}$/u);
    expect(await runtime.deleteProjection("doc-1", "workspace-a", "document")).toMatchObject({ ok: true });
    expect(decodeURIComponent(fake.calls.at(-1)!.path)).toBe(`/v1/default/banks/${hindsightBankForPartition("workspace-a")}/documents/knowledge-doc:doc-1`);
    expect(await runtime.extractFacts({ text: "x", partitionKey: "workspace-a", sourceSlug: "knowledge-docs/doc-1" })).toMatchObject({ ok: true, data: { status: "subsumed_by_retain" } });
    expect((await runtime.listPages({ partitionKey: "workspace-a" })).data).toEqual([{ slug: "knowledge-doc:doc-1", title: "knowledge-doc:doc-1", type: "document", updated_at: "2026-10-06T00:00:00Z" }]);
  });

  it("fails GBrain-only Program surfaces explicitly", async () => {
    const runtime = await engine();
    for (const result of [
      await runtime.getLinks({ slug: "x", partitionKey: "workspace-a" }), await runtime.getTimeline({ slug: "x", partitionKey: "workspace-a" }),
      await runtime.traverseGraph({ slug: "x", partitionKey: "workspace-a" }), await runtime.getEntityCard({ name: "x", partitionKey: "workspace-a" }),
      await runtime.recall({ entity: "henry", partitionKey: "workspace-a" }),
    ]) expect(result).toMatchObject({ ok: false, error: expect.stringContaining("engine_capability_unavailable") });
    expect(runtime.nativeCapabilityReadiness().capabilityGaps.map(gap => gap.code)).toContain("engine_capability_unavailable");
  });

  it("publishes a discovery catalog: compact list, per-operation describe with resolvable schemas, exclusions", async () => {
    const runtime = await engine();
    const catalog = await native(runtime, "catalog", {});
    expect(catalog.data.tools).toHaveLength(80);
    expect(catalog.data.excluded.map((item: { name: string }) => item.name)).toEqual(expect.arrayContaining(["delete_bank", "import_bank_transfer"]));
    expect(catalog.data.tools.every((tool: Record<string, unknown>) => !("inputSchema" in tool))).toBe(true);
    const described = await native(runtime, "catalog", { operation: "retain_memories" });
    const tool = described.data.tools[0];
    expect(tool).toMatchObject({ name: "retain_memories", scope: "write", portalCapability: "knowledge:engine:write" });
    expect(tool.inputSchema.required).toEqual(["body"]);
    expect(tool.inputSchema.properties.body.$ref).toBe("#/$defs/RetainRequest");
    const refs = JSON.stringify(tool.inputSchema).match(/#\/\$defs\/[A-Za-z0-9_]+/gu) ?? [];
    for (const ref of refs) expect(tool.inputSchema.$defs[ref.slice("#/$defs/".length)], ref).toBeDefined();
    expect(JSON.stringify(tool.inputSchema)).not.toContain("#/components/");
    const upload = (await native(runtime, "catalog", { operation: "file_retain" })).data.tools[0];
    expect(JSON.stringify(upload.inputSchema)).toContain("contentBase64");
    expect((await native(runtime, "catalog", { query: "mental model" })).data.tools.every((t: { name: string; description: string }) => /mental/iu.test(`${t.name} ${t.description}`))).toBe(true);
  });
});
