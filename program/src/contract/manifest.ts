import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { assertManifest, type Manifest } from "@tealbrick/contract";

import { KIT_READ_PARTITIONS } from "./read-partitions.js";

/** The release manifest, served at /.well-known/tealbrick/manifest. Lives at the repository root next to manifest.json. */
export const MANIFEST_URL = new URL("../../../tealbrick.app.json", import.meta.url);

let cached: Manifest | undefined;

/**
 * The manifest the installed contract kit can hold. tealbrick.app.json declares `runtime.partitions.contract: 2`
 * (read sets, @tealbrick/contract 0.1.0-alpha.5). The pinned 0.1.0-alpha.4 kit only knows contract 1 and refuses
 * the manifest otherwise, so with that kit this build declares contract 1: Portal then sends no read sets and every
 * grant keeps the contract 1 behaviour. Remove with the pin bump to 0.1.0-alpha.5.
 */
export function kitManifest(raw: unknown): Manifest {
  if (KIT_READ_PARTITIONS || !raw || typeof raw !== "object") return assertManifest(raw);
  const runtime = (raw as { runtime?: { partitions?: { contract?: unknown } } }).runtime;
  if (runtime?.partitions?.contract !== 2) return assertManifest(raw);
  return assertManifest({ ...(raw as Record<string, unknown>), runtime: { ...runtime, partitions: { contract: 1 } } });
}

export function loadKnowledgeManifest(url: URL = MANIFEST_URL): Manifest {
  if (url === MANIFEST_URL && cached) return cached;
  const manifest = kitManifest(JSON.parse(readFileSync(fileURLToPath(url), "utf8")));
  if (url === MANIFEST_URL) cached = manifest;
  return manifest;
}
