import fs from "node:fs";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";

export type ResearchChatOperation = "session" | "message";
export type ResearchChatState = "pending" | "succeeded" | "uncertain" | "rejected";

export type ResearchChatErrorCode =
  | "invalid_request"
  | "scope_denied"
  | "policy_denied"
  | "upstream_unavailable"
  | "upstream_rejected"
  | "ambiguous_response"
  | "reconciliation_required";

export interface ResearchChatScope {
  readonly principalId: string;
  readonly companyId: string;
  readonly knowledgeNotebookId: string;
  readonly externalNotebookId: string;
  readonly modelId: string;
}

export interface ResearchChatAnswer {
  readonly id: string;
  readonly type: "ai";
  readonly content: string;
}

export interface ResearchChatReceipt {
  readonly operation: ResearchChatOperation;
  readonly idempotencyKey: string;
  readonly state: ResearchChatState;
  readonly localSessionId: string;
  readonly answer: ResearchChatAnswer | null;
  readonly errorCode: ResearchChatErrorCode | null;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface ResearchChatSession {
  readonly localSessionId: string;
  readonly externalSessionId: string;
  readonly title: string;
  readonly modelId: string;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export type ResearchChatConflictCode = "idempotency_conflict" | "scope_conflict";

export type ResearchChatBeginResult =
  | { readonly kind: "claimed"; readonly receipt: ResearchChatReceipt; readonly claimToken: string }
  | { readonly kind: "replay"; readonly receipt: ResearchChatReceipt }
  | { readonly kind: "reconciliation_required"; readonly receipt: ResearchChatReceipt }
  | { readonly kind: "session_busy"; readonly receipt: ResearchChatReceipt }
  | { readonly kind: "conflict"; readonly code: ResearchChatConflictCode };

export class ResearchChatLedgerError extends Error {
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
    this.name = "ResearchChatLedgerError";
  }
}

interface SessionRow {
  readonly local_session_id: string;
  readonly principal_id: string;
  readonly company_id: string;
  readonly knowledge_notebook_id: string;
  readonly external_notebook_id: string;
  readonly model_id: string;
  readonly title: string;
  readonly status: "pending" | "ready" | "uncertain" | "rejected";
  readonly external_session_id: string | null;
  readonly created_at: string;
  readonly updated_at: string;
}

interface IntentRow {
  readonly principal_id: string;
  readonly company_id: string;
  readonly operation: ResearchChatOperation;
  readonly idempotency_key: string;
  readonly request_hash: string;
  readonly local_session_id: string;
  readonly state: ResearchChatState;
  readonly answer_json: string | null;
  readonly error_code: ResearchChatErrorCode | null;
  readonly claim_digest: string;
  readonly created_at: string;
  readonly updated_at: string;
}

const SESSION_TABLE = "research_chat_sessions";
const INTENT_TABLE = "research_chat_intents";
const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/u;
const IDEMPOTENCY_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_.:/-]{0,255}$/u;
const SESSION_PATTERN = /^chat_session:[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/u;
const MODEL_PATTERN = /^model:[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/u;
const MAX_TITLE_BYTES = 4096;
const MAX_MESSAGE_BYTES = 32 * 1024;
const MAX_ANSWER_BYTES = 64 * 1024;
const SCOPE_KEYS = new Set(["principalId", "companyId", "knowledgeNotebookId", "externalNotebookId", "modelId"]);
const ANSWER_KEYS = new Set(["id", "type", "content"]);
const ERROR_CODES: readonly ResearchChatErrorCode[] = [
  "invalid_request",
  "scope_denied",
  "policy_denied",
  "upstream_unavailable",
  "upstream_rejected",
  "ambiguous_response",
  "reconciliation_required",
];

function digest(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function byteLength(value: string): number {
  return Buffer.byteLength(value, "utf8");
}

function validId(value: unknown): value is string {
  return typeof value === "string" && ID_PATTERN.test(value);
}

function validateScope(scope: ResearchChatScope): ResearchChatScope {
  if (
    !scope ||
    typeof scope !== "object" ||
    Object.keys(scope).length !== SCOPE_KEYS.size ||
    Object.keys(scope).some((key) => !SCOPE_KEYS.has(key)) ||
    !validId(scope.principalId) ||
    !validId(scope.companyId) ||
    !validId(scope.knowledgeNotebookId) ||
    !validId(scope.externalNotebookId) ||
    !MODEL_PATTERN.test(scope.modelId)
  ) {
    throw new ResearchChatLedgerError("invalid_input", "invalid chat scope");
  }
  return Object.freeze({
    principalId: scope.principalId,
    companyId: scope.companyId,
    knowledgeNotebookId: scope.knowledgeNotebookId,
    externalNotebookId: scope.externalNotebookId,
    modelId: scope.modelId,
  });
}

function validateIdempotencyKey(value: string): string {
  if (typeof value !== "string" || !IDEMPOTENCY_PATTERN.test(value)) {
    throw new ResearchChatLedgerError("invalid_input", "invalid idempotency key");
  }
  return value;
}

function validateSessionId(value: string): string {
  if (typeof value !== "string" || !SESSION_PATTERN.test(value)) {
    throw new ResearchChatLedgerError("invalid_input", "invalid local session id");
  }
  return value;
}

function validateExternalSessionId(value: string): string {
  if (typeof value !== "string" || !SESSION_PATTERN.test(value)) {
    throw new ResearchChatLedgerError("invalid_input", "invalid upstream session id");
  }
  return value;
}

function validateTitle(value: string): string {
  if (typeof value !== "string" || !value.trim() || byteLength(value) > MAX_TITLE_BYTES) {
    throw new ResearchChatLedgerError("invalid_input", "invalid session title");
  }
  return value;
}

function validateMessage(value: string): string {
  if (typeof value !== "string" || !value.trim() || byteLength(value) > MAX_MESSAGE_BYTES) {
    throw new ResearchChatLedgerError("invalid_input", "invalid chat message");
  }
  return value;
}

function validateAnswer(value: ResearchChatAnswer): ResearchChatAnswer {
  if (
    !value ||
    typeof value !== "object" ||
    Object.keys(value).length !== ANSWER_KEYS.size ||
    Object.keys(value).some((key) => !ANSWER_KEYS.has(key)) ||
    typeof value.id !== "string" ||
    value.id.length === 0 ||
    byteLength(value.id) > 256 ||
    value.type !== "ai" ||
    typeof value.content !== "string" ||
    byteLength(value.content) > MAX_ANSWER_BYTES
  ) {
    throw new ResearchChatLedgerError("invalid_input", "invalid assistant answer");
  }
  return Object.freeze({ id: value.id, type: "ai", content: value.content });
}

function validateErrorCode(value: ResearchChatErrorCode): ResearchChatErrorCode {
  if (typeof value !== "string" || !ERROR_CODES.includes(value)) {
    throw new ResearchChatLedgerError("invalid_input", "invalid chat error code");
  }
  return value;
}

function validateClaimToken(value: string): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new ResearchChatLedgerError("claim_not_owner", "chat claim token is required");
  }
  return value;
}

function hashSessionRequest(title: string): string {
  return digest(JSON.stringify({ operation: "session", title }));
}

function hashMessageRequest(localSessionId: string, message: string): string {
  return digest(JSON.stringify({ operation: "message", localSessionId, message }));
}

function sameScope(row: SessionRow, scope: ResearchChatScope): boolean {
  return (
    row.principal_id === scope.principalId &&
    row.company_id === scope.companyId &&
    row.knowledge_notebook_id === scope.knowledgeNotebookId &&
    row.external_notebook_id === scope.externalNotebookId &&
    row.model_id === scope.modelId
  );
}

function sameIntentScope(row: IntentRow, scope: ResearchChatScope): boolean {
  return (
    row.principal_id === scope.principalId &&
    row.company_id === scope.companyId
  );
}

function storedAnswer(row: IntentRow): ResearchChatAnswer | null {
  if (row.answer_json === null) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(row.answer_json);
  } catch {
    throw new ResearchChatLedgerError("invalid_transition", "stored chat answer is malformed");
  }
  try {
    return validateAnswer(parsed as ResearchChatAnswer);
  } catch {
    throw new ResearchChatLedgerError("invalid_transition", "stored chat answer is malformed");
  }
}

