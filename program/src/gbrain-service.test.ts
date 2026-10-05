import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { GBrainServiceConnection, GBrainServiceError, deterministicRequestId, principalClientKey } from "./gbrain-service.js";

const admin = "admin-token-fixture-0123456789abcdef0123";
const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

function fixture(options: { unknownSource?: boolean; tokenStatus?: () => number } = {}) {
  const dataDir = mkdtempSync(path.join(os.tmpdir(), "gbrain-service-"));
  dirs.push(dataDir);
  const calls: Array<{ path: string; body: string }> = [];
  let registered = 0, minted = 0;
  const fetcher = (async (url: string | URL, init?: RequestInit) => {
    const target = new URL(String(url));
    calls.push({ path: target.pathname, body: String(init?.body ?? "") });
    if (target.pathname === "/admin/login") return new Response('{"status":"authenticated"}', { status: 200, headers: { "set-cookie": "gbrain_admin=session; HttpOnly" } });
    if (target.pathname === "/admin/api/register-client") {
      if ((init?.headers as Record<string, string>).cookie !== "gbrain_admin=session") return new Response("{}", { status: 401 });
      if (options.unknownSource) return Response.json({ error: "unknown_source" }, { status: 400 });
      registered++;
      return Response.json({ clientId: `client-${registered}`, clientSecret: `secret-${registered}` });
    }
    if (target.pathname === "/token") {
      const status = options.tokenStatus?.() ?? 200;
      if (status !== 200) return Response.json({ error: "invalid_client" }, { status });
      minted++;
      return Response.json({ access_token: `token-${minted}`, token_type: "bearer", expires_in: 3600 });
    }
    return new Response("{}", { status: 404 });
  }) as typeof fetch;
  const connection = () => new GBrainServiceConnection({ baseUrl: "http://gbrain.internal:3131", adminToken: admin, dataDir, fetch: fetcher });
  return { dataDir, calls, connection, counts: () => ({ registered, minted }) };
}

describe("GBrain service connection", () => {
  it("registers one source-bound client per partition and per principal, persisted owner-only", async () => {
    const f = fixture();
    const connection = f.connection();
    expect(await connection.token("kb-aaaaaaaaaaaaaaaaaaaaaaaa")).toBe("token-1");
    expect(await connection.token("kb-aaaaaaaaaaaaaaaaaaaaaaaa")).toBe("token-1");
    expect(await connection.token("kb-aaaaaaaaaaaaaaaaaaaaaaaa", "agent-henry")).toBe("token-2");
    expect(f.counts()).toEqual({ registered: 2, minted: 2 });
    const registration = JSON.parse(f.calls.find(call => call.path === "/admin/api/register-client")!.body);
    expect(registration).toMatchObject({ source: "kb-aaaaaaaaaaaaaaaaaaaaaaaa", scopes: "read write", grantTypes: ["client_credentials"] });
    const file = path.join(f.dataDir, "gbrain-service-clients.json");
    expect(statSync(file).mode & 0o077).toBe(0);
    const stored = JSON.parse(readFileSync(file, "utf8"));
    expect(Object.keys(stored.clients)).toEqual(["kb-aaaaaaaaaaaaaaaaaaaaaaaa|", `kb-aaaaaaaaaaaaaaaaaaaaaaaa|${principalClientKey("agent-henry")}`]);
    // A restarted Knowledge reuses persisted clients instead of registering new ones.
    expect(await f.connection().token("kb-aaaaaaaaaaaaaaaaaaaaaaaa")).toBe("token-3");
    expect(f.counts().registered).toBe(2);
  });

  it("re-registers a revoked client and refuses unprovisioned sources", async () => {
    let first = true;
    const f = fixture({ tokenStatus: () => { const status = first ? 401 : 200; first = false; return status; } });
    expect(await f.connection().token("kb-aaaaaaaaaaaaaaaaaaaaaaaa")).toBe("token-1");
    expect(f.counts().registered).toBe(2);
    await expect(fixture({ unknownSource: true }).connection().token("kb-bbbbbbbbbbbbbbbbbbbbbbbb")).rejects.toMatchObject({ code: "brain_partition_binding_required" });
    await expect(fixture().connection().token("default; drop")).rejects.toBeInstanceOf(GBrainServiceError);
  });

  it("never reuses credentials minted for another GBrain service", async () => {
    const f = fixture();
    await f.connection().token("kb-aaaaaaaaaaaaaaaaaaaaaaaa");
    const moved = new GBrainServiceConnection({ baseUrl: "http://other.internal:3131", adminToken: admin, dataDir: f.dataDir, fetch: (async (url: string | URL, init?: RequestInit) => {
      const target = new URL(String(url));
      if (target.pathname === "/admin/login") return new Response("{}", { status: 200, headers: { "set-cookie": "gbrain_admin=session" } });
      if (target.pathname === "/admin/api/register-client") return Response.json({ clientId: "other", clientSecret: "other-secret" });
      return Response.json({ access_token: JSON.parse(JSON.stringify(Object.fromEntries(new URLSearchParams(String(init?.body))))).client_id, expires_in: 3600 });
    }) as typeof fetch });
    expect(await moved.token("kb-aaaaaaaaaaaaaaaaaaaaaaaa")).toBe("other");
  });

  it("refuses unsafe configuration", () => {
    expect(() => new GBrainServiceConnection({ baseUrl: "http://user:pw@gbrain:3131", adminToken: admin, dataDir: "/tmp" })).toThrow();
    expect(() => new GBrainServiceConnection({ baseUrl: "http://gbrain:3131/mcp", adminToken: admin, dataDir: "/tmp" })).toThrow();
    expect(() => new GBrainServiceConnection({ baseUrl: "http://gbrain:3131", adminToken: "short", dataDir: "/tmp" })).toThrow();
  });

  it("derives stable UUID-shaped request ids that differ by intent", () => {
    const id = deterministicRequestId("put_page", "kb-a", "knowledge-docs/1", "hash", "create");
    expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u);
    expect(deterministicRequestId("put_page", "kb-a", "knowledge-docs/1", "hash", "create")).toBe(id);
    expect(deterministicRequestId("put_page", "kb-a", "knowledge-docs/1", "hash2", "create")).not.toBe(id);
  });
});
