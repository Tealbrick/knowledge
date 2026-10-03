import Fastify, { type FastifyInstance } from "fastify";
import { afterEach, describe, expect, it } from "vitest";

import { buildKnowledgeApp } from "./app.js";
import { createKnowledgePrincipalResolver } from "./knowledge-principal.js";
import {
  registerOpenNotebookRoutes,
  type OpenNotebookNotebookBinding,
  type OpenNotebookNotebookSummary,
} from "./open-notebook-routes.js";
import { ResearchBrowserSessionAuthority } from "./research-browser-session.js";

const alpha = {
  token: "discovery-alpha-token",
  principalId: "discovery-alpha-principal",
  companyId: "company-alpha",
  capabilities: ["research:read"],
} as const;
const beta = {
  token: "discovery-beta-token",
  principalId: "discovery-beta-principal",
  companyId: "company-beta",
  capabilities: ["research:read"],
} as const;
const alphaMapping: OpenNotebookNotebookBinding = {
  knowledgeNotebookId: "notebook:alpha",
  companyId: "company-alpha",
  externalNotebookId: "notebook:upstream-alpha",
};
const betaMapping: OpenNotebookNotebookBinding = {
  knowledgeNotebookId: "notebook:beta",
  companyId: "company-beta",
  externalNotebookId: "notebook:upstream-beta",
};
const alphaSummary: OpenNotebookNotebookSummary = {
  id: alphaMapping.knowledgeNotebookId,
  name: "Alpha local notebook",
  description: "Local Knowledge summary",
};
const betaSummary: OpenNotebookNotebookSummary = {
  id: betaMapping.knowledgeNotebookId,
  name: "Beta local notebook",
  description: "",
};

const apps: FastifyInstance[] = [];

afterEach(async () => {
  for (const app of apps.splice(0)) await app.close();
});

function buildRouteFixture(options: {
  readonly bindings?: readonly OpenNotebookNotebookBinding[];
  readonly owners?: Readonly<Record<string, string | null>>;
  readonly summaries?: Readonly<Record<string, OpenNotebookNotebookSummary | null>>;
  readonly principals?: ReturnType<typeof createKnowledgePrincipalResolver>;
  readonly browserSession?: ResearchBrowserSessionAuthority | null;
} = {}) {
  const app = Fastify();
  apps.push(app);
  const bindings = options.bindings ?? [alphaMapping, betaMapping];
  const owners = options.owners ?? {
    [alphaMapping.knowledgeNotebookId]: alphaMapping.companyId,
    [betaMapping.knowledgeNotebookId]: betaMapping.companyId,
  };
  const summaries = options.summaries ?? {
    [alphaSummary.id]: alphaSummary,
    [betaSummary.id]: betaSummary,
  };
  const principals = options.principals ?? createKnowledgePrincipalResolver([alpha, beta]);
  let summaryCalls = 0;
  registerOpenNotebookRoutes(app, {
    adapter: null,
    principals,
    browserSession: options.browserSession,
    bindings,
    resolveNotebookCompany: (id) => owners[id] ?? null,
    resolveNotebookSummary: (id) => {
      summaryCalls += 1;
      return summaries[id] ?? null;
    },
  });
  return { app, get summaryCalls() { return summaryCalls; } };
}

function bearer(token: string) {
  return { authorization: `Bearer ${token}` };
}

