import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

import type { KnowledgeStorePersistence, KnowledgeStoreSnapshot } from "./store.js";

interface SnapshotRow {
  readonly value: string;
}

export class SqliteKnowledgePersistence implements KnowledgeStorePersistence {
  private readonly db: DatabaseSync;

  constructor(private readonly dbPath: string) {
    fs.mkdirSync(path.dirname(dbPath), { recursive: true });
    this.db = new DatabaseSync(dbPath);
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA foreign_keys = ON;
      CREATE TABLE IF NOT EXISTS knowledge_snapshots (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
    `);
  }

  load(): KnowledgeStoreSnapshot | null {
    const row = this.db
      .prepare("SELECT value FROM knowledge_snapshots WHERE key = ?")
      .get("store") as SnapshotRow | undefined;
    if (!row) {
      return null;
    }
    const parsed = JSON.parse(row.value) as KnowledgeStoreSnapshot;
    if (parsed.version !== 1) {
      throw new Error(`Unsupported Knowledge database snapshot version: ${String(parsed.version)}`);
    }
    return parsed;
  }

  save(snapshot: KnowledgeStoreSnapshot): void {
    this.db
      .prepare(
        `INSERT INTO knowledge_snapshots (key, value, updated_at)
         VALUES (?, ?, ?)
         ON CONFLICT(key) DO UPDATE SET
           value = excluded.value,
           updated_at = excluded.updated_at`,
      )
      .run("store", JSON.stringify(snapshot), new Date().toISOString());
  }

  close(): void {
    this.db.close();
  }

  describe(): Record<string, unknown> {
    return {
      kind: "sqlite",
      path: this.dbPath,
    };
  }
}
