import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import type { FullConfig } from "@playwright/test";

import { buildKnowledgeApp } from "../../src/app.js";

const DEFAULT_BASE_URL = "http://127.0.0.1:5310";

export default async function globalSetup(config: FullConfig) {
  if (process.env.KNOWLEDGE_E2E_BASE_URL) {
    return;
  }

  const baseUrl = new URL(config.projects[0]?.use.baseURL?.toString() ?? DEFAULT_BASE_URL);
  assert.equal(baseUrl.protocol, "http:", "Knowledge E2E fixture server must use HTTP");
  assert.ok(
    baseUrl.hostname === "127.0.0.1" || baseUrl.hostname === "localhost",
    "Knowledge E2E fixture server must remain on loopback",
  );

  const dataDir = await mkdtemp(path.join(tmpdir(), "doppelganger-knowledge-e2e-"));
  const app = await buildKnowledgeApp({
    environment: "test",
    config: {
      host: baseUrl.hostname,
      port: Number.parseInt(baseUrl.port, 10),
      dataDir,
      gbrainAutoStart: false,
      gbrainBaseUrl: null,
      gbrainToken: null,
      gbrainHome: path.join(dataDir, "gbrain-home"),
      knowledgeDatabasePath: path.join(dataDir, "knowledge.sqlite"),
      knowledgeDatabaseUrl: null,
    },
  });

  try {
    const collectionResponse = await app.inject({
      method: "POST",
      url: "/api/companies/default/knowledge/collections",
      payload: {
        name: "Knowledge E2E Fixtures",
        description: "Disposable native records created only for browser acceptance.",
        sourceConfig: { provider: "native" },
      },
    });
    assert.equal(collectionResponse.statusCode, 201);
    const collection = collectionResponse.json<{ id: string }>();

    const documentResponse = await app.inject({
      method: "POST",
      url: `/api/knowledge/collections/${collection.id}/documents`,
      payload: {
        title: "Knowledge Browser Acceptance Fixture",
        summary: "Disposable local record used to verify the standalone Knowledge frontend.",
        body: [
          "# Knowledge Browser Acceptance Fixture",
          "",
          "This document exists only inside the Playwright-managed temporary SQLite database.",
          "It verifies that the Library renders a canonical native Knowledge document without touching a live deployment.",
        ].join("\n"),
        bodyFormat: "markdown",
        status: "published",
        actor: { kind: "app", id: "playwright-e2e" },
      },
    });
    assert.equal(documentResponse.statusCode, 201);

    await app.listen({ host: baseUrl.hostname, port: Number.parseInt(baseUrl.port, 10) });
  } catch (error) {
    await app.close();
    await rm(dataDir, { recursive: true, force: true });
    throw error;
  }

  return async () => {
    await app.close();
    await rm(dataDir, { recursive: true, force: true });
  };
}
