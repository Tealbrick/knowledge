import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DatabaseSync } from "node:sqlite";
import {
  ResearchChatLedger,
  ResearchChatLedgerError,
  type ResearchChatAnswer,
  type ResearchChatScope,
} from "./research-chat-ledger.js";

const scopeA: ResearchChatScope = {
  principalId: "principal-a",
  companyId: "company-a",
  knowledgeNotebookId: "notebook-a",
  externalNotebookId: "notebook:external-a",
  modelId: "model:fixture-a",
};

const scopeB: ResearchChatScope = {
  principalId: "principal-b",
  companyId: "company-b",
  knowledgeNotebookId: "notebook-b",
  externalNotebookId: "notebook:external-b",
  modelId: "model:fixture-b",
};

const answerA: ResearchChatAnswer = {
  id: "message:answer-a",
  type: "ai",
  content: "Synthetic answer from the bounded fixture.",
};

const roots: string[] = [];
const ledgers: ResearchChatLedger[] = [];
const moduleUrl = new URL("./research-chat-ledger.ts", import.meta.url).href;

async function fixture(): Promise<{ root: string; dbPath: string }> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "knowledge-chat-ledger-"));
  roots.push(root);
  return { root, dbPath: path.join(root, "chat.sqlite") };
}

function open(dbPath: string): ResearchChatLedger {
  const ledger = new ResearchChatLedger(dbPath);
  ledgers.push(ledger);
  return ledger;
}

function forget(ledger: ResearchChatLedger): void {
  const index = ledgers.indexOf(ledger);
  if (index >= 0) ledgers.splice(index, 1);
}

function createReadySession(ledger: ResearchChatLedger, scope: ResearchChatScope = scopeA, key = "session-key") {
  const claim = ledger.beginSession(scope, key, "Fixture chat");
  expect(claim.kind).toBe("claimed");
  if (claim.kind !== "claimed") throw new Error("expected a session claim");
  const receipt = ledger.completeSession(scope, key, claim.claimToken, "chat_session:upstream-a");
  expect(receipt.state).toBe("succeeded");
  const session = ledger.getSession(scope, receipt.localSessionId);
  expect(session).not.toBeNull();
  if (!session) throw new Error("expected a ready session");
  return { session, claim, receipt };
}

async function runWorker(dbPath: string, startFile: string): Promise<{ code: number | null; output: string }> {
  const workerCode = `
    import fs from "node:fs/promises";
    const { ResearchChatLedger } = await import(${JSON.stringify(moduleUrl)});
    while (true) { try { await fs.access(process.env.START_FILE); break; } catch { await new Promise((resolve) => setTimeout(resolve, 2)); } }
    const ledger = new ResearchChatLedger(process.env.DB_PATH);
    const result = ledger.beginSession(JSON.parse(process.env.SCOPE), process.env.KEY, "Race session");
    process.stdout.write(JSON.stringify({ kind: result.kind, localSessionId: result.receipt?.localSessionId ?? null }));
    ledger.close();
  `;
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["--import", "tsx/esm", "--input-type=module", "-e", workerCode], {
      cwd: path.dirname(fileURLToPath(import.meta.url)),
      env: {
        ...process.env,
        DB_PATH: dbPath,
        START_FILE: startFile,
        KEY: "process-race-key",
        SCOPE: JSON.stringify(scopeA),
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let output = "";
    let error = "";
    child.stdout.on("data", (chunk) => { output += String(chunk); });
    child.stderr.on("data", (chunk) => { error += String(chunk); });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) resolve({ code, output });
      else reject(new Error(error || `worker exited ${String(code)}`));
    });
  });
}

afterEach(async () => {
  vi.useRealTimers();
  for (const ledger of ledgers.splice(0)) ledger.close();
  for (const root of roots.splice(0)) await fs.rm(root, { recursive: true, force: true });
});

