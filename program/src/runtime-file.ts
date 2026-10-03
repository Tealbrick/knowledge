import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import type { AddressInfo } from "node:net";
import path from "node:path";

import { describeListenUrl } from "./listen-url.js";
import type { KnowledgeConfig } from "./types.js";

export type KnowledgeRuntimeFile = {
  readonly baseUrl: string;
  readonly host?: string;
  readonly pid: number;
  readonly pluginId: "knowledge";
  readonly port?: number;
  readonly sidecarId: "knowledge-program";
  readonly startedAt: string;
  readonly updatedAt: string;
};

export function knowledgeRuntimeFilePath(config: KnowledgeConfig): string {
  return knowledgeRuntimeFilePaths(config)[0]!;
}

function defaultKnowledgeRuntimeFilePath(config: KnowledgeConfig): string {
  return path.join(config.dataDir, "program-runtime.json");
}

function knowledgeRuntimeFilePaths(config: KnowledgeConfig): readonly string[] {
  const configuredPath = path.resolve(
    process.env.DOPPELGANGER_RUNTIME_FILE ??
      process.env.KNOWLEDGE_RUNTIME_FILE ??
      defaultKnowledgeRuntimeFilePath(config),
  );
  const defaultPath = path.resolve(defaultKnowledgeRuntimeFilePath(config));
  return configuredPath === defaultPath ? [configuredPath] : [configuredPath, defaultPath];
}

async function writeRuntimeFile(filePath: string, runtimeFile: KnowledgeRuntimeFile) {
  const tempPath = `${filePath}.${process.pid}.tmp`;
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(tempPath, `${JSON.stringify(runtimeFile, null, 2)}\n`, "utf8");
  await rename(tempPath, filePath);
}

async function removeRuntimeFile(filePath: string, pid?: number) {
  try {
    const parsed = JSON.parse(await readFile(filePath, "utf8")) as { readonly pid?: unknown };
    if (typeof pid === "number" && typeof parsed.pid === "number" && parsed.pid !== pid) {
      return;
    }
    await rm(filePath, { force: true });
  } catch {
    await rm(filePath, { force: true }).catch(() => undefined);
  }
}

export function knowledgeRuntimeDiscoveryPaths(config: KnowledgeConfig): readonly string[] {
  return knowledgeRuntimeFilePaths(config);
}

export async function writeKnowledgeRuntimeFile(input: {
  readonly address: AddressInfo | string | null;
  readonly config: KnowledgeConfig;
  readonly now?: Date;
}): Promise<KnowledgeRuntimeFile | null> {
  const listenUrl = describeListenUrl(input.address);
  if (!listenUrl.baseUrl) {
    return null;
  }
  const now = input.now ?? new Date();
  const runtimeFile: KnowledgeRuntimeFile = {
    baseUrl: listenUrl.baseUrl,
    host: listenUrl.host,
    pid: process.pid,
    pluginId: "knowledge",
    port: listenUrl.port,
    sidecarId: "knowledge-program",
    startedAt: now.toISOString(),
    updatedAt: now.toISOString(),
  };
  await Promise.all(
    knowledgeRuntimeFilePaths(input.config).map((filePath) =>
      writeRuntimeFile(filePath, runtimeFile),
    ),
  );
  return runtimeFile;
}

export async function removeKnowledgeRuntimeFile(input: {
  readonly config: KnowledgeConfig;
  readonly pid?: number;
}): Promise<void> {
  await Promise.all(
    knowledgeRuntimeFilePaths(input.config).map((filePath) =>
      removeRuntimeFile(filePath, input.pid),
    ),
  );
}
