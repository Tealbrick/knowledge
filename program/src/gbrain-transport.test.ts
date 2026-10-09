import { createServer, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { describe, expect, it } from "vitest";
import { callGBrainTool } from "./gbrain-transport.js";
import { GBrainRuntime } from "./gbrain.js";
import { loadConfig } from "./config.js";

async function fixture(run: (baseUrl: string, count: () => number) => Promise<void>, respond: (res: ServerResponse, id: string, args: Record<string, unknown>) => void) {
  let calls = 0;
  const server = createServer(async (req, res) => {
    if (req.url === "/health") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ status: "ok", version: "0.48.2.0", transport: "http", db: "ok" }));
      return;
    }
    calls++;
    let body = "";
    for await (const chunk of req) body += String(chunk);
    const request = JSON.parse(body) as { id: string; params: { arguments: Record<string, unknown> } };
    respond(res, request.id, request.params.arguments);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  try { await run(`http://127.0.0.1:${(server.address() as AddressInfo).port}`, () => calls); }
  finally { server.closeAllConnections(); await new Promise<void>((resolve) => server.close(() => resolve())); }
}

const call = (baseUrl: string, timeoutMs = 1000) => callGBrainTool({ baseUrl, token: "disposable-test-token", name: "query", args: { query: "fixture" }, timeoutMs });
const json = (res: ServerResponse, value: unknown) => { res.writeHead(200, { "content-type": "application/json" }); res.end(JSON.stringify(value)); };

