import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { describe, expect, it } from "vitest";
import { buildKnowledgeApp } from "./app.js";
import { loadConfig } from "./config.js";
import type { KnowledgeConfig } from "./types.js";

const base: Partial<KnowledgeConfig> = {
  gbrainAutoStart: false, gbrainBaseUrl: null, gbrainToken: null,
  rulesBaseUrl: null, rulesAuthToken: null,
  openNotebookBaseUrl: null, openNotebookToken: null,
  knowledgeServicePrincipals: [], openNotebookBindings: [],
};
const principal = { token: "fixture-service-alpha", principalId: "alpha-agent", companyId: "alpha", capabilities: ["research:read", "research:write"] };

describe("Open Notebook Program integration", () => {
  it("keeps the engine endpoint closed without a configured principal", async () => {
    const app = await buildKnowledgeApp({ environment: "test", config: base });
    try {
      const response = await app.inject({ url: "/api/research/notebooks/notebook_1/engine" });
      expect([401, 503]).toContain(response.statusCode);
      const summary = await app.inject({ url: "/api/research/summary?companyId=alpha" });
      expect(summary.json().posture.ask).toMatchObject({ mode: "grounded_fallback", degraded: true });
      expect(summary.json().posture.chat.degraded).toBe(true);
      const spec = (await app.inject({ url: "/openapi.json" })).json();
      for (const suffix of ["", "/sources", "/notes", "/sources/{sourceId}"]) {
        expect(spec.paths[`/api/research/notebooks/{notebookId}/engine${suffix}`].get.security).toEqual([{ bearerAuth: [] }, { researchBrowserCookie: [] }]);
      }
    } finally { await app.close(); }
  });

  it("rejects invalid principal configuration before opening the database", async () => {
    await expect(buildKnowledgeApp({ environment: "test", config: {
      ...base, knowledgeServicePrincipals: [{ ...principal, token: "" }],
    } })).rejects.toThrow("Invalid Knowledge service principal configuration");
  });

  it.each(["allow", "deny", "review", "unavailable"] as const)(
    "authenticates before Rules and scopes real HTTP adapter calls when Rules is %s", async (effect) => {
      const temp = await fs.mkdtemp(path.join(os.tmpdir(), "knowledge-research-route-"));
      const calls: Array<{ url: string; authorization: string | undefined }> = [];
      const rulesCalls: Array<Record<string, any>> = [];
      const server = createServer((request, response) => {
        if (request.url === "/api/rules/gateway/evaluate") {
          let body = "";
          request.on("data", (chunk) => { body += String(chunk); });
          request.on("end", () => {
            rulesCalls.push(JSON.parse(body));
            response.writeHead(effect === "unavailable" ? 503 : 200, { "content-type": "application/json" });
            response.end(JSON.stringify({ allowed: effect === "allow", effect,
              reason: `Fixture ${effect}`, method: "doppelganger.rules.evaluate", details: {},
              ...(effect === "review" ? { code: "review_required" } : {}),
            }));
          });
          return;
        }
        calls.push({ url: request.url ?? "", authorization: request.headers.authorization });
        response.writeHead(200, { "content-type": "application/json" });
        if (request.url === "/api/chat/context") {
          response.end(JSON.stringify({ context: { sources: [{ id: "source:fixture", title: "Fixture", full_text: "Synthetic text", insights: [] }], notes: [] }, token_count: 5, char_count: 20 }));
          return;
        }
        if (request.url?.startsWith("/api/notes")) { response.end("[]"); return; }
        if (request.url?.startsWith("/api/sources")) {
          const source = { id: "source:fixture", title: "Fixture", topics: [], embedded: false, embedded_chunks: 0, insights_count: 0,
            created: "2026-09-06T00:00:00Z", updated: "2026-09-06T00:00:00Z", full_text: "Synthetic text" };
          response.end(JSON.stringify(request.url.startsWith("/api/sources?") ? [source] : source));
          return;
        }
        response.end(JSON.stringify({ id: "notebook:alpha", name: "Real adapter fixture", description: "Synthetic", archived: false,
          created: "2026-09-06T00:00:00Z", updated: "2026-09-06T00:00:00Z", source_count: 0, note_count: 0 }));
      });
      await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
      const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
      const config = { ...base, dataDir: temp, knowledgeDatabasePath: path.join(temp, "fixture.sqlite"), researchWriteLedgerPath: path.join(temp, "writes.sqlite") };
      let app: Awaited<ReturnType<typeof buildKnowledgeApp>> | undefined;
      try {
        app = await buildKnowledgeApp({ environment: "test", config });
        const created = await app.inject({ method: "POST", url: "/api/companies/alpha/research/notebooks", payload: { title: "Alpha" } });
        expect(created.statusCode).toBe(201);
        const notebookId = created.json().id as string;
        await app.close();
        app = undefined;
        app = await buildKnowledgeApp({ environment: "test", config: {
          ...config, rulesBaseUrl: url, rulesAuthToken: "fixture-rules-secret",
          openNotebookBaseUrl: url, openNotebookToken: "fixture-upstream-secret",
          knowledgeServicePrincipals: [principal, { ...principal, token: "fixture-beta", principalId: "beta-agent", companyId: "beta" }],
          openNotebookBindings: [{ knowledgeNotebookId: notebookId, companyId: "alpha", externalNotebookId: "notebook:alpha" }],
        } });
        const endpoint = `/api/research/notebooks/${encodeURIComponent(notebookId)}/engine`;
        const anonymous = await app.inject({ url: endpoint });
        expect(anonymous.statusCode).toBe(401);
        const crossCompany = await app.inject({ url: `${endpoint}?companyId=alpha`, headers: { authorization: "Bearer fixture-beta" } });
        expect([403, 404]).toContain(crossCompany.statusCode);
        expect(rulesCalls).toHaveLength(0);
        expect(calls).toHaveLength(0);

        const result = await app.inject({ url: `${endpoint}?companyId=forged&actor=forged`, headers: { authorization: `Bearer ${principal.token}` } });
        expect(result.statusCode).toBe({ allow: 200, deny: 403, review: 409, unavailable: 503 }[effect]);
        expect(rulesCalls).toHaveLength(1);
        expect(rulesCalls[0]?.params.actor).toMatchObject({ id: "alpha-agent", companyId: "alpha" });
        expect(rulesCalls[0]?.params.target.companyId).toBe("alpha");
        expect(calls).toHaveLength(effect === "allow" ? 1 : 0);
        if (effect === "allow") {
          expect(calls[0]).toEqual({ url: "/api/notebooks/notebook%3Aalpha", authorization: "Bearer fixture-upstream-secret" });
          expect(result.json()).toMatchObject({ provider: "open_notebook", observedVersion: null });
        }
        for (const secret of [principal.token, "fixture-upstream-secret", "fixture-rules-secret"]) {
          expect(result.body).not.toContain(secret);
          expect((await app.inject({ url: "/api/status" })).body).not.toContain(secret);
        }
        const write = await app.inject({ method: "POST", url: `${endpoint}/sources?companyId=forged`,
          headers: { authorization: `Bearer ${principal.token}`, "idempotency-key": "rules-write" },
          payload: { title: "Fixture", content: "Synthetic text" } });
        expect(write.statusCode).toBe({ allow: 201, deny: 403, review: 409, unavailable: 503 }[effect]);
        expect(rulesCalls).toHaveLength(2);
        expect(rulesCalls[1]?.params.actor).toMatchObject({ id: "alpha-agent", companyId: "alpha" });
        expect(rulesCalls[1]?.params.target.companyId).toBe("alpha");
        expect(calls).toHaveLength(effect === "allow" ? 4 : 0);
        const context = await app.inject({ url: `${endpoint}/context`, headers: { authorization: `Bearer ${principal.token}` } });
        expect(context.statusCode).toBe({ allow: 200, deny: 403, review: 409, unavailable: 503 }[effect]);
        expect(rulesCalls).toHaveLength(3);
        expect(rulesCalls[2]?.params.actor).toMatchObject({ id: "alpha-agent", companyId: "alpha" });
        expect(rulesCalls[2]?.params.target.companyId).toBe("alpha");
        expect(calls.some((call) => call.url === "/api/chat/context")).toBe(effect === "allow");
      } finally {
        await app?.close();
        server.closeAllConnections();
        await new Promise<void>((resolve) => server.close(() => resolve()));
        await fs.rm(temp, { recursive: true, force: true });
      }
    },
  );
});

