import { describe, expect, it, vi } from "vitest";
import { BrainScheduler } from "./brain-scheduler.js";
import { BrainProjections } from "./brain-projections.js";
import { BrainExtractions } from "./brain-extractions.js";
import type { GBrainRuntime } from "./gbrain.js";
import type { KnowledgeDocument } from "./types.js";
const deferred = () => { let resolve!: () => void; const promise = new Promise<void>(r => { resolve = r; }); return { promise, resolve }; };
const signal = () => new AbortController().signal;
describe("slow native model scheduling", () => {
  it("indexes while extraction waits, serializes extractors, and fences deletes", async () => {
    const scheduler = new BrainScheduler(); const hold = deferred(); const order: string[] = [];
    const extraction = scheduler.run("extraction", signal(), async () => { order.push("extract-start"); await hold.promise; order.push("extract-end"); });
    await scheduler.run("foreground", signal(), async () => { order.push("indexed"); });
    const second = scheduler.run("extraction", signal(), async () => { order.push("extract-2"); });
    const deletion = scheduler.run("barrier", signal(), async () => { order.push("deleted"); });
    const later = scheduler.run("foreground", signal(), async () => { order.push("later"); });
    expect(order).toEqual(["extract-start", "indexed"]);
    hold.resolve(); await Promise.all([extraction, second, deletion, later]);
    expect(order).toEqual(["extract-start", "indexed", "extract-end", "extract-2", "deleted", "later"]);
  });
  it("never executes an abandoned queued write and bounds queued work", async () => {
    const scheduler = new BrainScheduler(); const hold = deferred();
    const first = scheduler.run("extraction", signal(), () => hold.promise);
    const controller = new AbortController(); const fn = vi.fn();
    const cancelled = scheduler.run("extraction", controller.signal, fn).catch(e => e.message);
    controller.abort();
    const pending = Array.from({length:15}, () => scheduler.run("extraction", signal(), async () => {}));
    await expect(scheduler.run("extraction", signal(), async () => {})).rejects.toThrow("busy");
    hold.resolve(); await Promise.all([first,...pending]);
    expect(await cancelled).toBe("cancelled_before_start"); expect(fn).not.toHaveBeenCalled();
  });
  it("reconciliation keeps progressing and records late extraction exactly once", async () => {
    const hold = deferred(); const receipts = new BrainExtractions(":memory:");
    const documents = [{ id:"d1", companyId:"a", body:"fixture" } as KnowledgeDocument];
    const execute = vi.fn(async () => { await hold.promise; return {ok:true,inserted:1}; });
    const extract = () => receipts.run("a", "d1", {}, execute);
    const brain = { projectDocument:vi.fn().mockResolvedValue({ok:true}), status:()=>({status:"online"}) } as unknown as GBrainRuntime;
    const ledger = new BrainProjections(":memory:", brain, () => documents.map(value=>({kind:"document",value})), extract);
    await ledger.reconcile();
    expect(await extract()).toMatchObject({status:"pending"});
    documents.push({id:"d2",companyId:"a",body:"second"} as KnowledgeDocument);
    await ledger.reconcile();
    expect(ledger.status("a").counts).toEqual([{state:"ready",count:2}]);
    hold.resolve(); await ledger.close();
    expect(await extract()).toMatchObject({ok:true,inserted:1,replay:true});
    expect(execute).toHaveBeenCalledTimes(1); receipts.close();
  });
});
