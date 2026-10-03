import { DatabaseSync } from "node:sqlite";
import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import type { KnowledgeDocument, ResearchSource } from "./types.js";
import type { GBrainRuntime } from "./gbrain.js";

type Item = { kind: "document"; value: KnowledgeDocument } | { kind: "research"; value: ResearchSource };
type Row = { id: string; partition_key: string; kind: Item["kind"]; revision: string; state: string; error: string | null };

/** Durable projection receipts, not another copy of canonical content.
 * Reconciliation reads CURRENT source records; deterministic put_page upserts
 * can be retried. Fact extraction is deliberately not replayed after timeout.
 */
export class BrainProjections {
  private readonly db: DatabaseSync;
  private tail: Promise<unknown> = Promise.resolve();
  private stopped = false;
  private reconciling = false;
  private extractionTask: Promise<void> | undefined;
  private cursor = 0;
  constructor(file: string, private readonly brain: GBrainRuntime, private readonly current: () => Item[], private readonly extract?: (item: Item) => Promise<unknown>) {
    if (file !== ":memory:") fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    this.db = new DatabaseSync(file);
    this.db.exec("PRAGMA journal_mode=WAL; CREATE TABLE IF NOT EXISTS projections(id TEXT NOT NULL, partition_key TEXT NOT NULL, kind TEXT NOT NULL, revision TEXT NOT NULL, state TEXT NOT NULL, error TEXT, updated_at TEXT NOT NULL, PRIMARY KEY(id,partition_key,kind))");
    if (file !== ":memory:") fs.chmodSync(file, 0o600);
  }
  project(item: Item) {
    const task = this.tail.then(async () => {
      if (this.stopped) return { ok: false, status: "degraded" as const, error: "indexing_stopped" };
      // A queued revision must not resurrect an edited/deleted canonical record.
      const latest = this.current().find(candidate => candidate.kind === item.kind && candidate.value.id === item.value.id && candidate.value.companyId === item.value.companyId);
      if (!latest) return { ok: true, status: "ready" as const };
      const revision = createHash("sha256").update(JSON.stringify(latest.value)).digest("hex");
      const previous = this.db.prepare("SELECT * FROM projections WHERE id=? AND partition_key=? AND kind=?").get(item.value.id, item.value.companyId, item.kind) as Row | undefined;
      if (previous?.state === "ready" && previous.revision === revision) return { ok: true, status: "ready" as const };
      this.db.prepare("INSERT INTO projections VALUES(?,?,?,?,?,?,?) ON CONFLICT(id,partition_key,kind) DO UPDATE SET revision=excluded.revision,state=excluded.state,error=NULL,updated_at=excluded.updated_at").run(item.value.id,item.value.companyId,item.kind,revision,"pending",null,new Date().toISOString());
      const result = latest.kind === "document" ? await this.brain.projectDocument(latest.value) : await this.brain.projectResearchSource(latest.value);
      this.db.prepare("UPDATE projections SET state=?,error=?,updated_at=? WHERE id=? AND partition_key=? AND kind=?").run(result.ok ? "ready" : "failed", result.ok ? null : "indexing_failed",new Date().toISOString(),item.value.id,item.value.companyId,item.kind);
      return result;
    });
    this.tail = task.catch(() => undefined);
    return task;
  }
  async reconcile() {
    if (this.stopped || this.reconciling) return;
    this.reconciling = true;
    try {
    // Bound each pass. Failed records don't starve later records permanently.
    const current = this.current();
    const deleted = (this.db.prepare("SELECT * FROM projections WHERE state != 'deleted'").all() as Row[])
      .filter(row => !current.some(item => item.kind === row.kind && item.value.id === row.id && item.value.companyId === row.partition_key)).slice(0, 20);
    for (const row of deleted) {
      if (this.stopped) return;
      const removed = await this.brain.deleteProjection(row.id, row.partition_key, row.kind);
      this.db.prepare("UPDATE projections SET state=?,error=?,updated_at=? WHERE id=? AND partition_key=? AND kind=?").run(removed.ok ? "deleted" : "delete_pending", removed.ok ? null : "deletion_pending",new Date().toISOString(),row.id,row.partition_key,row.kind);
    }
    const window = [...current.slice(this.cursor), ...current.slice(0, this.cursor)].slice(0, 20);
    this.cursor = current.length ? (this.cursor + window.length) % current.length : 0;
    const pending = window.filter(item => {
      const row = this.db.prepare("SELECT revision,state FROM projections WHERE id=? AND partition_key=? AND kind=?").get(item.value.id,item.value.companyId,item.kind) as Row | undefined;
      return row?.state !== "ready" || row.revision !== createHash("sha256").update(JSON.stringify(item.value)).digest("hex");
    });
    for (const item of pending.slice(0, 20)) { if (this.stopped) return; await this.project(item); }
    if (this.extract && !this.extractionTask && this.brain.status().status === "online") {
      // Extraction has its own bounded lane. Slow LLM work must not prevent
      // reconciliation of subsequent canonical saves or projection failures.
      this.extractionTask = (async () => {
      for (const item of window) {
        if (this.stopped) return;
        const latest = this.current().find(candidate => candidate.kind === item.kind && candidate.value.id === item.value.id && candidate.value.companyId === item.value.companyId);
        if (!latest) continue;
        const row = this.db.prepare("SELECT state,revision FROM projections WHERE id=? AND partition_key=? AND kind=?").get(item.value.id,item.value.companyId,item.kind);
        if (row?.state === "ready" && row.revision === createHash("sha256").update(JSON.stringify(latest.value)).digest("hex")) await this.extract!(latest);
      }
      })().catch(() => { /* extraction ledger retains uncertain claims */ }).finally(() => { this.extractionTask = undefined; });
    }
    } finally { this.reconciling = false; }
  }
  status(partition: string) {
    const rows = this.db.prepare("SELECT id,kind,state,error,updated_at AS updatedAt FROM projections WHERE partition_key=? ORDER BY updated_at DESC LIMIT 100").all(partition);
    const counts = this.db.prepare("SELECT state,COUNT(*) AS count FROM projections WHERE partition_key=? GROUP BY state").all(partition);
    const known = new Set(this.db.prepare("SELECT id,kind FROM projections WHERE partition_key=?").all(partition).map(row => `${row.kind}:${row.id}`));
    const awaiting = this.current().filter(item => item.value.companyId === partition && !known.has(`${item.kind}:${item.value.id}`)).length;
    return { counts, awaiting, items: rows, recovery: "Automatic retries use current canonical documents; uncertain fact extraction is not automatically repeated." };
  }
  async close() { this.stopped = true; await this.tail; while (this.reconciling) await new Promise(resolve => setTimeout(resolve, 25)); await this.extractionTask; this.db.close(); }
}
