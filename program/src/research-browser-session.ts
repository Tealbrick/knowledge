import { createHash, randomBytes, timingSafeEqual } from "node:crypto";

import type {
  KnowledgePrincipalResolver,
  KnowledgeServicePrincipal,
} from "./knowledge-principal.js";

export const RESEARCH_BROWSER_SESSION_COOKIE = "knowledge_research_session";
export const RESEARCH_BROWSER_SESSION_TTL_MS = 60 * 60 * 1000;
export const RESEARCH_BROWSER_SESSION_MAX = 32;
export const RESEARCH_BROWSER_LOGIN_WINDOW_MS = 60 * 1000;
export const RESEARCH_BROWSER_LOGIN_MAX_ATTEMPTS = 8;

const SECRET_MIN_BYTES = 32;
const SECRET_MAX_BYTES = 1024;
const MAX_COOKIE_BYTES = 128;
const MAX_CSRF_BYTES = 128;
const SESSION_ID_BYTES = 32;
const CSRF_TOKEN_BYTES = 32;

export interface ResearchBrowserSessionConfig {
  readonly operatorSecret: string;
  readonly principalId: string;
  readonly origin: string;
  readonly principals: KnowledgePrincipalResolver;
}

export interface ResearchBrowserRequestHeaders {
  readonly [key: string]: string | readonly string[] | undefined;
}

export interface ResearchBrowserSessionPrincipal {
  readonly principalId: string;
  readonly companyId: string;
  readonly capabilities: readonly string[];
}

export interface ResearchBrowserSessionStatus {
  readonly enabled: true;
  readonly authenticated: boolean;
  readonly principal: ResearchBrowserSessionPrincipal | null;
  readonly csrfToken: string | null;
  readonly expiresAt: string | null;
}

export interface ResearchBrowserLoginResult {
  readonly status: ResearchBrowserSessionStatus;
  readonly setCookie: string;
}

export type ResearchBrowserSessionErrorCode =
  | "browser_session_invalid_config"
  | "browser_session_authority_unavailable"
  | "browser_session_invalid"
  | "browser_session_origin_denied"
  | "browser_session_host_denied"
  | "browser_session_fetch_site_denied"
  | "browser_session_csrf_required"
  | "browser_session_rate_limited"
  | "browser_session_login_failed";

export class ResearchBrowserSessionError extends Error {
  readonly code: ResearchBrowserSessionErrorCode;

  constructor(code: ResearchBrowserSessionErrorCode) {
    super(code);
    this.name = "ResearchBrowserSessionError";
    this.code = code;
  }
}

interface StoredSession {
  readonly sessionDigest: Buffer;
  readonly csrfDigest: Buffer;
  readonly principalId: string;
  readonly issuedAt: number;
  readonly expiresAt: number;
  readonly csrfToken: string;
}

interface BrowserOrigin {
  readonly origin: string;
  readonly host: string;
  readonly secure: boolean;
}

type CookieState =
  | { readonly kind: "missing" }
  | { readonly kind: "invalid" }
  | { readonly kind: "value"; readonly value: string };

function digest(value: string): Buffer {
  return createHash("sha256").update(value, "utf8").digest();
}

function equalDigest(left: Buffer, right: Buffer): boolean {
  return left.length === right.length && timingSafeEqual(left, right);
}

function byteLength(value: string): number {
  return Buffer.byteLength(value, "utf8");
}

function snapshotPrincipal(value: KnowledgeServicePrincipal): KnowledgeServicePrincipal {
  return Object.freeze({
    kind: "service",
    principalId: value.principalId,
    companyId: value.companyId,
    capabilities: Object.freeze([...value.capabilities]),
    ...(value.partitionGrants
      ? { partitionGrants: Object.freeze(value.partitionGrants.map((grant) => Object.freeze({
          ...grant,
          ...(grant.capabilities ? { capabilities: Object.freeze([...grant.capabilities]) } : {}),
        }))) }
      : {}),
  });
}

function publicPrincipal(value: KnowledgeServicePrincipal): ResearchBrowserSessionPrincipal {
  return Object.freeze({
    principalId: value.principalId,
    companyId: value.companyId,
    capabilities: Object.freeze([...value.capabilities]),
  });
}

function headerValue(headers: ResearchBrowserRequestHeaders, name: string): string | null {
  const value = headers[name.toLowerCase()];
  if (Array.isArray(value)) {
    return value.length === 1 && typeof value[0] === "string" ? value[0].trim() : null;
  }
  return typeof value === "string" ? value.trim() : null;
}

