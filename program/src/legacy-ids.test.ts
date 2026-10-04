import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  gbrainHomeFilePath,
  isRulesEvaluateMethod,
  migrateLegacyKnowledgeDataDir,
  readTealbrickEnv,
  resetLegacyWarningsForTest,
  resolveDefaultKnowledgeDataDir,
} from "./legacy-ids.js";

function tempHome() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "knowledge-legacy-home-"));
}

afterEach(() => {
  resetLegacyWarningsForTest();
  vi.restoreAllMocks();
});

describe("Tealbrick environment aliases", () => {
  it("prefers the new name, falls back to the deprecated name once-warned", () => {
    const warn = vi.spyOn(process, "emitWarning").mockImplementation(() => undefined);
    expect(readTealbrickEnv("TEALBRICK_RUNTIME_FILE", {
      TEALBRICK_RUNTIME_FILE: "/new",
      DOPPELGANGER_RUNTIME_FILE: "/old",
    })).toBe("/new");
    expect(warn).not.toHaveBeenCalled();

    const legacyOnly = { DOPPELGANGER_UI_SDK_ROOT: "/old-sdk" };
    expect(readTealbrickEnv("TEALBRICK_UI_SDK_ROOT", legacyOnly)).toBe("/old-sdk");
    expect(readTealbrickEnv("TEALBRICK_UI_SDK_ROOT", legacyOnly)).toBe("/old-sdk");
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0]?.[0])).toContain("TEALBRICK_UI_SDK_ROOT");

    expect(readTealbrickEnv("TEALBRICK_RUNTIME_FILE", {})).toBeUndefined();
  });
});

describe("Knowledge default data directory migration", () => {
  it("fresh install uses ~/.tealbrick-knowledge and migrates nothing", () => {
    const home = tempHome();
    expect(resolveDefaultKnowledgeDataDir(home)).toBe(path.join(home, ".tealbrick-knowledge"));
    expect(migrateLegacyKnowledgeDataDir({ homeDir: home, env: {} })).toEqual({
      status: "fresh",
      path: path.join(home, ".tealbrick-knowledge"),
    });
    expect(fs.existsSync(path.join(home, ".tealbrick-knowledge"))).toBe(false);
  });

  it("old-only install keeps working before migration and is renamed once at startup", () => {
    vi.spyOn(process, "emitWarning").mockImplementation(() => undefined);
    const home = tempHome();
    const legacy = path.join(home, ".doppelganger-knowledge");
    fs.mkdirSync(path.join(legacy, "gbrain-home"), { recursive: true });
    fs.writeFileSync(path.join(legacy, "knowledge.sqlite"), "data");

    expect(resolveDefaultKnowledgeDataDir(home)).toBe(legacy);

    expect(migrateLegacyKnowledgeDataDir({ homeDir: home, env: {} })).toEqual({
      status: "migrated",
      from: legacy,
      path: path.join(home, ".tealbrick-knowledge"),
    });
    expect(fs.existsSync(legacy)).toBe(false);
    expect(fs.readFileSync(path.join(home, ".tealbrick-knowledge", "knowledge.sqlite"), "utf8")).toBe("data");
    expect(resolveDefaultKnowledgeDataDir(home)).toBe(path.join(home, ".tealbrick-knowledge"));
    expect(migrateLegacyKnowledgeDataDir({ homeDir: home, env: {} }).status).toBe("current");
  });

  it("both present: the new directory wins and the legacy one is left untouched", () => {
    const home = tempHome();
    fs.mkdirSync(path.join(home, ".tealbrick-knowledge"));
    fs.mkdirSync(path.join(home, ".doppelganger-knowledge"));
    fs.writeFileSync(path.join(home, ".doppelganger-knowledge", "keep.txt"), "keep");

    expect(resolveDefaultKnowledgeDataDir(home)).toBe(path.join(home, ".tealbrick-knowledge"));
    expect(migrateLegacyKnowledgeDataDir({ homeDir: home, env: {} }).status).toBe("current");
    expect(fs.readFileSync(path.join(home, ".doppelganger-knowledge", "keep.txt"), "utf8")).toBe("keep");
  });

  it("an explicit KNOWLEDGE_DATA_DIR override wins and nothing is moved", () => {
    const home = tempHome();
    fs.mkdirSync(path.join(home, ".doppelganger-knowledge"));
    const override = path.join(home, "custom");

    expect(migrateLegacyKnowledgeDataDir({ homeDir: home, env: { KNOWLEDGE_DATA_DIR: override } })).toEqual({
      status: "override",
      path: override,
    });
    expect(fs.existsSync(path.join(home, ".doppelganger-knowledge"))).toBe(true);
    expect(fs.existsSync(path.join(home, ".tealbrick-knowledge"))).toBe(false);
  });

  it("keeps the legacy directory when the rename fails (e.g. cross-device)", () => {
    vi.spyOn(process, "emitWarning").mockImplementation(() => undefined);
    const home = tempHome();
    const legacy = path.join(home, ".doppelganger-knowledge");
    fs.mkdirSync(legacy);
    vi.spyOn(fs, "renameSync").mockImplementation(() => {
      throw Object.assign(new Error("cross-device link"), { code: "EXDEV" });
    });

    expect(migrateLegacyKnowledgeDataDir({ homeDir: home, env: {} })).toEqual({
      status: "legacy-kept",
      path: legacy,
      reason: "EXDEV",
    });
    expect(fs.existsSync(legacy)).toBe(true);
  });
});

describe("GBrain home legacy files", () => {
  it("moves a legacy token file to its Tealbrick name and prefers the new file when both exist", () => {
    const gbrainHome = tempHome();
    fs.writeFileSync(path.join(gbrainHome, ".doppelganger-token"), "gbrain_old\n", { mode: 0o600 });

    const tokenPath = gbrainHomeFilePath(gbrainHome, ".tealbrick-token");
    expect(tokenPath).toBe(path.join(gbrainHome, ".tealbrick-token"));
    expect(fs.readFileSync(tokenPath, "utf8")).toBe("gbrain_old\n");
    expect(fs.statSync(tokenPath).mode & 0o777).toBe(0o600);

    fs.writeFileSync(path.join(gbrainHome, ".doppelganger-token"), "gbrain_stale\n");
    expect(fs.readFileSync(gbrainHomeFilePath(gbrainHome, ".tealbrick-token"), "utf8")).toBe("gbrain_old\n");
    expect(fs.existsSync(path.join(gbrainHome, ".doppelganger-token"))).toBe(true);
  });
});

describe("Rules evaluate method aliases", () => {
  it("accepts both the legacy and Tealbrick method ids and nothing else", () => {
    expect(isRulesEvaluateMethod("doppelganger.rules.evaluate")).toBe(true);
    expect(isRulesEvaluateMethod("tealbrick.rules.evaluate")).toBe(true);
    expect(isRulesEvaluateMethod("rules.evaluate")).toBe(false);
    expect(isRulesEvaluateMethod(undefined)).toBe(false);
  });
});
