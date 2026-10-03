import { describe, expect, it } from "vitest";
import fs from "node:fs";
import { buildKnowledgeApp } from "./app.js";
import { KnowledgeStore, type KnowledgeStoreSnapshot } from "./store.js";

describe("retired shell surfaces", () => {
  it("does not mount or advertise the old routes", async () => {
    const app = await buildKnowledgeApp({ environment: "test" });
    try {
      for (const [method, url] of [
        ["GET", "/api/knowledge/boardstate/capabilities"],
        ["GET", "/api/knowledge/boardstate/workspace"],
        ["POST", "/api/knowledge/boardstate/projections/apply"],
      ] as const) {
        const response = await app.inject({ method, url });
        expect(response.statusCode).toBe(404);
      }
      for (const relative of ["../../extension/manifest.json", "../../mobile/manifest.json", "../../.codex-plugin/plugin.json"]) {
        expect(fs.existsSync(new URL(relative, import.meta.url))).toBe(false);
      }
    } finally { await app.close(); }
  });

  it("loads old snapshots without losing canonical documents or restoring presentation state", () => {
    let canonical: KnowledgeStoreSnapshot | undefined;
    const original = new KnowledgeStore({ load: () => null, save: value => { canonical = value; } });
    const collection = original.createKnowledgeCollection("test", { name: "Preserve me" });
    const document = original.createKnowledgeDocument(collection.id, { title: "Canonical", body: "Keep this content" });
    if (!document || !canonical) throw new Error("Fixture document missing");
    const snapshot = { ...canonical, boardstateProjections: [{ document: { legacy: true } }] };
    let saved: KnowledgeStoreSnapshot | undefined;
    const restored = new KnowledgeStore({ load: () => snapshot, save: value => { saved = value; } });
    expect(restored.getKnowledgeDocument(document.id)?.body).toBe("Keep this content");
    restored.createKnowledgeCollection("test", { name: "New" });
    expect(saved).not.toHaveProperty("boardstateProjections");
    expect(saved?.documents).toContainEqual(document);
  });
});
