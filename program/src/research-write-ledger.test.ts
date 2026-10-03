import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import {
  ResearchWriteLedger,
  ResearchWriteLedgerError,
  type ResearchWriteScope,
  type TextSourceWriteRequest,
} from "./research-write-ledger.js";

const scopeA: ResearchWriteScope = {
  principalId: "principal-a",
  companyId: "company-a",
  knowledgeNotebookId: "notebook-a",
  externalNotebookId: "notebook:external-a",
};

const scopeB: ResearchWriteScope = {
  principalId: "principal-b",
  companyId: "company-b",
  knowledgeNotebookId: "notebook-b",
  externalNotebookId: "notebook:external-b",
};

const requestA: TextSourceWriteRequest = {
  title: "Fixture source",
  content: "Synthetic content for a write-intent ledger test.",
};

const roots: string[] = [];
const ledgers: ResearchWriteLedger[] = [];

const moduleUrl = new URL("./research-write-ledger.ts", import.meta.url).href;

async function ledgerFixture(): Promise<{ root: string; dbPath: string }> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "knowledge-write-ledger-"));
  roots.push(root);
  return { root, dbPath: path.join(root, "ledger.sqlite") };
}

function open(dbPath: string): ResearchWriteLedger {
  const ledger = new ResearchWriteLedger(dbPath);
  ledgers.push(ledger);
  return ledger;
}

afterEach(async () => {
  for (const ledger of ledgers.splice(0)) ledger.close();
  for (const root of roots.splice(0)) await fs.rm(root, { recursive: true, force: true });
});

