import { createServer, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";

import { describe, expect, it } from "vitest";

import { loadConfig } from "./config.js";
import { GBrainRuntime } from "./gbrain.js";
import type { KnowledgeGBrainPartitionToken } from "./types.js";

async function withNativeFixture(
  run: (
    runtime: GBrainRuntime,
    calls: Array<{ name: string; arguments: Record<string, unknown> }>,
    authorizationHeaders: string[],
  ) => Promise<void>,
  options: { readonly partitionTokens?: readonly KnowledgeGBrainPartitionToken[] } = {},
): Promise<void> {
  const calls: Array<{ name: string; arguments: Record<string, unknown> }> = [];
  const authorizationHeaders: string[] = [];
  const server = createServer((request, response) => {
    if (request.url === "/health") {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ status: "ok", version: "0.48.2.0", engine: "pglite" }));
      return;
    }
    if (request.url !== "/mcp" || request.method !== "POST") {
      response.writeHead(404);
      response.end();
      return;
    }
    let body = "";
    request.on("data", (chunk) => {
      body += String(chunk);
    });
    request.on("end", () => {
      const parsed = JSON.parse(body) as {
        readonly id: string;
        readonly params?: { readonly name?: string; readonly arguments?: Record<string, unknown> };
      };
      const name = parsed.params?.name ?? "";
      const args = parsed.params?.arguments ?? {};
      calls.push({ name, arguments: args });
      authorizationHeaders.push(request.headers.authorization ?? "");
      const data =
        name === "list_pages"
          ? [{ slug: "people/alice-example", source_id: "default", title: "Alice Example", type: "person", updated_at: "2026-09-06T00:00:00.000Z" }]
          : name === "entity"
            ? {
                protocol_version: 1,
                found: true,
                card: {
                  entity: { slug: "people/alice-example", title: "Alice Example", type: "person" },
                  aka: ["alice"],
                  summary: "Privacy-safe synopsis",
                  last_touched: { updated_at: "2026-09-06T00:00:00.000Z", last_retrieved_at: null, last_timeline_date: null },
                  open_threads: [],
                  edges: [{ type: "works_at", direction: "out", slug: "companies/acme-example", context: null }],
                  backlink_count: 1,
                  active_fact_count: 2,
                },
              }
              : name === "get_timeline"
              ? [{ slug: "people/alice-example", date: "2026-09-01", summary: "Synthetic timeline marker" }]
              : name === "get_links"
                ? [{ from_slug: "people/alice-example", to_slug: "companies/acme-example", link_type: "works_at", context: null }]
                : name === "traverse_graph"
                  ? [{ from_slug: "people/alice-example", to_slug: "companies/acme-example", link_type: "works_at", depth: 1 }]
              : name === "find_trajectory"
                ? { points: [], regressions: [], drift_score: 0, schema_version: 1 }
                : { tool: name, args };
      sendJsonRpc(response, parsed.id, data);
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address() as AddressInfo;
  const runtime = new GBrainRuntime(
    loadConfig({
      environment: "test",
      config: {
        gbrainBaseUrl: `http://127.0.0.1:${address.port}`,
        gbrainToken: "disposable-test-token",
        gbrainPartitionTokens: options.partitionTokens ?? [],
      },
    }),
  );
  try {
    await runtime.start();
    await run(runtime, calls, authorizationHeaders);
  } finally {
    await runtime.close();
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

function sendJsonRpc(response: ServerResponse, id: string, data: unknown) {
  response.writeHead(200, { "content-type": "application/json" });
  response.end(JSON.stringify({
    jsonrpc: "2.0",
    id,
    result: { content: [{ type: "text", text: JSON.stringify(data) }] },
  }));
}

describe("native GBrain Brain surfaces", () => {
  it("enumerates pages through list_pages, not fact recall", async () => {
    await withNativeFixture(async (runtime, calls) => {
      const result = await runtime.listEntities({ limit: 25, offset: 5, type: "person" });
      expect(result).toMatchObject({ ok: true, status: "ready" });
      expect(result.data).toEqual([
        expect.objectContaining({ slug: "people/alice-example", type: "person" }),
      ]);
      expect(calls).toContainEqual({
        name: "list_pages",
        arguments: { limit: 25, offset: 5, type: "person", sort: "updated_desc" },
      });
      expect(calls.some((call) => call.name === "recall")).toBe(false);
    });
  });

  it("threads the authorized Knowledge partition into native GBrain reads", async () => {
    await withNativeFixture(async (runtime, calls) => {
      await runtime.query({ query: "fixture", partitionKey: "workspace-alpha/project-alpha" });
      await runtime.recall({ query: "fixture", partitionKey: "workspace-alpha/project-alpha" });
      await runtime.listPages({ partitionKey: "workspace-alpha/project-alpha" });
      expect(calls[0]?.arguments).toMatchObject({ source_id: expect.stringMatching(/^kb-[a-f0-9]{24}$/u) });
      expect(calls[0]?.arguments).not.toHaveProperty("expand");
      expect(calls[0]?.arguments).not.toHaveProperty("limit");
      expect(calls[0]?.arguments).not.toHaveProperty("detail");
      expect(calls[1]?.arguments).toMatchObject({ source_id: calls[0]?.arguments.source_id });
      expect(calls[1]?.arguments).toHaveProperty("query", "fixture");
      expect(calls[1]?.arguments).not.toHaveProperty("grep");
      expect(calls[1]?.arguments).not.toHaveProperty("limit");
      expect(calls[1]?.arguments).not.toHaveProperty("include_pending");
      expect(calls[2]?.arguments).toMatchObject({ source_id: calls[0]?.arguments.source_id });
    }, { partitionTokens: [{ partitionKey: "workspace-alpha/project-alpha", token: "partition-scoped-test-token" }] });
  });

  it("allows an explicit bounded retrieval strategy without hard-disabling native expansion", async () => {
    await withNativeFixture(async (runtime, calls) => {
      await runtime.query({ query: "fixture", expand: false, detail: "high", limit: 12 });
      expect(calls[0]?.arguments).toMatchObject({ expand: false, detail: "high", limit: 12 });
    });
  });

  it("preserves historical extraction provenance and distinct recall filters", async () => {
    await withNativeFixture(async (runtime, calls) => {
      await runtime.extractFacts({ text: "Fixture", sessionId: "history", validFrom: "2024-01-02T00:00:00Z", sourceSlug: "knowledge-docs/fixture" });
      expect(calls[0]?.arguments).toMatchObject({ source_slug: "knowledge-docs/fixture", valid_from: "2024-01-02T00:00:00Z", visibility: "private" });
      await runtime.recall({ query: "Where did Mira travel?", grep: "Mira", sessionId: "history", budgetTokens: 2000, includeExpired: true, since: "2024-01-01", supersessions: true, includePending: false });
      expect(calls[1]?.arguments).toMatchObject({ query: "Where did Mira travel?", grep: "Mira", session_id: "history", budget_tokens: 2000, include_expired: true, since: "2024-01-01", supersessions: true, include_pending: false });
    });
  });

  it("fails closed without a partition credential instead of reading the populated default source", async () => {
    await withNativeFixture(async (runtime, calls, headers) => {
      for (const partitionKey of ["eval-a", "eval-b"]) {
        expect(await runtime.recall({ query: "default source sentinel", partitionKey })).toMatchObject({ ok: false, status: "degraded" });
      }
      expect(calls).toEqual([]);
      expect(headers).toEqual([]);
      await expect(runtime.recall({ partitionKey: "../invalid" })).rejects.toThrow("Invalid Knowledge partition");
    });
  });

  it("uses a server-only GBrain token for a configured partition", async () => {
    await withNativeFixture(
      async (runtime, _calls, authorizationHeaders) => {
        await runtime.query({ query: "fixture", partitionKey: "workspace-alpha/project-alpha" });
        expect(authorizationHeaders[0]).toBe("Bearer partition-scoped-test-token");
      },
      {
        partitionTokens: [{ partitionKey: "workspace-alpha/project-alpha", token: "partition-scoped-test-token" }],
      },
    );
  });

  it("exposes native entity card aliases, timeline, trajectory and relationship calls", async () => {
    await withNativeFixture(async (runtime, calls) => {
      const card = await runtime.getEntityCard({ name: "people/alice-example" });
      const timeline = await runtime.getTimeline({ slug: "people/alice-example", limit: 10 });
      const links = await runtime.getLinks({ slug: "people/alice-example" });
      const graph = await runtime.traverseGraph({ slug: "people/alice-example", depth: 2, direction: "both" });
      const trajectory = await runtime.findTrajectory({ entitySlug: "people/alice-example", kind: "all", limit: 20 });
      expect(card.data).toMatchObject({ found: true, card: { aka: ["alice"], edges: [{ type: "works_at" }] } });
      expect(timeline.data).toEqual([expect.objectContaining({ summary: "Synthetic timeline marker" })]);
      expect(links.data).toEqual([expect.objectContaining({ link_type: "works_at" })]);
      expect(graph.data).toEqual([expect.objectContaining({ link_type: "works_at" })]);
      expect(trajectory.data).toMatchObject({ schema_version: 1 });
      expect(calls.map((call) => call.name)).toEqual(["entity", "get_timeline", "get_links", "traverse_graph", "find_trajectory"]);
      expect(calls[0]?.arguments).toEqual({ name: "people/alice-example" });
      expect(calls[1]?.arguments).toEqual({ slug: "people/alice-example", limit: 10 });
      expect(calls[2]?.arguments).toEqual({ slug: "people/alice-example" });
      expect(calls[3]?.arguments).toEqual({ slug: "people/alice-example", depth: 2, direction: "both" });
      expect(calls[4]?.arguments).toEqual({ entity_slug: "people/alice-example", kind: "all", limit: 20 });
    });
  });

  it("reports deterministic transport readiness and a bounded gap when offline", async () => {
    await withNativeFixture(async (runtime) => {
      expect(runtime.nativeCapabilityReadiness()).toMatchObject({
        status: "ready",
        capabilities: {
          // Health proves transport reachability only. Operation readiness is
          // observed by the caller after each native call, not declared by a
          // sidecar being online.
          pageEnumeration: { operation: "list_pages", status: "unknown" },
          entityCard: { operation: "entity", status: "unknown" },
          timeline: { operation: "get_timeline", status: "unknown" },
          typedRelationships: { operation: "get_links + traverse_graph", status: "unknown" },
        },
        capabilityGaps: [],
      });
    });

    const offline = new GBrainRuntime(loadConfig({ environment: "test", config: { gbrainAutoStart: false } }));
    await offline.start();
    expect(offline.nativeCapabilityReadiness()).toMatchObject({
      status: "degraded",
      capabilities: { pageEnumeration: { status: "unavailable" } },
      capabilityGaps: [{ code: "gbrain_unavailable" }],
    });
    await offline.close();
  });
});
