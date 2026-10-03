import { createPublicKey, verify } from "node:crypto";
import { chmodSync, mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { expect, it } from "vitest";
import { KnowledgeInstanceClaim } from "./instance-claim.js";

it("signs only bounded metadata, retains identity across restart, and protects the private key", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "knowledge-claim-"));
  try {
    const signer = new KnowledgeInstanceClaim(dir);
    const input = { portalIssuer: "https://portal.example", nonce: "challenge_123456789", companyId: "fixture-a" };
    const result = signer.signChallenge(input, 100_000);
    const [header, payload, signature] = result.proof.split(".");
    expect(JSON.parse(Buffer.from(header!, "base64url").toString())).toEqual({ alg: "EdDSA", typ: "JWT" });
    expect(JSON.parse(Buffer.from(payload!, "base64url").toString())).toEqual({ typ: "tealbrick-app-claim", version: 1,
      aud: input.portalIssuer, nonce: input.nonce, companyId: input.companyId, instanceId: signer.instanceId, iat: 100, exp: 400 });
    expect(verify(null, Buffer.from(`${header}.${payload}`), createPublicKey({ key: result.publicJwk, format: "jwk" }), Buffer.from(signature!, "base64url"))).toBe(true);
    expect(result.publicJwk).not.toHaveProperty("d");
    expect(new KnowledgeInstanceClaim(dir).instanceId).toBe(signer.instanceId);
    expect(statSync(path.join(dir, "instance-claim-identity.json")).mode & 0o777).toBe(0o600);
    for (const changed of [{ ...input, extra: "forged" }, { ...input, nonce: "short" }, { ...input, portalIssuer: "https://portal.example/path" }, { ...input, companyId: "../other" }]) {
      expect(() => signer.signChallenge(changed)).toThrow();
    }
    chmodSync(path.join(dir, "instance-claim-identity.json"), 0o644);
    expect(() => new KnowledgeInstanceClaim(dir)).toThrow("Unsafe Knowledge claim identity storage");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
