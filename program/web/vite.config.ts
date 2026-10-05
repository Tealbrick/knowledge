import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

import type * as AppIcons from "../../.sdk/tealbrick-ui/vite/app-icons.mjs";
import { readTealbrickEnv } from "../src/legacy-ids.ts";

const here = path.dirname(fileURLToPath(import.meta.url));
const localSdk = path.resolve(here, "../../../.sdk/tealbrick-ui");
const deployedSdk = path.resolve(here, "../../.sdk/tealbrick-ui");
const sdkRoot = readTealbrickEnv("TEALBRICK_UI_SDK_ROOT") ?? (fs.existsSync(localSdk) ? localSdk : deployedSdk);
// The SDK sits beside the repo checkout locally and at /app/.sdk in the image.
const { tealbrickAppIcons }: typeof AppIcons = await import(pathToFileURL(path.join(sdkRoot, "vite/app-icons.mjs")).href);
const programOrigin = process.env.KNOWLEDGE_PROGRAM_ORIGIN ?? "http://127.0.0.1:5310";

export default defineConfig({
  root: here,
  plugins: [react(), tealbrickAppIcons({ name: "Teal Brick Knowledge", shortName: "Knowledge" })],
  resolve: {
    dedupe: ["react", "react-dom"],
    // `@doppelganger/ui` is the legacy spelling; keep it resolving until every
    // consumer imports `@tealbrick/ui` (see LEGACY_IDS removal condition).
    alias: ["@tealbrick/ui", "@doppelganger/ui"].flatMap((scope) => [
      { find: new RegExp(`^${scope}/tokens\\.css$`, "u"), replacement: path.join(sdkRoot, "src/tokens.css") },
      { find: new RegExp(`^${scope}/components\\.css$`, "u"), replacement: path.join(sdkRoot, "src/components.css") },
      { find: new RegExp(`^${scope}/fleet\\.css$`, "u"), replacement: path.join(sdkRoot, "src/fleet.css") },
      { find: new RegExp(`^${scope}$`, "u"), replacement: path.join(sdkRoot, "src/index.tsx") },
    ]),
  },
  build: { outDir: path.resolve(here, "../web-dist"), emptyOutDir: true },
  server: {
    host: "127.0.0.1",
    port: 5410,
    fs: { allow: [path.resolve(here, ".."), sdkRoot] },
    proxy: {
      "/api": programOrigin,
      "/bootstrap.json": programOrigin,
      "/openapi.json": programOrigin,
      "/swagger.json": programOrigin,
      "/status": programOrigin,
      "/healthz": programOrigin,
    },
  },
});
