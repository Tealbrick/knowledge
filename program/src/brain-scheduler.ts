/** Native PGLite serializes DB transactions; do not serialize model I/O with
 * unrelated indexing. One extraction and one foreground operation may run.
 * Deletes are barriers: no earlier extraction can resurrect a deleted page.
 */
export class BrainScheduler {
  private pending: { lane: string; signal: AbortSignal; run: () => Promise<void>; reject: (error: Error) => void }[] = [];
  private active = new Set<string>();
  get size() { return this.pending.length + this.active.size; }
  run<T>(lane: "foreground" | "extraction" | "barrier", signal: AbortSignal, task: () => Promise<T>): Promise<T> {
    if (this.size >= 16) return Promise.reject(new Error("busy"));
    return new Promise<T>((resolve, reject) => {
      this.pending.push({ lane, signal, reject, run: async () => { try { resolve(await task()); } catch (error) { reject(error); } } });
      this.drain();
    });
  }
  private drain() {
    if (this.active.has("barrier")) return;
    for (let i = 0; i < this.pending.length;) {
      const item = this.pending[i]!;
      if (item.signal.aborted) { this.pending.splice(i, 1); item.reject(new Error("cancelled_before_start")); continue; }
      if (item.lane === "barrier" && (i > 0 || this.active.size)) return;
      if (this.active.has(item.lane)) { i++; continue; }
      this.pending.splice(i, 1);
      this.active.add(item.lane);
      void item.run().finally(() => { this.active.delete(item.lane); this.drain(); });
      if (item.lane === "barrier") return;
    }
  }
}