function toReceipt(row: IntentRow): ResearchChatReceipt {
  const answer = storedAnswer(row);
  if (row.state === "succeeded" && row.operation === "message" && !answer) {
    throw new ResearchChatLedgerError("invalid_transition", "successful chat message has no answer");
  }
  if (row.state === "succeeded" && row.operation === "session" && answer) {
    throw new ResearchChatLedgerError("invalid_transition", "successful chat session has an answer");
  }
  if ((row.state === "pending" || row.state === "uncertain") && answer) {
    throw new ResearchChatLedgerError("invalid_transition", "non-terminal chat intent has an answer");
  }
  if ((row.state === "uncertain" || row.state === "rejected") && !row.error_code) {
    throw new ResearchChatLedgerError("invalid_transition", "terminal chat error has no error code");
  }
  if (row.state === "pending" && row.error_code) {
    throw new ResearchChatLedgerError("invalid_transition", "pending chat intent has an error code");
  }
  return Object.freeze({
    operation: row.operation,
    idempotencyKey: row.idempotency_key,
    state: row.state,
    localSessionId: row.local_session_id,
    answer,
    errorCode: row.error_code,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  });
}

function toSession(row: SessionRow): ResearchChatSession {
  if (row.status !== "ready" || !row.external_session_id || !SESSION_PATTERN.test(row.external_session_id)) {
    throw new ResearchChatLedgerError("invalid_transition", "ready chat session has no valid upstream id");
  }
  return Object.freeze({
    localSessionId: row.local_session_id,
    externalSessionId: row.external_session_id,
    title: row.title,
    modelId: row.model_id,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  });
}

