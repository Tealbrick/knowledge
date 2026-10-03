import { createPrivateKey, createPublicKey, generateKeyPairSync, randomUUID, sign, type KeyObject, type JsonWebKey } from "node:crypto";
import { existsSync, lstatSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { normalizeKnowledgePartitionKey } from "./partition-authority.js";

/** Operator-only proof of app control. Never an entitlement or agent authorization. */
export class KnowledgeInstanceClaim {
  readonly instanceId: string;
  readonly publicJwk: JsonWebKey;
  private readonly key: KeyObject;

  constructor(dataDir: string) {
    mkdirSync(dataDir, { recursive: true, mode: 0o700 });
    const filename = path.join(dataDir, "instance-claim-identity.json");
    if (!existsSync(filename)) {
      const { privateKey } = generateKeyPairSync("ed25519");
      writeFileSync(filename, JSON.stringify({ version: 1, instanceId: randomUUID(), privateJwk: privateKey.export({ format: "jwk" }) }), { mode: 0o600, flag: "wx" });
    }
    const stat = lstatSync(filename);
    if (!stat.isFile() || (stat.mode & 0o077) !== 0 || stat.size > 16_384) throw new Error("Unsafe Knowledge claim identity storage");
    try {
      const identity = JSON.parse(readFileSync(filename, "utf8"));
      if (identity.version !== 1 || !/^[a-f0-9-]{36}$/u.test(identity.instanceId) || identity.privateJwk?.crv !== "Ed25519") throw new Error();
      this.key = createPrivateKey({ key: identity.privateJwk, format: "jwk" });
      this.instanceId = identity.instanceId;
      this.publicJwk = createPublicKey(this.key).export({ format: "jwk" });
    } catch { throw new Error("Invalid Knowledge claim identity storage"); }
  }

  signChallenge(input: unknown, now = Date.now()) {
    if (!input || typeof input !== "object" || Array.isArray(input)) throw new Error("invalid_claim_challenge");
    const value = input as Record<string, unknown>;
    if (Object.keys(value).sort().join(",") !== "companyId,nonce,portalIssuer") throw new Error("invalid_claim_challenge");
    if (typeof value.portalIssuer !== "string" || typeof value.nonce !== "string" || !/^[A-Za-z0-9_-]{16,256}$/u.test(value.nonce)) throw new Error("invalid_claim_challenge");
    const issuer = new URL(value.portalIssuer);
    if (issuer.origin !== value.portalIssuer || issuer.username || issuer.password ||
      (issuer.protocol !== "https:" && !(issuer.protocol === "http:" && ["127.0.0.1", "localhost", "[::1]"].includes(issuer.hostname)))) throw new Error("invalid_claim_challenge");
    const companyId = normalizeKnowledgePartitionKey(value.companyId);
    if (!companyId || companyId !== value.companyId) throw new Error("invalid_claim_challenge");
    const iat = Math.floor(now / 1000);
    const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");
    const content = `${encode({ alg: "EdDSA", typ: "JWT" })}.${encode({
      typ: "tealbrick-app-claim", version: 1, aud: issuer.origin, nonce: value.nonce,
      instanceId: this.instanceId, companyId, iat, exp: iat + 300,
    })}`;
    return { proof: `${content}.${sign(null, Buffer.from(content), this.key).toString("base64url")}`,
      publicJwk: this.publicJwk, instanceId: this.instanceId, companyId };
  }
}