describe("GBrain MCP compatibility", () => {
  it("pins bidirectional GraphPath semantics and preserves incoming and outgoing edges", async () => {
    const paths = [
      { from_slug: "incoming", to_slug: "root", link_type: "depends_on", context: "inbound", depth: 1 },
      { from_slug: "root", to_slug: "outgoing", link_type: "owns", context: "outbound", depth: 1 },
    ];
    let received: Record<string, unknown> | undefined;
    await fixture(async (url) => {
      const runtime = new GBrainRuntime(loadConfig({ environment: "test", config: { gbrainBaseUrl: url, gbrainToken: "disposable-test-token" } }));
      await runtime.start();
      try {
        expect(await runtime.traverseGraph({ slug: "root" })).toMatchObject({ ok: true, data: paths });
        expect(received).toEqual({ slug: "root", depth: 2, direction: "both" });
        await runtime.traverseGraph({ slug: "root", direction: "in", depth: 1, linkType: "owns" });
        expect(received).toEqual({ slug: "root", depth: 1, direction: "in", link_type: "owns" });
      } finally { await runtime.close(); }
    }, (res, id, args) => { received = args; json(res, { jsonrpc: "2.0", id, result: { content: [{ type: "text", text: JSON.stringify(paths) }] } }); });
  });

  it("reads legacy text JSON and structured content", async () => {
    for (const result of [{ content: [{ type: "text", text: '{"facts":[]}' }] }, { structuredContent: { facts: [] }, content: [{ type: "text", text: "fallback" }] }]) {
      await fixture(async (url) => { expect(await call(url)).toEqual({ facts: [] }); }, (res, id) => json(res, { jsonrpc: "2.0", id, result }));
    }
  });

  it("preserves multi-part results", async () => {
    const result = { content: [{ type: "text", text: "first" }, { type: "text", text: "second" }] };
    await fixture(async (url) => { expect(await call(url)).toEqual(result); }, (res, id) => json(res, { jsonrpc: "2.0", id, result }));
  });

  it("reads content[0] as the result when upstream appends notice or evidence blocks (v0.60.68+)", async () => {
    // Shape of upstream toolResultWithNotices on an upgraded brain: the JSON result stays
    // content[0]; the one-time behavior_changes notice and retrieval evidence are extra text blocks.
    const notice = "[gbrain notice behavior_changes kind=info]\nwhy: This brain was upgraded; these behaviors are now on.";
    const page = { slug: "people/henry", revision: "r1", content: "Henry" };
    for (const content of [
      [{ type: "text", text: JSON.stringify(page) }, { type: "text", text: notice }],
      [{ type: "text", text: JSON.stringify(page) }, { type: "text", text: "Other names: Hank" }, { type: "text", text: notice }],
      // Defensive: a notice block in front of the result is skipped too.
      [{ type: "text", text: notice }, { type: "text", text: JSON.stringify(page) }],
    ]) {
      let meta: Record<string, unknown> | undefined;
      await fixture(async (url) => {
        expect(await callGBrainTool({ baseUrl: url, token: "disposable-test-token", name: "get_page", args: { slug: "people/henry" }, timeoutMs: 1000, onMeta: m => { meta = m; } })).toEqual(page);
      }, (res, id) => json(res, { jsonrpc: "2.0", id, result: { content, _meta: { gbrain_notices: [{ code: "behavior_changes" }] } } }));
      expect(meta).toEqual({ gbrain_notices: [{ code: "behavior_changes" }] });
    }
  });

  it("resolves revision-aware page writes on an upgraded brain whose first reply carries a notice block", async () => {
    const notice = "[gbrain notice behavior_changes kind=info]\nwhy: upgraded";
    const sent: Array<{ name: string; args: Record<string, unknown> }> = [];
    let first = true;
    await fixture(async (url) => {
      const { GBrainServiceConnection } = await import("./gbrain-service.js");
      const fetcher: typeof fetch = async (input, init) => {
        const target = String(input);
        if (target.endsWith("/admin/login")) return new Response("{}", { status: 200, headers: { "set-cookie": "gbrain_admin=fixture; Path=/" } });
        if (target.endsWith("/admin/api/register-client")) return Response.json({ clientId: "c1", clientSecret: "s1" });
        if (target.endsWith("/token")) return Response.json({ access_token: "disposable-test-token", expires_in: 3600 });
        return fetch(input, init);
      };
      const dataDir = (await import("node:fs")).mkdtempSync((await import("node:path")).join((await import("node:os")).tmpdir(), "gbrain-notice-"));
      const service = new GBrainServiceConnection({ baseUrl: url, adminToken: "fixture-admin-token-0123456789abcdef0123", dataDir, fetch: fetcher });
      await service.putCanonicalPage("kb-0123456789abcdef01234567", "knowledge-docs/doc-1", "body");
      // The existing revision was read despite the notice block, so the write is an update, not a create.
      expect(sent.find(call => call.name === "put_page")?.args.expected_revision).toBe("r7");
    }, (res, id, args) => {
      const name = sent.length === 0 || !Object.hasOwn(args, "content") ? "get_page" : "put_page";
      sent.push({ name, args });
      const body = name === "get_page" ? { slug: "knowledge-docs/doc-1", revision: "r7" } : { status: "updated" };
      const content: Array<{ type: string; text: string }> = [{ type: "text", text: JSON.stringify(body) }];
      if (first) { content.push({ type: "text", text: notice }); first = false; }
      json(res, { jsonrpc: "2.0", id, result: { content } });
    });
  });

  it("preserves retrieval degradation instead of claiming a clean semantic result", async () => {
    await fixture(async url => {
      const runtime = new GBrainRuntime(loadConfig({ environment: "test", config: { gbrainBaseUrl: url, gbrainToken: "disposable-test-token" } }));
      await runtime.start();
      try {
        expect(await runtime.query({ query: "fixture" })).toMatchObject({ ok: true, status: "degraded", data: [], retrieval: { vector_enabled: false, degraded: [{ code: "embed_unavailable" }] } });
      } finally { await runtime.close(); }
    }, (res, id) => json(res, { jsonrpc: "2.0", id, result: { _meta: { retrieval: { vector_enabled: false, degraded: [{ code: "embed_unavailable" }] } }, content: [{ type: "text", text: "[]" }] } }));
  });

  it("reads a matching result from an open SSE stream after progress and multiline data", async () => {
    await fixture(async (url) => { expect(await call(url)).toEqual({ facts: [] }); }, (res, id) => {
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.write(': keepalive\r\n\r\ndata: {"jsonrpc":"2.0","method":"notifications/progress","params":{}}\r\n\r\n');
      res.write(`event: message\ndata: {"jsonrpc":"2.0","id":${JSON.stringify(id)},\ndata: "result":{"structuredContent":{"facts":[]}}}\n\n`);
      // Intentionally stays open: the adapter must stop after its result.
    });
  });

  it.each(["tool error", "protocol error", "wrong id", "missing result", "invalid isError"])("rejects %s even with HTTP 200", async (kind) => {
    await fixture(async (url, count) => {
      const runtime = new GBrainRuntime(loadConfig({ environment: "test", config: { gbrainBaseUrl: url, gbrainToken: "disposable-test-token" } }));
      await runtime.start();
      try {
        const result = await runtime.query({ query: "fixture" });
        expect(result).toMatchObject({ ok: false, status: "degraded", data: null });
        expect(JSON.stringify(result)).not.toContain("sensitive-upstream-detail");
        expect(count()).toBe(1);
      } finally { await runtime.close(); }
    }, (res, id) => {
      const message = kind === "tool error" ? { result: { isError: true, content: [{ type: "text", text: "sensitive-upstream-detail" }] } }
        : kind === "protocol error" ? { error: { code: -32602, message: "sensitive-upstream-detail" } }
        : kind === "missing result" ? {} : { result: { content: [], ...(kind === "invalid isError" ? { isError: "false" } : {}) } };
      json(res, { jsonrpc: "2.0", id: kind === "wrong id" ? "foreign-id" : id, ...message });
    });
  });

  it("rejects redirects without forwarding the token or retrying", async () => {
    await fixture(async (url, count) => { await expect(call(url)).rejects.toThrow(); expect(count()).toBe(1); }, (res) => { res.writeHead(307, { location: "/redirected" }); res.end(); });
  });

  it("rejects malformed, empty and oversized bodies", async () => {
    for (const body of ["", "not JSON", "x".repeat(2 * 1024 * 1024 + 1)]) {
      await fixture(async (url) => { await expect(call(url)).rejects.toThrow(); }, (res) => { res.writeHead(200, { "content-type": "application/json" }); res.end(body); });
    }
  });

  it("does not echo invalid upstream JSON in diagnostics", async () => {
    await fixture(async (url) => {
      await expect(call(url)).rejects.toThrow("Invalid GBrain MCP JSON response");
    }, (res) => { res.writeHead(200, { "content-type": "application/json" }); res.end("sensitive-upstream-detail"); });
  });

  it("bounds a stalled stream and does not retry", async () => {
    await fixture(async (url, count) => { await expect(call(url, 100)).rejects.toThrow(); expect(count()).toBe(1); }, (res) => { res.writeHead(200, { "content-type": "text/event-stream" }); res.write(": waiting\n\n"); });
  });
});
