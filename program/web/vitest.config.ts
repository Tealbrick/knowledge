import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { defineConfig } from "vitest/config";

import { readTealbrickEnv } from "../src/legacy-ids.ts";

const here = path.dirname(fileURLToPath(import.meta.url));
const localSdk = path.resolve(here, "../../../.sdk/tealbrick-ui");
const deployedSdk = path.resolve(here, "../../.sdk/tealbrick-ui");
const sdkRoot = readTealbrickEnv("TEALBRICK_UI_SDK_ROOT") ?? (fs.existsSync(localSdk) ? localSdk : deployedSdk);

export default defineConfig({
  resolve: {
    // Legacy `@doppelganger/ui` stays resolvable until all consumers migrate.
    alias: [
      { find: /^@tealbrick\/ui$/u, replacement: path.join(sdkRoot, "src/index.tsx") },
      { find: /^@doppelganger\/ui$/u, replacement: path.join(sdkRoot, "src/index.tsx") },
    ],
  },
  test: { environment: "node", include: [path.join(here, "src/**/*.test.ts")] },
});