describe("durable Knowledge research write ledger", () => {
  it("serializes simultaneous begin calls from two real Node worker processes", async () => {
    const fixture = await ledgerFixture();
    const startFile = path.join(fixture.root, "start.signal");
    const workerCode = `
      import fs from "node:fs/promises";
      const { ResearchWriteLedger } = await import(${JSON.stringify(moduleUrl)});
      while (true) { try { await fs.access(process.env.START_FILE); break; } catch { await new Promise((resolve) => setTimeout(resolve, 2)); } }
      const ledger = new ResearchWriteLedger(process.env.DB_PATH);
      const result = ledger.begin(JSON.parse(process.env.SCOPE), process.env.KEY, JSON.parse(process.env.REQUEST));
      process.stdout.write(JSON.stringify({ kind: result.kind, state: result.intent?.state ?? null }));
      ledger.close();
    `;
    const environment = {
      ...process.env,
      DB_PATH: fixture.dbPath,
      START_FILE: startFile,
      KEY: "process-contention-key",
      SCOPE: JSON.stringify(scopeA),
      REQUEST: JSON.stringify(requestA),
    };
    const runWorker = () => new Promise<{ code: number | null; output: string }>((resolve, reject) => {
      const child = spawn(process.execPath, ["--import", "tsx/esm", "--input-type=module", "-e", workerCode], {
        cwd: path.dirname(fileURLToPath(import.meta.url)),
        env: environment,
        stdio: ["ignore", "pipe", "pipe"],
      });
      let output = "";
      let error = "";
      child.stdout.on("data", (chunk) => { output += String(chunk); });
      child.stderr.on("data", (chunk) => { error += String(chunk); });
      child.on("error", reject);
      child.on("close", (code) => code === 0 ? resolve({ code, output }) : reject(new Error(error || `worker exited ${String(code)}`)));
    });
    const first = runWorker();
    const second = runWorker();
    await new Promise((resolve) => setTimeout(resolve, 100));
    await fs.writeFile(startFile, "go", { mode: 0o600 });
    const results = await Promise.all([first, second]);
    const kinds = results.map((result) => JSON.parse(result.output).kind).sort();
    expect(kinds).toEqual(["claimed", "reconciliation_required"]);
  });

  it("claims once across two SQLite instances and replays the terminal success", async () => {
    const fixture = await ledgerFixture();
    const first = open(fixture.dbPath);
    const second = open(fixture.dbPath);

    const claim = first.begin(scopeA, "research-001", requestA);
    expect(claim.kind).toBe("claimed");
    if (claim.kind !== "claimed") return;

    const competing = second.begin(scopeA, "research-001", requestA);
    expect(competing).toMatchObject({ kind: "reconciliation_required", intent: { state: "pending" } });
    const succeeded = first.succeed(scopeA, "research-001", claim.claimToken, "source:created-001");
    expect(succeeded).toMatchObject({ state: "succeeded", sourceId: "source:created-001", errorCode: null });

    const replay = second.begin(scopeA, "research-001", requestA);
    expect(replay).toMatchObject({
      kind: "replay",
      intent: { state: "succeeded", sourceId: "source:created-001", errorCode: null },
      result: { state: "succeeded", sourceId: "source:created-001" },
    });
  });

  it("persists pending and uncertain states across restart without authorizing resubmission", async () => {
    const fixture = await ledgerFixture();
    const first = open(fixture.dbPath);
    const pending = first.begin(scopeA, "research-pending", requestA);
    expect(pending.kind).toBe("claimed");
    if (pending.kind !== "claimed") return;
    first.close();
    ledgers.splice(ledgers.indexOf(first), 1);

    const restarted = open(fixture.dbPath);
    expect(restarted.begin(scopeA, "research-pending", requestA)).toMatchObject({ kind: "reconciliation_required", intent: { state: "pending" } });
    const uncertain = restarted.markUncertain(scopeA, "research-pending", pending.claimToken, "ambiguous_response");
    expect(uncertain.state).toBe("uncertain");
    restarted.close();
    ledgers.splice(ledgers.indexOf(restarted), 1);

    const reopened = open(fixture.dbPath);
    expect(reopened.begin(scopeA, "research-pending", requestA)).toMatchObject({ kind: "reconciliation_required", intent: { state: "uncertain", errorCode: "ambiguous_response" } });
    expect(reopened.get(scopeA, "research-pending")?.state).toBe("uncertain");
  });

  it("rejects changed body and changed mapping under the same principal/company key", async () => {
    const fixture = await ledgerFixture();
    const ledger = open(fixture.dbPath);
    const claim = ledger.begin(scopeA, "research-conflict", requestA);
    expect(claim.kind).toBe("claimed");
    expect(ledger.begin(scopeA, "research-conflict", { ...requestA, content: "changed content" })).toEqual({ kind: "conflict", code: "idempotency_conflict" });
    expect(ledger.begin({ ...scopeA, externalNotebookId: "notebook:external-other" }, "research-conflict", requestA)).toEqual({ kind: "conflict", code: "scope_conflict" });
    expect(ledger.begin({ ...scopeA, knowledgeNotebookId: "notebook:other" }, "research-conflict", requestA)).toEqual({ kind: "conflict", code: "scope_conflict" });
  });

  it("isolates identical idempotency keys by principal and company", async () => {
    const fixture = await ledgerFixture();
    const ledger = open(fixture.dbPath);
    const principalB = { ...scopeA, principalId: "principal-b" };
    const companyB = { ...scopeA, companyId: "company-b" };
    expect(ledger.begin(scopeA, "same-key", requestA).kind).toBe("claimed");
    expect(ledger.begin(principalB, "same-key", requestA).kind).toBe("claimed");
    expect(ledger.begin(companyB, "same-key", requestA).kind).toBe("claimed");
  });

  it("replays terminal rejection and never permits a second claim", async () => {
    const fixture = await ledgerFixture();
    const ledger = open(fixture.dbPath);
    const claim = ledger.begin(scopeA, "rejected-key", requestA);
    expect(claim.kind).toBe("claimed");
    if (claim.kind !== "claimed") return;
    const rejected = ledger.reject(scopeA, "rejected-key", claim.claimToken, "policy_denied");
    expect(rejected).toMatchObject({ state: "rejected", sourceId: null, errorCode: "policy_denied" });
    expect(ledger.begin(scopeA, "rejected-key", requestA)).toMatchObject({ kind: "replay", intent: { state: "rejected", errorCode: "policy_denied" }, result: { state: "rejected", errorCode: "policy_denied" } });
  });

  it("guards transitions by the original claim and rejects invalid transition order", async () => {
    const fixture = await ledgerFixture();
    const ledger = open(fixture.dbPath);
    const claim = ledger.begin(scopeA, "guarded-key", requestA);
    expect(claim.kind).toBe("claimed");
    if (claim.kind !== "claimed") return;

    expect(() => ledger.succeed(scopeA, "guarded-key", "wrong-claim", "source:wrong")).toThrowError(ResearchWriteLedgerError);
    expect(ledger.get(scopeA, "guarded-key")?.state).toBe("pending");
    ledger.markUncertain(scopeA, "guarded-key", claim.claimToken, "upstream_unavailable");
    ledger.succeed(scopeA, "guarded-key", claim.claimToken, "source:reconciled");
    expect(() => ledger.markUncertain(scopeA, "guarded-key", claim.claimToken, "ambiguous_response")).toThrowError(ResearchWriteLedgerError);
    expect(() => ledger.reject(scopeA, "guarded-key", claim.claimToken, "policy_denied")).toThrowError(ResearchWriteLedgerError);
  });

  it("rejects malformed scope, body, key, source, and error inputs without creating rows", async () => {
    const fixture = await ledgerFixture();
    const ledger = open(fixture.dbPath);
    expect(() => ledger.begin({ ...scopeA, companyId: "" }, "invalid-key", requestA)).toThrowError(ResearchWriteLedgerError);
    expect(() => ledger.begin({ ...scopeA, caller: "forged" } as never, "invalid-extra", requestA)).toThrowError(ResearchWriteLedgerError);
    expect(() => ledger.begin(scopeA, "", requestA)).toThrowError(ResearchWriteLedgerError);
    expect(() => ledger.begin(scopeA, "invalid key", requestA)).toThrowError(ResearchWriteLedgerError);
    expect(() => ledger.begin(scopeA, "invalid-body", { ...requestA, title: "" })).toThrowError(ResearchWriteLedgerError);
    expect(() => ledger.begin(scopeA, "invalid-extra-body", { ...requestA, secret: "forged" } as never)).toThrowError(ResearchWriteLedgerError);
    expect(() => ledger.begin(scopeA, "invalid-body-2", { ...requestA, content: "" })).toThrowError(ResearchWriteLedgerError);
    expect(() => ledger.begin(scopeA, "invalid-body-3", { ...requestA, content: "x".repeat(512 * 1024 + 1) })).toThrowError(ResearchWriteLedgerError);
    const claim = ledger.begin(scopeA, "valid-after-invalid", requestA);
    expect(claim.kind).toBe("claimed");
    if (claim.kind !== "claimed") return;
    expect(() => ledger.succeed(scopeA, "valid-after-invalid", claim.claimToken, "bad source id")).toThrowError(ResearchWriteLedgerError);
    expect(() => ledger.succeed(scopeA, "valid-after-invalid", claim.claimToken, "external:source-1")).toThrowError(ResearchWriteLedgerError);
    expect(() => ledger.markUncertain(scopeA, "valid-after-invalid", claim.claimToken, "not-a-safe-code" as never)).toThrowError(ResearchWriteLedgerError);
  });

  it("keeps the request hash limited to the fixed title/content body and does not expose content or claim tokens", async () => {
    const fixture = await ledgerFixture();
    const ledger = open(fixture.dbPath);
    const secretContent = "synthetic content, not a service credential";
    const claim = ledger.begin(scopeA, "hash-key", { title: "Hash title", content: secretContent });
    expect(claim.kind).toBe("claimed");
    if (claim.kind !== "claimed") return;
    expect(claim.intent.requestHash).toMatch(/^[a-f0-9]{64}$/u);
    expect(JSON.stringify(claim.intent)).not.toContain(secretContent);
    expect(JSON.stringify(claim.intent)).not.toContain(claim.claimToken);
  });

  it("refuses an existing non-ledger database and does not use an implicit path", async () => {
    const fixture = await ledgerFixture();
    const { DatabaseSync } = await import("node:sqlite");
    const db = new DatabaseSync(fixture.dbPath);
    db.exec("CREATE TABLE unrelated (id TEXT PRIMARY KEY)");
    db.close();
    expect(() => open(fixture.dbPath)).toThrowError(ResearchWriteLedgerError);
    expect(() => new ResearchWriteLedger("relative-ledger.sqlite")).toThrowError(ResearchWriteLedgerError);
  });

  it("creates the dedicated SQLite file with owner-only permissions", async () => {
    const fixture = await ledgerFixture();
    open(fixture.dbPath);
    const mode = (await fs.stat(fixture.dbPath)).mode & 0o777;
    expect(mode).toBe(0o600);
  });

  it("supports explicit company-separated scope records with the same local notebook label", async () => {
    const fixture = await ledgerFixture();
    const ledger = open(fixture.dbPath);
    const sameNotebookOtherCompany = { ...scopeB, knowledgeNotebookId: scopeA.knowledgeNotebookId };
    expect(ledger.begin(scopeA, "shared-label", requestA).kind).toBe("claimed");
    expect(ledger.begin(sameNotebookOtherCompany, "shared-label", requestA).kind).toBe("claimed");
  });
});
