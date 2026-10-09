import Fastify, { type FastifyInstance } from "fastify";
import fs from "node:fs/promises";
import { afterEach, describe, expect, it } from "vitest";
import { createKnowledgePrincipalResolver } from "./knowledge-principal.js";
import {
  OpenNotebookAdapterError,
  type OpenNotebookNote,
  type OpenNotebookNotebook,
  type OpenNotebookSource,
} from "./open-notebook.js";
import {
  registerOpenNotebookRoutes,
  type OpenNotebookNotebookBinding,
  type OpenNotebookRouteAdapter,
} from "./open-notebook-routes.js";
import { ResearchWriteLedger } from "./research-write-ledger.js";

type WriteAdapter = OpenNotebookRouteAdapter & {
  createNotebookTextSource: (...args: unknown[]) => Promise<OpenNotebookSource>;
};

type FixtureState = {
  readonly createCalls: { count: number };
  readonly verifyCalls: { count: number };
  readonly delayMs?: number;
  readonly createError?: Error;
  readonly sourceId: string;
};

const binding: OpenNotebookNotebookBinding = {
  knowledgeNotebookId: "notebook:local-a",
  companyId: "company-alpha",
  externalNotebookId: "notebook:external-a",
};

const writePrincipal = {
  token: "write-token-alpha",
  principalId: "principal-alpha-writer",
  companyId: "company-alpha",
  capabilities: ["research:write"],
};

const secondWritePrincipal = {
  token: "write-token-alpha-second",
  principalId: "principal-alpha-second",
  companyId: "company-alpha",
  capabilities: ["research:write"],
};

const readOnlyPrincipal = {
  token: "read-token-alpha",
  principalId: "principal-alpha-reader",
  companyId: "company-alpha",
  capabilities: ["research:read"],
};

const otherCompanyPrincipal = {
  token: "write-token-beta",
  principalId: "principal-beta-writer",
  companyId: "company-beta",
  capabilities: ["research:write"],
};

const notebook: OpenNotebookNotebook = {
  id: binding.externalNotebookId,
  name: "External fixture notebook",
  description: "Synthetic",
  archived: false,
  created: "2026-09-06T00:00:00Z",
  updated: "2026-09-06T00:00:00Z",
  sourceCount: 1,
  noteCount: 0,
};

const note: OpenNotebookNote = {
  id: "note:unused",
  title: null,
  content: null,
  noteType: null,
  created: "2026-09-06T00:00:00Z",
  updated: "2026-09-06T00:00:00Z",
  commandId: null,
};

const source = (sourceId: string, title: string, content: string): OpenNotebookSource => ({
  id: sourceId,
  title,
  topics: [],
  asset: { filePath: "/private/provider/path", url: "https://provider.example/source" },
  fullText: content,
  embedded: false,
  embeddedChunks: 0,
  insightsCount: 0,
  fileAvailable: null,
  created: "2026-09-06T00:00:00Z",
  updated: "2026-09-06T00:00:00Z",
  commandId: null,
  status: "ready",
});

const apps: FastifyInstance[] = [];
const ledgers: ResearchWriteLedger[] = [];
const roots: string[] = [];

afterEach(async () => {
  for (const app of apps.splice(0)) await app.close();
  for (const ledger of ledgers.splice(0)) ledger.close();
  for (const root of roots.splice(0)) await fs.rm(root, { recursive: true, force: true });
});

function fakeAdapter(state: FixtureState): WriteAdapter {
  return {
    async getNotebook(externalId) {
      return { ...notebook, id: externalId };
    },
    async listNotebookSources() {
      return [];
    },
    async listNotebookNotes() {
      return [note];
    },
    async getNotebookSource(_externalId, sourceId) {
      state.verifyCalls.count += 1;
      return source(sourceId, "Verified source", "verified content");
    },
    async createNotebookTextSource(...args: unknown[]) {
      state.createCalls.count += 1;
      if (state.delayMs) await new Promise((resolve) => setTimeout(resolve, state.delayMs));
      if (state.createError) throw state.createError;
      const request = args.find((value): value is { title: string; content: string } => value !== null && typeof value === "object" && "title" in value && "content" in value);
      const title = request?.title ?? String(args[1] ?? "Fixture source");
      const content = request?.content ?? String(args[2] ?? "fixture content");
      return source(state.sourceId, title, content);
    },
  };
}

async function buildHarness(input: {
  readonly dbPath: string;
  readonly adapter: WriteAdapter;
  readonly principals?: readonly typeof writePrincipal[];
  readonly rulesDeny?: boolean;
}): Promise<{ readonly app: FastifyInstance; readonly ledger: ResearchWriteLedger }> {
  const app = Fastify();
  const ledger = new ResearchWriteLedger(input.dbPath);
  const principals = createKnowledgePrincipalResolver(input.principals ?? [writePrincipal, secondWritePrincipal, readOnlyPrincipal, otherCompanyPrincipal]);
  if (input.rulesDeny) {
    app.addHook("preHandler", async (_request, reply) => {
      reply.code(403).send({ error: "rules_denied" });
    });
  }
  registerOpenNotebookRoutes(app, {
    adapter: input.adapter,
    principals,
    bindings: [binding],
    resolveNotebookCompany: (id: string) => id === binding.knowledgeNotebookId ? binding.companyId : null,
    ledger,
  } as never);
  await app.ready();
  apps.push(app);
  ledgers.push(ledger);
  return { app, ledger };
}

