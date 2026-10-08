import type { FastifyInstance } from "fastify";
import { afterEach, describe, expect, it, vi } from "vitest";

import { buildKnowledgeApp } from "./app.js";

let app: FastifyInstance | undefined;

async function build() {
  app = await buildKnowledgeApp({
    environment: "test",
    config: {
      gbrainAutoStart: false,
      gbrainBaseUrl: null,
      gbrainToken: null,
      openNotebookBaseUrl: null,
      openNotebookToken: null,
      knowledgeDatabasePath: null,
    },
  });
  return app;
}

afterEach(async () => {
  vi.unstubAllEnvs();
  await app?.close();
  app = undefined;
});

describe("web shell frame-ancestors", () => {
  it("allows exactly 'self' and the configured Portal origin", async () => {
    vi.stubEnv("TEALBRICK_PORTAL_URL", "https://portal.example/app/path?x=1");
    const instance = await build();
    for (const url of ["/", "/embed", "/?view=settings"]) {
      const csp = String((await instance.inject({ method: "GET", url })).headers["content-security-policy"]);
      expect(csp).toContain("frame-ancestors 'self' https://portal.example");
      expect(csp.match(/frame-ancestors[^;]*/u)?.[0]).toBe("frame-ancestors 'self' https://portal.example");
      expect(csp).not.toContain("*");
    }
  });

  it("is 'self' only when no Portal URL is configured", async () => {
    vi.stubEnv("TEALBRICK_PORTAL_URL", "");
    const csp = String((await (await build()).inject({ method: "GET", url: "/" })).headers["content-security-policy"]);
    expect(csp.match(/frame-ancestors[^;]*/u)?.[0]).toBe("frame-ancestors 'self'");
    expect(csp).not.toContain("*");
  });
});