describe("mapped Open Notebook discovery", () => {
  it("returns only current local mappings for the authenticated company and never calls upstream", async () => {
    const fixture = buildRouteFixture();
    const response = await fixture.app.inject({
      method: "GET",
      url: "/api/research/engine/notebooks",
      headers: bearer(alpha.token),
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      provider: "open_notebook",
      notebooks: [alphaSummary],
      pagination: { limit: 50, offset: 0, hasMore: false },
    });
    expect(JSON.stringify(response.json())).not.toContain("upstream-alpha");
    expect(fixture.summaryCalls).toBe(1);

    const betaResponse = await fixture.app.inject({
      method: "GET",
      url: "/api/research/engine/notebooks",
      headers: bearer(beta.token),
    });
    expect(betaResponse.statusCode).toBe(200);
    expect(betaResponse.json().notebooks).toEqual([betaSummary]);
  });

  it("uses the local owner as a live mapping check and omits stale or changed mappings", async () => {
    const stale: OpenNotebookNotebookBinding = {
      knowledgeNotebookId: "notebook:stale",
      companyId: "company-alpha",
      externalNotebookId: "notebook:upstream-stale",
    };
    const fixture = buildRouteFixture({
      bindings: [alphaMapping, stale],
      owners: {
        [alphaMapping.knowledgeNotebookId]: alphaMapping.companyId,
        [stale.knowledgeNotebookId]: null,
      },
      summaries: { [alphaSummary.id]: alphaSummary, [stale.knowledgeNotebookId]: null },
    });
    const response = await fixture.app.inject({ url: "/api/research/engine/notebooks", headers: bearer(alpha.token) });
    expect(response.statusCode).toBe(200);
    expect(response.json().notebooks).toEqual([alphaSummary]);
  });

  it("filters the complete set before bounded pagination and rejects caller scope selectors", async () => {
    const second: OpenNotebookNotebookBinding = {
      knowledgeNotebookId: "notebook:alpha-second",
      companyId: alphaMapping.companyId,
      externalNotebookId: "notebook:upstream-alpha-second",
    };
    const secondSummary: OpenNotebookNotebookSummary = {
      id: second.knowledgeNotebookId,
      name: "Alpha second",
      description: "Second local notebook",
    };
    const fixture = buildRouteFixture({
      bindings: [alphaMapping, second, betaMapping],
      owners: {
        [alphaMapping.knowledgeNotebookId]: alphaMapping.companyId,
        [second.knowledgeNotebookId]: second.companyId,
        [betaMapping.knowledgeNotebookId]: betaMapping.companyId,
      },
      summaries: {
        [alphaSummary.id]: alphaSummary,
        [secondSummary.id]: secondSummary,
        [betaSummary.id]: betaSummary,
      },
    });
    const page = await fixture.app.inject({
      url: "/api/research/engine/notebooks?limit=1&offset=1",
      headers: bearer(alpha.token),
    });
    expect(page.statusCode).toBe(200);
    expect(page.json()).toMatchObject({
      notebooks: [secondSummary],
      pagination: { limit: 1, offset: 1, hasMore: false },
    });
    for (const query of ["companyId=company-beta", "filter=company-beta", "notebookId=notebook:beta", "limit=51", "offset=201"]) {
      const response = await fixture.app.inject({
        url: `/api/research/engine/notebooks?${query}`,
        headers: bearer(alpha.token),
      });
      expect(response.statusCode, query).toBe(400);
    }
    const body = await fixture.app.inject({
      method: "GET",
      url: "/api/research/engine/notebooks",
      headers: { ...bearer(alpha.token), "content-type": "application/json" },
      payload: { companyId: "company-beta" },
    });
    expect(body.statusCode).toBe(400);
  });

  it("accepts an authenticated browser cookie but preserves cross-origin and capability boundaries", async () => {
    const resolver = createKnowledgePrincipalResolver([alpha]);
    const authority = new ResearchBrowserSessionAuthority({
      origin: "http://127.0.0.1:5422",
      operatorSecret: "discovery-browser-operator-secret-0123456789",
      principalId: alpha.principalId,
      principals: resolver,
    });
    const login = authority.login("discovery-browser-operator-secret-0123456789", {
      host: "127.0.0.1:5422",
      origin: "http://127.0.0.1:5422",
    });
    const fixture = buildRouteFixture({ principals: resolver, browserSession: authority });
    const headers = {
      host: "127.0.0.1:5422",
      origin: "http://127.0.0.1:5422",
      "sec-fetch-site": "same-origin",
      cookie: login.setCookie.split(";", 1)[0]!,
    };
    const cookieResponse = await fixture.app.inject({ url: "/api/research/engine/notebooks", headers });
    expect(cookieResponse.statusCode).toBe(200);
    expect(cookieResponse.json().notebooks).toEqual([alphaSummary]);

    const foreign = await fixture.app.inject({
      url: "/api/research/engine/notebooks",
      headers: { ...headers, origin: "https://evil.example" },
    });
    expect(foreign.statusCode).toBe(403);

    const noCapabilityResolver = createKnowledgePrincipalResolver([{ ...alpha, capabilities: ["research:write"] }]);
    const denied = buildRouteFixture({ principals: noCapabilityResolver });
    const deniedResponse = await denied.app.inject({ url: "/api/research/engine/notebooks", headers: bearer(alpha.token) });
    expect(deniedResponse.statusCode).toBe(403);
  });

  it("fails closed for unavailable or malformed local summaries", async () => {
    const absent = buildRouteFixture({ summaries: {} });
    const absentResponse = await absent.app.inject({ url: "/api/research/engine/notebooks", headers: bearer(alpha.token) });
    expect(absentResponse.statusCode).toBe(200);
    expect(absentResponse.json().notebooks).toEqual([]);

    const malformed = buildRouteFixture({ summaries: { [alphaSummary.id]: { id: "notebook:other", name: "wrong", description: "" } } });
    const malformedResponse = await malformed.app.inject({ url: "/api/research/engine/notebooks", headers: bearer(alpha.token) });
    expect(malformedResponse.statusCode).toBe(503);
    expect(malformedResponse.json()).toEqual({ error: "notebook_summary_unavailable" });
  });

  it("does not let a principal change during the Rules boundary change the discovery scope", async () => {
    let changed = false;
    const dynamicPrincipals = {
      configured: true,
      resolve: () => changed
        ? { kind: "service" as const, principalId: beta.principalId, companyId: beta.companyId, capabilities: beta.capabilities }
        : { kind: "service" as const, principalId: alpha.principalId, companyId: alpha.companyId, capabilities: alpha.capabilities },
    };
    const app = Fastify();
    apps.push(app);
    app.addHook("preHandler", async () => { changed = true; });
    registerOpenNotebookRoutes(app, {
      adapter: null,
      principals: dynamicPrincipals,
      bindings: [alphaMapping, betaMapping],
      resolveNotebookCompany: (id) => id === alphaMapping.knowledgeNotebookId ? alphaMapping.companyId : id === betaMapping.knowledgeNotebookId ? betaMapping.companyId : null,
      resolveNotebookSummary: (id) => id === alphaSummary.id ? alphaSummary : id === betaSummary.id ? betaSummary : null,
    });
    const response = await app.inject({ url: "/api/research/engine/notebooks", headers: bearer(alpha.token) });
    expect(response.statusCode).toBe(401);
    expect(response.json()).toEqual({ error: "authentication_required" });
  });
});

