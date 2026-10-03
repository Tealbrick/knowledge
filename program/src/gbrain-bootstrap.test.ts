import { afterEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { GBrainRuntime } from "./gbrain.js";
import { loadConfig } from "./config.js";

afterEach(() => vi.unstubAllEnvs());

// Controlled executable shim: exercises actual spawn arguments without running
// Bun, installing dependencies, initializing a brain, or touching user state.
async function bootstrapFixture(mode: "install" | "existing-identity", run: (runtime: GBrainRuntime, calls: () => Promise<string[][]>) => Promise<void>) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "knowledge-bootstrap-test-"));
  try {
    const repo = path.join(root, "repo");
    const fixtureGbrainHome = path.join(root, "gbrain-home");
    const bin = path.join(root, "fake-bun/bin");
    const log = path.join(root, "calls.jsonl");
    await fs.mkdir(path.join(repo, "src"), { recursive: true });
    await fs.writeFile(path.join(repo, "src/cli.ts"), "// disposable marker\n");
    await fs.mkdir(bin, { recursive: true });
    await fs.writeFile(path.join(bin, "bun"), `#!${process.execPath}\nrequire('node:fs').appendFileSync(${JSON.stringify(log)}, JSON.stringify(process.argv.slice(2))+'\\n');\nprocess.stderr.write(${JSON.stringify(mode === "install" ? "fixture install stopped" : "identity already exists")});\nprocess.exit(1);\n`, { mode: 0o700 });
    if (mode === "existing-identity") {
      await fs.mkdir(path.join(repo, "node_modules/@electric-sql/pglite"), { recursive: true });
      await fs.mkdir(path.join(fixtureGbrainHome, ".gbrain"), { recursive: true });
      await fs.writeFile(path.join(fixtureGbrainHome, ".gbrain/config.json"), JSON.stringify({ engine: "pglite" }));
    }
    vi.stubEnv("BUN_INSTALL", path.join(root, "fake-bun"));
    vi.stubEnv("GBRAIN_BASE_URL", "");
    vi.stubEnv("GBRAIN_TOKEN", "");
    const runtime = new GBrainRuntime(loadConfig({ environment: "test", config: {
      dataDir: root, gbrainHome: fixtureGbrainHome, gbrainRepoPath: repo,
      gbrainAutoStart: true, gbrainBaseUrl: null, gbrainToken: null,
    } }));
    try {
      await run(runtime, async () => (await fs.readFile(log, "utf8")).trim().split("\n").map(line => JSON.parse(line) as string[]));
    } finally { await runtime.close(); }
  } finally { await fs.rm(root, { recursive: true, force: true }); }
}

describe("GBrain bootstrap safety", () => {
  it("installs the frozen dependency graph without upstream lifecycle scripts", async () => {
    await bootstrapFixture("install", async (runtime, calls) => {
      await runtime.start();
      expect(await calls()).toEqual([["install", "--frozen-lockfile", "--ignore-scripts"]]);
      expect(runtime.status().status).toBe("degraded");
    });
  });

  it("starts the app-owned worker without creating or revoking legacy identities", async () => {
    await bootstrapFixture("existing-identity", async (runtime, calls) => {
      await runtime.start();
      expect(await calls()).toEqual([["run", expect.stringContaining("gbrain-managed-worker.mjs")]]);
      expect(runtime.status()).toMatchObject({ status: "degraded", tokenConfigured: true });
    });
  });
});