function auth(token: string): Record<string, string> {
  return { authorization: `Bearer ${token}` };
}

function writeUrl() {
  return `/api/research/notebooks/${encodeURIComponent(binding.knowledgeNotebookId)}/engine/sources`;
}

function receiptUrl(key: string) {
  return `/api/research/notebooks/${encodeURIComponent(binding.knowledgeNotebookId)}/engine/write-receipts/${encodeURIComponent(key)}`;
}

function payload(content = "synthetic write content") {
  return { title: "Synthetic source", content };
}

async function fixturePath(): Promise<string> {
  const directory = await fs.mkdtemp("/tmp/knowledge-write-routes-");
  roots.push(directory);
  return `${directory}/ledger.sqlite`;
}

describe("Open Notebook text-source write routes", () => {
  it("claims, creates, verifies, and returns only a safe 201 receipt", async () => {
    const dbPath = await fixturePath();
    const state: FixtureState = { createCalls: { count: 0 }, verifyCalls: { count: 0 }, sourceId: "source:created-1" };
    const { app } = await buildHarness({ dbPath, adapter: fakeAdapter(state) });
    const response = await app.inject({
      method: "POST",
      url: writeUrl(),
      headers: { ...auth(writePrincipal.token), "idempotency-key": "write-001" },
      payload: payload(),
    });

    expect(response.statusCode).toBe(201);
    expect(response.json()).toMatchObject({
      replayed: false,
      receipt: {
        state: "succeeded",
        sourceId: "source:created-1",
        idempotencyKey: "write-001",
        errorCode: null,
      },
    });
    expect(response.json().receipt.createdAt).toEqual(expect.any(String));
    expect(response.json().receipt.updatedAt).toEqual(expect.any(String));
    expect(Object.keys(response.json().receipt).sort()).toEqual(["createdAt", "errorCode", "idempotencyKey", "sourceId", "state", "updatedAt"].sort());
    expect(state.createCalls.count).toBe(1);
    expect(state.verifyCalls.count).toBe(1);
    expect(response.body).not.toContain("/private/provider/path");
  });

  it("replays a terminal result after ledger restart without calling the adapter again", async () => {
    const dbPath = await fixturePath();
    const firstState: FixtureState = { createCalls: { count: 0 }, verifyCalls: { count: 0 }, sourceId: "source:restart-1" };
    const first = await buildHarness({ dbPath, adapter: fakeAdapter(firstState) });
    const firstResponse = await first.app.inject({ method: "POST", url: writeUrl(), headers: { ...auth(writePrincipal.token), "idempotency-key": "restart-001" }, payload: payload() });
    expect(firstResponse.statusCode).toBe(201);
    await first.app.close();
    apps.splice(apps.indexOf(first.app), 1);
    first.ledger.close();
    ledgers.splice(ledgers.indexOf(first.ledger), 1);

    const secondState: FixtureState = { createCalls: { count: 0 }, verifyCalls: { count: 0 }, sourceId: "source:must-not-create" };
    const second = await buildHarness({ dbPath, adapter: fakeAdapter(secondState) });
    const replay = await second.app.inject({ method: "POST", url: writeUrl(), headers: { ...auth(writePrincipal.token), "idempotency-key": "restart-001" }, payload: payload() });
    expect(replay.statusCode).toBe(200);
    expect(replay.json()).toMatchObject({ replayed: true, receipt: { state: "succeeded", sourceId: "source:restart-1" } });
    expect(secondState.createCalls.count).toBe(0);
    expect(secondState.verifyCalls.count).toBe(0);
  });

  it("returns one success and one reconciliation response for concurrent duplicate writes", async () => {
    const dbPath = await fixturePath();
    const state: FixtureState = { createCalls: { count: 0 }, verifyCalls: { count: 0 }, delayMs: 40, sourceId: "source:concurrent-1" };
    const first = await buildHarness({ dbPath, adapter: fakeAdapter(state) });
    const second = await buildHarness({ dbPath, adapter: fakeAdapter(state) });
    const request = (app: FastifyInstance) => app.inject({ method: "POST", url: writeUrl(), headers: { ...auth(writePrincipal.token), "idempotency-key": "concurrent-001" }, payload: payload() });
    const responses = await Promise.all([request(first.app), request(second.app)]);
    expect(responses.map((item) => item.statusCode).sort()).toEqual([201, 409]);
    expect(responses.find((item) => item.statusCode === 409)?.json()).toMatchObject({ error: "reconciliation_required" });
    expect(state.createCalls.count).toBe(1);
  });

  it("rejects changed body and changed idempotency key inputs without upstream calls", async () => {
    const dbPath = await fixturePath();
    const state: FixtureState = { createCalls: { count: 0 }, verifyCalls: { count: 0 }, sourceId: "source:conflict-1" };
    const { app } = await buildHarness({ dbPath, adapter: fakeAdapter(state) });
    const first = await app.inject({ method: "POST", url: writeUrl(), headers: { ...auth(writePrincipal.token), "idempotency-key": "conflict-001" }, payload: payload() });
    expect(first.statusCode).toBe(201);
    const changed = await app.inject({ method: "POST", url: writeUrl(), headers: { ...auth(writePrincipal.token), "idempotency-key": "conflict-001" }, payload: payload("changed body") });
    expect(changed.statusCode).toBe(409);
    const missingKey = await app.inject({ method: "POST", url: writeUrl(), headers: auth(writePrincipal.token), payload: payload() });
    expect(missingKey.statusCode).toBe(400);
    const malformedKey = await app.inject({ method: "POST", url: writeUrl(), headers: { ...auth(writePrincipal.token), "idempotency-key": "contains whitespace" }, payload: payload() });
    expect(malformedKey.statusCode).toBe(400);
    const invalidBody = await app.inject({ method: "POST", url: writeUrl(), headers: { ...auth(writePrincipal.token), "idempotency-key": "invalid-body" }, payload: { ...payload(), companyId: "forged" } });
    expect(invalidBody.statusCode).toBe(400);
    expect(state.createCalls.count).toBe(1);
  });

  it("requires write capability and mapped company scope", async () => {
    const dbPath = await fixturePath();
    const state: FixtureState = { createCalls: { count: 0 }, verifyCalls: { count: 0 }, sourceId: "source:scope-1" };
    const { app } = await buildHarness({ dbPath, adapter: fakeAdapter(state) });
    const readOnly = await app.inject({ method: "POST", url: writeUrl(), headers: { ...auth(readOnlyPrincipal.token), "idempotency-key": "scope-read-only" }, payload: payload() });
    expect(readOnly.statusCode).toBe(403);
    const otherCompany = await app.inject({ method: "POST", url: writeUrl(), headers: { ...auth(otherCompanyPrincipal.token), "idempotency-key": "scope-company" }, payload: payload() });
    expect(otherCompany.statusCode).toBe(404);
    expect(state.createCalls.count).toBe(0);
  });

  it("holds an ambiguous upstream write and never resubmits it", async () => {
    const dbPath = await fixturePath();
    const state: FixtureState = { createCalls: { count: 0 }, verifyCalls: { count: 0 }, sourceId: "source:timeout-1", createError: new OpenNotebookAdapterError("timeout", "notebook") };
    const { app } = await buildHarness({ dbPath, adapter: fakeAdapter(state) });
    const first = await app.inject({ method: "POST", url: writeUrl(), headers: { ...auth(writePrincipal.token), "idempotency-key": "timeout-001" }, payload: payload() });
    expect(first.statusCode).toBe(503);
    expect(first.json()).toMatchObject({ error: "reconciliation_required" });
    const second = await app.inject({ method: "POST", url: writeUrl(), headers: { ...auth(writePrincipal.token), "idempotency-key": "timeout-001" }, payload: payload() });
    expect(second.statusCode).toBe(409);
    expect(second.json()).toMatchObject({ error: "reconciliation_required" });
    expect(state.createCalls.count).toBe(1);
  });

  it("isolates receipt reads by the attested principal and keeps failures secret-safe", async () => {
    const dbPath = await fixturePath();
    const state: FixtureState = { createCalls: { count: 0 }, verifyCalls: { count: 0 }, sourceId: "source:receipt-1", createError: new Error("provider=https://secret.example/token=upstream-secret") };
    const { app } = await buildHarness({ dbPath, adapter: fakeAdapter(state) });
    const failed = await app.inject({ method: "POST", url: writeUrl(), headers: { ...auth(writePrincipal.token), "idempotency-key": "receipt-001" }, payload: payload("provider-secret-content") });
    expect(failed.statusCode).toBe(503);
    expect(failed.body).not.toContain("upstream-secret");
    expect(failed.body).not.toContain("provider-secret-content");
    const receipt = await app.inject({ method: "GET", url: receiptUrl("receipt-001"), headers: auth(secondWritePrincipal.token) });
    expect([403, 404]).toContain(receipt.statusCode);
    expect(receipt.body).not.toContain("upstream-secret");
  });

  it("lets a Rules-like preHandler deny before claim or upstream side effect", async () => {
    const dbPath = await fixturePath();
    const state: FixtureState = { createCalls: { count: 0 }, verifyCalls: { count: 0 }, sourceId: "source:rules-1" };
    const { app, ledger } = await buildHarness({ dbPath, adapter: fakeAdapter(state), rulesDeny: true });
    const response = await app.inject({ method: "POST", url: writeUrl(), headers: { ...auth(writePrincipal.token), "idempotency-key": "rules-001" }, payload: payload() });
    expect(response.statusCode).toBe(403);
    expect(state.createCalls.count).toBe(0);
    expect(ledger.get({ ...binding, principalId: writePrincipal.principalId }, "rules-001")).toBeNull();
  });
});
