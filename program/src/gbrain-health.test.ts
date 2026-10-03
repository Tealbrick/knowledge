import { createServer, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { GBrainRuntime } from "./gbrain.js";
import { loadConfig } from "./config.js";
import {
  MAX_GBRAIN_HEALTH_RESPONSE_BYTES,
  probeGBrainHealth,
} from "./gbrain-health.js";

const servers: Array<ReturnType<typeof createServer>> = [];

afterEach(async () => {
  for (const server of servers.splice(0)) {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

async function fixture(
  handler: (response: ServerResponse, requestPath: string) => void,
  run: (baseUrl: string) => Promise<void>,
) {
  const server = createServer((request, response) => {
    handler(response, request.url ?? "/");
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address() as AddressInfo;
  await run(`http://127.0.0.1:${address.port}`);
}

function json(response: ServerResponse, value: unknown, status = 200) {
  response.writeHead(status, { "content-type": "application/json" });
  response.end(JSON.stringify(value));
}

describe("bounded GBrain health probe", () => {
  it.each(["pglite", "postgres"])("accepts the active serve --http %s liveness contract", async (engine) => {
    await fixture((response) => json(response, { status: "ok", version: "0.48.2.0", engine }), async (baseUrl) => {
      expect(await probeGBrainHealth({ baseUrl })).toEqual({ status: "healthy", version: "0.48.2.0", transport: "http", db: "ok" });
    });
  });

  it("does not mark a configured endpoint online when its health fails", async () => {
    await fixture((response) => json(response, { status: "down" }, 503), async (baseUrl) => {
      const runtime = new GBrainRuntime(loadConfig({ environment: "test", config: {
        gbrainBaseUrl: baseUrl, gbrainToken: "disposable-token",
      } }));
      await runtime.start();
      try {
        expect(runtime.status()).toMatchObject({ status: "degraded", observedVersion: null });
        expect(await runtime.getPage({ slug: "synthetic" })).toMatchObject({ ok: false, status: "degraded" });
      } finally { await runtime.close(); }
    });
  });

  it("records observed health version without treating a missing token as usable MCP", async () => {
    await fixture((response) => json(response, { status: "ok", version: "0.48.2.0", transport: "http", db: "ok" }), async (baseUrl) => {
      const runtime = new GBrainRuntime(loadConfig({ environment: "test", config: {
        gbrainBaseUrl: baseUrl, gbrainToken: "",
      } }));
      await runtime.start();
      try {
        expect(runtime.status()).toMatchObject({ status: "degraded", observedVersion: "0.48.2.0" });
        expect(await runtime.getPage({ slug: "synthetic" })).toMatchObject({ ok: false });
      } finally { await runtime.close(); }
    });
  });

  it("projects the strict 0.48 health contract and ignores additive fields", async () => {
    await fixture((response) => {
      json(response, {
        status: "ok",
        version: "0.48.0",
        transport: "http",
        db: "ok",
        build: "ignored",
      });
    }, async (baseUrl) => {
      await expect(probeGBrainHealth({ baseUrl })).resolves.toEqual({
        status: "healthy",
        version: "0.48.0",
        transport: "http",
        db: "ok",
      });
    });
  });

  it.each([
    ["wrong body", { status: "ready", version: "0.48.0", transport: "http", db: "ok" }],
    ["database down", { status: "ok", version: "0.48.0", transport: "http", db: "down" }],
    ["bare status", { status: "ok", version: "0.48.2.0" }],
    ["unknown engine", { status: "ok", version: "0.48.2.0", engine: "unknown" }],
    ["contradictory health", { status: "ok", version: "0.48.2.0", engine: "pglite", db: "down" }],
  ])("rejects a 200 response with %s", async (_label, body) => {
    await fixture((response) => json(response, body), async (baseUrl) => {
      await expect(probeGBrainHealth({ baseUrl })).resolves.toEqual({
        status: "unavailable",
        reason: "malformed_response",
      });
    });
  });

  it("rejects non-2xx without exposing the upstream body", async () => {
    await fixture((response) => json(response, { secret: "upstream-secret" }, 503), async (baseUrl) => {
      const result = await probeGBrainHealth({ baseUrl });
      expect(result).toEqual({ status: "unavailable", reason: "http_error" });
      expect(JSON.stringify(result)).not.toContain("upstream-secret");
    });
  });

  it("rejects redirects without requesting the target", async () => {
    let redirectedCalls = 0;
    await fixture((response, requestPath) => {
      if (requestPath === "/health") {
        response.writeHead(307, { location: "/health-target" });
        response.end();
        return;
      }
      redirectedCalls += 1;
      json(response, { status: "ok", version: "0.48.0", transport: "http", db: "ok" });
    }, async (baseUrl) => {
      await expect(probeGBrainHealth({ baseUrl })).resolves.toEqual({
        status: "unavailable",
        reason: "redirect_rejected",
      });
      expect(redirectedCalls).toBe(0);
    });
  });

  it("times out while the response body is stalled", async () => {
    await fixture((response) => {
      response.writeHead(200, { "content-type": "application/json" });
      response.write('{"status":"ok"');
    }, async (baseUrl) => {
      await expect(probeGBrainHealth({ baseUrl, timeoutMs: 50 })).resolves.toEqual({
        status: "unavailable",
        reason: "timeout",
      });
    });
  });

  it("stops reading an oversized response at the byte limit", async () => {
    await fixture((response) => {
      response.writeHead(200, { "content-type": "application/json" });
      response.end("x".repeat(MAX_GBRAIN_HEALTH_RESPONSE_BYTES + 1));
    }, async (baseUrl) => {
      await expect(probeGBrainHealth({ baseUrl })).resolves.toEqual({
        status: "unavailable",
        reason: "response_too_large",
      });
    });
  });

  it("rejects credential-bearing URLs without echoing credentials", async () => {
    const result = await probeGBrainHealth({
      baseUrl: "http://gbrain-user:secret-token@127.0.0.1:1",
    });
    expect(result).toEqual({ status: "unavailable", reason: "invalid_url" });
    expect(JSON.stringify(result)).not.toContain("secret-token");
  });
});
