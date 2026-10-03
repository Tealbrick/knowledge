import Fastify, { type FastifyInstance } from "fastify";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createKnowledgePrincipalResolver,
  type KnowledgeServicePrincipalBinding,
} from "./knowledge-principal.js";
import {
  RESEARCH_BROWSER_SESSION_COOKIE,
  ResearchBrowserSessionAuthority,
  ResearchBrowserSessionError,
} from "./research-browser-session.js";
import { buildKnowledgeApp } from "./app.js";
import { classifyKnowledgeOperation } from "./policy.js";

const principal: KnowledgeServicePrincipalBinding = {
  token: "browser-service-token",
  principalId: "browser-operator-principal",
  companyId: "company-alpha",
  capabilities: ["research:read", "research:write"],
};
const secret = "browser-operator-secret-that-is-at-least-32-bytes";
const origin = "http://127.0.0.1:5310";
const host = "127.0.0.1:5310";

function resolver() {
  return createKnowledgePrincipalResolver([principal]);
}

function headers(cookie?: string, extra: Record<string, string> = {}) {
  return {
    host,
    origin,
    "sec-fetch-site": "same-origin",
    ...(cookie ? { cookie } : {}),
    ...extra,
  };
}

function cookieValue(setCookie: string): string {
  return setCookie.slice(`${RESEARCH_BROWSER_SESSION_COOKIE}=`.length).split(";", 1)[0]!;
}

function authority(options: ConstructorParameters<typeof ResearchBrowserSessionAuthority>[1] = {}) {
  return new ResearchBrowserSessionAuthority({
    operatorSecret: secret,
    principalId: principal.principalId,
    origin,
    principals: resolver(),
  }, options);
}

