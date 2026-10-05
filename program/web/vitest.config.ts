import path from "node:path";
import { fileURLToPath } from "node:url";

import { defineConfig } from "vitest/config";

const here = path.dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  test: {
    environment: "node",
    include: [path.join(here, "src/**/*.test.ts")],
    // @tealbrick/ui's dist imports its mark SVG; let Vite transform it instead
    // of handing it to Node's loader.
    server: { deps: { inline: ["@tealbrick/ui"] } },
  },
});
