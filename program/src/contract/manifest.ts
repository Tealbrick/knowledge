import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { assertManifest, type Manifest } from "@tealbrick/contract";

/** The release manifest, served at /.well-known/tealbrick/manifest. Lives at the repository root next to manifest.json. */
export const MANIFEST_URL = new URL("../../../tealbrick.app.json", import.meta.url);

let cached: Manifest | undefined;

export function loadKnowledgeManifest(url: URL = MANIFEST_URL): Manifest {
  if (url === MANIFEST_URL && cached) return cached;
  const manifest = assertManifest(JSON.parse(readFileSync(fileURLToPath(url), "utf8")));
  if (url === MANIFEST_URL) cached = manifest;
  return manifest;
}