describe("Knowledge app discovery boundary", () => {
  it("marks discovery no-store and denies cross-origin bearer use without a browser fallback", async () => {
    const app = await buildKnowledgeApp({
      environment: "test",
      config: {
        gbrainAutoStart: false,
        gbrainBaseUrl: null,
        gbrainToken: null,
        openNotebookBaseUrl: null,
        openNotebookToken: null,
        rulesBaseUrl: null,
        rulesAuthToken: null,
        knowledgeServicePrincipals: [alpha],
        openNotebookBindings: [alphaMapping],
      },
    });
    try {
      const response = await app.inject({ url: "/api/research/engine/notebooks", headers: bearer(alpha.token) });
      expect(response.statusCode).toBe(200);
      expect(response.headers["cache-control"]).toBe("no-store");
      expect(response.headers["access-control-allow-origin"]).toBeUndefined();
      expect(response.json()).toMatchObject({ provider: "open_notebook", notebooks: [] });

      const foreign = await app.inject({
        url: "/api/research/engine/notebooks",
        headers: { ...bearer(alpha.token), origin: "https://evil.example" },
      });
      expect(foreign.statusCode).toBe(403);
      expect(foreign.headers["access-control-allow-origin"]).toBeUndefined();
    } finally {
      await app.close();
    }
  });
});
