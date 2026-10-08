import { generateKeyPairSync, randomBytes } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { wireKnowledgeContract, type KnowledgeContractWiring } from "./index.js";
import { PORTAL, fakePortalFetch, grantToken } from "./test-support.js";
import { loadKnowledgeManifest } from "./manifest.js";

const manifest = loadKnowledgeManifest();
const cleanup: (() => void | Promise<void>)[] = [];
afterEach(async () => { for (const task of cleanup.splice(0).reverse()) await task(); });

const INSTANCE_TOKEN = randomBytes(32).toString("hex");
const CODE = randomBytes(32).toString("base64url");

/** The kit endpoints and the emergency login behind a bare node server, with a fake Program and a fake Portal. */
async function boot(options: { env?: NodeJS.ProcessEnv; engine?: string; models?: boolean; emergency?: Parameters<typeof wireKnowledgeContract>[0]["emergency"] } = {}) {
  const dataDir = mkdtempSync(path.join(tmpdir(), "knowledge-control-"));
  const { privateKey } = generateKeyPairSync("ed25519");
  const jwk = privateKey.export({ format: "jwk" });
  const portal = fakePortalFetch(manifest, { [grantToken("a")]: { actions: ["read"] } });
  const wiring: KnowledgeContractWiring = wireKnowledgeContract({
    env: { TEALBRICK_TENANT_ID: PORTAL.tenantId, TEALBRICK_PORTAL_URL: PORTAL.url, TEALBRICK_DEPLOYMENT_ID: PORTAL.deploymentId, TEALBRICK_PORTAL_ORG_ID: PORTAL.orgId, TEALBRICK_EMERGENCY_CODE: CODE, ...options.env },
    config: { dataDir, memoryEngine: "gbrain", rulesBaseUrl: null, rulesAuthToken: null },
    program: {
      inject: async ({ url }) => ({
        statusCode: 200,
        json: () => (url === "/api/status" ? { sidecars: { gbrain: { status: options.engine ?? "online" } } } : { ok: true }),
      }),
    },
    settingsAuthority: "a".repeat(64),
    instanceToken: INSTANCE_TOKEN,
    identity: { instanceId: "11111111-1111-1111-1111-111111111111", publicJwk: { kty: "OKP", crv: "Ed25519", x: jwk.x! }, privateKey },
    fetch: portal.fetchImpl,
    ...(options.emergency ? { emergency: options.emergency } : {}),
  });
  const server: Server = createServer((req, res) => { void wiring.contract.control(req, res).then((handled) => { if (!handled) { res.writeHead(404); res.end(); } }); });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  cleanup.push(() => new Promise<void>((resolve) => server.close(() => resolve())), () => { wiring.close(); rmSync(dataDir, { recursive: true, force: true }); });
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  return { base, wiring, dataDir };
}

const instance = { authorization: `Bearer ${INSTANCE_TOKEN}` };
const legacy = { "x-knowledge-instance-token": INSTANCE_TOKEN };

describe("status reflects what the owner can act on", () => {
  it.each([
    ["online", "configured", { OPENAI_API_KEY: "sk-fixture-not-echoed" }],
    ["online", "needs-settings", {}],
    ["starting", "starting", { OPENAI_API_KEY: "sk-fixture-not-echoed" }],
    ["degraded", "unavailable", { OPENAI_API_KEY: "sk-fixture-not-echoed" }],
    ["degraded", "needs-settings", {}],
    ["disabled", "needs-settings", {}],
  ])("engine %s with %j models gives setup %s", async (engine, setup, env) => {
    const { base } = await boot({ engine, env });
    const answer = await (await fetch(`${base}/.well-known/tealbrick/status`, { headers: legacy })).json();
    expect(answer).toMatchObject({ app: "knowledge", setup, ok: setup === "configured" || setup === "needs-settings" });
    expect(JSON.stringify(answer)).not.toContain("sk-fixture");
  });
});

