import { randomUUID } from "node:crypto";
import { chmodSync, mkdirSync } from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

/**
 * Contract audit (metadata only, §5.5 and §12.8): who did what to which operation, the outcome and the time.
 * Never a token, a payload, a setting value or free text. Bounded; the oldest rows go first.
 */
export interface ContractAuditEntry {
  /** `grant` (agent operation), `control` (well-known endpoints), `emergency` or `launch`. */
  readonly kind: "grant" | "control" | "emergency" | "launch";
  readonly operation?: string | null;
  /** Opaque Portal agent id or a control credential kind. */
  readonly actor?: string | null;
  readonly partition?: string | null;
  readonly outcome: string;
  readonly status?: number | null;
  /** Error code of a refusal, never a message. */
  readonly code?: string | null;
}

export interface ContractAudit {
  record(entry: ContractAuditEntry): string;
  complete(id: string, status: number): void;
  close(): void;
}

const clip = (value: string | null | undefined, max: number) => (typeof value === "string" ? value.slice(0, max) : null);

export function createContractAudit(filename: string, limit = 10_000): ContractAudit {
  const rows = Math.max(1, Math.min(100_000, Math.floor(limit)));
  if (filename !== ":memory:") mkdirSync(path.dirname(filename), { recursive: true, mode: 0o700 });
  const db = new DatabaseSync(filename);
  if (filename !== ":memory:") chmodSync(filename, 0o600);
  db.exec(`
    PRAGMA journal_mode = DELETE;
    CREATE TABLE IF NOT EXISTS contract_audit (
      id TEXT PRIMARY KEY, at TEXT NOT NULL, kind TEXT NOT NULL, operation TEXT, actor TEXT,
      partition_key TEXT, outcome TEXT NOT NULL, status INTEGER, code TEXT
    );
  `);
  const insert = db.prepare(`INSERT INTO contract_audit (id, at, kind, operation, actor, partition_key, outcome, status, code) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`);
  const prune = db.prepare(`DELETE FROM contract_audit WHERE rowid NOT IN (SELECT rowid FROM contract_audit ORDER BY rowid DESC LIMIT ?)`);
  const complete = db.prepare(`UPDATE contract_audit SET status = ? WHERE id = ? AND status IS NULL`);
  let closed = false;
  return {
    record(entry) {
      const id = randomUUID();
      if (closed) return id;
      try {
        insert.run(id, new Date().toISOString(), entry.kind, clip(entry.operation, 128), clip(entry.actor, 128), clip(entry.partition, 256),
          entry.outcome.slice(0, 64), entry.status ?? null, clip(entry.code, 96));
        prune.run(rows);
      } catch { /* audit must not change outcomes */ }
      return id;
    },
    complete(id, status) {
      if (closed) return;
      try { complete.run(status, id); } catch { /* best effort */ }
    },
    close() { if (!closed) { closed = true; db.close(); } },
  };
}
