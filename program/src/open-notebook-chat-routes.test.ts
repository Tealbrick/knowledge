import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import Fastify, { type FastifyInstance } from "fastify";
import { afterEach, describe, expect, it } from "vitest";
import { registerOpenNotebookRoutes, type OpenNotebookRouteAdapter } from "./open-notebook-routes.js";
import { createKnowledgePrincipalResolver } from "./knowledge-principal.js";
import { OpenNotebookChatError, type OpenNotebookChatAdapter, type OpenNotebookChatMessage } from "./open-notebook-chat.js";
import { ResearchChatLedger } from "./research-chat-ledger.js";
import type { ResearchPrincipalProvider } from "./portal-research-principal.js";

const base = "/api/research/notebooks/local-a/engine/chat";
const headers = (token = "alpha", key = "request-1") => ({ authorization: `Bearer ${token}`, "idempotency-key": key });
const apps: FastifyInstance[] = [];
const directories: string[] = [];
afterEach(async () => {
  for (const app of apps.splice(0)) await app.close();
  for (const directory of directories.splice(0)) await fs.rm(directory, { recursive: true, force: true });
});
function backend() {
  return { creates: 0, executes: 0, reads: 0, contexts: 0, mode: "ok" as "ok" | "ambiguous" | "rejected", sessions: new Map<string, OpenNotebookChatMessage[]>(), block: null as Promise<void> | null, started: null as (() => void) | null };
}
type Binding = { knowledgeNotebookId: string; companyId: string; externalNotebookId: string };
async function fixture(options: { dir?: string; state?: ReturnType<typeof backend>; deny?: boolean; contextRevokes?: boolean; dynamicRead?: boolean; modelId?: () => string | null; bindings?: () => readonly Binding[] } = {}) {
  const dir = options.dir ?? await fs.mkdtemp(path.join(os.tmpdir(), "knowledge-chat-routes-"));
  if (!options.dir) directories.push(dir);
  const state = options.state ?? backend();
  const app = Fastify();
  apps.push(app);
  const ledger = new ResearchChatLedger(path.join(dir, "chat.sqlite"));
  app.addHook("onClose", async () => ledger.close());
  app.addHook("preHandler", async (_request, reply) => { if (options.deny) reply.code(403).send({ error: "rules_denied" }); });
  let owner = "company-a";
  let readRevoked = false;
  let revokeReadAtHandler = false;
  if (options.dynamicRead) app.addHook("preHandler", async (request) => {
    if (revokeReadAtHandler && (request.url.includes("/messages") || request.url.includes("/receipts/"))) readRevoked = true;
  });
  const engine = {
    async getNotebookContext() { state.contexts++; if (options.contextRevokes) owner = "revoked"; return { sources: [], notes: [], tokenCount: 0, charCount: 0 }; },
  } as unknown as OpenNotebookRouteAdapter;
  const adapter = {
    async createChatSession(notebookId: string) {
      state.creates++;
      const id = `chat_session:upstream-${state.creates}`;
      state.sessions.set(id, []);
      return { id, notebookId, modelId: "model:fixture", title: "Fixture", created: "now", updated: "now", messages: [] };
    },
    async getChatSession(notebookId: string, id: string) {
      state.reads++;
      if (!state.sessions.has(id)) throw new OpenNotebookChatError("http_error", "session_get", "rejected", 404);
      return { id, notebookId, modelId: "model:fixture", title: "Fixture", created: "now", updated: "now", messages: state.sessions.get(id)! };
    },
    async executeChatMessage(_notebookId: string, id: string, request: { message: string }) {
      if (state.mode === "rejected") throw new OpenNotebookChatError("model_policy_mismatch", "models_defaults", "rejected");
      state.executes++;
      state.started?.();
      if (state.block) await state.block;
      if (state.mode === "ambiguous") throw new OpenNotebookChatError("timeout", "execute", "ambiguous");
      const answer = { id: `ai-${state.executes}`, type: "ai" as const, content: "Fixture answer" };
      state.sessions.get(id)!.push({ id: `human-${state.executes}`, type: "human", content: request.message }, answer);
      return answer;
    },
  } as unknown as OpenNotebookChatAdapter;
  registerOpenNotebookRoutes(app, {
    adapter: engine, chatAdapter: adapter, chatLedger: ledger, chatModelId: options.modelId ?? "model:fixture",
    researchPrincipalProvider: options.dynamicRead ? (async (_request, _capability) => {
      return ({
      kind: "service" as const, principalId: "agent-a", companyId: "company-a",
      capabilities: ["research:read", "research:write"],
      partitionGrants: readRevoked
        ? [
            { partitionKey: "company-a", breadth: "exact" as const, maxDepth: 0, capabilities: ["research:write"] },
            { partitionKey: "company-b", breadth: "exact" as const, maxDepth: 0, capabilities: ["research:read"] },
          ]
        : [{ partitionKey: "company-a", breadth: "exact" as const, maxDepth: 0, capabilities: ["research:read", "research:write"] }],
      });
    }) satisfies ResearchPrincipalProvider : undefined,
    principals: createKnowledgePrincipalResolver([
      { token: "alpha", principalId: "agent-a", companyId: "company-a", capabilities: ["research:read", "research:write"] },
      { token: "alpha-other", principalId: "agent-other", companyId: "company-a", capabilities: ["research:read", "research:write"] },
      { token: "beta", principalId: "agent-b", companyId: "company-b", capabilities: ["research:read", "research:write"] },
      { token: "write-only", principalId: "agent-write", companyId: "company-a", capabilities: ["research:write"] },
    ]),
    bindings: options.bindings ?? [{ knowledgeNotebookId: "local-a", companyId: "company-a", externalNotebookId: "notebook:external-a" }],
    resolveNotebookCompany: () => owner,
  });
  return { app, dir, state,
    create: (key = "create-1", token = "alpha") => app.inject({ method: "POST", url: `${base}/sessions`, headers: headers(token, key), payload: { title: "Fixture" } }),
    message: (id: string, key = "turn-1", message = "Question") => app.inject({ method: "POST", url: `${base}/sessions/${id}/messages`, headers: headers("alpha", key), payload: { message } }),
    revokeReadAtHandler: () => { revokeReadAtHandler = true; },
  };
}

