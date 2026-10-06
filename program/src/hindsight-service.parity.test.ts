import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { hindsightSampleArguments } from "../scripts/engine-coverage.js";
import { loadConfig } from "./config.js";
import { hindsightExposure, hindsightOperationSpecs } from "./engine-exposure.js";
import { hindsightBankForPartition } from "./hindsight-client.js";
import { HindsightMemoryEngine } from "./hindsight-engine.js";
import type { KnowledgeDocument } from "./types.js";

/**
 * Parity against a REAL, unmodified Hindsight at the pinned tag (opt-in):
 *   KNOWLEDGE_HINDSIGHT_PARITY_URL=http://127.0.0.1:8888 KNOWLEDGE_HINDSIGHT_PARITY_KEY=<tenant key>
 * Runs without a model key when Hindsight uses HINDSIGHT_API_LLM_PROVIDER=mock and an
 * OpenAI-compatible embeddings fixture (deploy/container/model-provider-fixture.mjs);
 * LLM-backed results are then structural only, never evidence of extraction quality.
 */
const url = process.env.KNOWLEDGE_HINDSIGHT_PARITY_URL;
const key = process.env.KNOWLEDGE_HINDSIGHT_PARITY_KEY;
const run = `${Date.now().toString(36)}`;
const partitionA = `parity-a-${run}`, partitionB = `parity-b-${run}`;

describe.skipIf(!url || !key)("Hindsight service parity (real upstream)", () => {
  let engine: HindsightMemoryEngine;
  const native = (op: string, args: Record<string, unknown>, partition = partitionA) => engine.nativeOperation(op, args, partition, "agent-parity");
  async function settle(partition: string) {
    for (let i = 0; i < 120; i++) {
      const ops = await native("list_operations", {}, partition);
      const pending = JSON.stringify(ops.data ?? {}).match(/"status":"(pending|processing|running)"/u);
      if (!pending) return;
      await new Promise(r => setTimeout(r, 500));
    }
  }
  beforeAll(async () => {
    engine = new HindsightMemoryEngine(loadConfig({ environment: "test", config: { memoryEngine: "hindsight", hindsightUrl: url!, hindsightApiKey: key! } }));
    await engine.start();
  });
  afterAll(async () => { await engine?.close(); });

  it("is online at the pinned version", () => {
    expect(engine.status()).toMatchObject({ status: "online", runtime: "hindsight", observedVersion: "0.10.2" });
  });

  it("projects a canonical document (async retain) and lists it in the partition bank only", async () => {
    const document = { id: "doc-1", companyId: partitionA, collectionId: "c", title: "Meetup recap", summary: null,
      body: "Henry drafts the Bangkok AI meetup recap every month.", status: "published", createdAt: "2026-10-06T00:00:00.000Z", updatedAt: "2026-10-06T00:00:00.000Z" } as unknown as KnowledgeDocument;
    const projected = await engine.projectDocument(document);
    expect(projected.ok, projected.error).toBe(true);
    await settle(partitionA);
    const listed = await native("list_documents", {});
    expect(listed.ok, JSON.stringify(listed.error)).toBe(true);
    expect(JSON.stringify(listed.data)).toContain("knowledge-doc:doc-1");
    const foreign = await native("list_documents", {}, partitionB);
    expect(JSON.stringify(foreign.data ?? null)).not.toContain("knowledge-doc:doc-1");
  });

  it("retains, reads and recalls through the native surface", async () => {
    const retained = await native("retain_memories", { body: { items: [{ content: "Martin hosts the Bangkok AI meetup at the co-working space.", document_id: "agent-note-1", context: "parity" }] } });
    expect(retained.ok, JSON.stringify(retained.error)).toBe(true);
    const document = await native("get_document", { document_id: "agent-note-1" });
    expect(document.ok, JSON.stringify(document.error)).toBe(true);
    const chunks = await native("list_document_chunks", { document_id: "agent-note-1" });
    expect(chunks.ok, JSON.stringify(chunks.error)).toBe(true);
    const chunkId = JSON.stringify(chunks.data).match(new RegExp(`"(${hindsightBankForPartition(partitionA)}_[^"]+)"`, "u"))?.[1];
    if (chunkId) expect(await native("get_chunk", { chunk_id: chunkId })).toMatchObject({ ok: true });
    const recalled = await native("recall_memories", { body: { query: "Who hosts the meetup?" } });
    expect(recalled.ok, JSON.stringify(recalled.error)).toBe(true);
    for (const op of ["list_memories", "list_tags", "get_agent_stats", "get_bank_config", "list_entities", "get_graph", "list_directives", "list_mental_models", "get_knowledge_base_tree", "get_version"]) {
      const result = await native(op, {});
      expect(result.ok, `${op}: ${JSON.stringify(result.error)}`).toBe(true);
    }
  });

  it("creates and deletes a directive (write round trip)", async () => {
    const created = await native("create_directive", { body: { name: "parity", content: "Prefer concise answers." } });
    expect(created.ok, JSON.stringify(created.error)).toBe(true);
    const id = (created.data as { id?: string }).id;
    expect(id).toBeTruthy();
    expect(await native("get_directive", { directive_id: id })).toMatchObject({ ok: true });
    expect(await native("delete_directive", { directive_id: id })).toMatchObject({ ok: true });
    expect(await native("get_directive", { directive_id: id })).toMatchObject({ ok: false, error: { error: "not_found" } });
  });

  it("refuses excluded and cross-partition operations, and hard-deletes a projection", async () => {
    expect(await native("list_banks", {})).toMatchObject({ ok: false, error: { error: "scope_denied" } });
    expect(await native("get_chunk", { chunk_id: `${hindsightBankForPartition(partitionB)}_x_0` })).toMatchObject({ ok: false, error: { error: "argument_refused" } });
    expect(await native("delete_document", { document_id: "knowledge-doc:doc-1" })).toMatchObject({ ok: false, error: { error: "argument_refused" } });
    expect((await engine.deleteProjection("doc-1", partitionA, "document")).ok).toBe(true);
    expect(await native("get_document", { document_id: "knowledge-doc:doc-1" })).toMatchObject({ ok: false, error: { error: "not_found" } });
  });

  it("routes every exposed operation to a live upstream handler (no route-level 404/405)", async () => {
    const outcomes: Record<string, string> = {};
    for (const op of hindsightExposure().exposed.values()) {
      const result = await native(op.name, hindsightSampleArguments(hindsightOperationSpecs().get(op.name)!, partitionA));
      // Placeholder ids legitimately yield handler-level 4xx (and upstream 500s for some malformed UUIDs).
      expect(result.error?.detail, op.name).not.toBe("Not Found");
      expect(result.error?.status, op.name).not.toBe(405);
      outcomes[op.name] = result.ok ? "ok" : `${result.error.error}:${result.error.status ?? ""}`;
    }
    expect(Object.keys(outcomes)).toHaveLength(hindsightExposure().exposed.size);
  }, 300_000);

  it("reports model-backed operations as upstream reports them", async () => {
    const reflected = await native("reflect", { body: { query: "What happens at the meetup?" } });
    expect(typeof reflected.ok).toBe("boolean");
    if (!reflected.ok) expect(reflected.error.error).toBeTruthy();
  });
});
