import fs from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const DOPPELGANGER_GBRAIN_SCHEMA_PACK_NAME = "doppelganger";

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

export interface DoppelgangerGBrainSchemaInstallResult {
  readonly packName: typeof DOPPELGANGER_GBRAIN_SCHEMA_PACK_NAME;
  readonly packPath: string;
  readonly installed: boolean;
  readonly activated: boolean;
}

const moduleDir = path.dirname(fileURLToPath(import.meta.url));
const sourcePackPath = path.join(
  moduleDir,
  "schema-packs",
  DOPPELGANGER_GBRAIN_SCHEMA_PACK_NAME,
  "pack.json",
);

function gbrainConfigDir(gbrainHome: string) {
  return path.join(gbrainHome, ".gbrain");
}

function gbrainConfigPath(gbrainHome: string) {
  return path.join(gbrainConfigDir(gbrainHome), "config.json");
}

export function doppelgangerGBrainSchemaPackInstallPath(gbrainHome: string) {
  return path.join(
    gbrainConfigDir(gbrainHome),
    "schema-packs",
    DOPPELGANGER_GBRAIN_SCHEMA_PACK_NAME,
    "pack.json",
  );
}

export async function readDoppelgangerGBrainSchemaPack(): Promise<GBrainSchemaPack> {
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

export async function installDoppelgangerGBrainSchemaPack(
  gbrainHome: string,
): Promise<DoppelgangerGBrainSchemaInstallResult> {
  const pack = await readDoppelgangerGBrainSchemaPack();
  if (pack.name !== DOPPELGANGER_GBRAIN_SCHEMA_PACK_NAME) {
    throw new Error(
      `Teal Brick GBrain schema pack name mismatch: ${pack.name}`,
    );
  }

  const packPath = doppelgangerGBrainSchemaPackInstallPath(gbrainHome);
  const sourcePackBody = await fs.readFile(sourcePackPath, "utf8");
  const installed = !(await fileContentsMatch(packPath, sourcePackBody));
  if (installed) {
    await fs.mkdir(path.dirname(packPath), { recursive: true });
    await fs.writeFile(packPath, sourcePackBody, "utf8");
  }

  const configPath = gbrainConfigPath(gbrainHome);
  const config = await readJsonObject(configPath);
  if (config.schema_pack !== DOPPELGANGER_GBRAIN_SCHEMA_PACK_NAME) {
    await fs.mkdir(path.dirname(configPath), { recursive: true });
    await fs.writeFile(
      configPath,
      `${JSON.stringify(
        {
          ...config,
          schema_pack: DOPPELGANGER_GBRAIN_SCHEMA_PACK_NAME,
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
        { schema_pack: DOPPELGANGER_GBRAIN_SCHEMA_PACK_NAME },
        null,
        2,
      )}\n`,
      "utf8",
    );
  }

  return {
    packName: DOPPELGANGER_GBRAIN_SCHEMA_PACK_NAME,
    packPath,
    installed,
    activated: true,
  };
}