function hasHeader(headers: ResearchBrowserRequestHeaders, name: string): boolean {
  return Object.prototype.hasOwnProperty.call(headers, name.toLowerCase());
}

function normalizeOrigin(value: string): BrowserOrigin {
  if (typeof value !== "string" || !value || value !== value.trim()) {
    throw new ResearchBrowserSessionError("browser_session_invalid_config");
  }
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new ResearchBrowserSessionError("browser_session_invalid_config");
  }
  if (
    parsed.origin !== value ||
    parsed.username ||
    parsed.password ||
    parsed.pathname !== "/" ||
    parsed.search ||
    parsed.hash ||
    !parsed.host
  ) {
    throw new ResearchBrowserSessionError("browser_session_invalid_config");
  }
  const hostname = parsed.hostname.toLowerCase();
  const isLoopback = hostname === "127.0.0.1" || hostname === "localhost" || hostname === "[::1]" || hostname === "::1";
  if (parsed.protocol === "http:" && !isLoopback) {
    throw new ResearchBrowserSessionError("browser_session_invalid_config");
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new ResearchBrowserSessionError("browser_session_invalid_config");
  }
  return Object.freeze({ origin: parsed.origin, host: parsed.host, secure: parsed.protocol === "https:" });
}

function parseCookie(headers: ResearchBrowserRequestHeaders): CookieState {
  if (!hasHeader(headers, "cookie")) return { kind: "missing" };
  const raw = headers.cookie;
  if (Array.isArray(raw) || typeof raw !== "string" || byteLength(raw) > 4096) {
    return { kind: "invalid" };
  }
  let found: string | null = null;
  for (const part of raw.split(";")) {
    const trimmedPart = part.trim();
    const separator = part.indexOf("=");
    if (separator <= 0) {
      if (trimmedPart === RESEARCH_BROWSER_SESSION_COOKIE) return { kind: "invalid" };
      continue;
    }
    const name = part.slice(0, separator).trim();
    const value = part.slice(separator + 1).trim();
    if (name !== RESEARCH_BROWSER_SESSION_COOKIE) continue;
    if (found !== null || !value || byteLength(value) > MAX_COOKIE_BYTES || !/^[A-Za-z0-9_-]+$/u.test(value)) {
      return { kind: "invalid" };
    }
    found = value;
  }
  return found === null ? { kind: "missing" } : { kind: "value", value: found };
}

function sessionStatus(
  principal: KnowledgeServicePrincipal | null,
  session: StoredSession | null,
): ResearchBrowserSessionStatus {
  return {
    enabled: true,
    authenticated: principal !== null && session !== null,
    principal: principal ? publicPrincipal(principal) : null,
    csrfToken: session?.csrfToken ?? null,
    expiresAt: session ? new Date(session.expiresAt).toISOString() : null,
  };
}

export class ResearchBrowserSessionAuthority {
  readonly enabled = true;
  readonly origin: string;
  readonly host: string;
  readonly secure: boolean;

  private readonly operatorSecretDigest: Buffer;
  private readonly principalId: string;
  private readonly principals: KnowledgePrincipalResolver;
  private readonly sessions = new Map<string, StoredSession>();
  private readonly ttlMs: number;
  private readonly maxSessions: number;
  private readonly loginWindowMs: number;
  private readonly loginMaxAttempts: number;
  private loginWindowStarted = 0;
  private loginAttempts = 0;

