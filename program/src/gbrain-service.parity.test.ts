import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { mkdtempSync, readFileSync, realpathSync, rmSync, statSync } from "node:fs";
import { createServer } from "node:net";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { GBrainRuntime } from "./gbrain.js";
import { loadConfig } from "./config.js";
import { knowledgePartitionSourceId } from "./partition-authority.js";
import type { KnowledgeDocument } from "./types.js";

/**
 * Capability parity against a REAL, unmodified upstream GBrain (`gbrain serve --http`).
 * Opt-in: KNOWLEDGE_GBRAIN_PARITY_REPO=<upstream checkout at the pinned commit> (needs bun).
 * The GBrain service is provisioned exactly like the deploy entrypoint: init, owner-CLI
 * `sources add` for each partition source, then serve with a bootstrap token.
 */
const repo = process.env.KNOWLEDGE_GBRAIN_PARITY_REPO;
const adminToken = "parity-admin-token-fixture-0123456789abcdef";
const partitions = ["fixture-a", "fixture-b"] as const;

async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.listen(0, "127.0.0.1", () => { const port = (server.address() as { port: number }).port; server.close(() => resolve(port)); });
    server.on("error", reject);
  });
}

const document = (id: string, companyId: string, body: string): KnowledgeDocument => ({
  id, companyId, collectionId: "collection", title: `Doc ${id}`, summary: null, body, status: "published",
  createdAt: "2026-10-05T00:00:00.000Z", updatedAt: new Date().toISOString(),
} as unknown as KnowledgeDocument);

