import fs from "node:fs";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { OPEN_NOTEBOOK_MAX_SOURCE_TITLE_BYTES, OPEN_NOTEBOOK_MAX_SOURCE_CONTENT_BYTES } from "./open-notebook.js";
import { isCanonicalPartitionScope } from "./partition-authority.js";

export type ResearchWriteState = "pending" | "succeeded" | "uncertain" | "rejected";

export type ResearchWriteErrorCode =
  | "invalid_request"
  | "scope_denied"
  | "policy_denied"
  | "upstream_unavailable"
  | "upstream_rejected"
  | "ambiguous_response"
  | "reconciliation_required";

export interface ResearchWriteScope {
  readonly principalId: string;
  readonly companyId: string;
  readonly knowledgeNotebookId: string;
  readonly externalNotebookId: string;
}

export interface TextSourceWriteRequest {
  readonly title: string;
  readonly content: string;
}

export interface ResearchWriteIntent extends ResearchWriteScope {
  readonly idempotencyKey: string;
  readonly requestHash: string;
  readonly state: ResearchWriteState;
  readonly sourceId: string | null;
  readonly errorCode: ResearchWriteErrorCode | null;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export type ResearchWriteTerminalResult =
  | { readonly state: "succeeded"; readonly sourceId: string }
  | { readonly state: "rejected"; readonly errorCode: ResearchWriteErrorCode };

export type ResearchWriteBeginResult =
  | { readonly kind: "claimed"; readonly intent: ResearchWriteIntent; readonly claimToken: string }
  | { readonly kind: "replay"; readonly intent: ResearchWriteIntent; readonly result: ResearchWriteTerminalResult }
  | { readonly kind: "reconciliation_required"; readonly intent: ResearchWriteIntent }
  | { readonly kind: "conflict"; readonly code: "idempotency_conflict" | "scope_conflict" };

export class ResearchWriteLedgerError extends Error {
  constructor(
    readonly code:
      | "invalid_path"
      | "invalid_input"
      | "database_not_dedicated"
      | "not_found"
      | "claim_not_owner"
      | "invalid_transition"
      | "closed",
    message: string,
  ) {
    super(message);
  }
}

interface LedgerRow {
  readonly principal_id: string;
  readonly company_id: string;
  readonly knowledge_notebook_id: string;
  readonly external_notebook_id: string;
  readonly idempotency_key: string;
  readonly request_hash: string;
  readonly state: ResearchWriteState;
  readonly source_id: string | null;
  readonly error_code: ResearchWriteErrorCode | null;
  readonly claim_digest: string;
  readonly created_at: string;
  readonly updated_at: string;
}

const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/u;
const IDEMPOTENCY_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_.:/-]{0,255}$/u;
const MAX_TITLE_BYTES = OPEN_NOTEBOOK_MAX_SOURCE_TITLE_BYTES;
const MAX_CONTENT_BYTES = OPEN_NOTEBOOK_MAX_SOURCE_CONTENT_BYTES;
const LEDGER_TABLE = "research_write_intents";
const SCOPE_KEYS = new Set(["principalId", "companyId", "knowledgeNotebookId", "externalNotebookId"]);
const REQUEST_KEYS = new Set(["title", "content"]);