  constructor(
    config: ResearchBrowserSessionConfig,
    options: {
      readonly ttlMs?: number;
      readonly maxSessions?: number;
      readonly loginWindowMs?: number;
      readonly loginMaxAttempts?: number;
    } = {},
  ) {
    if (
      typeof config.operatorSecret !== "string" ||
      Array.from(config.operatorSecret).length < SECRET_MIN_BYTES ||
      byteLength(config.operatorSecret) > SECRET_MAX_BYTES ||
      !config.operatorSecret.trim() ||
      typeof config.principalId !== "string" ||
      !config.principalId.trim() ||
      !config.principals?.configured ||
      typeof config.principals.resolveById !== "function"
    ) {
      throw new ResearchBrowserSessionError("browser_session_invalid_config");
    }
    const browserOrigin = normalizeOrigin(config.origin);
    let configuredPrincipal: KnowledgeServicePrincipal | null;
    try {
      configuredPrincipal = config.principals.resolveById(config.principalId);
    } catch {
      throw new ResearchBrowserSessionError("browser_session_authority_unavailable");
    }
    if (!configuredPrincipal || configuredPrincipal.kind !== "service" || configuredPrincipal.principalId !== config.principalId) {
      throw new ResearchBrowserSessionError("browser_session_invalid_config");
    }
    this.operatorSecretDigest = digest(config.operatorSecret);
    this.principalId = config.principalId;
    this.principals = config.principals;
    this.origin = browserOrigin.origin;
    this.host = browserOrigin.host;
    this.secure = browserOrigin.secure;
    this.ttlMs = this.validBound(options.ttlMs ?? RESEARCH_BROWSER_SESSION_TTL_MS, 1_000, 24 * 60 * 60 * 1000);
    this.maxSessions = this.validBound(options.maxSessions ?? RESEARCH_BROWSER_SESSION_MAX, 1, RESEARCH_BROWSER_SESSION_MAX);
    this.loginWindowMs = this.validBound(options.loginWindowMs ?? RESEARCH_BROWSER_LOGIN_WINDOW_MS, 1_000, 60 * 60 * 1000);
    this.loginMaxAttempts = this.validBound(options.loginMaxAttempts ?? RESEARCH_BROWSER_LOGIN_MAX_ATTEMPTS, 1, 100);
  }

