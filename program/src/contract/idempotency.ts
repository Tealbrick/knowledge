import { createHash } from "node:crypto";
import { chmodSync, mkdirSync } from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

/**
 * Idempotency for the agent creates the Program has no ledger for (collections, documents, native memory writes).
 * Research creates keep their own ledgers inside the Program; this one only fronts the operations the manifest marks
 * `idempotency: "required"` that the Program would otherwise repeat on a retry.
 *
 * A key is scoped to the agent, the partition and the operation. The same key with the same body replays the stored
 * successful answer; the same key with another body is a conflict; a request still running, or one whose outcome was
 * never recorded (a crash), is never repeated blindly: the caller reconciles or uses a new key (no blind retries).
 * Only metadata and the answer body are stored; entries expire after a day.
 */

export const IDEMPOTENCY_KEY = /^[A-Za-z0-9][A-Za-z0-9_.:/-]{0,255}$/u;
const TTL_MS = 24 * 60 * 60_000;
const PENDING_MS = 5 * 60_000;
const MAX_STORED_BODY = 512 * 1024;

export type IdempotencyClaim =
  | { readonly kind: "execute"; readonly finish: (status: number, headers: Record<string, string>, body: Buffer) => void; readonly abandon: () => void }
  | { readonly kind: "replay"; readonly status: number; readonly headers: Record<string, string>; readonly body: Buffer }
  | { readonly kind: "conflict" }
  | { readonly kind: "in_progress" }
  | { readonly kind: "outcome_unknown" };

export interface IdempotencyStore {
  claim(scope: { agentId: string; partition: string | null; operation: string }, key: string, body: string | Buffer | undefined): IdempotencyClaim;
  close(): void;
}

const digest = (...parts: (string | Buffer | null | undefined)[]) => {
  const hash = createHash("sha256");
  for (const part of parts) { hash.update(part ?? ""); hash.update("\u0000"); }
  return hash.digest("hex");
};

export function createIdempotencyStore(filename: string, now: () => number = Date.now): IdempotencyStore {
  if (filename !== ":memory:") mkdirSync(path.dirname(filename), { recursive: true, mode: 0o700 });
  const db = new DatabaseSync(filename);
  if (filename !== ":memory:") chmodSync(filename, 0o600);
  db.exec(`
    PRAGMA journal_mode = DELETE;
    CREATE TABLE IF NOT EXISTS edge_idempotency (
      scope TEXT NOT NULL, idem_key TEXT NOT NULL, body_hash TEXT NOT NULL, state TEXT NOT NULL,
      status INTEGER, headers TEXT, response BLOB, created_at INTEGER NOT NULL,
      PRIMARY KEY (scope, idem_key)
    );
  `);
  const select = db.prepare("SELECT body_hash, state, status, headers, response, created_at FROM edge_idempotency WHERE scope = ? AND idem_key = ?");
  const insert = db.prepare("INSERT INTO edge_idempotency (scope, idem_key, body_hash, state, created_at) VALUES (?, ?, ?, 'pending', ?)");
  const complete = db.prepare("UPDATE edge_idempotency SET state = 'done', status = ?, headers = ?, response = ? WHERE scope = ? AND idem_key = ? AND state = 'pending'");
  const remove = db.prepare("DELETE FROM edge_idempotency WHERE scope = ? AND idem_key = ?");
  const expire = db.prepare("DELETE FROM edge_idempotency WHERE created_at < ?");
  let closed = false;
  return {
    claim(scope, key, body) {
      const scopeId = digest(scope.agentId, scope.partition ?? "", scope.operation);
      const bodyHash = digest(body);
      expire.run(now() - TTL_MS);
      const existing = select.get(scopeId, key) as { body_hash: string; state: string; status: number | null; headers: string | null; response: Uint8Array | null; created_at: number } | undefined;
      if (existing) {
        if (existing.body_hash !== bodyHash) return { kind: "conflict" };
        if (existing.state === "done" && existing.status !== null) {
          return { kind: "replay", status: existing.status, headers: JSON.parse(existing.headers ?? "{}"), body: Buffer.from(existing.response ?? []) };
        }
        // Pending: still running, or the process ended before the answer was recorded. Never run it a second time.
        return now() - existing.created_at > PENDING_MS ? { kind: "outcome_unknown" } : { kind: "in_progress" };
      }
      insert.run(scopeId, key, bodyHash, now());
      return {
        kind: "execute",
        finish(status, headers, response) {
          if (closed) return;
          // A failed or oversized answer is not stored: the caller may retry a failure with the same key.
          if (status >= 200 && status < 300 && response.length <= MAX_STORED_BODY) complete.run(status, JSON.stringify(headers), response, scopeId, key);
          else remove.run(scopeId, key);
        },
        abandon() { if (!closed) remove.run(scopeId, key); },
      };
    },
    close() { if (!closed) { closed = true; db.close(); } },
  };
}
