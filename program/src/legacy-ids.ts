import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/**
 * Doppelganger -> Tealbrick identifier transition (2026-10-04).
 *
 * This is the single place that lists every legacy identifier Knowledge still
 * accepts. Each entry maps the new Tealbrick name to the old Doppelganger name.
 *
 * Transition rule: readers/validators accept BOTH names; producers keep
 * emitting the legacy wire id until every consumer accepts the new one.
 *
 * Removal condition: delete an entry (and its fallback branch) once
 *   1. every consumer listed in the PR "flip emission" plan (Portal Core,
 *      Rules Approvals, Marketplace, the Hermes plugin installer) accepts the
 *      new id and emission has been flipped to it, and
 *   2. no supported install still has the legacy env var, directory or file
 *      (one release after the flip, at the earliest).
 */
export const LEGACY_IDS = {
  /** Environment variables: new name -> deprecated alias. */
  env: {
    TEALBRICK_RUNTIME_FILE: "DOPPELGANGER_RUNTIME_FILE",
    TEALBRICK_UI_SDK_ROOT: "DOPPELGANGER_UI_SDK_ROOT",
  },
  /** Default hidden-home data directory: new basename -> legacy basename. */
  dataDir: {
    ".tealbrick-knowledge": ".doppelganger-knowledge",
  },
  /** Files inside the GBrain home: new basename -> legacy basename. */
  gbrainHomeFiles: {
    ".tealbrick-token": ".doppelganger-token",
    ".tealbrick-gbrain-runtime.json": ".doppelganger-gbrain-runtime.json",
  },
  /** Wire/RPC ids accepted from peers: new id -> legacy id (still emitted). */
  wire: {
    "tealbrick.rules.evaluate": "doppelganger.rules.evaluate",
  },
  /**
   * GBrain schema pack ids: alias -> canonical. The canonical id stays
   * `doppelganger` because it is persisted in installed GBrain config and
   * brain rows; `tealbrick` is installed as an alias pack that extends it.
   */
  schemaPack: {
    tealbrick: "doppelganger",
  },
} as const;

export type TealbrickEnvName = keyof typeof LEGACY_IDS.env;

const warned = new Set<string>();

/** Emit a deprecation warning at most once per process for a given key. */
export function warnLegacyOnce(key: string, message: string): void {
  if (warned.has(key)) return;
  warned.add(key);
  process.emitWarning(message, { type: "DeprecationWarning", code: "TEALBRICK_LEGACY_ID" });
}

/** Test hook: forget which deprecation warnings were already emitted. */
export function resetLegacyWarningsForTest(): void {
  warned.clear();
}

/**
 * Read `TEALBRICK_X`, falling back to the deprecated `DOPPELGANGER_X` alias.
 * Warns once when only the legacy name is set.
 */
export function readTealbrickEnv(
  name: TealbrickEnvName,
  env: NodeJS.ProcessEnv = process.env,
): string | undefined {
  const current = env[name];
  if (current !== undefined) return current;
  const legacyName = LEGACY_IDS.env[name];
  const legacy = env[legacyName];
  if (legacy !== undefined) {
    warnLegacyOnce(
      `env:${legacyName}`,
      `${legacyName} is deprecated; set ${name} instead.`,
    );
  }
  return legacy;
}

const KNOWLEDGE_DATA_DIR_NAME = ".tealbrick-knowledge" as const;

export function knowledgeDataDirCandidates(homeDir: string = os.homedir()) {
  return {
    current: path.join(homeDir, KNOWLEDGE_DATA_DIR_NAME),
    legacy: path.join(homeDir, LEGACY_IDS.dataDir[KNOWLEDGE_DATA_DIR_NAME]),
  };
}

/**
 * Resolve the default (no KNOWLEDGE_DATA_DIR override) data directory without
 * touching the filesystem beyond existence checks: the new directory wins when
 * present; an install that still only has the legacy directory keeps using it.
 */
export function resolveDefaultKnowledgeDataDir(homeDir: string = os.homedir()): string {
  const { current, legacy } = knowledgeDataDirCandidates(homeDir);
  if (!fs.existsSync(current) && fs.existsSync(legacy)) {
    warnLegacyOnce(
      "dataDir",
      `Using legacy Knowledge data directory ${legacy}; it will move to ${current} on next Program start.`,
    );
    return legacy;
  }
  return current;
}

export type LegacyMigrationOutcome =
  | { readonly status: "fresh"; readonly path: string }
  | { readonly status: "current"; readonly path: string }
  | { readonly status: "migrated"; readonly from: string; readonly path: string }
  | { readonly status: "legacy-kept"; readonly path: string; readonly reason: string };

/**
 * One-time move of a legacy path to its new name. Never deletes data:
 *   - new exists           -> untouched (legacy, if any, is left in place)
 *   - only legacy exists   -> atomic rename; on failure (e.g. EXDEV) keep legacy
 *   - neither exists       -> fresh install, nothing to do
 */
export function migrateLegacyPath(current: string, legacy: string): LegacyMigrationOutcome {
  if (fs.existsSync(current)) return { status: "current", path: current };
  if (!fs.existsSync(legacy)) return { status: "fresh", path: current };
  try {
    fs.renameSync(legacy, current);
    return { status: "migrated", from: legacy, path: current };
  } catch (error) {
    const reason = (error as NodeJS.ErrnoException).code ?? String(error);
    warnLegacyOnce(
      `migrate:${legacy}`,
      `Could not move ${legacy} to ${current} (${reason}); continuing with the legacy path.`,
    );
    return { status: "legacy-kept", path: legacy, reason };
  }
}

/**
 * Startup migration for the default data directory. Explicit overrides
 * (KNOWLEDGE_DATA_DIR or a configured dataDir) win unchanged.
 */
export function migrateLegacyKnowledgeDataDir(options: {
  readonly homeDir?: string;
  readonly env?: NodeJS.ProcessEnv;
} = {}): LegacyMigrationOutcome | { readonly status: "override"; readonly path: string } {
  const env = options.env ?? process.env;
  if (env.KNOWLEDGE_DATA_DIR !== undefined && env.KNOWLEDGE_DATA_DIR.trim() !== "") {
    return { status: "override", path: path.resolve(env.KNOWLEDGE_DATA_DIR) };
  }
  const { current, legacy } = knowledgeDataDirCandidates(options.homeDir);
  return migrateLegacyPath(current, legacy);
}

export type GBrainHomeFileName = keyof typeof LEGACY_IDS.gbrainHomeFiles;

/**
 * Path of a Tealbrick-named file inside the GBrain home. When only the legacy
 * file exists it is renamed in place (same directory, so the rename is atomic);
 * if that fails the legacy path is returned so nothing is lost.
 */
export function gbrainHomeFilePath(gbrainHome: string, name: GBrainHomeFileName): string {
  const current = path.join(gbrainHome, name);
  const legacy = path.join(gbrainHome, LEGACY_IDS.gbrainHomeFiles[name]);
  return migrateLegacyPath(current, legacy).path;
}

/** Rules evaluate method still emitted on the wire (flip pending). */
export const RULES_EVALUATE_METHOD = LEGACY_IDS.wire["tealbrick.rules.evaluate"];

const ACCEPTED_RULES_METHODS: ReadonlySet<string> = new Set([
  "tealbrick.rules.evaluate",
  RULES_EVALUATE_METHOD,
]);

export function isRulesEvaluateMethod(value: unknown): boolean {
  return typeof value === "string" && ACCEPTED_RULES_METHODS.has(value);
}
