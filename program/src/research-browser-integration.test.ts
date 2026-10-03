import Fastify, { type FastifyInstance } from "fastify";
import { afterEach, describe, expect, it } from "vitest";
import { createKnowledgePrincipalResolver, type KnowledgeServicePrincipal } from "./knowledge-principal.js";
import { ResearchBrowserSessionAuthority } from "./research-browser-session.js";
import { registerOpenNotebookRoutes, type OpenNotebookRouteAdapter } from "./open-notebook-routes.js";

const origin = "http://127.0.0.1:5411";
const secret = "disposable-browser-integration-secret";
const apps: FastifyInstance[] = [];
afterEach(async () => { for (const app of apps.splice(0)) await app.close(); });
function fixture() {
  const app = Fastify(); apps.push(app);
  const resolver = createKnowledgePrincipalResolver([{ token: "service-a", principalId: "principal-a", companyId: "company-a", capabilities: ["research:read", "research:write"] }]);
  let current: KnowledgeServicePrincipal | null = resolver.resolve("service-a");
  const principals = { configured: true, resolve: resolver.resolve, resolveById: () => current };
  const authority = new ResearchBrowserSessionAuthority({ origin, operatorSecret: secret, principalId: "principal-a", principals });
  const login = authority.login(secret, { host: "127.0.0.1:5411", origin });
  const browserHeaders = { host: "127.0.0.1:5411", origin, cookie: login.setCookie.split(";", 1)[0]!, "sec-fetch-site": "same-origin" };
  let calls = 0;
  let beforeHandler: (() => void) | null = null;
  let attested: KnowledgeServicePrincipal | undefined;
  app.addHook("preHandler", async request => { attested = request.knowledgePrincipal; beforeHandler?.(); });
  const source = { id: "source:a", title: "Scoped evidence", topics: [], asset: { filePath: "/private/file", url: null }, fullText: "<script>untrusted evidence</script>", embedded: false, embeddedChunks: 0, insightsCount: 0, fileAvailable: false, created: "now", updated: "now", commandId: null, status: "ready" };
  const adapter = {
    async getNotebook() { calls++; return { id: "notebook:up-a", name: "Fixture", description: null, archived: false, created: "now", updated: "now" }; },
    async listNotebookSources(externalId: string) { expect(externalId).toBe("notebook:up-a"); calls++; return [source]; },
    async getNotebookSource(externalId: string, sourceId: string) { expect(externalId).toBe("notebook:up-a"); expect(sourceId).toBe(source.id); calls++; return source; },
  } as unknown as OpenNotebookRouteAdapter;
  registerOpenNotebookRoutes(app, { adapter, principals, browserSession: authority,
    bindings: [{ knowledgeNotebookId: "local-a", companyId: "company-a", externalNotebookId: "notebook:up-a" }], resolveNotebookCompany: () => "company-a" });
  return { app, authority, browserHeaders, csrf: login.status.csrfToken!, get calls() { return calls; }, get attested() { return attested; },
    revoke() { current = null; }, loseCapability() { current = { ...current!, capabilities: [] }; },
    before(action: () => void) { beforeHandler = action; } };
}
describe("Research browser authority at the actual engine routing seam", () => {
  it("reads mapped source inventory and full detail using only the browser cookie", async () => {
    const f = fixture();
    const inventory = await f.app.inject({ url: "/api/research/notebooks/local-a/engine/sources?limit=20&offset=0", headers: f.browserHeaders });
    expect(inventory.statusCode).toBe(200);
    expect(inventory.json()).toMatchObject({ provider: "open_notebook", pagination: { limit: 20, offset: 0 }, sources: [{ id: "source:a", title: "Scoped evidence" }] });
    expect(inventory.json().sources[0]).not.toHaveProperty("fullText");
    expect(JSON.stringify(inventory.json())).not.toContain("/private/file");
    const detail = await f.app.inject({ url: "/api/research/notebooks/local-a/engine/sources/source%3Aa", headers: f.browserHeaders });
    expect(detail.statusCode).toBe(200);
    expect(detail.json().source.fullText).toBe("<script>untrusted evidence</script>");
    // Cache headers are installed by buildKnowledgeApp, not this route-only fixture.
    expect(f.calls).toBe(2);
  });
  it.each(["/sources?limit=20&offset=0", "/sources/source%3Aa"])("denies source reads without a session or current capability: %s", async suffix => {
    const f = fixture(); const url = `/api/research/notebooks/local-a/engine${suffix}`;
    expect((await f.app.inject({ url, headers: { host: f.browserHeaders.host, origin } })).statusCode).toBe(401);
    f.loseCapability();
    expect((await f.app.inject({ url, headers: f.browserHeaders })).statusCode).toBe(403);
    expect(f.calls).toBe(0);
  });
  it.each(["/sources?limit=20&offset=0", "/sources/source%3Aa"])("does not use a browser notebook selector as source authority: %s", async suffix => {
    const f = fixture();
    expect((await f.app.inject({ url: `/api/research/notebooks/foreign/engine${suffix}`, headers: f.browserHeaders })).statusCode).toBe(404);
    expect(f.calls).toBe(0);
  });
  it("attests the principal before domain policy and calls the adapter once", async () => {
    const f = fixture(); const result = await f.app.inject({ url: "/api/research/notebooks/local-a/engine", headers: f.browserHeaders });
    expect(result.statusCode).toBe(200); expect(f.calls).toBe(1);
    expect(f.attested).toMatchObject({ principalId: "principal-a", companyId: "company-a", kind: "service" });
  });
  it.each(["", "Basic invalid", "Bearer invalid"])("never falls back to a cookie when Authorization is %j", async authorization => {
    const f = fixture(); const r = await f.app.inject({ url: "/api/research/notebooks/local-a/engine", headers: { ...f.browserHeaders, authorization } });
    expect(r.statusCode).toBe(401); expect(f.calls).toBe(0);
  });
  it("keeps server bearer transport compatible without browser metadata", async () => {
    const f = fixture(); const r = await f.app.inject({ url: "/api/research/notebooks/local-a/engine", headers: { authorization: "Bearer service-a", host: "harness-bridge.internal" } });
    expect(r.statusCode).toBe(200); expect(f.calls).toBe(1);
  });
  it.each([{ origin: "null" }, { origin: "https://evil.example" }, { host: "127.0.0.1:8888" }, { "sec-fetch-site": "same-site" }])("denies a foreign browser boundary %j", async extra => {
    const f = fixture(); const r = await f.app.inject({ url: "/api/research/notebooks/local-a/engine", headers: { ...f.browserHeaders, ...extra } });
    expect(r.statusCode).toBe(403); expect(f.calls).toBe(0);
  });
  it("requires CSRF on chat and source writes before the handler", async () => {
    const f = fixture();
    for (const suffix of ["/sources", "/chat/sessions", "/chat/sessions/session-a/messages"]) {
      const r = await f.app.inject({ method: "POST", url: `/api/research/notebooks/local-a/engine${suffix}`, headers: { ...f.browserHeaders, "idempotency-key": "blocked" }, payload: {} });
      expect(r.statusCode).toBe(403); expect(r.json().error).toBe("browser_session_csrf_required");
    }
    expect(f.calls).toBe(0);
  });
  it("rechecks principal revocation after policy and before the adapter", async () => {
    const f = fixture(); f.before(() => f.revoke());
    const r = await f.app.inject({ url: "/api/research/notebooks/local-a/engine", headers: f.browserHeaders });
    expect(r.statusCode).toBe(401); expect(f.calls).toBe(0);
  });
  it("rechecks capability removal after policy and before the adapter", async () => {
    const f = fixture(); f.before(() => f.loseCapability());
    const r = await f.app.inject({ url: "/api/research/notebooks/local-a/engine", headers: f.browserHeaders });
    expect(r.statusCode).toBe(403); expect(f.calls).toBe(0);
  });
  it("does not let a valid session select an unmapped notebook", async () => {
    const f = fixture(); const r = await f.app.inject({ url: "/api/research/notebooks/foreign/engine", headers: f.browserHeaders });
    expect(r.statusCode).toBe(404); expect(f.calls).toBe(0);
  });
  it("allows metadata-absent GET clients only with exact Host, while writes still require Origin and CSRF", async () => {
    const f = fixture();
    const minimal = { host: f.browserHeaders.host, cookie: f.browserHeaders.cookie };
    expect((await f.app.inject({ url: "/api/research/notebooks/local-a/engine", headers: minimal })).statusCode).toBe(200);
    const write = await f.app.inject({ method: "POST", url: "/api/research/notebooks/local-a/engine/chat/sessions", headers: { ...minimal, "x-csrf-token": f.csrf, "idempotency-key": "blocked-origin" }, payload: {} });
    expect(write.statusCode).toBe(403);
    expect(write.json().error).toBe("browser_session_origin_denied");
  });
  it("rotates sessions on login and sets Secure for HTTPS", () => {
    const f = fixture(); const renewed = f.authority.login(secret, f.browserHeaders);
    expect(renewed.setCookie).not.toBe(f.browserHeaders.cookie);
    expect(f.authority.status(f.browserHeaders).authenticated).toBe(false);
    const secure = new ResearchBrowserSessionAuthority({ origin: "https://knowledge.example", operatorSecret: secret, principalId: "p",
      principals: createKnowledgePrincipalResolver([{ token: "s", principalId: "p", companyId: "c", capabilities: [] }]) });
    expect(secure.login(secret, { host: "knowledge.example", origin: "https://knowledge.example" }).setCookie).toContain("; Secure");
  });
});
