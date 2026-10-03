/** Manual browser QA only. Invoked by the native disposable runner with --browser. */
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import net from "node:net";
import path from "node:path";
import os from "node:os";
import { randomUUID } from "node:crypto";
import { buildKnowledgeApp } from "../src/app.js";
import { startChatModelFixture, type ChatModelFixture } from "./open-notebook-chat-fixture.js";

assert.equal(process.env.KNOWLEDGE_OPEN_NOTEBOOK_FIXTURE, "disposable");
const upstream = new URL(process.env.KNOWLEDGE_OPEN_NOTEBOOK_FIXTURE_URL!);
assert.equal(upstream.protocol, "http:"); assert.equal(upstream.hostname, "127.0.0.1");
assert.equal(upstream.pathname, "/"); assert(!upstream.username && !upstream.password && !upstream.search && !upstream.hash);
const upstreamToken = process.env.KNOWLEDGE_OPEN_NOTEBOOK_FIXTURE_TOKEN!;
assert(upstreamToken);
const root = await fs.mkdtemp(path.join(os.tmpdir(), "knowledge-browser-qa-"));
let app: Awaited<ReturnType<typeof buildKnowledgeApp>> | null = null;
let provider: ChatModelFixture | null = null;
let notebookId: string | null = null;
let finished = false;
let finish!: () => void;
const completed = new Promise<void>(resolve => { finish = resolve; });
const stop = () => finish();
process.once("SIGINT", stop); process.once("SIGTERM", stop);
const timer = setTimeout(finish, 540000);
async function upstreamCall(method: "POST" | "DELETE", route: string, body?: unknown) {
  const response = await fetch(new URL(route, upstream), { method, redirect: "error", signal: AbortSignal.timeout(30000),
    headers: { authorization: `Bearer ${upstreamToken}`, ...(body ? { "content-type": "application/json" } : {}) },
    ...(body ? { body: JSON.stringify(body) } : {}) });
  assert(response.ok, `fixture_upstream_${method}_failed_${response.status}`);
  return response.json();
}
try {
  const server = net.createServer();
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as net.AddressInfo).port;
  await new Promise<void>(resolve => server.close(() => resolve()));
  const origin = `http://127.0.0.1:${port}`;
  notebookId = (await upstreamCall("POST", "/api/notebooks", { name: "Browser Research acceptance", description: "Synthetic local notebook" })).id;
  assert(notebookId);
  await upstreamCall("POST", "/api/notes", { notebook_id: notebookId, title: "Research field notes", note_type: "human",
    content: "KNOWLEDGE_NOTE_MARKER: Durable agents need attributable evidence and explicit action receipts.\n\n<script>window.__noteExecuted = true</script>\n\n[Untrusted link](https://fixture.invalid)\n\nLong reference: " + "n".repeat(512) });
  // Explicit title prevents upstream AI-title generation; this is synthetic
  // metadata to exercise the label, not a generated research result.
  await upstreamCall("POST", "/api/notes", { notebook_id: notebookId, title: "Synthetic synthesis note", note_type: "ai",
    content: "Synthetic fixture text. An AI origin label is metadata, not proof of accuracy or promotion." });
  provider = await startChatModelFixture(upstream.origin, upstreamToken);
  const config = { dataDir: root, knowledgeDatabasePath: path.join(root, "knowledge.sqlite"), knowledgeDatabaseUrl: null,
    gbrainAutoStart: false, gbrainBaseUrl: null, gbrainToken: null, defaultDocsSourceConfig: null,
    openNotebookBaseUrl: null, openNotebookToken: null, knowledgeServicePrincipals: [], openNotebookBindings: [],
    browserOperatorSecret: null, browserPrincipalId: null, browserOrigin: null, rulesBaseUrl: null, rulesAuthToken: null };
  app = await buildKnowledgeApp({ environment: "test", config });
  const local = await app.inject({ method: "POST", url: "/api/companies/browser-fixture/research/notebooks",
    payload: { title: "Research interaction study", summary: "A disposable Open Notebook workspace for sign-in, grounded chat and safe recovery checks." } });
  assert.equal(local.statusCode, 201);
  const localId = local.json().id as string;
  await app.close(); app = null;
  const serviceToken = `fixture-service-${randomUUID()}`;
  // Public synthetic QA login code, never valid in an operator deployment.
  const loginCode = "disposable-browser-fixture-login-only";
  app = await buildKnowledgeApp({ environment: "test", config: { ...config,
    openNotebookBaseUrl: upstream.origin, openNotebookToken: upstreamToken,
    openNotebookChatModelId: provider.modelId, researchChatLedgerPath: path.join(root, "chat.sqlite"), researchWriteLedgerPath: path.join(root, "writes.sqlite"),
    knowledgeServicePrincipals: [{ token: serviceToken, principalId: "browser-qa", companyId: "browser-fixture", capabilities: ["research:read", "research:write"] }],
    openNotebookBindings: [{ knowledgeNotebookId: localId, companyId: "browser-fixture", externalNotebookId: notebookId }],
    browserOperatorSecret: loginCode, browserPrincipalId: "browser-qa", browserOrigin: origin,
  } });
  // This control route exists ONLY in this opt-in disposable script, not app.ts.
  app.post("/__fixture/control", async (request, reply) => {
    if (request.headers.origin !== origin || request.headers.host !== new URL(origin).host) return reply.code(403).send({ error: "fixture_origin_denied" });
    const mode = (request.body as { mode?: string })?.mode;
    if (mode === "reject" || mode === "none") provider!.setFailureMode(mode);
    else if (mode === "finish") { finished = true; setTimeout(finish, 100); }
    else return reply.code(400).send({ error: "invalid_fixture_mode" });
    return { ok: true, providerCalls: provider!.providerCalls.length };
  });
  const source = await app.inject({ method: "POST", url: `/api/research/notebooks/${localId}/engine/sources`,
    headers: { authorization: `Bearer ${serviceToken}`, host: new URL(origin).host, "idempotency-key": "browser-source-fixture" },
    payload: { title: "Interaction study findings", content: "KNOWLEDGE_CONTEXT_MARKER: People need durable agents, attributable research and an explicit confirmation when an action has completed.\n\n<script>window.__sourceExecuted = true</script>\n\nLong citation identifier: " + "a".repeat(512) } });
  assert.equal(source.statusCode, 201, `fixture_source_failed_${source.statusCode}`);
  await app.listen({ host: "127.0.0.1", port });
  console.log(JSON.stringify({ event: "browser.ready", url: `${origin}/?view=research&companyId=browser-fixture`, publicSyntheticLogin: loginCode, localNotebookId: localId }));
  await completed;
  console.log(JSON.stringify({ event: "browser.finished", explicitFinish: finished, providerCalls: provider.providerCalls.length,
    scopedContextSeen: provider.providerCalls.some(call => JSON.stringify(call.messages).includes("KNOWLEDGE_CONTEXT_MARKER")) }));
  if (!finished) process.exitCode = 1;
} finally {
  clearTimeout(timer); process.removeListener("SIGINT", stop); process.removeListener("SIGTERM", stop);
  await app?.close();
  await provider?.close();
  if (notebookId) await upstreamCall("DELETE", `/api/notebooks/${encodeURIComponent(notebookId)}`);
  await fs.rm(root, { recursive: true, force: true });
}
