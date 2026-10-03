import { mkdtemp, readFile } from "node:fs/promises";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { loadConfig } from "./config.js";
import {
  knowledgeRuntimeFilePath,
  removeKnowledgeRuntimeFile,
  writeKnowledgeRuntimeFile,
} from "./runtime-file.js";

describe("knowledge runtime file", () => {
  it("publishes the dynamic loopback URL into the Knowledge data directory", async () => {
    const dataDir = await mkdtemp(path.join(os.tmpdir(), "knowledge-runtime-"));
    const config = loadConfig({ config: { dataDir }, environment: "test" });
    const address: AddressInfo = {
      address: "127.0.0.1",
      family: "IPv4",
      port: 53127,
    };

    const runtimeFile = await writeKnowledgeRuntimeFile({
      address,
      config,
      now: new Date("2026-06-15T00:00:00.000Z"),
    });

    expect(runtimeFile).toEqual(
      expect.objectContaining({
        baseUrl: "http://127.0.0.1:53127",
        pid: process.pid,
        pluginId: "knowledge",
        sidecarId: "knowledge-program",
      }),
    );
    await expect(
      readFile(knowledgeRuntimeFilePath(config), "utf8").then((body) => JSON.parse(body)),
    ).resolves.toEqual(runtimeFile);

    await removeKnowledgeRuntimeFile({ config, pid: process.pid + 1 });
    await expect(readFile(knowledgeRuntimeFilePath(config), "utf8")).resolves.toContain(
      "http://127.0.0.1:53127",
    );

    await removeKnowledgeRuntimeFile({ config, pid: process.pid });
    await expect(readFile(knowledgeRuntimeFilePath(config), "utf8")).rejects.toThrow();
  });
});
