import Fastify, { type FastifyInstance } from "fastify";
import { afterEach, describe, expect, it } from "vitest";
import {
  OPEN_NOTEBOOK_CONTRACT_BASELINE,
  OPEN_NOTEBOOK_OBSERVED_VERSION,
  OpenNotebookAdapterError,
  type OpenNotebookNote,
  type OpenNotebookNotebook,
  type OpenNotebookSourceListOptions,
  type OpenNotebookSource,
} from "./open-notebook.js";
import { createKnowledgePrincipalResolver } from "./knowledge-principal.js";
import {
  registerOpenNotebookRoutes,
  type OpenNotebookNotebookBinding,
  type OpenNotebookRouteAdapter,
} from "./open-notebook-routes.js";

const alphaBinding: OpenNotebookNotebookBinding = {
  knowledgeNotebookId: "notebook:alpha",
  companyId: "company-alpha",
  externalNotebookId: "notebook:upstream-alpha",
};

const betaBinding: OpenNotebookNotebookBinding = {
  knowledgeNotebookId: "notebook:beta",
  companyId: "company-beta",
  externalNotebookId: "notebook:upstream-beta",
};

const alphaPrincipal = {
  token: "knowledge-alpha-route-token",
  principalId: "service-knowledge-alpha",
  companyId: "company-alpha",
  capabilities: ["research:read"],
};

const betaPrincipal = {
  token: "knowledge-beta-route-token",
  principalId: "service-knowledge-beta",
  companyId: "company-beta",
  capabilities: ["research:read"],
};

const notebook: OpenNotebookNotebook = {
  id: alphaBinding.externalNotebookId,
  name: "Alpha notebook",
  description: "Read-only fixture",
  archived: false,
  created: "2026-09-06T00:00:00Z",
  updated: "2026-09-06T00:00:00Z",
  sourceCount: 1,
  noteCount: 1,
};

const source: OpenNotebookSource = {
  id: "source:alpha",
  title: "Alpha source",
  topics: ["alpha"],
  asset: { filePath: "/private/provider/path.pdf", url: "https://source.example/alpha" },
  fullText: "Alpha source text",
  embedded: true,
  embeddedChunks: 2,
  insightsCount: 1,
  fileAvailable: true,
  created: "2026-09-06T00:00:00Z",
  updated: "2026-09-06T00:00:00Z",
  commandId: null,
  status: "ready",
};

const note: OpenNotebookNote = {
  id: "note:alpha",
  title: "Alpha note",
  content: "Alpha note content",
  noteType: "human",
  created: "2026-09-06T00:00:00Z",
  updated: "2026-09-06T00:00:00Z",
  commandId: null,
};

function bearer(token: string) {
  return { authorization: `Bearer ${token}` };
}

function createAdapter(calls: string[] = []): OpenNotebookRouteAdapter {
  return {
    async getNotebook(externalId) {
      calls.push(`notebook:${externalId}`);
      return { ...notebook, id: externalId };
    },
    async listNotebookSources(externalId) {
      calls.push(`sources:${externalId}`);
      return [source];
    },
    async listNotebookNotes(externalId) {
      calls.push(`notes:${externalId}`);
      return [{ ...note, id: `note:${externalId}` }];
    },
    async getNotebookNote(externalId, noteId) {
      calls.push(`note:${externalId}:${noteId}`);
      return { ...note, id: noteId };
    },
    async getNotebookSource(externalId, sourceId) {
      calls.push(`source:${externalId}:${sourceId}`);
      return { ...source, id: sourceId };
    },
  };
}

async function buildApp(
  overrides: Partial<{
    adapter: OpenNotebookRouteAdapter | null;
    bindings: readonly OpenNotebookNotebookBinding[];
    principals: ReturnType<typeof createKnowledgePrincipalResolver>;
    resolveNotebookCompany: (id: string) => string | null;
  }> = {},
): Promise<{ app: FastifyInstance; calls: string[]; seenPrincipal: { principalId: string } | null; owner: { value: string | null } }> {
  const app = Fastify();
  const calls: string[] = [];
  const state: { seenPrincipal: { principalId: string } | null; owner: { value: string | null } } = { seenPrincipal: null, owner: { value: alphaBinding.companyId } };
  app.addHook("onResponse", (request, _reply, done) => {
    state.seenPrincipal = request.knowledgePrincipal ? { principalId: request.knowledgePrincipal.principalId } : null;
    done();
  });
  const resolveOwner = overrides.resolveNotebookCompany ?? ((id: string) => id === alphaBinding.knowledgeNotebookId ? alphaBinding.companyId : id === betaBinding.knowledgeNotebookId ? betaBinding.companyId : null);
  registerOpenNotebookRoutes(app, {
    adapter: overrides.adapter === undefined ? createAdapter(calls) : overrides.adapter,
    principals: overrides.principals ?? createKnowledgePrincipalResolver([alphaPrincipal, betaPrincipal]),
    bindings: overrides.bindings ?? [alphaBinding, betaBinding],
    resolveNotebookCompany: (id) => overrides.resolveNotebookCompany ? overrides.resolveNotebookCompany(id) : (state.owner.value && resolveOwner(id)),
  });
  await app.ready();
  return {
    app,
    calls,
    get seenPrincipal() { return state.seenPrincipal; },
    owner: state.owner,
  };
}

