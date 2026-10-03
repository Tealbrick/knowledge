import { describe, expect, it, vi } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { BrainProjections } from "./brain-projections.js";
import { BrainExtractions } from "./brain-extractions.js";
import type { GBrainRuntime } from "./gbrain.js";
import type { KnowledgeDocument } from "./types.js";

describe("durable Brain recovery", () => {
  it("repairs a failed projection after restart from the latest canonical content without duplicating it", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "knowledge-recovery-"));
    let document = { id: "d1", companyId: "a", body: "original" } as KnowledgeDocument;
    const projectDocument = vi.fn().mockResolvedValueOnce({ ok: false, status: "degraded" }).mockResolvedValue({ ok: true, status: "ready" });
    const brain = { projectDocument } as unknown as GBrainRuntime;
    const current = () => [{ kind: "document" as const, value: document }];
    const file = path.join(dir, "projections.sqlite");
    try {
      let ledger = new BrainProjections(file, brain, current);
      await ledger.reconcile();
      expect(ledger.status("a").counts).toEqual([{ state: "failed", count: 1 }]);
      expect(ledger.status("b").items).toEqual([]);
      await ledger.close();
      document = { ...document, body: "corrected" };
      ledger = new BrainProjections(file, brain, current);
      await ledger.reconcile(); await ledger.reconcile();
      expect(projectDocument).toHaveBeenCalledTimes(2);
      expect(projectDocument.mock.lastCall?.[0].body).toBe("corrected");
      expect(ledger.status("a").counts).toEqual([{ state: "ready", count: 1 }]);
      await ledger.close();
    } finally { await fs.rm(dir, { recursive: true, force: true }); }
  });
  it("does not repeat a completed, conflicted or uncertain extraction, including after restart", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "knowledge-extraction-"));
    const file = path.join(dir, "receipts.sqlite");
    const call = vi.fn().mockResolvedValue({ ok: true, result: { inserted: 1 } });
    try {
      let ledger = new BrainExtractions(file);
      expect(await ledger.run("a", "one", {text:"fixture"}, call)).toMatchObject({ok:true});
      ledger.close(); ledger = new BrainExtractions(file);
      expect(await ledger.run("a", "one", {text:"fixture"}, call)).toMatchObject({ok:true,replay:true});
      expect(await ledger.run("a", "one", {text:"changed"}, call)).toMatchObject({error:"idempotency_conflict"});
      expect(call).toHaveBeenCalledTimes(1);
      await ledger.run("a", "two", {}, async () => { throw new Error("disconnect"); });
      expect(await ledger.run("a", "two", {}, call)).toMatchObject({status:"pending"});
      expect(call).toHaveBeenCalledTimes(1);
      expect(await ledger.run("b", "one", {text:"fixture"}, call)).toMatchObject({ok:true});
      ledger.close();
    } finally { await fs.rm(dir, { recursive:true, force:true }); }
  });
});
