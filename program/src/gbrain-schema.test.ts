import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import {
  DOPPELGANGER_GBRAIN_SCHEMA_PACK_NAME,
  installDoppelgangerGBrainSchemaPack,
  readDoppelgangerGBrainSchemaPack,
} from "./gbrain-schema.js";

describe("Teal Brick GBrain schema pack", () => {
  it("declares the DG domain entity and edge types GBrain should use", async () => {
    const pack = await readDoppelgangerGBrainSchemaPack();

    expect(pack.api_version).toBe("gbrain-schema-pack-v1");
    expect(pack.name).toBe(DOPPELGANGER_GBRAIN_SCHEMA_PACK_NAME);
    expect(pack.extends).toBe("gbrain-base");
    expect(pack.page_types.map((type) => type.name)).toEqual([
      "knowledge_document",
      "research_source",
      "doppelganger-agent",
      "doppelganger-app",
      "doppelganger-product",
      "doppelganger-microapp",
      "doppelganger-plugin",
      "doppelganger-extension",
      "doppelganger-program",
      "doppelganger-skill",
      "doppelganger-sidecar",
      "doppelganger-runtime",
      "doppelganger-remote",
      "doppelganger-local",
      "doppelganger-operator",
      "doppelganger-decision",
      "doppelganger-risk",
    ]);
    expect(pack.version).toBe("1.1.0");
    expect(pack.page_types.slice(0, 2)).toMatchObject([
      { name: "knowledge_document", path_prefixes: ["knowledge-docs/"], extractable: false },
      { name: "research_source", path_prefixes: ["knowledge-research/sources/"], extractable: false },
    ]);
    expect(pack.link_types.map((type) => type.name)).toEqual([
      "owns",
      "installs",
      "materializes",
      "provides",
      "relays",
      "deploys",
      "adapts",
      "governs",
      "depends_on",
      "blocks",
      "supersedes",
    ]);
  });

  it("installs and activates the DG schema pack in a fresh GBrain home idempotently", async () => {
    const gbrainHome = await fs.mkdtemp(path.join(os.tmpdir(), "dg-gbrain-schema-"));
    await fs.mkdir(path.join(gbrainHome, ".gbrain"), { recursive: true });
    await fs.writeFile(
      path.join(gbrainHome, ".gbrain", "config.json"),
      `${JSON.stringify({ engine: "pglite", existing: true }, null, 2)}\n`,
      "utf8",
    );

    const firstInstall = await installDoppelgangerGBrainSchemaPack(gbrainHome);
    const secondInstall = await installDoppelgangerGBrainSchemaPack(gbrainHome);

    expect(firstInstall).toEqual({
      packName: DOPPELGANGER_GBRAIN_SCHEMA_PACK_NAME,
      installed: true,
      activated: true,
      packPath: path.join(
        gbrainHome,
        ".gbrain",
        "schema-packs",
        DOPPELGANGER_GBRAIN_SCHEMA_PACK_NAME,
        "pack.json",
      ),
    });
    expect(secondInstall).toEqual({ ...firstInstall, installed: false });
    await expect(fs.readFile(firstInstall.packPath, "utf8")).resolves.toContain(
      '"name": "doppelganger"',
    );
    await expect(
      fs.readFile(path.join(gbrainHome, ".gbrain", "config.json"), "utf8").then((body) =>
        JSON.parse(body) as Record<string, unknown>,
      ),
    ).resolves.toMatchObject({
      engine: "pglite",
      existing: true,
      schema_pack: DOPPELGANGER_GBRAIN_SCHEMA_PACK_NAME,
    });
  });
});