describe("durable scoped Knowledge research chat ledger", () => {
  it("serializes a session claim across two real Node processes", async () => {
    const { root, dbPath } = await fixture();
    const startFile = path.join(root, "start.signal");
    const first = runWorker(dbPath, startFile);
    const second = runWorker(dbPath, startFile);
    await new Promise((resolve) => setTimeout(resolve, 100));
    await fs.writeFile(startFile, "go", { mode: 0o600 });
    const results = await Promise.all([first, second]);
    const parsed = results.map((result) => JSON.parse(result.output));
    expect(parsed.map((result) => result.kind).sort()).toEqual(["claimed", "reconciliation_required"]);
    expect(new Set(parsed.map((result) => result.localSessionId)).size).toBe(1);
  });

  it("replays a completed session and message after closing and reopening", async () => {
    const { dbPath } = await fixture();
    const first = open(dbPath);
    const created = createReadySession(first);
    const turn = first.beginTurn(scopeA, created.session.localSessionId, "message-key", "What is in the fixture?");
    expect(turn.kind).toBe("claimed");
    if (turn.kind !== "claimed") return;
    const completedTurn = first.completeTurn(scopeA, "message-key", turn.claimToken, answerA);
    expect(completedTurn).toMatchObject({ operation: "message", state: "succeeded", answer: answerA });
    const localSessionId = created.session.localSessionId;
    first.close();
    forget(first);

    const restarted = open(dbPath);
    const sessionReplay = restarted.beginSession(scopeA, "session-key", "Fixture chat");
    expect(sessionReplay).toMatchObject({ kind: "replay", receipt: { state: "succeeded", localSessionId } });
    const messageReplay = restarted.beginTurn(scopeA, localSessionId, "message-key", "What is in the fixture?");
    expect(messageReplay).toMatchObject({ kind: "replay", receipt: { state: "succeeded", answer: answerA } });
    expect(restarted.getSession(scopeA, localSessionId)).toMatchObject({
      localSessionId,
      externalSessionId: "chat_session:upstream-a",
      title: "Fixture chat",
      modelId: "model:fixture-a",
    });
  });

  it("advances the session timestamp when a message completes", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-09-06T04:00:00.000Z"));
    const { dbPath } = await fixture();
    const ledger = open(dbPath);
    const created = createReadySession(ledger, scopeA, "timestamp-session");
    const initialUpdatedAt = created.session.updatedAt;
    vi.setSystemTime(new Date("2026-09-06T04:01:00.000Z"));
    const turn = ledger.beginTurn(scopeA, created.session.localSessionId, "timestamp-turn", "advance it");
    expect(turn.kind).toBe("claimed");
    if (turn.kind !== "claimed") return;
    ledger.completeTurn(scopeA, "timestamp-turn", turn.claimToken, answerA);
    expect(ledger.getSession(scopeA, created.session.localSessionId)?.updatedAt).toBe("2026-09-06T04:01:00.000Z");
    expect(ledger.getSession(scopeA, created.session.localSessionId)?.updatedAt).not.toBe(initialUpdatedAt);
  });

  it("holds pending and uncertain session and turn claims across restart", async () => {
    const { dbPath } = await fixture();
    const first = open(dbPath);
    const sessionClaim = first.beginSession(scopeA, "pending-session", "Pending");
    expect(sessionClaim.kind).toBe("claimed");
    if (sessionClaim.kind !== "claimed") return;
    first.close();
    forget(first);

    const restarted = open(dbPath);
    expect(restarted.beginSession(scopeA, "pending-session", "Pending")).toMatchObject({ kind: "reconciliation_required", receipt: { state: "pending" } });
    const uncertainSession = restarted.markUncertain(scopeA, "pending-session", sessionClaim.claimToken, "ambiguous_response");
    expect(uncertainSession).toMatchObject({ operation: "session", state: "uncertain", errorCode: "ambiguous_response" });
    expect(restarted.beginSession(scopeA, "pending-session", "Pending")).toMatchObject({ kind: "reconciliation_required", receipt: { state: "uncertain" } });
    restarted.close();
    forget(restarted);

    const reopened = open(dbPath);
    const ready = createReadySession(reopened, scopeA, "ready-for-uncertain-turn");
    const turn = reopened.beginTurn(scopeA, ready.session.localSessionId, "uncertain-turn", "Hold this turn");
    expect(turn.kind).toBe("claimed");
    if (turn.kind !== "claimed") return;
    reopened.markUncertain(scopeA, "uncertain-turn", turn.claimToken, "upstream_unavailable");
    reopened.close();
    forget(reopened);

    const afterRestart = open(dbPath);
    expect(afterRestart.beginTurn(scopeA, ready.session.localSessionId, "uncertain-turn", "Hold this turn")).toMatchObject({ kind: "reconciliation_required", receipt: { state: "uncertain", errorCode: "upstream_unavailable" } });
    expect(afterRestart.getReceipt(scopeA, "uncertain-turn")).toMatchObject({ state: "uncertain", answer: null });
  });

  it("rejects changed body, notebook mapping, model, operation, and scope", async () => {
    const { dbPath } = await fixture();
    const ledger = open(dbPath);
    const claim = ledger.beginSession(scopeA, "conflict-key", "Original");
    expect(claim.kind).toBe("claimed");
    expect(ledger.beginSession(scopeA, "conflict-key", "Changed")).toEqual({ kind: "conflict", code: "idempotency_conflict" });
    expect(ledger.beginSession({ ...scopeA, externalNotebookId: "notebook:other" }, "conflict-key", "Original")).toEqual({ kind: "conflict", code: "scope_conflict" });
    expect(ledger.beginSession({ ...scopeA, modelId: "model:other" }, "conflict-key", "Original")).toEqual({ kind: "conflict", code: "scope_conflict" });

    const ready = createReadySession(ledger, scopeA, "operation-session");
    const message = ledger.beginTurn(scopeA, ready.session.localSessionId, "operation-session", "message with session key");
    expect(message).toEqual({ kind: "conflict", code: "idempotency_conflict" });

    const turn = ledger.beginTurn(scopeA, ready.session.localSessionId, "changed-message", "first body");
    expect(turn.kind).toBe("claimed");
    if (turn.kind !== "claimed") return;
    expect(ledger.beginTurn(scopeA, ready.session.localSessionId, "changed-message", "changed body")).toEqual({ kind: "conflict", code: "idempotency_conflict" });
    expect(ledger.beginTurn({ ...scopeA, modelId: "model:other" }, ready.session.localSessionId, "changed-message", "first body")).toEqual({ kind: "conflict", code: "scope_conflict" });
  });

  it("serializes distinct turns and releases the session only on explicit rejection", async () => {
    const { dbPath } = await fixture();
    const ledger = open(dbPath);
    const { session } = createReadySession(ledger, scopeA, "serialized-session");
    const first = ledger.beginTurn(scopeA, session.localSessionId, "turn-one", "first");
    expect(first.kind).toBe("claimed");
    if (first.kind !== "claimed") return;
    const busy = ledger.beginTurn(scopeA, session.localSessionId, "turn-two", "second");
    expect(busy).toMatchObject({ kind: "session_busy", receipt: { idempotencyKey: "turn-one", state: "pending" } });
    ledger.markUncertain(scopeA, "turn-one", first.claimToken, "ambiguous_response");
    expect(ledger.beginTurn(scopeA, session.localSessionId, "turn-two", "second")).toMatchObject({ kind: "session_busy", receipt: { idempotencyKey: "turn-one", state: "uncertain" } });
    ledger.reject(scopeA, "turn-one", first.claimToken, "upstream_rejected");
    const second = ledger.beginTurn(scopeA, session.localSessionId, "turn-two", "second");
    expect(second.kind).toBe("claimed");
    if (second.kind !== "claimed") return;
    ledger.completeTurn(scopeA, "turn-two", second.claimToken, answerA);
    expect(ledger.beginTurn(scopeA, session.localSessionId, "turn-two", "second")).toMatchObject({ kind: "replay", receipt: { state: "succeeded" } });
  });

  it("does not disclose or permit a cross-principal session", async () => {
    const { dbPath } = await fixture();
    const ledger = open(dbPath);
    const { session } = createReadySession(ledger);
    expect(ledger.getSession(scopeB, session.localSessionId)).toBeNull();
    expect(ledger.getReceipt(scopeB, "session-key")).toBeNull();
    expect(() => ledger.beginTurn(scopeB, session.localSessionId, "foreign-turn", "forged selector")).toThrowError(
      expect.objectContaining({ code: "not_found" }),
    );
    const foreignSession = ledger.beginSession(scopeB, "session-key", "Foreign session");
    expect(foreignSession.kind).toBe("claimed");
    expect(foreignSession.kind === "claimed" ? foreignSession.receipt.localSessionId : "").not.toBe(session.localSessionId);
  });

  it("rejects malformed fields, unknown answer fields, prefixes, and oversized values", async () => {
    const { dbPath } = await fixture();
    const ledger = open(dbPath);
    expect(() => ledger.beginSession({ ...scopeA, modelId: "gpt-fixture" }, "bad-model", "Title")).toThrowError(ResearchChatLedgerError);
    expect(() => ledger.beginSession({ ...scopeA, extra: "forged" } as never, "bad-scope", "Title")).toThrowError(ResearchChatLedgerError);
    expect(() => ledger.beginSession(scopeA, "", "Title")).toThrowError(ResearchChatLedgerError);
    expect(() => ledger.beginSession(scopeA, "bad key", "Title")).toThrowError(ResearchChatLedgerError);
    expect(() => ledger.beginSession(scopeA, "bad-title", " ")).toThrowError(ResearchChatLedgerError);
    expect(() => ledger.beginSession(scopeA, "huge-title", "x".repeat(4097))).toThrowError(ResearchChatLedgerError);

    const { session } = createReadySession(ledger, scopeA, "validation-session");
    expect(() => ledger.beginTurn(scopeA, session.localSessionId, "blank-message", " ")).toThrowError(ResearchChatLedgerError);
    expect(() => ledger.beginTurn(scopeA, session.localSessionId, "huge-message", "x".repeat(32 * 1024 + 1))).toThrowError(ResearchChatLedgerError);
    const turn = ledger.beginTurn(scopeA, session.localSessionId, "answer-validation", "answer");
    expect(turn.kind).toBe("claimed");
    if (turn.kind !== "claimed") return;
    expect(() => ledger.completeTurn(scopeA, "answer-validation", turn.claimToken, { ...answerA, extra: "secret" } as never)).toThrowError(ResearchChatLedgerError);
    expect(() => ledger.completeTurn(scopeA, "answer-validation", turn.claimToken, { ...answerA, content: "x".repeat(64 * 1024 + 1) })).toThrowError(ResearchChatLedgerError);
    expect(() => ledger.completeTurn(scopeA, "answer-validation", turn.claimToken, { ...answerA, type: "human" } as never)).toThrowError(ResearchChatLedgerError);
    expect(() => ledger.completeTurn(scopeA, "answer-validation", turn.claimToken, { ...answerA, id: "message:answer-b" })).not.toThrowError();
  });

  it("stores only a digest for the prompt and keeps answers bounded", async () => {
    const { dbPath } = await fixture();
    const ledger = open(dbPath);
    const { session } = createReadySession(ledger, scopeA, "storage-session");
    const secretPrompt = "do not store this prompt or bearer=fixture-secret";
    const turn = ledger.beginTurn(scopeA, session.localSessionId, "storage-turn", secretPrompt);
    expect(turn.kind).toBe("claimed");
    if (turn.kind !== "claimed") return;
    const receipt = ledger.completeTurn(scopeA, "storage-turn", turn.claimToken, answerA);
    expect(JSON.stringify(receipt)).not.toContain(secretPrompt);
    expect(JSON.stringify(receipt)).not.toContain(turn.claimToken);
    const db = new DatabaseSync(dbPath);
    const raw = db.prepare("SELECT * FROM research_chat_intents WHERE idempotency_key = ?").get("storage-turn") as Record<string, unknown>;
    db.close();
    expect(JSON.stringify(raw)).not.toContain(secretPrompt);
    expect(JSON.stringify(raw)).not.toContain(turn.claimToken);
    expect(raw.answer_json).toContain("Synthetic answer");
  });

  it("closes safely and refuses a non-dedicated or failed database", async () => {
    const { dbPath } = await fixture();
    const ledger = open(dbPath);
    ledger.close();
    expect(() => ledger.getReceipt(scopeA, "closed-key")).toThrowError(expect.objectContaining({ code: "closed" }));
    forget(ledger);

    const badPath = path.join(path.dirname(dbPath), "unrelated.sqlite");
    const bad = new DatabaseSync(badPath);
    bad.exec("CREATE TABLE unrelated (id TEXT PRIMARY KEY)");
    bad.close();
    expect(() => new ResearchChatLedger(badPath)).toThrowError(expect.objectContaining({ code: "database_not_dedicated" }));
    const reopened = new DatabaseSync(badPath);
    expect(reopened.prepare("SELECT count(*) AS count FROM unrelated").get()).toEqual({ count: 0 });
    reopened.close();
  });

  it("uses owner-only permissions and rejects an implicit path", async () => {
    const { dbPath } = await fixture();
    const ledger = open(dbPath);
    const mode = (await fs.stat(dbPath)).mode & 0o777;
    expect(mode).toBe(0o600);
    expect(() => new ResearchChatLedger("relative-chat.sqlite")).toThrowError(ResearchChatLedgerError);
    ledger.close();
    forget(ledger);
  });
});