describe("emergency login (break-glass owner session)", () => {
  const login = (base: string, code: string, headers: Record<string, string> = {}) =>
    fetch(`${base}/auth/emergency`, { method: "POST", headers: { "content-type": "application/json", accept: "application/json", ...headers }, body: JSON.stringify({ code }) });

  it("is off without a code, and refuses a weak code at startup", async () => {
    const { base } = await boot({ env: { TEALBRICK_EMERGENCY_CODE: "" } });
    expect((await login(base, CODE)).status).toBe(404);
    expect(() => wireKnowledgeContract({
      env: { TEALBRICK_EMERGENCY_CODE: "short" }, config: { dataDir: tmpdir(), memoryEngine: "gbrain", rulesBaseUrl: null, rulesAuthToken: null },
      program: { inject: async () => ({ statusCode: 200, json: () => ({}) }) }, settingsAuthority: "a".repeat(64), instanceToken: INSTANCE_TOKEN,
      identity: { instanceId: "i", publicJwk: { kty: "OKP", crv: "Ed25519", x: "x" }, privateKey: generateKeyPairSync("ed25519").privateKey },
    })).toThrowError(/128 bits/);
  });

  it("mints one short owner session, with a banner, and audits it without the code", async () => {
    const { base, wiring, dataDir } = await boot();
    const answer = (await (await login(base, CODE)).json()) as { sessionToken: string; expiresAt: number; banner: string; owner?: boolean; bannerRequired?: boolean };
    expect(answer).toMatchObject({ owner: true, bannerRequired: true });
    expect(answer.banner).toMatch(/Emergency access/);
    expect(answer.expiresAt - Date.now()).toBeLessThanOrEqual(15 * 60_000 + 1000);
    const session = (await (await fetch(`${base}/auth/emergency/session`, { headers: { authorization: `Bearer ${answer.sessionToken}` } })).json()) as Record<string, unknown>;
    expect(session).toMatchObject({ active: true, bannerRequired: true });
    expect((await login(base, CODE, { authorization: `Bearer ${answer.sessionToken}` })).status).toBe(409);
    wiring.audit.close();
    const { DatabaseSync } = await import("node:sqlite");
    const db = new DatabaseSync(path.join(dataDir, "contract-audit.sqlite"));
    const rows = db.prepare("SELECT kind, operation, outcome FROM contract_audit").all();
    db.close();
    expect(rows).toEqual([{ kind: "emergency", operation: "emergency_login", outcome: "success" }, { kind: "emergency", operation: "emergency_login", outcome: "denied" }]);
  });

  it("rate-limits per client behind one trusted proxy, from the right-most forwarded address", async () => {
    const { base } = await boot();
    const from = (chain: string) => ({ "x-forwarded-for": chain });
    for (let attempt = 0; attempt < 5; attempt++) expect((await login(base, "wrong", from("203.0.113.1, 198.51.100.7"))).status).toBe(401);
    expect((await login(base, "wrong", from("203.0.113.1, 198.51.100.7"))).status).toBe(429);
    // A forged left-most address buys nothing; another client behind the same proxy is unaffected.
    expect((await login(base, "wrong", from("203.0.113.99, 198.51.100.7"))).status).toBe(429);
    expect((await login(base, "wrong", from("203.0.113.1, 198.51.100.8"))).status).toBe(401);
    expect((await login(base, CODE, from("203.0.113.1, 198.51.100.8"))).status).toBe(200);
  });

  it("still accepts the correct code while the global backstop of failed attempts is tripped", async () => {
    const { base } = await boot({ emergency: { rateLimit: { perClient: { max: 100, windowMs: 60_000 }, global: { max: 3, windowMs: 60_000 } } } });
    for (let attempt = 0; attempt < 3; attempt++) expect((await login(base, "wrong", { "x-forwarded-for": `198.51.100.${attempt}` })).status).toBe(401);
    expect((await login(base, "wrong", { "x-forwarded-for": "198.51.100.50" })).status).toBe(429);
    const owner = await login(base, CODE, { "x-forwarded-for": "198.51.100.60" });
    expect(owner.status).toBe(200);
    expect(((await owner.json()) as { owner: boolean }).owner).toBe(true);
  });

  it("an emergency session opens the settings endpoint; a settings bearer does not open the owner session", async () => {
    const { base, wiring } = await boot();
    const session = (await (await login(base, CODE)).json()) as { sessionToken: string };
    const settings = await fetch(`${base}/.well-known/tealbrick/settings`, { headers: { authorization: `Bearer ${session.sessionToken}` } });
    expect(settings.status).toBe(200);
    const issued = await wiring.contract.settingsSessions.issue({ subject: "owner", workspaceId: PORTAL.tenantId });
    expect((await fetch(`${base}/auth/emergency/session`, { headers: { authorization: `Bearer ${issued.bearer}` } })).status).toBe(200);
    expect(((await (await fetch(`${base}/auth/emergency/session`, { headers: { authorization: `Bearer ${issued.bearer}` } })).json()) as { active: boolean }).active).toBe(false);
  });
});

describe("claim", () => {
  it("serves one identity on both paths and pins the first issuer on the volume", async () => {
    const { base, dataDir } = await boot();
    const body = (issuer: string, nonce: string) => JSON.stringify({ portalIssuer: issuer, nonce, companyId: PORTAL.tenantId });
    const post = (route: string, headers: Record<string, string>, payload: string) => fetch(`${base}${route}`, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: payload });
    expect((await post("/api/tealbrick/claim", legacy, body("https://portal.fixture.invalid", "a".repeat(24)))).status).toBe(200);
    expect((await post("/.well-known/tealbrick/claim", instance, body("https://other.fixture.invalid", "b".repeat(24)))).status).toBe(409);
    const stored = JSON.parse((await import("node:fs")).readFileSync(path.join(dataDir, "contract-claim.json"), "utf8"));
    expect(stored).toMatchObject({ portalIssuer: "https://portal.fixture.invalid", tenantId: PORTAL.tenantId, instanceId: "11111111-1111-1111-1111-111111111111" });
    expect(JSON.stringify(stored)).not.toMatch(/"d":|privateJwk/);
  });
});