  private validBound(value: number, minimum: number, maximum: number): number {
    if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
      throw new ResearchBrowserSessionError("browser_session_invalid_config");
    }
    return value;
  }

  private cleanup(now = Date.now()): void {
    for (const [key, session] of this.sessions) {
      if (session.expiresAt <= now) this.sessions.delete(key);
    }
  }

  private currentPrincipal(): KnowledgeServicePrincipal | null {
    try {
      const principal = this.principals.resolveById?.(this.principalId) ?? null;
      if (!principal || principal.kind !== "service" || principal.principalId !== this.principalId) return null;
      return snapshotPrincipal(principal);
    } catch {
      return null;
    }
  }

  private sessionFor(headers: ResearchBrowserRequestHeaders): { state: CookieState; session: StoredSession | null } {
    this.cleanup();
    const state = parseCookie(headers);
    if (state.kind !== "value") return { state, session: null };
    const key = digest(state.value).toString("hex");
    const session = this.sessions.get(key) ?? null;
    if (!session || session.expiresAt <= Date.now()) {
      this.sessions.delete(key);
      return { state: { kind: "invalid" }, session: null };
    }
    return { state, session };
  }

  private assertRequestOrigin(headers: ResearchBrowserRequestHeaders, method: string, requireOrigin: boolean): void {
    const origin = headerValue(headers, "origin");
    const host = headerValue(headers, "host");
    const fetchSite = headerValue(headers, "sec-fetch-site");
    if ((hasHeader(headers, "origin") && origin === null) || (hasHeader(headers, "host") && host === null) || (hasHeader(headers, "sec-fetch-site") && fetchSite === null)) {
      throw new ResearchBrowserSessionError("browser_session_origin_denied");
    }
    if (requireOrigin && origin !== this.origin) {
      throw new ResearchBrowserSessionError("browser_session_origin_denied");
    }
    if (origin !== null && origin !== this.origin) {
      throw new ResearchBrowserSessionError("browser_session_origin_denied");
    }
    if (host !== this.host) {
      throw new ResearchBrowserSessionError("browser_session_host_denied");
    }
    const allowedFetchSites = method === "GET" ? ["same-origin", "none"] : ["same-origin"];
    // Native/server callers may omit Sec-Fetch-Site. When cookie auth is used,
    // the exact configured Origin/Host checks above still apply whenever the
    // browser supplies those headers; absence is not a browser CSRF proof.
    if (fetchSite !== null && !allowedFetchSites.includes(fetchSite)) {
      throw new ResearchBrowserSessionError("browser_session_fetch_site_denied");
    }
  }

  /** Enforce the configured origin/host boundary for bearer and cookie requests. */
  assertSameOrigin(headers: ResearchBrowserRequestHeaders, method = "GET"): void {
    this.assertRequestOrigin(headers, method, false);
  }

  private assertCsrf(headers: ResearchBrowserRequestHeaders, session: StoredSession): void {
    const supplied = headerValue(headers, "x-csrf-token");
    if (!supplied || byteLength(supplied) > MAX_CSRF_BYTES || !equalDigest(digest(supplied), session.csrfDigest)) {
      throw new ResearchBrowserSessionError("browser_session_csrf_required");
    }
  }

  private consumeLoginAttempt(): void {
    const now = Date.now();
    if (now - this.loginWindowStarted >= this.loginWindowMs) {
      this.loginWindowStarted = now;
      this.loginAttempts = 0;
    }
    this.loginAttempts += 1;
    if (this.loginAttempts > this.loginMaxAttempts) {
      throw new ResearchBrowserSessionError("browser_session_rate_limited");
    }
  }

  status(headers: ResearchBrowserRequestHeaders): ResearchBrowserSessionStatus {
    this.assertRequestOrigin(headers, "GET", false);
    const current = this.currentPrincipal();
    const { state, session } = this.sessionFor(headers);
    if (state.kind === "missing") return sessionStatus(null, null);
    if (state.kind === "invalid" || !session || !current) {
      if (session) this.sessions.delete(session.sessionDigest.toString("hex"));
      return sessionStatus(null, null);
    }
    return sessionStatus(current, session);
  }

  login(secret: unknown, headers: ResearchBrowserRequestHeaders): ResearchBrowserLoginResult {
    this.assertRequestOrigin(headers, "POST", true);
    this.consumeLoginAttempt();
    if (typeof secret !== "string" || byteLength(secret) > 4096 || !equalDigest(digest(secret), this.operatorSecretDigest)) {
      throw new ResearchBrowserSessionError("browser_session_login_failed");
    }
    const principal = this.currentPrincipal();
    if (!principal) throw new ResearchBrowserSessionError("browser_session_authority_unavailable");

    const previous = this.sessionFor(headers).session;
    if (previous) this.sessions.delete(previous.sessionDigest.toString("hex"));
    this.cleanup();
    while (this.sessions.size >= this.maxSessions) {
      const oldest = this.sessions.keys().next().value as string | undefined;
      if (!oldest) break;
      this.sessions.delete(oldest);
    }
    const sessionValue = randomBytes(SESSION_ID_BYTES).toString("base64url");
    const csrfToken = randomBytes(CSRF_TOKEN_BYTES).toString("base64url");
    const issuedAt = Date.now();
    const session: StoredSession = Object.freeze({
      sessionDigest: digest(sessionValue),
      csrfDigest: digest(csrfToken),
      principalId: this.principalId,
      issuedAt,
      expiresAt: issuedAt + this.ttlMs,
      csrfToken,
    });
    this.sessions.set(session.sessionDigest.toString("hex"), session);
    const secure = this.secure ? "; Secure" : "";
    return {
      status: sessionStatus(principal, session),
      setCookie: `${RESEARCH_BROWSER_SESSION_COOKIE}=${sessionValue}; HttpOnly; SameSite=Strict; Path=/api/research${secure}; Max-Age=${Math.floor(this.ttlMs / 1000)}`,
    };
  }

  authenticate(headers: ResearchBrowserRequestHeaders, method: string): KnowledgeServicePrincipal | null {
    const { state, session } = this.sessionFor(headers);
    if (state.kind === "missing") return null;
    if (state.kind === "invalid" || !session) throw new ResearchBrowserSessionError("browser_session_invalid");
    this.assertRequestOrigin(headers, method, method !== "GET" && method !== "HEAD");
    if (method !== "GET" && method !== "HEAD") this.assertCsrf(headers, session);
    const principal = this.currentPrincipal();
    if (!principal) {
      this.sessions.delete(session.sessionDigest.toString("hex"));
      return null;
    }
    return principal;
  }

  logout(headers: ResearchBrowserRequestHeaders): ResearchBrowserSessionStatus {
    const { state, session } = this.sessionFor(headers);
    if (state.kind !== "value" || !session) throw new ResearchBrowserSessionError("browser_session_invalid");
    this.assertRequestOrigin(headers, "DELETE", true);
    this.assertCsrf(headers, session);
    this.sessions.delete(session.sessionDigest.toString("hex"));
    return sessionStatus(null, null);
  }
}

export function browserSessionErrorStatus(error: unknown): number {
  if (!(error instanceof ResearchBrowserSessionError)) return 503;
  if (error.code === "browser_session_login_failed" || error.code === "browser_session_invalid") return 401;
  if (error.code === "browser_session_rate_limited") return 429;
  if (error.code === "browser_session_authority_unavailable" || error.code === "browser_session_invalid_config") return 503;
  return 403;
}
