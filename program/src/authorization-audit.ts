import { randomUUID } from "node:crypto";
import { chmodSync, mkdirSync } from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

export interface AuthorizationAuditEntry {
  readonly principalId: string | null;
  readonly partitionKey: string | null;
  readonly method: string;
  /** Registered route template only: never a caller URL, query or body. */
  readonly route: string;
  readonly capability: string | null;
  readonly decision: "admitted" | "denied";
}

/** Local metadata only, bounded independently of domain snapshots and Research ledgers. */
export class KnowledgeAuthorizationAudit {
  private readonly db: DatabaseSync;
  private readonly limit: number;

  constructor(filename: string, limit = 10_000) {
    this.limit = Math.max(1, Math.min(10_000, Math.floor(limit)));
    if (filename !== ":memory:") mkdirSync(path.dirname(filename), { recursive: true, mode: 0o700 });
    this.db = new DatabaseSync(filename);
    if (filename !== ":memory:") chmodSync(filename, 0o600);
    this.db.exec(`
      PRAGMA journal_mode = DELETE;
      CREATE TABLE IF NOT EXISTS authorization_audit (
        id TEXT PRIMARY KEY, created_at TEXT NOT NULL,
        principal_id TEXT, partition_key TEXT, method TEXT NOT NULL,
        route TEXT NOT NULL, capability TEXT, decision TEXT NOT NULL,
        response_status INTEGER
      );
    `);
  }

  record(entry: AuthorizationAuditEntry): string {
    const id = randomUUID();
    this.db.exec("BEGIN IMMEDIATE");
    try {
      this.db.prepare(`INSERT INTO authorization_audit
        (id, created_at, principal_id, partition_key, method, route, capability, decision)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)`).run(id, new Date().toISOString(),
        entry.principalId?.slice(0, 128) ?? null, entry.partitionKey?.slice(0, 256) ?? null,
        entry.method.slice(0, 16), entry.route.slice(0, 256), entry.capability?.slice(0, 128) ?? null, entry.decision);
      this.db.prepare(`DELETE FROM authorization_audit WHERE rowid NOT IN
        (SELECT rowid FROM authorization_audit ORDER BY rowid DESC LIMIT ?)`).run(this.limit);
      this.db.exec("COMMIT");
      return id;
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  complete(id: string, status: number): void {
    this.db.prepare("UPDATE authorization_audit SET response_status = ? WHERE id = ?").run(status, id);
  }

  close(): void { this.db.close(); }
}