describe("Research browser session authority", () => {
  it("issues an opaque host-only cookie and exposes only the public principal", () => {
    const session = authority();
    const result = session.login(secret, headers());
    expect(result.setCookie).toContain(`${RESEARCH_BROWSER_SESSION_COOKIE}=`);
    expect(result.setCookie).toContain("HttpOnly");
    expect(result.setCookie).toContain("SameSite=Strict");
    expect(result.setCookie).toContain("Path=/api/research");
    expect(result.setCookie).not.toContain("Domain=");
    expect(result.setCookie).not.toContain(secret);
    expect(result.status).toMatchObject({
      enabled: true,
      authenticated: true,
      principal: { principalId: principal.principalId, companyId: principal.companyId, capabilities: principal.capabilities },
    });
    expect(result.status.csrfToken).toBeTruthy();
    const status = session.status(headers(`${RESEARCH_BROWSER_SESSION_COOKIE}=${cookieValue(result.setCookie)}`));
    expect(status).toEqual(result.status);
  });

  it.each([
    ["short secret", { operatorSecret: "too-short" }],
    ["whitespace secret", { operatorSecret: " ".repeat(32) }],
    ["long secret", { operatorSecret: "x".repeat(1025) }],
    ["non-loopback http", { origin: "http://example.com:5310" }],
    ["origin path", { origin: "http://127.0.0.1:5310/research" }],
  ] as const)("fails closed for invalid %s", (_label, override) => {
    const values = override as { readonly operatorSecret?: string; readonly origin?: string };
    expect(() => new ResearchBrowserSessionAuthority({
      operatorSecret: values.operatorSecret ?? secret,
      principalId: principal.principalId,
      origin: values.origin ?? origin,
      principals: resolver(),
    })).toThrow(ResearchBrowserSessionError);
  });

  it("requires an existing principal and re-resolves it for revocation", () => {
    const configured = resolver();
    expect(() => new ResearchBrowserSessionAuthority({ operatorSecret: secret, principalId: "missing", origin, principals: configured })).toThrow();
    let revoked = false;
    const revocable = {
      configured: true,
      resolve: configured.resolve,
      resolveById: (id: string | null | undefined) => revoked ? null : configured.resolveById?.(id) ?? null,
    };
    const session = new ResearchBrowserSessionAuthority({ operatorSecret: secret, principalId: principal.principalId, origin, principals: revocable });
    const result = session.login(secret, headers());
    const cookie = `${RESEARCH_BROWSER_SESSION_COOKIE}=${cookieValue(result.setCookie)}`;
    revoked = true;
    expect(session.status(headers(cookie)).authenticated).toBe(false);
    expect(() => session.authenticate(headers(cookie), "GET")).toThrow("browser_session_invalid");
  });

  it("rejects wrong origin, host, fetch site, duplicate cookies, and CSRF", () => {
    const session = authority();
    expect(() => session.login(secret, headers(undefined, { origin: "http://evil.example" }))).toThrow("browser_session_origin_denied");
    expect(() => session.login(secret, headers(undefined, { host: "evil.example" }))).toThrow("browser_session_host_denied");
    expect(() => session.login(secret, headers(undefined, { "sec-fetch-site": "cross-site" }))).toThrow("browser_session_fetch_site_denied");
    expect(() => session.status(headers(undefined, { origin: "http://evil.example" }))).toThrow("browser_session_origin_denied");
    expect(() => session.status(headers(undefined, { host: "evil.example" }))).toThrow("browser_session_host_denied");
    expect(session.status({ host }).authenticated).toBe(false);
    const result = session.login(secret, headers());
    const value = cookieValue(result.setCookie);
    const cookie = `${RESEARCH_BROWSER_SESSION_COOKIE}=${value}`;
    expect(() => session.authenticate(headers(`${cookie}; ${cookie}`), "GET")).toThrow("browser_session_invalid");
    expect(() => session.authenticate(headers(cookie), "POST")).toThrow("browser_session_csrf_required");
    expect(() => session.logout(headers(cookie, { "x-csrf-token": "wrong" }))).toThrow("browser_session_csrf_required");
    expect(() => session.logout(headers(cookie, { origin: "http://evil.example", "x-csrf-token": result.status.csrfToken! }))).toThrow("browser_session_origin_denied");
    expect(session.logout(headers(cookie, { "x-csrf-token": result.status.csrfToken! })).authenticated).toBe(false);
  });

  it("uses a global login rate limit rather than caller IP headers", () => {
    const session = authority({ loginMaxAttempts: 2 });
    for (let attempt = 0; attempt < 2; attempt += 1) {
      expect(() => session.login("wrong", headers(undefined, { "x-forwarded-for": `198.51.100.${attempt}` }))).toThrow("browser_session_login_failed");
    }
    expect(() => session.login(secret, headers(undefined, { "x-forwarded-for": "203.0.113.9" }))).toThrow("browser_session_rate_limited");
  });

  it("expires sessions and bounds the session store", () => {
    vi.useFakeTimers();
    try {
      const session = authority({ ttlMs: 1_000, maxSessions: 2 });
      const first = session.login(secret, headers());
      vi.advanceTimersByTime(1_001);
      expect(session.status(headers(`${RESEARCH_BROWSER_SESSION_COOKIE}=${cookieValue(first.setCookie)}`)).authenticated).toBe(false);
      vi.setSystemTime(new Date("2026-09-06T12:00:00Z"));
      const one = session.login(secret, headers());
      const two = session.login(secret, headers());
      const three = session.login(secret, headers());
      expect(session.status(headers(`${RESEARCH_BROWSER_SESSION_COOKIE}=${cookieValue(one.setCookie)}`)).authenticated).toBe(false);
      expect(session.status(headers(`${RESEARCH_BROWSER_SESSION_COOKIE}=${cookieValue(two.setCookie)}`)).authenticated).toBe(true);
      expect(session.status(headers(`${RESEARCH_BROWSER_SESSION_COOKIE}=${cookieValue(three.setCookie)}`)).authenticated).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("Knowledge Program browser session routes", () => {
  let app: FastifyInstance | undefined;

  afterEach(async () => {
    await app?.close();
    app = undefined;
  });

  it("fails startup for incomplete browser configuration instead of silently disabling it", async () => {
    await expect(buildKnowledgeApp({
      environment: "test",
      config: {
        gbrainAutoStart: false,
        gbrainBaseUrl: null,
        gbrainToken: null,
        knowledgeDatabasePath: null,
        knowledgeServicePrincipals: [principal],
        browserOperatorSecret: secret,
        browserPrincipalId: null,
        browserOrigin: null,
      },
    })).rejects.toThrow("Invalid Knowledge browser session configuration");
  });

  it("fails startup when the browser secret reuses a configured service credential", async () => {
    const serviceToken = "service-token-that-is-long-enough-for-a-browser-secret";
    await expect(buildKnowledgeApp({
      environment: "test",
      config: {
        gbrainAutoStart: false,
        gbrainBaseUrl: null,
        gbrainToken: null,
        openNotebookBaseUrl: null,
        openNotebookToken: null,
        knowledgeDatabasePath: null,
        knowledgeServicePrincipals: [{ ...principal, token: serviceToken }],
        browserOperatorSecret: serviceToken,
        browserPrincipalId: principal.principalId,
        browserOrigin: origin,
      },
    })).rejects.toThrow("Invalid Knowledge browser session configuration");
  });

  it("exposes strict status/login/logout without service credentials and tightens Research response headers", async () => {
    app = await buildKnowledgeApp({
      environment: "test",
      config: {
        gbrainAutoStart: false,
        gbrainBaseUrl: null,
        gbrainToken: null,
        openNotebookBaseUrl: null,
        openNotebookToken: null,
        knowledgeDatabasePath: null,
        knowledgeServicePrincipals: [principal],
        browserOperatorSecret: secret,
        browserPrincipalId: principal.principalId,
        browserOrigin: origin,
      },
    });
    const initial = await app.inject({ method: "GET", url: "/api/research/browser-session", headers: headers() });
    expect(initial.statusCode).toBe(200);
    expect(initial.headers["cache-control"]).toBe("no-store");
    expect(initial.json()).toEqual({ enabled: true, authenticated: false, principal: null, csrfToken: null, expiresAt: null });

    const wrongOriginStatus = await app.inject({ method: "GET", url: "/api/research/browser-session", headers: headers(undefined, { origin: "http://evil.example" }) });
    expect(wrongOriginStatus.statusCode).toBe(403);
    expect(wrongOriginStatus.headers["cache-control"]).toBe("no-store");
    const wrongHostStatus = await app.inject({ method: "GET", url: "/api/research/browser-session", headers: headers(undefined, { host: "evil.example" }) });
    expect(wrongHostStatus.statusCode).toBe(403);
    expect(wrongHostStatus.headers["cache-control"]).toBe("no-store");
    const invalidCookieStatus = await app.inject({ method: "GET", url: "/api/research/browser-session", headers: headers(`${RESEARCH_BROWSER_SESSION_COOKIE}=not-a-valid-session`) });
    expect(invalidCookieStatus.statusCode).toBe(200);
    expect(invalidCookieStatus.headers["cache-control"]).toBe("no-store");

    const badBody = await app.inject({ method: "POST", url: "/api/research/browser-session", headers: headers(), payload: { secret, extra: "reject" } });
    expect(badBody.statusCode).toBe(400);
    const oversizedBody = await app.inject({
      method: "POST",
      url: "/api/research/browser-session",
      headers: { ...headers(), "content-type": "application/json" },
      payload: `{"secret":"${"x".repeat(4100)}"}`,
    });
    expect(oversizedBody.statusCode).toBe(413);
    expect(oversizedBody.headers["cache-control"]).toBe("no-store");
    const login = await app.inject({ method: "POST", url: "/api/research/browser-session", headers: headers(), payload: { secret } });
    expect(login.statusCode).toBe(200);
    expect(login.headers["access-control-allow-origin"]).toBeUndefined();
    const setCookie = login.headers["set-cookie"];
    const cookie = (Array.isArray(setCookie) ? setCookie[0] : setCookie)?.split(";", 1)[0];
    expect(cookie).toBeTruthy();
    expect(login.body).not.toContain(principal.token);
    expect(login.body).not.toContain(secret);

    const csrf = login.json().csrfToken as string;
    const logout = await app.inject({ method: "DELETE", url: "/api/research/browser-session", headers: headers(cookie, { "x-csrf-token": csrf }) });
    expect(logout.statusCode).toBe(200);
    expect(logout.json()).toMatchObject({ enabled: true, authenticated: false, csrfToken: null });
    expect(logout.headers["set-cookie"]).toContain("Max-Age=0");

    const shell = await app.inject({ method: "GET", url: "/" });
    expect(shell.headers["content-security-policy"]).toContain("frame-ancestors 'self'");
    const engine = await app.inject({ method: "GET", url: "/api/research/notebooks/notebook:alpha/engine" });
    expect(engine.headers["access-control-allow-origin"]).toBeUndefined();
  });

  it("does not classify browser session lifecycle as a Rules domain operation", () => {
    expect(classifyKnowledgeOperation({ method: "GET", pathname: "/api/research/browser-session" })).toBeNull();
    expect(classifyKnowledgeOperation({ method: "POST", pathname: "/api/research/browser-session" })).toBeNull();
    expect(classifyKnowledgeOperation({ method: "DELETE", pathname: "/api/research/browser-session" })).toBeNull();
    expect(classifyKnowledgeOperation({ method: "GET", pathname: "/api/research/notebooks/notebook:alpha/engine" })).not.toBeNull();
  });
});
