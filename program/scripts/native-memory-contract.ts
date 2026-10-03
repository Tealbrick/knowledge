/** Keyless contract proof against the REAL bundled GBrain engine and worker.
 * Not a retrieval-quality benchmark: no LLM, embeddings, or user database.
 * Run: bun run knowledge/program/scripts/native-memory-contract.ts
 */
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:net";
import { randomBytes } from "node:crypto";

const root = await fs.mkdtemp(path.join(os.tmpdir(), "knowledge-native-contract-"));
// No developer/provider configuration may affect this disposable process.
for (const key of Object.keys(process.env)) {
  if (/API_KEY|TOKEN|SECRET|DATABASE_URL|^GBRAIN_|^KNOWLEDGE_/u.test(key)) delete process.env[key];
}
process.env.GBRAIN_HOME = root;
process.env.GBRAIN_NO_SNAPSHOT = "1";
const repo = path.resolve(import.meta.dir, "../../sidecars/gbrain");
const config = { engine: "pglite" as const, database_path: path.join(root, "db") };
await fs.mkdir(path.join(root, ".gbrain"), { mode: 0o700 });
await fs.writeFile(path.join(root, ".gbrain/config.json"), JSON.stringify(config), { mode: 0o600 });
const { PGLiteEngine } = await import("../../sidecars/gbrain/src/core/pglite-engine.ts");
const { operationsByName } = await import("../../sidecars/gbrain/src/core/operations.ts");
const { configureGateway } = await import("../../sidecars/gbrain/src/core/ai/gateway.ts");
const { knowledgePartitionSourceId } = await import("../src/partition-authority.ts");
const { managedBrainToken } = await import("../src/gbrain-managed-auth.ts");
const { buildKnowledgeApp } = await import("../src/app.ts");
configureGateway({ env: {} });
const engine = new PGLiteEngine();
let engineOpen = false;
let worker: ReturnType<typeof spawn> | undefined;
let app: Awaited<ReturnType<typeof buildKnowledgeApp>> | undefined;
let workerLog = "";
const secret = randomBytes(32).toString("hex");
const partition = "contract-a";
const sourceId = knowledgePartitionSourceId(partition)!;
const otherSource = knowledgePartitionSourceId("contract-b")!;
const logger = { info() {}, warn() {}, error() {} };
const context = (source: string) => ({ engine, config, logger, remote: false, dryRun: false, sourceId: source, auth: { clientId: source, sourceId: source, scopes: ["read", "write"], allowedSources: [source], hasSourceGrant: true } });
const native = (name: string, args: Record<string, unknown>, source = sourceId) => operationsByName[name]!.handler(context(source) as any, args);
const checks: string[] = [];
try {
  await engine.connect(config); engineOpen = true;
  await engine.initSchema();
  await engine.setConfig("search.cache.enabled", "false");
  await engine.setConfig("search.expansion", "false");
  for (const source of [sourceId, otherSource]) {
    await engine.executeRaw("INSERT INTO sources(id,name,local_path,config) VALUES($1,$1,NULL,'{\"federated\":false}'::jsonb)", [source]);
    await native("put_page", { slug: "people/alice-example", content: "---\ntitle: Alice Example\ntype: person\naka: [Ally]\n---\n\nAlice likes amber observatories.", source_id: source }, source);
    await native("remember", { fact: source === sourceId ? "Alice lives in Larkspur." : "FOREIGN-SENTINEL Alice lives in Cedarport.", entity: "people/alice-example", provenance: "contract fixture", visibility: "private" }, source);
  }
  for (let i = 0; i < 24; i++) await native("remember", { fact: `Contract observation ${i}: instrument label ${i}.`, provenance: "contract fixture", visibility: "private" });
  // Semantic deduplication requires embeddings; this keyless lane does not
  // claim to qualify it. Seed facts through native remember, then compare reads.
  await native("put_page", { slug: "companies/acme-example", content: "---\ntitle: Acme Example\ntype: company\n---\n\nBuilds observatories.", source_id: sourceId });
  await native("add_link", { from: "people/alice-example", to: "companies/acme-example", link_type: "works_at" });
  await native("add_timeline_entry", { slug: "people/alice-example", date: "2025-04-03", summary: "Joined Acme Example" });
  const cases = [
    { input: {}, params: {} },
    { input: { entity: "people/alice-example" }, params: { entity: "people/alice-example" } },
    { input: { grep: "instrument", limit: 7, budgetTokens: 256 }, params: { grep: "instrument", limit: 7, budget_tokens: 256 } },
    { input: { since: "2099-01-01", includeExpired: true, supersessions: true }, params: { since: "2099-01-01", include_expired: true, supersessions: true } },
    { input: { query: "amber observatories" }, params: { query: "amber observatories" } },
  ];
  const expected = [];
  for (const item of cases) expected.push(JSON.parse(JSON.stringify(await native("recall", item.params))));
  assert((expected[0] as any).facts.length > 20, "default-cap test must be non-vacuous");
  const expectedLinks = JSON.parse(JSON.stringify(await native("get_links", { slug: "people/alice-example" })));
  const expectedTimeline = JSON.parse(JSON.stringify(await native("get_timeline", { slug: "people/alice-example", limit: 100 })));
  await engine.disconnect(); engineOpen = false;
  const port = await new Promise<number>(resolve => { const server = createServer(); server.listen(0, "127.0.0.1", () => { const port = (server.address() as any).port; server.close(() => resolve(port)); }); });
  worker = spawn(process.execPath, [path.resolve(import.meta.dir, "../src/gbrain-managed-worker.mjs")], { cwd: root, env: { ...process.env, KNOWLEDGE_GBRAIN_REPO_PATH: repo, KNOWLEDGE_MANAGED_BRAIN_SECRET: secret, KNOWLEDGE_MANAGED_BRAIN_PORT: String(port) }, stdio: ["ignore", "pipe", "pipe"] });
  worker.stdout?.on("data", b => { workerLog += b; });
  worker.stderr?.on("data", b => { workerLog += b; });
  const endpoint = `http://127.0.0.1:${port}`;
  let ready = false;
  for (let i = 0; i < 200; i++) {
    if (worker.exitCode !== null) throw new Error(`Worker exited: ${workerLog}`);
    try { if ((await fetch(endpoint + "/health")).ok) { ready = true; break; } } catch {}
    await new Promise(r => setTimeout(r, 100));
  }
  assert(ready, "worker startup timeout");
  const principals = [partition, "contract-b"].map(companyId => ({ token: randomBytes(32).toString("hex"), principalId: companyId, companyId, capabilities: ["knowledge:read", "brain:read", "brain:context"] }));
  app = await buildKnowledgeApp({ environment: "test", config: { dataDir: root, gbrainBaseUrl: endpoint, gbrainToken: "unused-base", gbrainAutoStart: false, gbrainPartitionTokens: [partition, "contract-b"].map(partitionKey => ({ partitionKey, token: managedBrainToken(secret, knowledgePartitionSourceId(partitionKey)!) })), knowledgeServicePrincipals: principals, partitionAuthorizationRequired: true } });
  const api = async (url: string, input?: Record<string, unknown>, who = 0) => {
    const response = await app!.inject({ method: input ? "POST" : "GET", url, headers: { authorization: `Bearer ${principals[who]!.token}` }, ...(input ? { payload: input } : {}) });
    assert.equal(response.statusCode, 200, `${url}: ${JSON.stringify(input)}: ${response.body}`); return response.json();
  };
  for (let i = 0; i < cases.length; i++) {
    const result = await api("/api/brain/recall", { partitionKey: partition, scopeRef: partition, ...cases[i]!.input });
    assert.equal(result.ok, true, JSON.stringify(result));
    assert.deepEqual(result.memories, expected[i]);
    if ((expected[i] as any).search_degraded) assert.equal(result.status, "degraded");
    checks.push(`exact native recall parity ${i + 1}`);
  }
  const profile = await api(`/api/brain/entities?partitionKey=${partition}&slug=people%2Falice-example`);
  assert.equal(profile.ok, true, JSON.stringify(profile));
  assert.deepEqual(profile.links, expectedLinks);
  assert.deepEqual(profile.timeline, expectedTimeline);
  assert(profile.entityCard && profile.graph, "entity/graph arms missing");
  checks.push("native entity card, typed links, graph and timeline");
  const other = await api("/api/brain/recall", { partitionKey: "contract-b", scopeRef: "contract-b", entity: "people/alice-example" }, 1);
  assert(JSON.stringify(other.memories).includes("FOREIGN-SENTINEL"));
  assert(!JSON.stringify(profile).includes("FOREIGN-SENTINEL"));
  assert(!JSON.stringify(other.memories).includes("Larkspur"));
  checks.push("two populated partitions with overlapping entity slugs stay isolated");
  console.log(JSON.stringify({ ok: true, upstream: JSON.parse(await fs.readFile(path.join(repo, "package.json"), "utf8")).version, checks, evidence: "real native engine + managed worker + authenticated Knowledge API; keyless, not model-quality evaluation" }, null, 2));
} finally {
  await app?.close();
  if (worker && worker.exitCode === null) { worker.kill("SIGTERM"); await new Promise(resolve => worker!.once("exit", resolve)); }
  if (engineOpen) await engine.disconnect();
  await fs.rm(root, { recursive: true, force: true });
}
