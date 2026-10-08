import { chmodSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";

import type { ClaimStore } from "@tealbrick/contract";

/**
 * Durable claim binding: the first claim pins the Portal issuer and tenant (refused rebinding survives restarts).
 * The identity key itself stays in instance-claim-identity.json (KnowledgeInstanceClaim); this file holds no key.
 */
export function createFileClaimStore(dataDir: string): ClaimStore {
  const file = path.join(dataDir, "contract-claim.json");
  return {
    read() {
      try { return JSON.parse(readFileSync(file, "utf8")); } catch { return null; }
    },
    write(binding) {
      mkdirSync(dataDir, { recursive: true, mode: 0o700 });
      const temporary = `${file}.${process.pid}.${randomUUID()}.tmp`;
      writeFileSync(temporary, `${JSON.stringify(binding)}\n`, { mode: 0o600 });
      renameSync(temporary, file);
      try { chmodSync(file, 0o600); } catch { /* best effort */ }
    },
  };
}