describe("Open Notebook server configuration", () => {
  it("explicit null and empty arrays disable ambient Research credentials", () => {
    const values = {
      KNOWLEDGE_OPEN_NOTEBOOK_BASE_URL: "http://127.0.0.1:1",
      KNOWLEDGE_OPEN_NOTEBOOK_TOKEN: "ambient-fixture-secret",
      KNOWLEDGE_SERVICE_PRINCIPALS: JSON.stringify([principal]),
      KNOWLEDGE_OPEN_NOTEBOOK_BINDINGS: JSON.stringify([{ knowledgeNotebookId: "local", companyId: "alpha", externalNotebookId: "notebook:alpha" }]),
    };
    const previous = new Map(Object.keys(values).map((key) => [key, process.env[key]]));
    Object.assign(process.env, values);
    try {
      const inherited = loadConfig({ environment: "test" });
      expect(inherited.openNotebookToken).toBe("ambient-fixture-secret");
      expect(inherited.knowledgeServicePrincipals).toEqual([principal]);
      expect(inherited.openNotebookBindings).toHaveLength(1);
      const config = loadConfig({ environment: "test", config: base });
      expect(config.openNotebookToken).toBeNull();
      expect(config.openNotebookBaseUrl).toBeNull();
      expect(config.knowledgeServicePrincipals).toEqual([]);
      expect(config.openNotebookBindings).toEqual([]);
    } finally {
      for (const [key, value] of previous) {
        if (value === undefined) delete process.env[key]; else process.env[key] = value;
      }
    }
  });
  it.each(["KNOWLEDGE_SERVICE_PRINCIPALS", "KNOWLEDGE_OPEN_NOTEBOOK_BINDINGS"])("rejects malformed %s without echoing its contents", (name) => {
    const previous = process.env[name];
    process.env[name] = "{super-secret-malformed-json";
    try {
      expect(() => loadConfig({ environment: "test" })).toThrow(`${name} must be a JSON array`);
    } finally {
      if (previous === undefined) delete process.env[name]; else process.env[name] = previous;
    }
  });
});
