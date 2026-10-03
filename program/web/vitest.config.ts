import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { defineConfig } from "vitest/config";

const here = path.dirname(fileURLToPath(import.meta.url));
const localSdk = path.resolve(here, "../../../.sdk/doppelganger-ui");
const deployedSdk = path.resolve(here, "../../.sdk/doppelganger-ui");
const sdkRoot = process.env.DOPPELGANGER_UI_SDK_ROOT ?? (fs.existsSync(localSdk) ? localSdk : deployedSdk);

export default defineConfig({
  resolve: { alias: [{ find: /^@doppelganger\/ui$/u, replacement: path.join(sdkRoot, "src/index.tsx") }] },
  test: { environment: "node", include: [path.join(here, "src/**/*.test.ts")] },
});