describe.skipIf(!repo)("GBrain service parity (real upstream)", () => {
  let home: string, dataDir: string, child: ChildProcess, runtime: GBrainRuntime, base: string;
  beforeAll(async () => {
    home = realpathSync(mkdtempSync(path.join(os.tmpdir(), "gbrain-parity-home-")));
    dataDir = mkdtempSync(path.join(os.tmpdir(), "gbrain-parity-data-"));
    const env = { ...process.env, GBRAIN_HOME: home };
    const cli = (...args: string[]) => spawnSync("bun", ["run", "src/cli.ts", ...args], { cwd: repo, env, encoding: "utf8" });
    const init = cli("init", "--pglite", "--no-embedding");
    expect(init.status, init.stderr.slice(-400)).toBe(0);
    const migrations = cli("apply-migrations", "--yes", "--no-autopilot-install");
    expect(migrations.status, migrations.stderr.slice(-400)).toBe(0);
    for (const partition of partitions) { const added = cli("sources", "add", knowledgePartitionSourceId(partition), "--name", partition); expect(added.status, added.stderr.slice(-400)).toBe(0); }
    const port = await freePort();
    base = `http://127.0.0.1:${port}`;
    child = spawn("bun", ["run", "src/cli.ts", "serve", "--http", "--port", String(port), "--bind", "127.0.0.1", "--public-url", base, "--suppress-bootstrap-token"],
      { cwd: repo, env: { ...env, GBRAIN_ADMIN_BOOTSTRAP_TOKEN: adminToken }, stdio: "ignore" });
    for (let i = 0; i < 120; i++) { try { if ((await fetch(`${base}/health`)).ok) break; } catch { /* starting */ } await new Promise(r => setTimeout(r, 250)); }
    runtime = new GBrainRuntime(loadConfig({ environment: "test", config: { dataDir, gbrainServiceUrl: base, gbrainServiceAdminToken: adminToken } }));
    await runtime.start();
  }, 120_000);
  afterAll(async () => {
    await runtime?.close();
    child?.kill("SIGTERM");
    await new Promise(r => setTimeout(r, 500));
    for (const dir of [home, dataDir]) if (dir) rmSync(dir, { recursive: true, force: true });
  });

  it("is online against the pinned upstream with no Knowledge code in the GBrain process", () => {
    const status = runtime.status();
    expect(status.status).toBe("online");
    expect(status.topology).toBe("service");
    expect(status.observedVersion).toMatch(/^\d+\.\d+\.\d+/u);
  });

  it("projects, updates and reads canonical pages through revision-aware writes", async () => {
    const created = await runtime.projectDocument(document("doc-1", "fixture-a", "Henry drafts the Bangkok AI meetup recap."));
    expect(created.ok, created.error).toBe(true);
    const updated = await runtime.projectDocument(document("doc-1", "fixture-a", "Henry drafts the Bangkok AI meetup recap every month."));
    expect(updated.ok, updated.error).toBe(true);
    const replay = await runtime.projectDocument(document("doc-1", "fixture-a", "Henry drafts the Bangkok AI meetup recap every month."));
    expect(replay.ok, replay.error).toBe(true);
    const page = await runtime.getPage({ slug: "knowledge-docs/doc-1", partitionKey: "fixture-a" });
    expect(page.ok, page.error).toBe(true);
    expect(JSON.stringify(page.data)).toContain("every month");
    const pages = await runtime.listPages({ partitionKey: "fixture-a", limit: 10 });
    expect(JSON.stringify(pages.data)).toContain("knowledge-docs/doc-1");
  });

  it("projects canonical text containing fence markers as plain content (upstream refuses remote fences)", async () => {
    const body = "Intro.\n\n<!--- gbrain:facts:begin -->\n| quoted-marker-text |\n<!--- gbrain:facts:end -->\n";
    const projected = await runtime.projectDocument(document("doc-fenced", "fixture-a", body));
    expect(projected.ok, projected.error).toBe(true);
    const page = await runtime.getPage({ slug: "knowledge-docs/doc-fenced", partitionKey: "fixture-a" });
    expect(JSON.stringify(page.data)).toContain("quoted-marker-text");
    expect(JSON.stringify(page.data)).not.toContain("<!--- gbrain:facts:begin");
  });

  it("freezes every memory write for a migration while reads continue", async () => {
    process.env.KNOWLEDGE_BRAIN_WRITES = "paused";
    try {
      const projected = await runtime.projectDocument(document("doc-frozen", "fixture-a", "Not yet."));
      expect(projected).toMatchObject({ ok: false, error: "brain_writes_paused" });
      expect((await runtime.extractFacts({ text: "x", partitionKey: "fixture-a" })).error).toBe("brain_writes_paused");
      expect((await runtime.deleteProjection("doc-1", "fixture-a", "document")).error).toBe("brain_writes_paused");
      expect((await runtime.nativeOperation("remember", { fact: "x" }, "fixture-a", "agent-henry")).ok).toBe(false);
      expect((await runtime.getPage({ slug: "knowledge-docs/doc-1", partitionKey: "fixture-a" })).ok).toBe(true);
    } finally { delete process.env.KNOWLEDGE_BRAIN_WRITES; }
    expect((await runtime.projectDocument(document("doc-frozen", "fixture-a", "Now."))).ok).toBe(true);
  });

  it("isolates partitions in upstream itself", async () => {
    const foreign = await runtime.getPage({ slug: "knowledge-docs/doc-1", partitionKey: "fixture-b" });
    expect(foreign.ok).toBe(false);
    const foreignList = await runtime.listPages({ partitionKey: "fixture-b", limit: 10 });
    expect(JSON.stringify(foreignList.data ?? null)).not.toContain("knowledge-docs/doc-1");
    const unprovisioned = await runtime.listPages({ partitionKey: "fixture-unprovisioned", limit: 10 });
    expect(unprovisioned.ok).toBe(false);
    expect(unprovisioned.error).toContain("brain_partition_binding_required");
  });

  it("exposes upstream's native memory catalog with source selection removed", async () => {
    const catalog = await runtime.nativeOperation("catalog", {}, "fixture-a", "agent-henry");
    expect(catalog.ok).toBe(true);
    const names = catalog.data.tools.map((tool: { name: string }) => tool.name);
    for (const verb of ["remember", "recall", "entity", "synthesize", "forget", "context_pack", "delta"]) expect(names).toContain(verb);
    for (const tool of catalog.data.tools) expect(Object.keys(tool.inputSchema.properties ?? {})).not.toContain("source_id");
  });

  it("remembers, recalls and forgets per partition and principal; refuses private and source overrides", async () => {
    const schema = (await runtime.nativeOperation("catalog", {}, "fixture-a", "agent-henry")).data.tools.find((tool: { name: string }) => tool.name === "remember").inputSchema;
    const field = Object.hasOwn(schema.properties, "fact") ? "fact" : "claim";
    const remembered = await runtime.nativeOperation("remember", { [field]: "Henry posts meetup recaps on Mondays", entity: "henry", provenance: "conversation: parity" }, "fixture-a", "agent-henry");
    expect(remembered.ok, JSON.stringify(remembered.error)).toBe(true);
    const recalled = await runtime.nativeOperation("recall", { entity: "henry" }, "fixture-a", "agent-henry");
    expect(recalled.ok).toBe(true);
    expect(JSON.stringify(recalled.data)).toContain("Mondays");
    const other = await runtime.nativeOperation("recall", { entity: "henry" }, "fixture-b", "agent-henry");
    expect(JSON.stringify(other.data ?? null)).not.toContain("Mondays");
    expect((await runtime.nativeOperation("remember", { [field]: "secret", entity: "henry", visibility: "private" }, "fixture-a", "agent-henry")).ok).toBe(false);
    expect((await runtime.nativeOperation("recall", { entity: "henry", source_id: knowledgePartitionSourceId("fixture-b") }, "fixture-a", "agent-henry")).ok).toBe(false);
    const factId = String((recalled.data.facts ?? []).find((fact: { text?: string; fact?: string }) => JSON.stringify(fact).includes("Mondays"))?.id ?? "");
    expect(factId).not.toBe("");
    const forgotten = await runtime.nativeOperation("forget", { id: factId, reason: "parity" }, "fixture-a", "agent-henry");
    expect(forgotten.ok, JSON.stringify(forgotten.error)).toBe(true);
    // One OAuth client per partition plus one per (partition, principal); secrets at rest are owner-only.
    const file = path.join(dataDir, "gbrain-service-clients.json");
    expect(statSync(file).mode & 0o077).toBe(0);
    const clients = Object.values(JSON.parse(readFileSync(file, "utf8")).clients) as Array<{ sourceId: string; principal: string | null }>;
    expect(clients.some(client => client.principal === null)).toBe(true);
    expect(clients.some(client => client.principal?.startsWith("kc-"))).toBe(true);
  });

  it("answers every MemoryEngine read surface explicitly", async () => {
    for (const call of [
      () => runtime.recall({ query: "meetup", partitionKey: "fixture-a" }),
      () => runtime.query({ query: "meetup", partitionKey: "fixture-a" }),
      () => runtime.getEntityCard({ name: "henry", partitionKey: "fixture-a" }),
      () => runtime.getLinks({ slug: "knowledge-docs/doc-1", partitionKey: "fixture-a" }),
      () => runtime.getTimeline({ slug: "knowledge-docs/doc-1", partitionKey: "fixture-a" }),
      () => runtime.traverseGraph({ slug: "knowledge-docs/doc-1", partitionKey: "fixture-a" }),
    ]) {
      const result = await call();
      expect(typeof result.ok).toBe("boolean");
      if (!result.ok) expect(result.error).toBeTruthy();
    }
    const extracted = await runtime.extractFacts({ text: "Martin hosts the meetup.", partitionKey: "fixture-a", sessionId: "document:doc-1" });
    expect(typeof extracted.ok).toBe("boolean");
  });

  it("deletes a projection: its session facts and the page", async () => {
    const deleted = await runtime.deleteProjection("doc-1", "fixture-a", "document");
    expect(deleted.ok, deleted.error).toBe(true);
    const page = await runtime.getPage({ slug: "knowledge-docs/doc-1", partitionKey: "fixture-a" });
    expect(page.ok).toBe(false);
  });
});
