import { mkdtempSync, rmSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { buildKnowledgeApp } from "./app.js";
import { createAttachmentResearchAuthority } from "./attachment-research-principal.js";

/**
 * A partitioned edge attachment (Portal `partitionKey` claim) works in the
 * company scope `<workspace>/<key>`. Research writes and chat record receipts
 * under that scope, so both durable ledgers must accept it. This drives the
 * real app (routes, adapters, SQLite ledgers) against a stub Open Notebook.
 */
const workspace = "0b1f9c52-7d3a-4a4e-9a55-3f0c6c1d2e11";
const personal = `${workspace}/personal`;
const other = `${workspace}/other`;
const MODEL = "model:fixture";
const NOW = "2026-10-08T00:00:00Z";

const dirs: string[] = [];
const servers: Server[] = [];
afterEach(async () => {
  for (const server of servers.splice(0)) await new Promise((resolve) => server.close(resolve));
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

interface Stub {
  readonly origin: string;
  readonly calls: { method: string; path: string }[];
}

/** The minimum Open Notebook surface the source-write and chat routes touch. */
async function startStubOpenNotebook(): Promise<Stub> {
  const sources = new Map<string, { id: string; title: string; text: string; notebook: string }>();
  const sessions = new Map<string, { id: string; notebook: string; messages: { id: string; type: "human" | "ai"; content: string }[] }>();
  const calls: Stub["calls"] = [];
  let counter = 0;
  const source = (item: { id: string; title: string; text: string; notebook: string }, detail: boolean) => ({
    id: item.id, title: item.title, topics: [], embedded: false, embedded_chunks: 0, created: NOW, updated: NOW, status: "ready",
    ...(detail ? { full_text: item.text, notebooks: [item.notebook] } : { insights_count: 0 }),
  });
  const server = createServer(async (req, res) => {
    let raw = ""; for await (const chunk of req) raw += chunk;
    const url = new URL(req.url ?? "/", "http://stub");
    calls.push({ method: req.method ?? "", path: url.pathname });
    const body = raw ? JSON.parse(raw) : {};
    const send = (value: unknown, status = 200) => { res.writeHead(status, { "content-type": "application/json" }); res.end(JSON.stringify(value)); };
    const inNotebook = (id: string) => [...sources.values()].filter((item) => item.notebook === id);
    if (req.method === "POST" && url.pathname === "/api/sources/json") {
      const item = { id: `source:s${++counter}`, title: body.title, text: body.content, notebook: body.notebooks[0] };
      sources.set(item.id, item);
      return send(source(item, true));
    }
    if (req.method === "GET" && url.pathname === "/api/sources") return send(inNotebook(url.searchParams.get("notebook_id") ?? "").map((item) => source(item, false)));
    if (req.method === "GET" && url.pathname.startsWith("/api/sources/")) {
      const item = sources.get(decodeURIComponent(url.pathname.slice("/api/sources/".length)));
      return item ? send(source(item, true)) : send({ detail: "not found" }, 404);
    }
    if (req.method === "GET" && url.pathname === "/api/notes") return send([]);
    if (req.method === "POST" && url.pathname === "/api/chat/context") {
      const items = inNotebook(body.notebook_id);
      return send({ context: { sources: items.map((item) => ({ id: item.id, title: item.title, full_text: item.text, insights: [] })), notes: [] }, token_count: 1, char_count: 1 });
    }
    if (req.method === "GET" && url.pathname === "/api/models/defaults") return send({ large_context_model: MODEL, default_chat_model: null });
    if (req.method === "POST" && url.pathname === "/api/chat/sessions") {
      const session = { id: `chat_session:u${++counter}`, notebook: body.notebook_id, messages: [] };
      sessions.set(session.id, session);
      return send({ id: session.id, notebook_id: session.notebook, title: body.title ?? "Chat", model_override: body.model_override, created: NOW, updated: NOW });
    }
    const match = /^\/api\/chat\/sessions\/(.+)$/u.exec(url.pathname);
    if (req.method === "GET" && match) {
      const session = sessions.get(decodeURIComponent(match[1]!));
      return session ? send({ id: session.id, notebook_id: session.notebook, title: "Chat", model_override: MODEL, created: NOW, updated: NOW, messages: session.messages }) : send({ detail: "not found" }, 404);
    }
    if (req.method === "POST" && url.pathname === "/api/chat/execute") {
      const session = sessions.get(body.session_id)!;
      session.messages.push({ id: `h${++counter}`, type: "human", content: body.message }, { id: `a${++counter}`, type: "ai", content: "Stub answer" });
      return send({ session_id: session.id, messages: session.messages });
    }
    return send({ detail: "unexpected" }, 404);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  servers.push(server);
  return { origin: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, calls };
}

async function fixture() {
  const dir = mkdtempSync(path.join(os.tmpdir(), "knowledge-partition-research-"));
  dirs.push(dir);
  const stub = await startStubOpenNotebook();
  const base = {
    dataDir: dir, knowledgeDatabasePath: path.join(dir, "knowledge.sqlite"), knowledgeDatabaseUrl: null, gbrainAutoStart: false, gbrainBaseUrl: null, gbrainToken: null,
    rulesBaseUrl: null, rulesAuthToken: null, knowledgeServicePrincipals: [], openNotebookBindings: [],
  };
  // Pass 1 creates the local notebooks; pass 2 binds them to the stub.
  const seed = await buildKnowledgeApp({ environment: "test", config: base });
  const notebooks: Record<string, string> = {};
  for (const [name, company] of [["default", workspace], ["personal", personal], ["other", other]] as const) {
    const created = await seed.inject({ method: "POST", url: `/api/companies/${encodeURIComponent(company)}/research/notebooks`, payload: { title: name, summary: name } });
    expect(created.statusCode).toBe(201);
    notebooks[name] = created.json().id;
  }
  await seed.close();
  const authority = createAttachmentResearchAuthority({ companyId: workspace, fallback: null });
  const app = await buildKnowledgeApp({
    environment: "test",
    researchPrincipalProvider: authority.provider,
    config: {
      ...base, openNotebookBaseUrl: stub.origin, openNotebookToken: "stub-token", openNotebookChatModelId: MODEL,
      researchWriteLedgerPath: path.join(dir, "writes.sqlite"), researchChatLedgerPath: path.join(dir, "chat.sqlite"),
      openNotebookBindings: [
        { knowledgeNotebookId: notebooks.default!, companyId: workspace, externalNotebookId: "notebook:ext-default" },
        { knowledgeNotebookId: notebooks.personal!, companyId: personal, externalNotebookId: "notebook:ext-personal" },
        { knowledgeNotebookId: notebooks.other!, companyId: other, externalNotebookId: "notebook:ext-other" },
      ],
    },
  });
  const grant = { agentId: "agent-1", orgId: "org-1", capabilities: ["knowledge:research:read", "knowledge:research:write"], expiresAt: Date.now() + 60_000 };
  const bearer = (partitionKey?: string) => ({ authorization: `Bearer ${authority.issue(partitionKey ? { ...grant, partitionKey } : grant)!}` });
  return { app, stub, notebooks, bearer };
}

describe("partitioned attachment principal in Research", () => {
  it("adds a source and replays the receipt under the partition scope", async () => {
    const { app, stub, notebooks, bearer } = await fixture();
    try {
      const url = `/api/research/notebooks/${notebooks.personal}/engine/sources`;
      const headers = { ...bearer("personal"), "idempotency-key": "source-1" };
      const created = await app.inject({ method: "POST", url, headers, payload: { title: "Findings", content: "Partitioned source text." } });
      expect(created.statusCode).toBe(201);
      expect(created.json().receipt).toMatchObject({ state: "succeeded", sourceId: expect.stringMatching(/^source:/u) });
      const posts = () => stub.calls.filter((call) => call.method === "POST" && call.path === "/api/sources/json").length;
      expect(posts()).toBe(1);

      const replay = await app.inject({ method: "POST", url, headers: { ...bearer("personal"), "idempotency-key": "source-1" }, payload: { title: "Findings", content: "Partitioned source text." } });
      expect(replay.statusCode).toBe(200);
      expect(replay.json()).toMatchObject({ replayed: true, receipt: { sourceId: created.json().receipt.sourceId } });
      expect(posts()).toBe(1);

      const receipt = await app.inject({ url: `${url.replace(/\/sources$/u, "")}/write-receipts/source-1`, headers: bearer("personal") });
      expect(receipt.statusCode).toBe(200);
      expect(receipt.json().receipt).toMatchObject({ state: "succeeded" });

      const listed = await app.inject({ url, headers: bearer("personal") });
      expect(listed.statusCode).toBe(200);
      expect(JSON.stringify(listed.json())).toContain("Findings");
    } finally { await app.close(); }
  });

  it("creates a chat session and answers a message under the partition scope", async () => {
    const { app, stub, notebooks, bearer } = await fixture();
    try {
      const chat = `/api/research/notebooks/${notebooks.personal}/engine/chat`;
      const source = await app.inject({ method: "POST", url: `/api/research/notebooks/${notebooks.personal}/engine/sources`, headers: { ...bearer("personal"), "idempotency-key": "src" }, payload: { title: "Findings", content: "Partitioned source text." } });
      expect(source.statusCode).toBe(201);
      const session = await app.inject({ method: "POST", url: `${chat}/sessions`, headers: { ...bearer("personal"), "idempotency-key": "session-1" }, payload: { title: "Ask" } });
      expect(session.statusCode).toBe(201);
      const sessionId = session.json().receipt.sessionId as string;
      const answer = await app.inject({ method: "POST", url: `${chat}/sessions/${sessionId}/messages`, headers: { ...bearer("personal"), "idempotency-key": "turn-1" }, payload: { message: "What is in the source?" } });
      expect(answer.statusCode).toBe(201);
      expect(answer.json().receipt).toMatchObject({ state: "succeeded", answer: { type: "ai", content: "Stub answer" } });
      const executes = () => stub.calls.filter((call) => call.path === "/api/chat/execute").length;
      expect(executes()).toBe(1);
      const replay = await app.inject({ method: "POST", url: `${chat}/sessions/${sessionId}/messages`, headers: { ...bearer("personal"), "idempotency-key": "turn-1" }, payload: { message: "What is in the source?" } });
      expect(replay.json()).toMatchObject({ replayed: true });
      expect(executes()).toBe(1);
      const history = await app.inject({ url: `${chat}/sessions/${sessionId}`, headers: bearer("personal") });
      expect(history.statusCode).toBe(200);
      expect(history.json().messages.map((item: { type: string }) => item.type)).toEqual(["human", "ai"]);
    } finally { await app.close(); }
  });

  it("keeps partitions isolated: sibling, workspace and default attachments cannot reach or replay it", async () => {
    const { app, stub, notebooks, bearer } = await fixture();
    try {
      const chat = `/api/research/notebooks/${notebooks.personal}/engine/chat`;
      const session = await app.inject({ method: "POST", url: `${chat}/sessions`, headers: { ...bearer("personal"), "idempotency-key": "shared-key" }, payload: {} });
      expect(session.statusCode).toBe(201);
      const sessionId = session.json().receipt.sessionId as string;
      // Another partition and the workspace default are refused at the notebook scope.
      for (const partitionKey of ["other", undefined]) {
        const denied = await app.inject({ method: "POST", url: `${chat}/sessions`, headers: { ...bearer(partitionKey), "idempotency-key": "shared-key" }, payload: {} });
        expect(denied.statusCode, String(partitionKey)).toBe(404);
        expect((await app.inject({ url: `${chat}/sessions/${sessionId}`, headers: bearer(partitionKey) })).statusCode, String(partitionKey)).toBe(404);
        expect((await app.inject({ method: "POST", url: `/api/research/notebooks/${notebooks.personal}/engine/sources`, headers: { ...bearer(partitionKey), "idempotency-key": "shared-key" }, payload: { title: "x", content: "y" } })).statusCode, String(partitionKey)).toBe(404);
      }
      // The same idempotency key in a sibling's own notebook is a fresh claim, not a replay of the personal receipt.
      const sibling = await app.inject({ method: "POST", url: `/api/research/notebooks/${notebooks.other}/engine/chat/sessions`, headers: { ...bearer("other"), "idempotency-key": "shared-key" }, payload: {} });
      expect(sibling.statusCode).toBe(201);
      expect(sibling.json().receipt.sessionId).not.toBe(sessionId);
      const workspaceSession = await app.inject({ method: "POST", url: `/api/research/notebooks/${notebooks.default}/engine/chat/sessions`, headers: { ...bearer(), "idempotency-key": "shared-key" }, payload: {} });
      expect(workspaceSession.statusCode).toBe(201);
      expect(workspaceSession.json().receipt.sessionId).not.toBe(sessionId);
      expect(stub.calls.filter((call) => call.path === "/api/chat/sessions" && call.method === "POST")).toHaveLength(3);
    } finally { await app.close(); }
  });
});