/**
 * Durable Knowledge chat session/turn claims. This class never calls an
 * upstream model or retries a turn. Pending and uncertain claims remain held
 * until an explicitly owned future reconciliation path changes them.
 */
export class ResearchChatLedger {
  private readonly db: DatabaseSync;
  private closed = false;

  constructor(readonly dbPath: string) {
    if (typeof dbPath !== "string" || !path.isAbsolute(dbPath) || path.basename(dbPath).trim() === "") {
      throw new ResearchChatLedgerError("invalid_path", "chat ledger path must be an explicit absolute file path");
    }
    fs.mkdirSync(path.dirname(dbPath), { recursive: true });
    let db: DatabaseSync | null = null;
    try {
      db = new DatabaseSync(dbPath);
      fs.chmodSync(dbPath, 0o600);
      // These pragmas must precede sqlite_master inspection: another worker
      // may still be creating the dedicated schema when this process opens it.
      db.exec("PRAGMA busy_timeout = 5000; PRAGMA foreign_keys = ON;");
      const tables = (db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'").all() as Array<{ name: string }>).map((row) => row.name);
      if (tables.some((name) => name !== SESSION_TABLE && name !== INTENT_TABLE)) {
        throw new ResearchChatLedgerError("database_not_dedicated", "chat ledger database must not contain unrelated tables");
      }
      db.exec("BEGIN IMMEDIATE");
      try {
        db.exec(`
          CREATE TABLE IF NOT EXISTS ${SESSION_TABLE} (
            local_session_id TEXT PRIMARY KEY CHECK (local_session_id GLOB 'chat_session:*'),
            principal_id TEXT NOT NULL,
            company_id TEXT NOT NULL,
            knowledge_notebook_id TEXT NOT NULL,
            external_notebook_id TEXT NOT NULL,
            model_id TEXT NOT NULL CHECK (model_id GLOB 'model:*'),
            title TEXT NOT NULL,
            status TEXT NOT NULL CHECK (status IN ('pending', 'ready', 'uncertain', 'rejected')),
            external_session_id TEXT UNIQUE CHECK (external_session_id IS NULL OR external_session_id GLOB 'chat_session:*'),
            created_at TEXT NOT NULL,
            updated_at TEXT NOT NULL,
            CHECK ((status = 'ready' AND external_session_id IS NOT NULL) OR (status IN ('pending', 'uncertain', 'rejected') AND external_session_id IS NULL))
          );
          CREATE TABLE IF NOT EXISTS ${INTENT_TABLE} (
            principal_id TEXT NOT NULL,
            company_id TEXT NOT NULL,
            operation TEXT NOT NULL CHECK (operation IN ('session', 'message')),
            idempotency_key TEXT NOT NULL,
            request_hash TEXT NOT NULL,
            local_session_id TEXT NOT NULL REFERENCES ${SESSION_TABLE}(local_session_id),
            state TEXT NOT NULL CHECK (state IN ('pending', 'succeeded', 'uncertain', 'rejected')),
            answer_json TEXT,
            error_code TEXT,
            claim_digest TEXT NOT NULL,
            created_at TEXT NOT NULL,
            updated_at TEXT NOT NULL,
            PRIMARY KEY (principal_id, company_id, idempotency_key),
            CHECK ((state = 'succeeded' AND ((operation = 'session' AND answer_json IS NULL AND error_code IS NULL) OR (operation = 'message' AND answer_json IS NOT NULL AND error_code IS NULL))) OR
                   (state = 'pending' AND answer_json IS NULL AND error_code IS NULL) OR
                   (state = 'uncertain' AND answer_json IS NULL AND error_code IS NOT NULL) OR
                   (state = 'rejected' AND answer_json IS NULL AND error_code IS NOT NULL))
          );
          CREATE INDEX IF NOT EXISTS idx_research_chat_session_scope
            ON ${SESSION_TABLE} (principal_id, company_id, knowledge_notebook_id, external_notebook_id);
          CREATE INDEX IF NOT EXISTS idx_research_chat_active_turn
            ON ${INTENT_TABLE} (principal_id, company_id, local_session_id, operation, state);
        `);
        db.exec("COMMIT");
      } catch (error) {
        try { db.exec("ROLLBACK"); } catch { /* preserve original error */ }
        throw error;
      }
      fs.chmodSync(dbPath, 0o600);
      this.db = db;
    } catch (error) {
      try { db?.close(); } catch { /* preserve original error */ }
      throw error;
    }
  }

  beginSession(scopeInput: ResearchChatScope, idempotencyKeyInput: string, titleInput: string): ResearchChatBeginResult {
    this.ensureOpen();
    const scope = validateScope(scopeInput);
    const idempotencyKey = validateIdempotencyKey(idempotencyKeyInput);
    const title = validateTitle(titleInput);
    const requestHash = hashSessionRequest(title);
    const claimToken = randomUUID();
    const claimDigest = digest(claimToken);
    const now = new Date().toISOString();

    this.db.exec("BEGIN IMMEDIATE");
    try {
      const existing = this.intentByKey(scope, idempotencyKey);
      if (existing) {
        this.db.exec("COMMIT");
        return this.resolveExisting(existing, scope, requestHash, "session");
      }

      const localSessionId = `chat_session:${randomUUID()}`;
      this.db.prepare(`
        INSERT INTO ${SESSION_TABLE}
          (local_session_id, principal_id, company_id, knowledge_notebook_id, external_notebook_id, model_id, title, status, external_session_id, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', NULL, ?, ?)
      `).run(localSessionId, scope.principalId, scope.companyId, scope.knowledgeNotebookId, scope.externalNotebookId, scope.modelId, title, now, now);
      this.db.prepare(`
        INSERT INTO ${INTENT_TABLE}
          (principal_id, company_id, operation, idempotency_key, request_hash, local_session_id, state, answer_json, error_code, claim_digest, created_at, updated_at)
        VALUES (?, ?, 'session', ?, ?, ?, 'pending', NULL, NULL, ?, ?, ?)
      `).run(scope.principalId, scope.companyId, idempotencyKey, requestHash, localSessionId, claimDigest, now, now);
      const inserted = this.intentByKey(scope, idempotencyKey);
      if (!inserted) throw new ResearchChatLedgerError("not_found", "new chat session claim disappeared");
      const receipt = toReceipt(inserted);
      this.db.exec("COMMIT");
      return { kind: "claimed", receipt, claimToken };
    } catch (error) {
      try { this.db.exec("ROLLBACK"); } catch { /* preserve original error */ }
      throw error;
    }
  }

  completeSession(scopeInput: ResearchChatScope, idempotencyKeyInput: string, claimTokenInput: string, externalSessionIdInput: string): ResearchChatReceipt {
    this.ensureOpen();
    const scope = validateScope(scopeInput);
    const idempotencyKey = validateIdempotencyKey(idempotencyKeyInput);
    const claimToken = validateClaimToken(claimTokenInput);
    const externalSessionId = validateExternalSessionId(externalSessionIdInput);
    const claimDigest = digest(claimToken);
    const now = new Date().toISOString();

    this.db.exec("BEGIN IMMEDIATE");
    try {
      const intent = this.requireOwnedIntent(scope, idempotencyKey, claimDigest, "session");
      if (intent.state !== "pending") throw new ResearchChatLedgerError("invalid_transition", "chat session claim is not pending");
      const session = this.sessionById(intent.local_session_id);
      if (!session || session.status !== "pending" || !sameScope(session, scope)) {
        throw new ResearchChatLedgerError("invalid_transition", "chat session claim has no pending session");
      }
      const sessionUpdate = this.db.prepare(`
        UPDATE ${SESSION_TABLE}
        SET status = 'ready', external_session_id = ?, updated_at = ?
        WHERE local_session_id = ? AND status = 'pending' AND external_session_id IS NULL
      `).run(externalSessionId, now, session.local_session_id);
      if (sessionUpdate.changes !== 1) throw new ResearchChatLedgerError("invalid_transition", "chat session is no longer pending");
      const intentUpdate = this.db.prepare(`
        UPDATE ${INTENT_TABLE}
        SET state = 'succeeded', updated_at = ?
        WHERE principal_id = ? AND company_id = ? AND idempotency_key = ? AND claim_digest = ? AND operation = 'session' AND state = 'pending'
      `).run(now, scope.principalId, scope.companyId, idempotencyKey, claimDigest);
      if (intentUpdate.changes !== 1) throw new ResearchChatLedgerError("invalid_transition", "chat session intent is no longer pending");
      const updated = this.intentByKey(scope, idempotencyKey);
      if (!updated) throw new ResearchChatLedgerError("not_found", "chat session receipt disappeared");
      const receipt = toReceipt(updated);
      this.db.exec("COMMIT");
      return receipt;
    } catch (error) {
      try { this.db.exec("ROLLBACK"); } catch { /* preserve original error */ }
      throw error;
    }
  }

  getSession(scopeInput: ResearchChatScope, localSessionIdInput: string): ResearchChatSession | null {
    this.ensureOpen();
    const scope = validateScope(scopeInput);
    const localSessionId = validateSessionId(localSessionIdInput);
    const row = this.sessionById(localSessionId);
    if (!row || row.status !== "ready" || !sameScope(row, scope)) return null;
    return toSession(row);
  }

  beginTurn(scopeInput: ResearchChatScope, localSessionIdInput: string, idempotencyKeyInput: string, messageInput: string): ResearchChatBeginResult {
    this.ensureOpen();
    const scope = validateScope(scopeInput);
    const localSessionId = validateSessionId(localSessionIdInput);
    const idempotencyKey = validateIdempotencyKey(idempotencyKeyInput);
    const message = validateMessage(messageInput);
    const requestHash = hashMessageRequest(localSessionId, message);
    const claimToken = randomUUID();
    const claimDigest = digest(claimToken);
    const now = new Date().toISOString();

    this.db.exec("BEGIN IMMEDIATE");
    try {
      const existing = this.intentByKey(scope, idempotencyKey);
      if (existing) {
        this.db.exec("COMMIT");
        if (existing.operation !== "message" || existing.local_session_id !== localSessionId) return { kind: "conflict", code: "idempotency_conflict" };
        return this.resolveExisting(existing, scope, requestHash, "message");
      }

      const session = this.sessionById(localSessionId);
      if (!session || session.status !== "ready" || !sameScope(session, scope)) {
        throw new ResearchChatLedgerError("not_found", "chat session not found for scope");
      }

      const busy = this.db.prepare(`
        SELECT * FROM ${INTENT_TABLE}
        WHERE principal_id = ? AND company_id = ? AND local_session_id = ? AND operation = 'message' AND state IN ('pending', 'uncertain')
        ORDER BY created_at ASC LIMIT 1
      `).get(scope.principalId, scope.companyId, localSessionId) as IntentRow | undefined;
      if (busy) {
        this.db.exec("COMMIT");
        return { kind: "session_busy", receipt: toReceipt(busy) };
      }

      this.db.prepare(`
        INSERT INTO ${INTENT_TABLE}
          (principal_id, company_id, operation, idempotency_key, request_hash, local_session_id, state, answer_json, error_code, claim_digest, created_at, updated_at)
        VALUES (?, ?, 'message', ?, ?, ?, 'pending', NULL, NULL, ?, ?, ?)
      `).run(scope.principalId, scope.companyId, idempotencyKey, requestHash, localSessionId, claimDigest, now, now);
      const inserted = this.intentByKey(scope, idempotencyKey);
      if (!inserted) throw new ResearchChatLedgerError("not_found", "new chat turn claim disappeared");
      const receipt = toReceipt(inserted);
      this.db.exec("COMMIT");
      return { kind: "claimed", receipt, claimToken };
    } catch (error) {
      try { this.db.exec("ROLLBACK"); } catch { /* preserve original error */ }
      throw error;
    }
  }

  completeTurn(scopeInput: ResearchChatScope, idempotencyKeyInput: string, claimTokenInput: string, answerInput: ResearchChatAnswer): ResearchChatReceipt {
    const answer = validateAnswer(answerInput);
    return this.transition(scopeInput, idempotencyKeyInput, claimTokenInput, "succeeded", answer, null);
  }

  markUncertain(scopeInput: ResearchChatScope, idempotencyKeyInput: string, claimTokenInput: string, errorCodeInput: ResearchChatErrorCode = "ambiguous_response"): ResearchChatReceipt {
    return this.transition(scopeInput, idempotencyKeyInput, claimTokenInput, "uncertain", null, validateErrorCode(errorCodeInput));
  }

  reject(scopeInput: ResearchChatScope, idempotencyKeyInput: string, claimTokenInput: string, errorCodeInput: ResearchChatErrorCode = "invalid_request"): ResearchChatReceipt {
    return this.transition(scopeInput, idempotencyKeyInput, claimTokenInput, "rejected", null, validateErrorCode(errorCodeInput));
  }

  getReceipt(scopeInput: ResearchChatScope, idempotencyKeyInput: string): ResearchChatReceipt | null {
    this.ensureOpen();
    const scope = validateScope(scopeInput);
    const idempotencyKey = validateIdempotencyKey(idempotencyKeyInput);
    const row = this.intentByKey(scope, idempotencyKey);
    if (!row || !sameIntentScope(row, scope) || !this.intentScopeMatchesSession(row, scope)) return null;
    return toReceipt(row);
  }

  close(): void {
    if (!this.closed) {
      this.db.close();
      this.closed = true;
    }
  }

  private transition(
    scopeInput: ResearchChatScope,
    idempotencyKeyInput: string,
    claimTokenInput: string,
    targetState: "succeeded" | "uncertain" | "rejected",
    answer: ResearchChatAnswer | null,
    errorCode: ResearchChatErrorCode | null,
  ): ResearchChatReceipt {
    this.ensureOpen();
    const scope = validateScope(scopeInput);
    const idempotencyKey = validateIdempotencyKey(idempotencyKeyInput);
    const claimToken = validateClaimToken(claimTokenInput);
    const claimDigest = digest(claimToken);
    const now = new Date().toISOString();

    this.db.exec("BEGIN IMMEDIATE");
    try {
      const intent = this.requireOwnedIntent(scope, idempotencyKey, claimDigest, undefined);
      const session = this.sessionById(intent.local_session_id);
      if (!session || !sameScope(session, scope)) throw new ResearchChatLedgerError("invalid_transition", "chat intent has no matching session");
      if (targetState === "succeeded" && (intent.operation !== "message" || session.status !== "ready" || intent.state !== "pending")) {
        throw new ResearchChatLedgerError("invalid_transition", "chat turn is not pending");
      }
      if (targetState === "uncertain" && intent.state !== "pending") throw new ResearchChatLedgerError("invalid_transition", "chat turn is not pending");
      if (targetState === "rejected" && intent.state !== "pending" && intent.state !== "uncertain") throw new ResearchChatLedgerError("invalid_transition", "chat turn cannot be rejected");
      if (targetState === "succeeded" && !answer) throw new ResearchChatLedgerError("invalid_input", "successful chat turn needs an answer");
      if ((targetState === "uncertain" || targetState === "rejected") && !errorCode) throw new ResearchChatLedgerError("invalid_input", "chat failure needs an error code");

      if (intent.operation === "message" && session.status !== "ready") {
        throw new ResearchChatLedgerError("invalid_transition", "chat turn has no ready session");
      }
      if (intent.operation === "session" && targetState === "succeeded") {
        throw new ResearchChatLedgerError("invalid_transition", "chat session needs completeSession");
      }

      const updated = this.db.prepare(`
        UPDATE ${INTENT_TABLE}
        SET state = ?, answer_json = ?, error_code = ?, updated_at = ?
        WHERE principal_id = ? AND company_id = ? AND idempotency_key = ? AND claim_digest = ? AND state IN ('pending', 'uncertain')
      `).run(targetState, answer ? JSON.stringify(answer) : null, errorCode, now, scope.principalId, scope.companyId, idempotencyKey, claimDigest);
      if (updated.changes !== 1) throw new ResearchChatLedgerError("invalid_transition", "chat turn transition was not applied");

      if (intent.operation === "session") {
        const sessionStatus = targetState === "uncertain" ? "uncertain" : "rejected";
        const sessionUpdate = this.db.prepare(`
          UPDATE ${SESSION_TABLE}
          SET status = ?, updated_at = ?
          WHERE local_session_id = ? AND status IN ('pending', 'uncertain') AND external_session_id IS NULL
        `).run(sessionStatus, now, intent.local_session_id);
        if (sessionUpdate.changes !== 1) throw new ResearchChatLedgerError("invalid_transition", "chat session state was not updated");
      } else if (targetState === "succeeded") {
        const sessionUpdate = this.db.prepare(`
          UPDATE ${SESSION_TABLE}
          SET updated_at = ?
          WHERE local_session_id = ? AND status = 'ready'
        `).run(now, intent.local_session_id);
        if (sessionUpdate.changes !== 1) throw new ResearchChatLedgerError("invalid_transition", "ready chat session timestamp was not updated");
      }
      const row = this.intentByKey(scope, idempotencyKey);
      if (!row) throw new ResearchChatLedgerError("not_found", "chat turn receipt disappeared");
      const receipt = toReceipt(row);
      this.db.exec("COMMIT");
      return receipt;
    } catch (error) {
      try { this.db.exec("ROLLBACK"); } catch { /* preserve original error */ }
      throw error;
    }
  }

  private resolveExisting(row: IntentRow, scope: ResearchChatScope, requestHash: string, operation: ResearchChatOperation): ResearchChatBeginResult {
    if (row.operation !== operation) return { kind: "conflict", code: "idempotency_conflict" };
    if (!sameIntentScope(row, scope) || !this.intentScopeMatchesSession(row, scope)) return { kind: "conflict", code: "scope_conflict" };
    if (row.request_hash !== requestHash) return { kind: "conflict", code: "idempotency_conflict" };
    const receipt = toReceipt(row);
    if (row.state === "pending" || row.state === "uncertain") return { kind: "reconciliation_required", receipt };
    return { kind: "replay", receipt };
  }

  private intentByKey(scope: ResearchChatScope, idempotencyKey: string): IntentRow | undefined {
    return this.db.prepare(`
      SELECT * FROM ${INTENT_TABLE}
      WHERE principal_id = ? AND company_id = ? AND idempotency_key = ?
    `).get(scope.principalId, scope.companyId, idempotencyKey) as IntentRow | undefined;
  }

  private sessionById(localSessionId: string): SessionRow | undefined {
    return this.db.prepare(`SELECT * FROM ${SESSION_TABLE} WHERE local_session_id = ?`).get(localSessionId) as SessionRow | undefined;
  }

  private intentScopeMatchesSession(row: IntentRow, scope: ResearchChatScope): boolean {
    const session = this.sessionById(row.local_session_id);
    return !!session && sameScope(session, scope);
  }

  private requireOwnedIntent(scope: ResearchChatScope, idempotencyKey: string, claimDigest: string, operation: ResearchChatOperation | undefined): IntentRow {
    const row = this.intentByKey(scope, idempotencyKey);
    if (!row || !sameIntentScope(row, scope) || !this.intentScopeMatchesSession(row, scope)) {
      throw new ResearchChatLedgerError("not_found", "chat intent not found for scope");
    }
    if (operation && row.operation !== operation) throw new ResearchChatLedgerError("invalid_transition", "chat intent operation does not match");
    if (row.claim_digest !== claimDigest) throw new ResearchChatLedgerError("claim_not_owner", "chat intent claim is not owned by caller");
    return row;
  }

  private ensureOpen(): void {
    if (this.closed) throw new ResearchChatLedgerError("closed", "chat ledger is closed");
  }
}
