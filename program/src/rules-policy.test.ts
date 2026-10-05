import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { buildKnowledgeApp } from "./app.js";
import { KnowledgeRulesClient } from "./rules-client.js";

interface RulesTestServerOptions {
  readonly decision?: (input: { readonly operation: string; readonly method: string }) => Record<string, unknown>;
  readonly responseBody?: unknown;
  readonly rawBody?: string;
  readonly redirect?: boolean;
  readonly hold?: boolean;
  readonly slowBody?: boolean;
}

async function withRulesServer<T>(options: RulesTestServerOptions, fn: (baseUrl: string, calls: unknown[]) => Promise<T>): Promise<T> {
  const calls: unknown[] = [];
  const server = createServer((request, response) => {
    if (options.hold) return;
    if (request.url === "/redirected") {
      calls.push({ redirected: true });
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ ok: true }));
      return;
    }
    if (options.redirect) {
      response.writeHead(302, { location: "/redirected" });
      response.end();
      return;
    }
    if (options.slowBody) {
      response.writeHead(200, { "content-type": "application/json" });
      response.write('{"allowed":true,"reason":"partial response",');
      setTimeout(() => response.end('"method":"doppelganger.rules.evaluate","details":{}}'), 100);
      return;
    }
    let raw = "";
    request.on("data", (chunk) => { raw += String(chunk); });
    request.on("end", () => {
      const body = raw ? JSON.parse(raw) as { method?: string; params?: { operation?: string } } : {};
      calls.push({ headers: request.headers, body });
      const decision = options.decision?.({
        operation: body.params?.operation ?? "",
        method: body.method ?? "",
      }) ?? {
        allowed: true,
        reason: "test allow",
        method: "doppelganger.rules.evaluate",
        details: {},
      };
      response.writeHead(200, { "content-type": "application/json" });
      response.end(options.rawBody ?? JSON.stringify(options.responseBody ?? {
        method: "doppelganger.rules.evaluate",
        details: {},
        ...decision,
      }));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address() as AddressInfo;
  try {
    return await fn(`http://127.0.0.1:${address.port}`, calls);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

describe("Knowledge Rules policy boundary", () => {
  it("uses the actual generic Rules gateway contract and server actor", async () => {
    await withRulesServer({}, async (baseUrl, calls) => {
      const client = new KnowledgeRulesClient({
        baseUrl,
        authToken: "rules-test-token",
        workspaceSlug: "workspace-test",
        timeoutMs: 500,
      });
      const decision = await client.evaluate({
        operation: "knowledge.document.create",
        targetKind: "knowledge_document",
        targetId: null,
        companyId: "company-selector",
        payload: { pathname: "/api/knowledge/documents" },
        actor: {
          id: "knowledge-program",
          roles: ["service"],
          source: "knowledge-program",
          companyId: "company-selector",
        },
      });
      expect(decision.effect).toBe("allow");
      expect(calls).toHaveLength(1);
      expect(calls[0]).toMatchObject({
        headers: { authorization: "Bearer rules-test-token" },
        body: {
          method: "doppelganger.rules.evaluate",
          params: {
            ruleKey: "knowledge",
            operation: "knowledge.document.create",
            runtimeContext: { app: "knowledge", workspaceSlug: "workspace-test" },
          },
        },
      });
    });
  });

  it("accepts the Tealbrick rules method in responses while still emitting the legacy method", async () => {
    const input = {
      operation: "knowledge.document.read", targetKind: "knowledge_document", targetId: "doc", companyId: null,
      payload: {}, actor: { id: "knowledge-program", roles: ["service"], source: "knowledge-program", companyId: null },
    } as const;
    await withRulesServer({
      responseBody: { allowed: true, reason: "allow", method: "tealbrick.rules.evaluate", details: {} },
    }, async (baseUrl, calls) => {
      const client = new KnowledgeRulesClient({ baseUrl, authToken: "token", workspaceSlug: "test", timeoutMs: 500 });
      await expect(client.evaluate(input)).resolves.toMatchObject({ effect: "allow" });
      expect(calls[0]).toMatchObject({ body: { method: "doppelganger.rules.evaluate" } });
    });
    await withRulesServer({
      responseBody: { allowed: true, reason: "allow", method: "other.rules.evaluate", details: {} },
    }, async (baseUrl) => {
      const client = new KnowledgeRulesClient({ baseUrl, authToken: "token", workspaceSlug: "test", timeoutMs: 500 });
      await expect(client.evaluate(input)).resolves.toMatchObject({ effect: "unavailable" });
    });
  });

  it("fails closed on redirects and timeouts", async () => {
    await withRulesServer({ redirect: true }, async (baseUrl, calls) => {
      const client = new KnowledgeRulesClient({ baseUrl, authToken: "token", workspaceSlug: "test", timeoutMs: 500 });
      await expect(client.evaluate({
        operation: "knowledge.document.read", targetKind: "knowledge_document", targetId: "doc", companyId: null,
        payload: {}, actor: { id: "knowledge-program", roles: ["service"], source: "knowledge-program", companyId: null },
      })).resolves.toMatchObject({ effect: "unavailable" });
      expect(calls).toEqual([]);
    });
    await withRulesServer({ hold: true }, async (baseUrl) => {
      const client = new KnowledgeRulesClient({ baseUrl, authToken: "token", workspaceSlug: "test", timeoutMs: 20 });
      await expect(client.evaluate({
        operation: "knowledge.document.read", targetKind: "knowledge_document", targetId: "doc", companyId: null,
        payload: {}, actor: { id: "knowledge-program", roles: ["service"], source: "knowledge-program", companyId: null },
      })).resolves.toMatchObject({ effect: "unavailable" });
    });
    await withRulesServer({ slowBody: true }, async (baseUrl) => {
      const client = new KnowledgeRulesClient({ baseUrl, authToken: "token", workspaceSlug: "test", timeoutMs: 20 });
      await expect(client.evaluate({
        operation: "knowledge.document.read", targetKind: "knowledge_document", targetId: "doc", companyId: null,
        payload: {}, actor: { id: "knowledge-program", roles: ["service"], source: "knowledge-program", companyId: null },
      })).resolves.toMatchObject({ effect: "unavailable" });
    });
  });

  it("fails closed on malformed, contradictory, unknown-code, and oversized responses", async () => {
    const input = {
      operation: "knowledge.document.read",
      targetKind: "knowledge_document",
      targetId: "doc",
      companyId: null,
      payload: {},
      actor: { id: "knowledge-program", roles: ["service"], source: "knowledge-program", companyId: null },
    } as const;
    const responses: unknown[] = [
      { allowed: true, reason: "allow", method: "doppelganger.rules.evaluate", details: {}, code: "revoked" },
      { allowed: true, reason: "allow", method: "doppelganger.rules.evaluate", details: {}, code: "invalid_request" },
      { allowed: true, reason: "allow", method: "doppelganger.rules.evaluate", details: {}, code: "review_required" },
      { allowed: true, reason: "allow", method: "doppelganger.rules.evaluate", details: {}, effect: "deny" },
      { allowed: false, reason: "deny", method: "doppelganger.rules.evaluate", details: {}, effect: "allow" },
      { allowed: false, reason: "deny", method: "doppelganger.rules.evaluate", details: {}, code: "capability_mismatch" },
      { allowed: false, reason: "deny", method: "doppelganger.rules.evaluate", details: {}, code: "invalid_request" },
      { allowed: true, reason: "allow" },
    ];
    for (const responseBody of responses) {
      await withRulesServer({ responseBody }, async (baseUrl) => {
        const client = new KnowledgeRulesClient({ baseUrl, authToken: "token", workspaceSlug: "test", timeoutMs: 500 });
        await expect(client.evaluate(input)).resolves.toMatchObject({ effect: "unavailable" });
      });
    }
    await withRulesServer({
      responseBody: {
        allowed: true,
        reason: "allow",
        method: "doppelganger.rules.evaluate",
        details: { oversized: "x".repeat(70 * 1024) },
      },
    }, async (baseUrl) => {
      const client = new KnowledgeRulesClient({ baseUrl, authToken: "token", workspaceSlug: "test", timeoutMs: 500 });
      await expect(client.evaluate(input)).resolves.toMatchObject({ effect: "unavailable" });
    });
  });

  it("denies a direct collection write before SQLite mutation", async () => {
    await withRulesServer({
      decision: ({ operation }) => operation.endsWith(".create")
        ? { allowed: false, reason: "operator approval required" }
        : { allowed: true, reason: "read allowed" },
    }, async (baseUrl, calls) => {
      const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "knowledge-rules-"));
      const app = await buildKnowledgeApp({
        environment: "test",
        config: {
          dataDir,
          knowledgeDatabasePath: path.join(dataDir, "knowledge.sqlite"),
          rulesBaseUrl: baseUrl,
          rulesAuthToken: "rules-test-token",
          rulesTimeoutMs: 500,
        },
      });
      try {
        const denied = await app.inject({
          method: "POST",
          url: "/api/companies/company-1/knowledge/collections",
          payload: { name: "must not be written", actor: { kind: "operator", id: "caller-controlled" } },
        });
        expect(denied.statusCode).toBe(403);
        expect(denied.json()).toMatchObject({ error: "rules_denied" });
        const listed = await app.inject({ method: "GET", url: "/api/companies/company-1/knowledge/collections" });
        expect(listed.statusCode).toBe(200);
        expect(listed.json()).toEqual([
          expect.objectContaining({ name: "Default" }),
        ]);
        expect(listed.json()).not.toEqual(
          expect.arrayContaining([expect.objectContaining({ name: "must not be written" })]),
        );
        expect(calls).toHaveLength(2);
        expect(calls[0]).toMatchObject({ body: { params: {
          actor: { id: "knowledge-program", companyId: null },
          target: { companyId: "company-1" },
        } } });
      } finally {
        await app.close();
        await fs.rm(dataDir, { recursive: true, force: true });
      }
    });
  });

  it("fails closed for a partial Rules binding and preserves standalone mode without one", async () => {
    const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "knowledge-rules-partial-"));
    const app = await buildKnowledgeApp({
      environment: "test",
      config: { dataDir, rulesBaseUrl: "http://127.0.0.1:9", rulesAuthToken: null },
    });
    try {
      const response = await app.inject({
        method: "POST",
        url: "/api/companies/company-1/knowledge/collections",
        payload: { name: "central binding is incomplete" },
      });
      expect(response.statusCode).toBe(503);
      expect(response.json()).toMatchObject({ error: "rules_unavailable" });
    } finally {
      await app.close();
      await fs.rm(dataDir, { recursive: true, force: true });
    }
    const standalone = await buildKnowledgeApp({ environment: "test" });
    const response = await standalone.inject({
      method: "POST",
      url: "/api/companies/company-1/knowledge/collections",
      payload: { name: "standalone local collection" },
    });
    expect(response.statusCode).toBe(201);
    await standalone.close();
  });
});
