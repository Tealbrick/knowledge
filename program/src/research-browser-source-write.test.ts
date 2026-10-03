import Fastify, { type FastifyInstance } from "fastify";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createKnowledgePrincipalResolver } from "./knowledge-principal.js";
import { registerOpenNotebookRoutes, type OpenNotebookRouteAdapter } from "./open-notebook-routes.js";
import { ResearchBrowserSessionAuthority } from "./research-browser-session.js";
import { ResearchWriteLedger } from "./research-write-ledger.js";

const owned: { app: FastifyInstance; ledger: ResearchWriteLedger; root: string }[] = [];
afterEach(async () => { for (const fixture of owned.splice(0)) { await fixture.app.close(); fixture.ledger.close(); fs.rmSync(fixture.root, { recursive: true, force: true }); } });

function fixture(ambiguous = false) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "knowledge-browser-write-test-"));
  const ledger = new ResearchWriteLedger(path.join(root, "writes.sqlite"));
  const app = Fastify(); owned.push({ app, ledger, root });
  const principals = createKnowledgePrincipalResolver([{ token: "fixture-service", principalId: "operator", companyId: "company", capabilities: ["research:read", "research:write"] }]);
  const origin = "http://127.0.0.1:5422";
  const authority = new ResearchBrowserSessionAuthority({ origin, operatorSecret: "disposable-source-write-browser-code", principalId: "operator", principals });
  const session = authority.login("disposable-source-write-browser-code", { host: "127.0.0.1:5422", origin });
  const headers = { host: "127.0.0.1:5422", origin, cookie: session.setCookie.split(";", 1)[0]!, "x-csrf-token": session.status.csrfToken!, "idempotency-key": "browser-write-key" };
  let calls = 0;
  const adapter = {
    async createNotebookTextSource(notebook: string, body: { title: string; content: string }) {
      expect(notebook).toBe("notebook:upstream"); expect(body).toEqual({ title: "Evidence", content: "Fixture text" });
      calls++; if (ambiguous) throw new Error("fixture_response_lost"); return { id: "source:created" };
    },
    async getNotebookSource(notebook: string, source: string) { expect(notebook).toBe("notebook:upstream"); expect(source).toBe("source:created"); return { id: source }; },
  } as unknown as OpenNotebookRouteAdapter;
  registerOpenNotebookRoutes(app, { adapter, ledger, principals, browserSession: authority,
    bindings: [{ knowledgeNotebookId: "local", companyId: "company", externalNotebookId: "notebook:upstream" }],
    resolveNotebookCompany: () => "company" });
  return { app, headers, get calls() { return calls; } };
}
const url = "/api/research/notebooks/local/engine/sources";
const receiptUrl = "/api/research/notebooks/local/engine/write-receipts/browser-write-key";
const payload = { title: "Evidence", content: "Fixture text" };
const withoutCsrf = (headers: Record<string, string>) => Object.fromEntries(Object.entries(headers).filter(([key]) => key !== "x-csrf-token"));

describe("Browser cookie source writes and durable receipts", () => {
  it("creates once, reads the stored receipt and replays without resubmission", async () => {
    const f = fixture();
    const first = await f.app.inject({ method: "POST", url, headers: f.headers, payload });
    expect(first.statusCode).toBe(201);
    expect(first.json().receipt).toMatchObject({ idempotencyKey: "browser-write-key", state: "succeeded", sourceId: "source:created", errorCode: null });
    const read = await f.app.inject({ url: receiptUrl, headers: withoutCsrf(f.headers) });
    expect(read.statusCode).toBe(200); expect(read.json().receipt).toEqual(first.json().receipt);
    const replay = await f.app.inject({ method: "POST", url, headers: f.headers, payload });
    expect(replay.statusCode).toBe(200); expect(replay.json().replayed).toBe(true); expect(f.calls).toBe(1);
  });
  it("does not claim or submit a browser write without CSRF", async () => {
    const f = fixture();
    const denied = await f.app.inject({ method: "POST", url, headers: withoutCsrf(f.headers), payload });
    expect(denied.statusCode).toBe(403); expect(f.calls).toBe(0);
    expect((await f.app.inject({ url: receiptUrl, headers: f.headers })).statusCode).toBe(404);
  });
  it("holds an uncertain upstream result under the original browser key", async () => {
    const f = fixture(true);
    expect((await f.app.inject({ method: "POST", url, headers: f.headers, payload })).statusCode).toBe(503);
    const read = await f.app.inject({ url: receiptUrl, headers: f.headers });
    expect(read.statusCode).toBe(200);
    expect(read.json().receipt).toMatchObject({ idempotencyKey: "browser-write-key", state: "uncertain", sourceId: null, errorCode: "ambiguous_response" });
    expect((await f.app.inject({ method: "POST", url, headers: f.headers, payload })).statusCode).toBe(409);
    expect(f.calls).toBe(1);
  });
  it("cannot write or read receipts in an unmapped notebook", async () => {
    const f = fixture();
    expect((await f.app.inject({ method: "POST", url: url.replace("/local/", "/foreign/"), headers: f.headers, payload })).statusCode).toBe(404);
    expect((await f.app.inject({ url: receiptUrl.replace("/local/", "/foreign/"), headers: f.headers })).statusCode).toBe(404);
    expect(f.calls).toBe(0);
  });
});
