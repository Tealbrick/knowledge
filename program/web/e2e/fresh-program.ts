import { mkdtemp, rm } from "node:fs/promises";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";

import { buildKnowledgeApp } from "../../src/app.js";

/**
 * A brand-new, empty Knowledge Program on a loopback port with its own
 * disposable data directory. Used for first-run flows that the shared seeded
 * fixture cannot exercise.
 */
export async function startFreshProgram() {
  const dataDir = await mkdtemp(path.join(tmpdir(), "knowledge-e2e-fresh-"));
  const app = await buildKnowledgeApp({
    environment: "test",
    config: {
      host: "127.0.0.1",
      port: 0,
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
    await app.listen({ host: "127.0.0.1", port: 0 });
  } catch (error) {
    await app.close();
    await rm(dataDir, { recursive: true, force: true });
    throw error;
  }
  const { port } = app.server.address() as AddressInfo;
  return {
    baseUrl: `http://127.0.0.1:${port}`,
    dataDir,
    async close() {
      await app.close();
      await rm(dataDir, { recursive: true, force: true });
    },
  };
}