const openApps: FastifyInstance[] = [];

afterEach(async () => {
  for (const app of openApps.splice(0)) await app.close();
});

describe("Open Notebook Knowledge routes", () => {
  it("builds context only from the server mapping and rejects caller selectors", async () => {
    const calls: string[] = [];
    const fixture = await buildApp({ adapter: {
      ...createAdapter(),
      async getNotebookContext(id) {
        calls.push(id);
        return { sources: [{ id: "source:alpha", title: "Alpha", fullText: "Synthetic source", insights: [] }], notes: [], tokenCount: 5, charCount: 20 };
      },
    } });
    openApps.push(fixture.app);
    const endpoint = "/api/research/notebooks/notebook:alpha/engine/context";
    expect((await fixture.app.inject({ url: endpoint })).statusCode).toBe(401);
    expect((await fixture.app.inject({ url: endpoint, headers: bearer(betaPrincipal.token) })).statusCode).toBe(403);
    for (const query of ["sourceId=source:beta", "notebook_id=notebook:beta", "context_config=forged", "companyId=company-beta"]) {
      expect((await fixture.app.inject({ url: `${endpoint}?${query}`, headers: bearer(alphaPrincipal.token) })).statusCode).toBe(400);
    }
    expect((await fixture.app.inject({ method: "GET", url: endpoint, headers: { ...bearer(alphaPrincipal.token), "content-type": "application/json" }, payload: { context_config: { sources: { "source:beta": "full content" } } } })).statusCode).toBe(400);
    expect(calls).toEqual([]);
    const result = await fixture.app.inject({ url: endpoint, headers: bearer(alphaPrincipal.token) });
    expect(result.statusCode).toBe(200);
    expect(result.headers["cache-control"]).toBe("no-store");
    expect(result.json()).toMatchObject({ provider: "open_notebook", modelInvoked: false, contextPolicy: "server-selected-full-content", context: { sources: [{ id: "source:alpha", fullText: "Synthetic source" }] } });
    expect(calls).toEqual([alphaBinding.externalNotebookId]);
  });

  it("rechecks context scope before disclosing a long-running result", async () => {
    let owner = alphaBinding.companyId;
    const fixture = await buildApp({ resolveNotebookCompany: () => owner, adapter: {
      ...createAdapter(),
      async getNotebookContext() { owner = "revoked-company"; return { sources: [], notes: [], tokenCount: 0, charCount: 0 }; },
    } });
    openApps.push(fixture.app);
    const response = await fixture.app.inject({ url: "/api/research/notebooks/notebook:alpha/engine/context", headers: bearer(alphaPrincipal.token) });
    expect(response.statusCode).toBe(403);
    expect(response.json()).toEqual({ error: "notebook_scope_denied" });
  });

  it.each([
    ["context_limit_exceeded", 413, "research_context_limit_exceeded"],
    ["context_membership_changed", 409, "research_context_membership_changed"],
    ["incomplete_context", 502, "research_context_incomplete"],
  ] as const)("projects %s without raw upstream details", async (code, status, error) => {
    const fixture = await buildApp({ adapter: { ...createAdapter(), async getNotebookContext() { throw new OpenNotebookAdapterError(code, "notebook_context"); } } });
    openApps.push(fixture.app);
    const response = await fixture.app.inject({ url: "/api/research/notebooks/notebook:alpha/engine/context", headers: bearer(alphaPrincipal.token) });
    expect(response.statusCode).toBe(status);
    expect(response.json()).toEqual({ error });
  });

  it("authenticates, enforces the mapped company, and projects all four read routes", async () => {
    const fixture = await buildApp();
    openApps.push(fixture.app);

    const notebookResponse = await fixture.app.inject({ method: "GET", url: "/api/research/notebooks/notebook:alpha/engine", headers: bearer(alphaPrincipal.token) });
    expect(notebookResponse.statusCode).toBe(200);
    expect(notebookResponse.json()).toEqual({
      provider: "open_notebook",
      contractBaseline: OPEN_NOTEBOOK_CONTRACT_BASELINE,
      observedVersion: OPEN_NOTEBOOK_OBSERVED_VERSION,
      notebook: {
        id: alphaBinding.externalNotebookId,
        name: notebook.name,
        description: notebook.description,
        archived: notebook.archived,
        created: notebook.created,
        updated: notebook.updated,
        sourceCount: notebook.sourceCount,
        noteCount: notebook.noteCount,
      },
    });

    const sourcesResponse = await fixture.app.inject({ method: "GET", url: "/api/research/notebooks/notebook:alpha/engine/sources", headers: bearer(alphaPrincipal.token) });
    expect(sourcesResponse.statusCode).toBe(200);
    expect(sourcesResponse.json().pagination).toEqual({ limit: 50, offset: 0 });
    expect(sourcesResponse.json().sources[0]).toMatchObject({ id: source.id, asset: { url: source.asset?.url } });
    expect(JSON.stringify(sourcesResponse.json())).not.toContain("private/provider/path.pdf");
    expect(sourcesResponse.json().sources[0].asset.filePath).toBeUndefined();

    const notesResponse = await fixture.app.inject({ method: "GET", url: "/api/research/notebooks/notebook:alpha/engine/notes", headers: bearer(alphaPrincipal.token) });
    expect(notesResponse.statusCode).toBe(200);
    expect(notesResponse.json().notes[0]).toMatchObject({ id: `note:${alphaBinding.externalNotebookId}`, content: note.content });

    const sourceResponse = await fixture.app.inject({ method: "GET", url: "/api/research/notebooks/notebook:alpha/engine/sources/source:alpha", headers: bearer(alphaPrincipal.token) });
    expect(sourceResponse.statusCode).toBe(200);
    expect(sourceResponse.json().source).toMatchObject({ id: "source:alpha", fullText: source.fullText });
    expect(JSON.stringify(sourceResponse.json())).not.toContain("private/provider/path.pdf");
    expect(fixture.calls).toEqual([
      `notebook:${alphaBinding.externalNotebookId}`,
      `sources:${alphaBinding.externalNotebookId}`,
      `notes:${alphaBinding.externalNotebookId}`,
      `source:${alphaBinding.externalNotebookId}:source:alpha`,
    ]);
  });

  it("authenticates note detail, rejects caller selectors, and returns only the scoped projection", async () => {
    const fixture = await buildApp();
    openApps.push(fixture.app);
    const endpoint = "/api/research/notebooks/notebook:alpha/engine/notes/note:alpha";

    expect((await fixture.app.inject({ method: "GET", url: endpoint })).statusCode).toBe(401);
    expect((await fixture.app.inject({ method: "GET", url: endpoint, headers: bearer(betaPrincipal.token) })).statusCode).toBe(403);
    expect((await fixture.app.inject({ method: "GET", url: `${endpoint}?notebookId=notebook:beta`, headers: bearer(alphaPrincipal.token) })).statusCode).toBe(400);
    expect((await fixture.app.inject({
      method: "GET",
      url: endpoint,
      headers: { ...bearer(alphaPrincipal.token), "content-type": "application/json" },
      payload: { notebookId: "notebook:beta" },
    })).statusCode).toBe(400);

    const response = await fixture.app.inject({ method: "GET", url: endpoint, headers: bearer(alphaPrincipal.token) });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      provider: "open_notebook",
      note: { id: "note:alpha", content: note.content },
    });
    expect(fixture.calls).toEqual([`note:${alphaBinding.externalNotebookId}:note:alpha`]);

    const noCapability = await buildApp({
      principals: createKnowledgePrincipalResolver([{ ...alphaPrincipal, token: "no-note-capability", capabilities: ["notebooks:read"] }]),
    });
    openApps.push(noCapability.app);
    expect((await noCapability.app.inject({ method: "GET", url: endpoint, headers: bearer("no-note-capability") })).statusCode).toBe(403);
    expect(noCapability.calls).toEqual([]);

    const ownerChanged = await buildApp({ resolveNotebookCompany: () => "company-other" });
    openApps.push(ownerChanged.app);
    expect((await ownerChanged.app.inject({ method: "GET", url: endpoint, headers: bearer(alphaPrincipal.token) })).statusCode).toBe(403);
    expect(ownerChanged.calls).toEqual([]);
  });

  it("rechecks local principal and notebook ownership before disclosing note detail", async () => {
    let owner = alphaBinding.companyId;
    const fixture = await buildApp({
      resolveNotebookCompany: () => owner,
      adapter: {
        ...createAdapter(),
        async getNotebookNote() {
          owner = "revoked-company";
          return note;
        },
      },
    });
    openApps.push(fixture.app);
    const response = await fixture.app.inject({
      method: "GET",
      url: "/api/research/notebooks/notebook:alpha/engine/notes/note:alpha",
      headers: bearer(alphaPrincipal.token),
    });
    expect(response.statusCode).toBe(403);
    expect(response.json()).toEqual({ error: "notebook_scope_denied" });
    expect(response.body).not.toContain(note.content!);
  });

  it("sets the server-resolved principal only after authorization succeeds", async () => {
    const fixture = await buildApp();
    openApps.push(fixture.app);
    const response = await fixture.app.inject({ method: "GET", url: "/api/research/notebooks/notebook:alpha/engine", headers: bearer(alphaPrincipal.token) });
    expect(response.statusCode).toBe(200);
    expect(fixture.seenPrincipal).toEqual({ principalId: alphaPrincipal.principalId });
  });

  it("passes explicit bounded pagination and fixed ordering to the notebook-scoped adapter", async () => {
    let received: OpenNotebookSourceListOptions | undefined;
    const fixture = await buildApp({
      adapter: {
        ...createAdapter(),
        async listNotebookSources(externalId, options) {
          received = options;
          return [{ ...source, id: externalId }];
        },
      },
    });
    openApps.push(fixture.app);
    const response = await fixture.app.inject({ method: "GET", url: "/api/research/notebooks/notebook:alpha/engine/sources?limit=2&offset=3", headers: bearer(alphaPrincipal.token) });
    expect(response.statusCode).toBe(200);
    expect(received).toEqual({ limit: 2, offset: 3, sortBy: "updated", sortOrder: "desc" });
    expect(response.json().pagination).toEqual({ limit: 2, offset: 3 });
  });

  it("rechecks owner scope immediately before the adapter after an earlier hook changes it", async () => {
    const app = Fastify();
    const calls: string[] = [];
    let owner: string | null = alphaBinding.companyId;
    app.addHook("preHandler", async () => {
      owner = null;
    });
    registerOpenNotebookRoutes(app, {
      adapter: createAdapter(calls),
      principals: createKnowledgePrincipalResolver([alphaPrincipal]),
      bindings: [alphaBinding],
      resolveNotebookCompany: () => owner,
    });
    await app.ready();
    openApps.push(app);

    const response = await app.inject({ method: "GET", url: "/api/research/notebooks/notebook:alpha/engine", headers: bearer(alphaPrincipal.token) });
    expect(response.statusCode).toBe(404);
    expect(response.json()).toEqual({ error: "notebook_not_found" });
    expect(calls).toEqual([]);
  });

  it("rejects malformed pagination without upstream calls", async () => {
    const fixture = await buildApp();
    openApps.push(fixture.app);
    for (const query of ["limit=101", "limit=0", "offset=-1", "offset=10000001", "limit=1&limit=2", "companyId=forged"]) {
      const response = await fixture.app.inject({ url: `/api/research/notebooks/notebook:alpha/engine/sources?${query}`, headers: bearer(alphaPrincipal.token) });
      expect(response.statusCode).toBe(400);
    }
    expect(fixture.calls).toEqual([]);
  });

  it("rechecks credential revocation after the Rules hook boundary", async () => {
    const app = Fastify();
    const calls: string[] = [];
    const original = createKnowledgePrincipalResolver([alphaPrincipal]);
    let revoked = false;
    app.addHook("preHandler", async () => { revoked = true; });
    registerOpenNotebookRoutes(app, {
      adapter: createAdapter(calls),
      principals: { configured: true, resolve: (token) => revoked ? null : original.resolve(token) },
      bindings: [alphaBinding], resolveNotebookCompany: () => alphaBinding.companyId,
    });
    openApps.push(app);
    const response = await app.inject({ url: "/api/research/notebooks/notebook:alpha/engine", headers: bearer(alphaPrincipal.token) });
    expect(response.statusCode).toBe(401);
    expect(calls).toEqual([]);
  });

  it.each([
    ["missing bearer", "/api/research/notebooks/notebook:alpha/engine", {}, 401, "authentication_required"],
    ["unknown bearer", "/api/research/notebooks/notebook:alpha/engine", bearer("revoked-or-unknown"), 401, "authentication_required"],
    ["missing object", "/api/research/notebooks/notebook:missing/engine", bearer(alphaPrincipal.token), 404, "notebook_not_found"],
    ["cross-company principal", "/api/research/notebooks/notebook:alpha/engine", bearer(betaPrincipal.token), 403, "notebook_scope_denied"],
    ["current owner changed", "/api/research/notebooks/notebook:alpha/engine", bearer(alphaPrincipal.token), 403, "notebook_scope_denied"],
    ["insufficient capability", "/api/research/notebooks/notebook:alpha/engine", bearer("no-research-capability"), 403, "insufficient_capability"],
  ] as const)("rejects %s before any upstream call", async (label, url, headers, statusCode, error) => {
    const fixture = await buildApp({
      principals: label === "insufficient capability"
        ? createKnowledgePrincipalResolver([{ ...alphaPrincipal, token: "no-research-capability", capabilities: ["notebooks:read"] }])
        : undefined,
      resolveNotebookCompany: label === "current owner changed" ? () => "company-other" : undefined,
    });
    openApps.push(fixture.app);
    const response = await fixture.app.inject({ method: "GET", url, headers });
    expect(response.statusCode, label).toBe(statusCode);
    expect(response.json()).toEqual({ error });
    expect(fixture.calls).toEqual([]);
  });

  it("fails closed for invalid and duplicate mappings without calling the adapter", async () => {
    for (const bindings of [
      [{ ...alphaBinding, externalNotebookId: "" }],
      [alphaBinding, alphaBinding],
      [alphaBinding, { ...betaBinding, externalNotebookId: alphaBinding.externalNotebookId }],
      [{ ...alphaBinding, unexpected: "caller" }],
    ] as const) {
      const fixture = await buildApp({ bindings: bindings as unknown as OpenNotebookNotebookBinding[] });
      openApps.push(fixture.app);
      const response = await fixture.app.inject({ method: "GET", url: "/api/research/notebooks/notebook:alpha/engine", headers: bearer(alphaPrincipal.token) });
      expect(response.statusCode).toBe(503);
      expect(response.json()).toEqual({ error: "notebook_mapping_unavailable" });
      expect(fixture.calls).toEqual([]);
    }
  });

  it("treats absent principal configuration and absent engine as unavailable, without fallback", async () => {
    const unconfigured = await buildApp({ principals: createKnowledgePrincipalResolver([]) });
    openApps.push(unconfigured.app);
    await expect(unconfigured.app.inject({ method: "GET", url: "/api/research/notebooks/notebook:alpha/engine", headers: bearer(alphaPrincipal.token) })).resolves.toMatchObject({ statusCode: 503 });
    expect(unconfigured.calls).toEqual([]);

    const noAdapter = await buildApp({ adapter: null });
    openApps.push(noAdapter.app);
    const response = await noAdapter.app.inject({ method: "GET", url: "/api/research/notebooks/notebook:alpha/engine", headers: bearer(alphaPrincipal.token) });
    expect(response.statusCode).toBe(503);
    expect(response.json()).toEqual({ error: "research_engine_unavailable" });
    expect(noAdapter.calls).toEqual([]);
  });

  it("maps upstream failures to safe responses without exposing error details", async () => {
    const calls: string[] = [];
    const fixture = await buildApp({
      adapter: {
        ...createAdapter(calls),
        async getNotebook() {
          throw new Error("https://provider.example/private?token=upstream-secret");
        },
      },
    });
    openApps.push(fixture.app);
    const response = await fixture.app.inject({ method: "GET", url: "/api/research/notebooks/notebook:alpha/engine", headers: bearer(alphaPrincipal.token) });
    expect(response.statusCode).toBe(503);
    expect(response.json()).toEqual({ error: "research_engine_unavailable" });
    expect(response.body).not.toContain("upstream-secret");

    const contractFixture = await buildApp({
      adapter: {
        ...createAdapter(),
        async getNotebook() {
          throw new OpenNotebookAdapterError("malformed_response", "notebook");
        },
      },
    });
    openApps.push(contractFixture.app);
    const contractResponse = await contractFixture.app.inject({ method: "GET", url: "/api/research/notebooks/notebook:alpha/engine", headers: bearer(alphaPrincipal.token) });
    expect(contractResponse.statusCode).toBe(502);
    expect(contractResponse.json()).toEqual({ error: "research_engine_contract_error" });
  });
});
