import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { expect, it } from "vitest";
import { KnowledgeAuthorizationAudit } from "./authorization-audit.js";

it("persists bounded metadata and response outcomes across restart with protected permissions", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "knowledge-audit-"));
  const filename = path.join(dir, "audit.sqlite");
  try {
    let audit = new KnowledgeAuthorizationAudit(filename, 3);
    for (let i = 0; i < 8; i++) {
      const id = audit.record({ principalId: "aura", partitionKey: "fixture-a", method: "PATCH",
        route: "/api/knowledge/documents/:documentId", capability: "knowledge:update", decision: "admitted" });
      audit.complete(id, 200);
    }
    audit.close();
    audit = new KnowledgeAuthorizationAudit(filename, 3);
    audit.close();
    const db = new DatabaseSync(filename, { readOnly: true });
    try {
      const rows = db.prepare("SELECT * FROM authorization_audit").all();
      expect(rows).toHaveLength(3);
      expect(rows[0]).toMatchObject({ principal_id: "aura", partition_key: "fixture-a", response_status: 200 });
      expect(Object.keys(rows[0]!)).not.toEqual(expect.arrayContaining(["body", "token", "query", "headers"]));
    } finally { db.close(); }
    expect(statSync(filename).mode & 0o777).toBe(0o600);
    expect(readFileSync(filename).length).toBeLessThan(100_000);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