describe("principal-owned durable Research chat routes", () => {
  it("reads the chat model and notebook bindings at request time (Settings -> Models sync, no restart)", async () => {
    let modelId: string | null = null;
    let bindings: readonly Binding[] = [];
    const f = await fixture({ modelId: () => modelId, bindings: () => bindings });
    expect((await f.create("create-a")).statusCode).toBe(404);
    bindings = [{ knowledgeNotebookId: "local-a", companyId: "company-a", externalNotebookId: "notebook:external-a" }];
    expect((await f.create("create-b")).json()).toEqual({ error: "research_chat_unavailable" });
    modelId = "model:fixture";
    expect((await f.create("create-c")).statusCode).toBe(201);
    // A conflicting union fails closed rather than picking one mapping.
    bindings = [...bindings, { knowledgeNotebookId: "local-b", companyId: "company-a", externalNotebookId: "notebook:external-a" }];
    expect((await f.create("create-d")).json()).toEqual({ error: "notebook_mapping_unavailable" });
  });

  it("creates local sessions and returns only the current durable assistant reply", async () => {
    const f = await fixture();
    const created = await f.create();
    expect(created.statusCode).toBe(201);
    const id = created.json().receipt.sessionId;
    expect(created.body).not.toContain("upstream-");
    const answer = await f.message(id);
    expect(answer.statusCode).toBe(201);
    expect(answer.json()).toMatchObject({ receipt: { operation: "message", state: "succeeded", answer: { type: "ai", content: "Fixture answer" } }, providerRetryPolicy: "upstream-controlled" });
    expect(answer.body).not.toContain("external-a");
    const history = await f.app.inject({ url: `${base}/sessions/${id}`, headers: headers() });
    expect(history.statusCode).toBe(200);
    expect(history.json().messages.map((item: { type: string }) => item.type)).toEqual(["human", "ai"]);
    expect(history.headers["cache-control"]).toBe("no-store");
    expect(f.state.creates).toBe(1); expect(f.state.executes).toBe(1);
  });

  it("replays create and answer receipts after restart without another upstream call", async () => {
    const first = await fixture();
    const created = await first.create();
    const id = created.json().receipt.sessionId;
    expect((await first.message(id)).statusCode).toBe(201);
    await first.app.close();
    const second = await fixture({ dir: first.dir, state: first.state });
    expect((await second.create()).json()).toMatchObject({ replayed: true, receipt: { sessionId: id } });
    const replay = await second.message(id);
    expect(replay.statusCode).toBe(200);
    expect(replay.json()).toMatchObject({ replayed: true, receipt: { answer: { content: "Fixture answer" } } });
    expect(second.state.creates).toBe(1); expect(second.state.executes).toBe(1); expect(second.state.contexts).toBe(1);
    expect((await second.message(id, "turn-1", "Different body")).statusCode).toBe(409);
  });

  it("rejects same-company other principals, other companies and missing read grants", async () => {
    const f = await fixture(); const id = (await f.create()).json().receipt.sessionId;
    const reads = f.state.reads;
    for (const token of ["alpha-other", "beta"]) {
      const result = await f.app.inject({ url: `${base}/sessions/${id}`, headers: headers(token) });
      expect([403, 404]).toContain(result.statusCode);
    }
    expect((await f.app.inject({ url: `${base}/sessions/${id}` })).statusCode).toBe(401);
    expect((await f.app.inject({ method: "POST", url: `${base}/sessions/${id}/messages`, headers: headers("write-only"), payload: { message: "x" } })).statusCode).toBe(403);
    expect(f.state.reads).toBe(reads); expect(f.state.executes).toBe(0);
  });

  it("rejects caller model/context/session overrides and missing idempotency keys", async () => {
    const f = await fixture();
    for (const payload of [{ title: "Fixture", modelId: "model:evil" }, { notebook_id: "notebook:evil" }, { context: {} }]) {
      expect((await f.app.inject({ method: "POST", url: `${base}/sessions`, headers: headers(), payload })).statusCode).toBe(400);
    }
    expect((await f.app.inject({ method: "POST", url: `${base}/sessions`, headers: { authorization: "Bearer alpha" }, payload: {} })).statusCode).toBe(400);
    expect(f.state.creates).toBe(0);
  });

  it("serializes different turn keys for one session", async () => {
    const f = await fixture(); const id = (await f.create()).json().receipt.sessionId;
    let release!: () => void;
    const started = new Promise<void>((resolve) => { f.state.started = resolve; });
    f.state.block = new Promise<void>((resolve) => { release = resolve; });
    const first = f.message(id);
    await started;
    expect((await f.message(id, "turn-2")).statusCode).toBe(409);
    release(); expect((await first).statusCode).toBe(201);
    expect(f.state.executes).toBe(1);
    f.state.block = null;
    expect((await f.message(id, "turn-2")).statusCode).toBe(201);
    expect(f.state.executes).toBe(2);
  });

  it("holds ambiguous turns across replay and blocks new turns", async () => {
    const f = await fixture(); const id = (await f.create()).json().receipt.sessionId;
    f.state.mode = "ambiguous";
    expect((await f.message(id)).statusCode).toBe(503);
    expect((await f.message(id)).statusCode).toBe(409);
    expect((await f.message(id, "new-key")).statusCode).toBe(409);
    const receipt = await f.app.inject({ url: `${base}/receipts/turn-1`, headers: headers() });
    expect(receipt.json().receipt.state).toBe("uncertain");
    expect((await f.app.inject({ url: `${base}/receipts/turn-1`, headers: headers("alpha-other") })).statusCode).toBe(404);
    expect(f.state.executes).toBe(1);
  });

  it("lets a known pre-dispatch rejection release the session without executing", async () => {
    const f = await fixture(); const id = (await f.create()).json().receipt.sessionId;
    f.state.mode = "rejected";
    expect((await f.message(id)).statusCode).toBe(502);
    expect(f.state.executes).toBe(0);
    f.state.mode = "ok";
    expect((await f.message(id, "new-key")).statusCode).toBe(201);
  });

  it("enforces Rules denial and revocation before execution", async () => {
    const denied = await fixture({ deny: true });
    expect((await denied.create()).statusCode).toBe(403); expect(denied.state.creates).toBe(0);
    const revoked = await fixture({ contextRevokes: true });
    const id = (await revoked.create()).json().receipt.sessionId;
    expect((await revoked.message(id)).statusCode).toBe(404); expect(revoked.state.executes).toBe(0);
  });

  it("rechecks notebook read grants before replaying cached answers and receipts", async () => {
    const replay = await fixture({ dynamicRead: true });
    const replayId = (await replay.create()).json().receipt.sessionId;
    expect((await replay.message(replayId)).statusCode).toBe(201);
    replay.revokeReadAtHandler();
    expect((await replay.message(replayId)).statusCode).toBe(404);

    const receipt = await fixture({ dynamicRead: true });
    const receiptId = (await receipt.create()).json().receipt.sessionId;
    expect((await receipt.message(receiptId)).statusCode).toBe(201);
    receipt.revokeReadAtHandler();
    expect((await receipt.app.inject({ url: `${base}/receipts/turn-1`, headers: headers() })).statusCode).toBe(404);
  });
});
