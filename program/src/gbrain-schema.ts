import fs from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { LEGACY_IDS } from "./legacy-ids.js";

/**
 * Canonical GBrain schema pack id. This is a persisted contract id (written to
 * `.gbrain/config.json` and recorded by GBrain), so it stays `doppelganger`.
 */
export const KNOWLEDGE_GBRAIN_SCHEMA_PACK_NAME = LEGACY_IDS.schemaPack.tealbrick;

/**
 * Tealbrick alias pack id. Installed next to the canonical pack as a pack that
 * extends it with no additions, so a GBrain home configured with either id
 * resolves the same page/link types.
 */
export const KNOWLEDGE_GBRAIN_SCHEMA_PACK_ALIAS = "tealbrick" as const satisfies keyof typeof LEGACY_IDS.schemaPack;

const ACCEPTED_SCHEMA_PACK_NAMES: ReadonlySet<string> = new Set([
  KNOWLEDGE_GBRAIN_SCHEMA_PACK_NAME,
  KNOWLEDGE_GBRAIN_SCHEMA_PACK_ALIAS,
]);

export function isKnowledgeGBrainSchemaPackName(value: unknown): boolean {
  return typeof value === "string" && ACCEPTED_SCHEMA_PACK_NAMES.has(value);
}

interface GBrainSchemaPackPageType {
  readonly name: string;
  readonly primitive: "entity" | "media" | "temporal" | "annotation" | "concept";
  readonly path_prefixes: readonly string[];
  readonly aliases: readonly string[];
  readonly extractable: boolean | Record<string, unknown>;
  readonly expert_routing: boolean;
}

interface GBrainSchemaPackLinkType {
  readonly name: string;
  readonly inverse?: string;
}

export interface GBrainSchemaPack {
  readonly api_version: "gbrain-schema-pack-v1";
  readonly name: string;
  readonly version: string;
  readonly description: string;
  readonly extends: string | null;
  readonly page_types: readonly GBrainSchemaPackPageType[];
  readonly link_types: readonly GBrainSchemaPackLinkType[];
}

export interface KnowledgeGBrainSchemaInstallResult {
  readonly packName: typeof KNOWLEDGE_GBRAIN_SCHEMA_PACK_NAME;
  readonly packPath: string;
  readonly installed: boolean;
  readonly activated: boolean;
}

const moduleDir = path.dirname(fileURLToPath(import.meta.url));
const sourcePackPath = path.join(
  moduleDir,
  "schema-packs",
  KNOWLEDGE_GBRAIN_SCHEMA_PACK_NAME,
  "pack.json",
);

function gbrainConfigDir(gbrainHome: string) {
  return path.join(gbrainHome, ".gbrain");
}

function gbrainConfigPath(gbrainHome: string) {
  return path.join(gbrainConfigDir(gbrainHome), "config.json");
}

export function knowledgeGBrainSchemaPackInstallPath(
  gbrainHome: string,
  packName: string = KNOWLEDGE_GBRAIN_SCHEMA_PACK_NAME,
) {
  return path.join(gbrainConfigDir(gbrainHome), "schema-packs", packName, "pack.json");
}

function aliasPackBody(pack: GBrainSchemaPack) {
  return `${JSON.stringify(
    {
      api_version: pack.api_version,
      name: KNOWLEDGE_GBRAIN_SCHEMA_PACK_ALIAS,
      version: pack.version,
      description: `Tealbrick alias of the ${KNOWLEDGE_GBRAIN_SCHEMA_PACK_NAME} schema pack.`,
      author: "Tealbrick",
      license: "UNLICENSED",
      extends: KNOWLEDGE_GBRAIN_SCHEMA_PACK_NAME,
      page_types: [],
      link_types: [],
    },
    null,
    2,
  )}\n`;
}

export async function readKnowledgeGBrainSchemaPack(): Promise<GBrainSchemaPack> {
  const raw = await fs.readFile(sourcePackPath, "utf8");
  return JSON.parse(raw) as GBrainSchemaPack;
}

async function readJsonObject(filePath: string): Promise<Record<string, unknown>> {
  try {
    const raw = await fs.readFile(filePath, "utf8");
    const parsed = JSON.parse(raw) as unknown;
    return parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {};
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return {};
    }
    throw error;
  }
}

async function fileContentsMatch(filePath: string, expected: string) {
  try {
    return (await fs.readFile(filePath, "utf8")) === expected;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return false;
    }
    throw error;
  }
}

export async function installKnowledgeGBrainSchemaPack(
  gbrainHome: string,
): Promise<KnowledgeGBrainSchemaInstallResult> {
  const pack = await readKnowledgeGBrainSchemaPack();
  if (pack.name !== KNOWLEDGE_GBRAIN_SCHEMA_PACK_NAME) {
    throw new Error(
      `Teal Brick GBrain schema pack name mismatch: ${pack.name}`,
    );
  }

  const packPath = knowledgeGBrainSchemaPackInstallPath(gbrainHome);
  const sourcePackBody = await fs.readFile(sourcePackPath, "utf8");
  const installed = !(await fileContentsMatch(packPath, sourcePackBody));
  if (installed) {
    await fs.mkdir(path.dirname(packPath), { recursive: true });
    await fs.writeFile(packPath, sourcePackBody, "utf8");
  }
  const aliasPath = knowledgeGBrainSchemaPackInstallPath(gbrainHome, KNOWLEDGE_GBRAIN_SCHEMA_PACK_ALIAS);
  const aliasBody = aliasPackBody(pack);
  if (!(await fileContentsMatch(aliasPath, aliasBody))) {
    await fs.mkdir(path.dirname(aliasPath), { recursive: true });
    await fs.writeFile(aliasPath, aliasBody, "utf8");
  }

  const configPath = gbrainConfigPath(gbrainHome);
  const config = await readJsonObject(configPath);
  // Accept both ids; a home already on the alias is left as configured.
  if (!isKnowledgeGBrainSchemaPackName(config.schema_pack)) {
    await fs.mkdir(path.dirname(configPath), { recursive: true });
    await fs.writeFile(
      configPath,
      `${JSON.stringify(
        {
          ...config,
          schema_pack: KNOWLEDGE_GBRAIN_SCHEMA_PACK_NAME,
        },
        null,
        2,
      )}\n`,
      "utf8",
    );
  } else if (!existsSync(configPath)) {
    await fs.mkdir(path.dirname(configPath), { recursive: true });
    await fs.writeFile(
      configPath,
      `${JSON.stringify(
        { schema_pack: KNOWLEDGE_GBRAIN_SCHEMA_PACK_NAME },
        null,
        2,
      )}\n`,
      "utf8",
    );
  }

  return {
    packName: KNOWLEDGE_GBRAIN_SCHEMA_PACK_NAME,
    packPath,
    installed,
    activated: true,
  };
}
