import { DatabaseSync } from "node:sqlite";
import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

/** Private result receipts prevent an HTTP retry from re-running extraction. */
export class BrainExtractions {
  private readonly db: DatabaseSync;
  constructor(file: string) {
    if (file !== ":memory:") fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    this.db = new DatabaseSync(file);
    this.db.exec("PRAGMA journal_mode=WAL; CREATE TABLE IF NOT EXISTS extractions(id TEXT PRIMARY KEY, scope TEXT NOT NULL, request_key TEXT NOT NULL, hash TEXT NOT NULL, state TEXT NOT NULL, result TEXT, UNIQUE(scope,request_key))");
    if (file !== ":memory:") fs.chmodSync(file, 0o600);
  }
  async run(scope: string, key: string | undefined, input: unknown, execute: () => Promise<unknown>) {
    const hash = createHash("sha256").update(JSON.stringify(input)).digest("hex");
    const requestKey = key ?? hash;
    if (!/^[A-Za-z0-9._:-]{1,200}$/u.test(requestKey)) return { ok: false, status: "rejected", error: "invalid_idempotency_key" };
    const existing = this.db.prepare("SELECT * FROM extractions WHERE scope=? AND request_key=?").get(scope, requestKey);
    if (existing) {
      if (existing.hash !== hash) return { ok: false, status: "rejected", error: "idempotency_conflict" };
      return existing.result ? { ...JSON.parse(String(existing.result)), receiptId: existing.id, replay: true } : { ok: false, status: "pending", receiptId: existing.id, error: "extraction_in_progress_or_reconciliation_required" };
    }
    const id = randomUUID();
    this.db.prepare("INSERT INTO extractions VALUES(?,?,?,?,?,NULL)").run(id, scope, requestKey, hash, "pending");
    try {
      const result = await execute();
      this.db.prepare("UPDATE extractions SET state='finished',result=? WHERE id=?").run(JSON.stringify(result), id);
      return { ...(result as Record<string, unknown>), receiptId: id };
    } catch {
      // Never clear the claim or repeat an operation of uncertain outcome.
      return { ok: false, status: "uncertain", receiptId: id, error: "extraction_reconciliation_required" };
    }
  }
  close() { this.db.close(); }
}