function digest(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function byteLength(value: string): number {
  return Buffer.byteLength(value, "utf8");
}

function validId(value: unknown): value is string {
  return typeof value === "string" && ID_PATTERN.test(value);
}

/** A workspace id, or a canonical edge partition scope (`workspace/key`). */
function validCompanyId(value: unknown): value is string {
  return validId(value) || isCanonicalPartitionScope(value);
}

function validateScope(scope: ResearchWriteScope): ResearchWriteScope {
  if (!scope || typeof scope !== "object" || Object.keys(scope).length !== SCOPE_KEYS.size || Object.keys(scope).some((key) => !SCOPE_KEYS.has(key)) || !validId(scope.principalId) || !validCompanyId(scope.companyId) || !validId(scope.knowledgeNotebookId) || !validId(scope.externalNotebookId)) {
    throw new ResearchWriteLedgerError("invalid_input", "invalid write scope");
  }
  return Object.freeze({
    principalId: scope.principalId,
    companyId: scope.companyId,
    knowledgeNotebookId: scope.knowledgeNotebookId,
    externalNotebookId: scope.externalNotebookId,
  });
}

function validateIdempotencyKey(value: string): string {
  if (typeof value !== "string" || !IDEMPOTENCY_PATTERN.test(value)) {
    throw new ResearchWriteLedgerError("invalid_input", "invalid idempotency key");
  }
  return value;
}

function validateRequest(request: TextSourceWriteRequest): TextSourceWriteRequest {
  if (!request || typeof request !== "object" || Object.keys(request).length !== REQUEST_KEYS.size || Object.keys(request).some((key) => !REQUEST_KEYS.has(key)) || typeof request.title !== "string" || typeof request.content !== "string") {
    throw new ResearchWriteLedgerError("invalid_input", "invalid text source request");
  }
  if (!request.title.trim() || byteLength(request.title) > MAX_TITLE_BYTES || !request.content.trim() || byteLength(request.content) > MAX_CONTENT_BYTES) {
    throw new ResearchWriteLedgerError("invalid_input", "invalid text source request");
  }
  return Object.freeze({ title: request.title, content: request.content });
}

function requestHash(request: TextSourceWriteRequest): string {
  return digest(JSON.stringify({ title: request.title, content: request.content }));
}

function validateSourceId(sourceId: string): string {
  if (!validId(sourceId) || !sourceId.startsWith("source:") || sourceId.length <= "source:".length) throw new ResearchWriteLedgerError("invalid_input", "invalid source id");
  return sourceId;
}

function validateErrorCode(errorCode: ResearchWriteErrorCode): ResearchWriteErrorCode {
  const allowed: readonly ResearchWriteErrorCode[] = [
    "invalid_request",
    "scope_denied",
    "policy_denied",
    "upstream_unavailable",
    "upstream_rejected",
    "ambiguous_response",
    "reconciliation_required",
  ];
  if (!allowed.includes(errorCode)) throw new ResearchWriteLedgerError("invalid_input", "invalid write error code");
  return errorCode;
}

function toIntent(row: LedgerRow): ResearchWriteIntent {
  return Object.freeze({
    principalId: row.principal_id,
    companyId: row.company_id,
    knowledgeNotebookId: row.knowledge_notebook_id,
    externalNotebookId: row.external_notebook_id,
    idempotencyKey: row.idempotency_key,
    requestHash: row.request_hash,
    state: row.state,
    sourceId: row.source_id,
    errorCode: row.error_code,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  });
}

function terminalResult(intent: ResearchWriteIntent): ResearchWriteTerminalResult {
  if (intent.state === "succeeded" && intent.sourceId) return { state: "succeeded", sourceId: intent.sourceId };
  if (intent.state === "rejected" && intent.errorCode) return { state: "rejected", errorCode: intent.errorCode };
  throw new ResearchWriteLedgerError("invalid_transition", "non-terminal intent has no terminal result");
}

function sameScope(row: LedgerRow, scope: ResearchWriteScope): boolean {
  return row.principal_id === scope.principalId && row.company_id === scope.companyId && row.knowledge_notebook_id === scope.knowledgeNotebookId && row.external_notebook_id === scope.externalNotebookId;
}

/**
 * Durable write-intent state only. This ledger never submits or retries an
 * upstream write. If the caller loses its claim token after a crash, pending
 * or uncertain rows remain reconciliation-required until an explicitly owned
 * manual reconciliation path is added by the integrating application.
 */
export class ResearchWriteLedger {
  private readonly db: DatabaseSync;
  private closed = false;

  constructor(readonly dbPath: string) {
    if (typeof dbPath !== "string" || !path.isAbsolute(dbPath) || path.basename(dbPath).trim() === "") {
      throw new ResearchWriteLedgerError("invalid_path", "ledger path must be an explicit absolute file path");
    }
    fs.mkdirSync(path.dirname(dbPath), { recursive: true });
    let db: DatabaseSync | null = null;
    try {
      db = new DatabaseSync(dbPath);
      fs.chmodSync(dbPath, 0o600);
      // Set the lock wait and FK policy before any schema inspection. A second
      // process can open the same fresh ledger while the first creates it; the
      // constructor must not issue a lock-sensitive read with SQLite's default
      // zero timeout and then configure the timeout too late.
      db.exec("PRAGMA busy_timeout = 5000; PRAGMA foreign_keys = ON;");
      const tables = (db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'").all() as Array<{ name: string }>).map((row) => row.name);
      if (tables.some((name) => name !== LEDGER_TABLE)) {
        throw new ResearchWriteLedgerError("database_not_dedicated", "ledger database must not contain unrelated tables");
      }
      db.exec(`
        CREATE TABLE IF NOT EXISTS ${LEDGER_TABLE} (
          principal_id TEXT NOT NULL,
          company_id TEXT NOT NULL,
          knowledge_notebook_id TEXT NOT NULL,
          external_notebook_id TEXT NOT NULL,
          idempotency_key TEXT NOT NULL,
          request_hash TEXT NOT NULL,
          state TEXT NOT NULL CHECK (state IN ('pending', 'succeeded', 'uncertain', 'rejected')),
          source_id TEXT,
          error_code TEXT,
          claim_digest TEXT NOT NULL,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL,
          PRIMARY KEY (principal_id, company_id, idempotency_key),
          CHECK ((state = 'succeeded' AND source_id IS NOT NULL AND error_code IS NULL) OR
                 (state = 'rejected' AND source_id IS NULL AND error_code IS NOT NULL) OR
                 (state IN ('pending', 'uncertain')))
        );
        CREATE INDEX IF NOT EXISTS idx_research_write_scope
          ON ${LEDGER_TABLE} (company_id, knowledge_notebook_id, external_notebook_id);
      `);
      fs.chmodSync(dbPath, 0o600);
      this.db = db;
    } catch (error) {
      db?.close();
      throw error;
    }
  }

  begin(
    scopeInput: ResearchWriteScope,
    idempotencyKeyInput: string,
    requestInput: TextSourceWriteRequest,
  ): ResearchWriteBeginResult {
    this.ensureOpen();
    const scope = validateScope(scopeInput);
    const idempotencyKey = validateIdempotencyKey(idempotencyKeyInput);
    const request = validateRequest(requestInput);
    const hash = requestHash(request);
    const existing = this.db
      .prepare(`SELECT * FROM ${LEDGER_TABLE} WHERE principal_id = ? AND company_id = ? AND idempotency_key = ?`)
      .get(scope.principalId, scope.companyId, idempotencyKey) as LedgerRow | undefined;

    if (existing) {
      if (!sameScope(existing, scope)) return { kind: "conflict", code: "scope_conflict" };
      if (existing.request_hash !== hash) return { kind: "conflict", code: "idempotency_conflict" };
      const intent = toIntent(existing);
      if (existing.state === "pending" || existing.state === "uncertain") return { kind: "reconciliation_required", intent };
      return { kind: "replay", intent, result: terminalResult(intent) };
    }

    const claimToken = randomUUID();
    const now = new Date().toISOString();
    const claimDigest = digest(claimToken);
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const raced = this.db
        .prepare(`SELECT * FROM ${LEDGER_TABLE} WHERE principal_id = ? AND company_id = ? AND idempotency_key = ?`)
        .get(scope.principalId, scope.companyId, idempotencyKey) as LedgerRow | undefined;
      if (raced) {
        this.db.exec("COMMIT");
        if (!sameScope(raced, scope)) return { kind: "conflict", code: "scope_conflict" };
        if (raced.request_hash !== hash) return { kind: "conflict", code: "idempotency_conflict" };
        const intent = toIntent(raced);
        return raced.state === "pending" || raced.state === "uncertain"
          ? { kind: "reconciliation_required", intent }
          : { kind: "replay", intent, result: terminalResult(intent) };
      }
      this.db
        .prepare(`INSERT INTO ${LEDGER_TABLE} (principal_id, company_id, knowledge_notebook_id, external_notebook_id, idempotency_key, request_hash, state, source_id, error_code, claim_digest, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, 'pending', NULL, NULL, ?, ?, ?)`)
        .run(scope.principalId, scope.companyId, scope.knowledgeNotebookId, scope.externalNotebookId, idempotencyKey, hash, claimDigest, now, now);
      this.db.exec("COMMIT");
    } catch (error) {
      try { this.db.exec("ROLLBACK"); } catch { /* preserve the original failure */ }
      throw error;
    }
    const intent = this.get(scope, idempotencyKey);
    if (!intent) throw new ResearchWriteLedgerError("not_found", "new ledger claim disappeared");
    return { kind: "claimed", intent, claimToken };
  }

  get(scopeInput: ResearchWriteScope, idempotencyKeyInput: string): ResearchWriteIntent | null {
    this.ensureOpen();
    const scope = validateScope(scopeInput);
    const idempotencyKey = validateIdempotencyKey(idempotencyKeyInput);
    const row = this.db
      .prepare(`SELECT * FROM ${LEDGER_TABLE} WHERE principal_id = ? AND company_id = ? AND idempotency_key = ?`)
      .get(scope.principalId, scope.companyId, idempotencyKey) as LedgerRow | undefined;
    if (!row || !sameScope(row, scope)) return null;
    return toIntent(row);
  }

  succeed(scopeInput: ResearchWriteScope, idempotencyKeyInput: string, claimToken: string, sourceIdInput: string): ResearchWriteIntent {
    return this.transition(scopeInput, idempotencyKeyInput, claimToken, "succeeded", validateSourceId(sourceIdInput), null);
  }

  markUncertain(scopeInput: ResearchWriteScope, idempotencyKeyInput: string, claimToken: string, errorCodeInput: ResearchWriteErrorCode = "ambiguous_response"): ResearchWriteIntent {
    return this.transition(scopeInput, idempotencyKeyInput, claimToken, "uncertain", null, validateErrorCode(errorCodeInput));
  }

  reject(scopeInput: ResearchWriteScope, idempotencyKeyInput: string, claimToken: string, errorCodeInput: ResearchWriteErrorCode = "invalid_request"): ResearchWriteIntent {
    return this.transition(scopeInput, idempotencyKeyInput, claimToken, "rejected", null, validateErrorCode(errorCodeInput));
  }

  close(): void {
    if (!this.closed) {
      this.db.close();
      this.closed = true;
    }
  }

  private transition(
    scopeInput: ResearchWriteScope,
    idempotencyKeyInput: string,
    claimToken: string,
    state: "succeeded" | "uncertain" | "rejected",
    sourceId: string | null,
    errorCode: ResearchWriteErrorCode | null,
  ): ResearchWriteIntent {
    this.ensureOpen();
    const scope = validateScope(scopeInput);
    const idempotencyKey = validateIdempotencyKey(idempotencyKeyInput);
    if (typeof claimToken !== "string" || !claimToken.trim()) throw new ResearchWriteLedgerError("claim_not_owner", "claim token is required");
    const claimDigest = digest(claimToken);
    const now = new Date().toISOString();
    const allowedStates = state === "uncertain" ? "state = 'pending'" : "state IN ('pending', 'uncertain')";
    const result = this.db.prepare(`UPDATE ${LEDGER_TABLE} SET state = ?, source_id = ?, error_code = ?, updated_at = ? WHERE principal_id = ? AND company_id = ? AND knowledge_notebook_id = ? AND external_notebook_id = ? AND idempotency_key = ? AND claim_digest = ? AND ${allowedStates}`).run(state, sourceId, errorCode, now, scope.principalId, scope.companyId, scope.knowledgeNotebookId, scope.externalNotebookId, idempotencyKey, claimDigest);
    if (result.changes !== 1) {
      const current = this.db.prepare(`SELECT * FROM ${LEDGER_TABLE} WHERE principal_id = ? AND company_id = ? AND idempotency_key = ?`).get(scope.principalId, scope.companyId, idempotencyKey) as LedgerRow | undefined;
      if (!current || !sameScope(current, scope)) throw new ResearchWriteLedgerError("not_found", "write intent not found for scope");
      if (current.claim_digest !== claimDigest) throw new ResearchWriteLedgerError("claim_not_owner", "write intent claim is not owned by caller");
      throw new ResearchWriteLedgerError("invalid_transition", "write intent transition is not allowed");
    }
    const updated = this.get(scope, idempotencyKey);
    if (!updated) throw new ResearchWriteLedgerError("not_found", "write intent disappeared after transition");
    return updated;
  }

  private ensureOpen(): void {
    if (this.closed) throw new ResearchWriteLedgerError("closed", "write ledger is closed");
  }
}
