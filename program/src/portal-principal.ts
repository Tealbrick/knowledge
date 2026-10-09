import { createHash } from "node:crypto";

import type { KnowledgeServicePrincipal } from "./knowledge-principal.js";
import { edgePartitionGrants, edgeScopeFor, normalizeKnowledgePartitionKey, parseEdgePartitionClaim, parseEdgeReadPartitionsClaim } from "./partition-authority.js";

/**
 * Portal-validated runtime principals (Tealbrick runtime-principal-v1).
 *
 * An agent presents a short-lived, instance-bound `tbkg_` grant minted by
 * Portal from its saved canvas CRUD wire. This resolver never trusts the
 * grant's contents: on every cache miss it asks Portal what the grant may do
 * now, in a request signed by this instance's claim key. The answer becomes an
 * ordinary KnowledgeServicePrincipal, so the Program's existing partition and
 * per-operation authorization stays the only enforcement point.
 *
 * Nothing here is configured per agent; KNOWLEDGE_SERVICE_PRINCIPALS remains
 * available for operator-managed service credentials.
 */
export const PORTAL_GRANT_PATTERN = /^tbkg_[A-Za-z0-9_-]{43}$/u;
export const PORTAL_INTROSPECT_PATH = "/api/runtime/knowledge-principal/introspect";
/** The complete capability vocabulary Portal may derive from CRUD actions. */
export const PORTAL_RUNTIME_CAPABILITIES: ReadonlySet<string> = new Set([
  "knowledge:create", "knowledge:read", "knowledge:update", "knowledge:delete", "brain:read",
]);

export interface PortalIntrospectionSigner {
  readonly instanceId: string;
  signIntrospection(input: { readonly portalIssuer: string; readonly companyId: string; readonly tokenDigest: string }): string;
}

export interface PortalPrincipalResolverOptions {
  /** Fixed Portal origin (TEALBRICK_PORTAL_URL). */
  readonly portal: string;
  /** Raw Portal company ID (KNOWLEDGE_COMPANY_ID) as registered at claim time. */
  readonly companyId: string;
  /** Portal organization (KNOWLEDGE_PORTAL_ORG_ID). */
  readonly portalOrgId: string;
  readonly signer: PortalIntrospectionSigner;
  readonly fetch?: typeof fetch;
  readonly now?: () => number;
  /** Upper bound for a positive cache entry; Portal's expiresAt may shorten it. */
  readonly cacheTtlMs?: number;
  /** Short negative cache so an invalid grant cannot hammer Portal. */
  readonly negativeTtlMs?: number;
  readonly maxEntries?: number;
  /** Concurrent Portal introspections; above it new lookups fail closed (not cached). */
  readonly maxInflight?: number;
  readonly timeoutMs?: number;
}

export interface PortalPrincipalResolver {
  readonly configured: true;
  readonly resolve: (token: string | null | undefined) => Promise<KnowledgeServicePrincipal | null>;
}

interface CacheEntry {
  readonly principal: KnowledgeServicePrincipal;
  readonly expiresAt: number;
}

const MAX_RESPONSE_BYTES = 16_384;
const RESPONSE_KEYS = new Set([
  "authorized", "principalId", "agentId", "orgId", "workspaceId", "instanceId", "companyId",
  "actions", "capabilities", "partitionGrants", "capabilityRevision", "expiresAt",
  // Portal sends it only for a non-default per-edge memory partition.
  "partitionKey",
  // Contract 2: the edge's read set (includes the write key; null = the workspace default scope).
  "readPartitionKeys",
]);

const digest = (token: string) => createHash("sha256").update(token).digest("hex");
const identifier = (value: unknown, max = 160): value is string =>
  typeof value === "string" && value.length > 0 && value.length <= max && !/\s/u.test(value);

function capabilityList(value: unknown): readonly string[] | null {
  if (!Array.isArray(value) || !value.length || value.length > PORTAL_RUNTIME_CAPABILITIES.size) return null;
  if (new Set(value).size !== value.length || value.some((item) => typeof item !== "string" || !PORTAL_RUNTIME_CAPABILITIES.has(item))) return null;
  return Object.freeze([...value] as string[]);
}

/** Strictly validate Portal's answer against this instance's own binding. */
export function portalPrincipalFromResponse(
  data: unknown,
  expected: { readonly instanceId: string; readonly companyId: string; readonly portalOrgId: string },
  now: number,
): { principal: KnowledgeServicePrincipal; expiresAt: number } | null {
  if (!data || typeof data !== "object" || Array.isArray(data)) return null;
  const value = data as Record<string, unknown>;
  if (Object.keys(value).some((key) => !RESPONSE_KEYS.has(key))) return null;
  const partition = normalizeKnowledgePartitionKey(expected.companyId);
  if (
    value.authorized !== true || !partition ||
    value.instanceId !== expected.instanceId || value.companyId !== expected.companyId || value.orgId !== expected.portalOrgId ||
    !identifier(value.principalId, 128) || !value.principalId.startsWith("tealbrick-agent:") || !identifier(value.agentId) ||
    typeof value.expiresAt !== "number" || !Number.isFinite(value.expiresAt) || value.expiresAt <= now
  ) return null;
  const capabilities = capabilityList(value.capabilities);
  if (!capabilities) return null;
  // Exactly one exact grant on this instance's own partition, no wider than the principal.
  const grants = value.partitionGrants;
  if (!Array.isArray(grants) || grants.length !== 1) return null;
  const grant = grants[0] as Record<string, unknown> | null;
  if (!grant || typeof grant !== "object" || Array.isArray(grant)) return null;
  if (Object.keys(grant).sort().join(",") !== "breadth,capabilities,maxDepth,partitionKey") return null;
  const grantCapabilities = capabilityList(grant.capabilities);
  if (
    normalizeKnowledgePartitionKey(grant.partitionKey) !== partition || grant.breadth !== "exact" || grant.maxDepth !== 0 ||
    !grantCapabilities || grantCapabilities.some((capability) => !capabilities.includes(capability))
  ) return null;
  // Per-edge memory partition: Portal's grant stays on the workspace; Knowledge
  // narrows it to the exact `company/key` child. A malformed claim denies.
  const claim = parseEdgePartitionClaim(value);
  if (!claim.ok) return null;
  // Contract 2: writes stay in that partition; reads may also use the read set (read-only grants).
  const reads = parseEdgeReadPartitionsClaim(value, claim.partitionKey);
  if (!reads.ok) return null;
  const scope = edgeScopeFor(expected.companyId, claim.partitionKey, reads.readPartitionKeys);
  if (!scope.ok) return null;
  const principal: KnowledgeServicePrincipal = Object.freeze({
    kind: "service",
    principalId: value.principalId,
    companyId: scope.write,
    capabilities,
    partitionGrants: edgePartitionGrants(scope, grantCapabilities),
    ...(scope.bound ? { boundPartition: scope.bound } : {}),
  });
  return { principal, expiresAt: value.expiresAt };
}

export function createPortalPrincipalResolver(options: PortalPrincipalResolverOptions): PortalPrincipalResolver {
  const portal = new URL(options.portal);
  if (
    portal.origin !== options.portal.replace(/\/$/u, "") || portal.username || portal.password || portal.search || portal.hash ||
    (portal.protocol !== "https:" && !(portal.protocol === "http:" && ["127.0.0.1", "localhost", "[::1]"].includes(portal.hostname)))
  ) throw new Error("Portal principal authority must be a fixed HTTPS origin (loopback HTTP permitted for fixtures)");
  if (!identifier(options.companyId, 128) || !identifier(options.portalOrgId, 128) || !normalizeKnowledgePartitionKey(options.companyId)) {
    throw new Error("Portal principal authority requires company and portal organization IDs");
  }
  const fetcher = options.fetch ?? fetch;
  const now = options.now ?? Date.now;
  // 5s bound: a partition or capability edit on the canvas reaches an admitted grant within 5 seconds.
  const cacheTtlMs = Math.min(options.cacheTtlMs ?? 5_000, 60_000);
  const negativeTtlMs = options.negativeTtlMs ?? 5_000;
  const maxEntries = options.maxEntries ?? 1_000;
  const maxInflight = options.maxInflight ?? 32;
  const timeoutMs = options.timeoutMs ?? 5_000;
  // Positive and negative answers live apart so a flood of junk grants cannot evict live agents.
  const cache = new Map<string, CacheEntry>();
  const denied = new Map<string, number>();
  const inflight = new Map<string, Promise<KnowledgeServicePrincipal | null>>();
  const expected = { instanceId: options.signer.instanceId, companyId: options.companyId, portalOrgId: options.portalOrgId };

  const bounded = <V>(map: Map<string, V>, limit: number, expired: (value: V) => boolean) => {
    if (map.size < limit) return;
    for (const [entryKey, value] of map) if (expired(value)) map.delete(entryKey);
    while (map.size >= limit) map.delete(map.keys().next().value!);
  };
  const remember = (key: string, principal: KnowledgeServicePrincipal | null, expiresAt: number) => {
    if (!principal) {
      bounded(denied, maxEntries, until => until <= now());
      denied.set(key, expiresAt);
      return;
    }
    bounded(cache, maxEntries, entry => entry.expiresAt <= now());
    cache.set(key, { principal, expiresAt });
  };

  async function introspect(token: string, tokenDigest: string): Promise<KnowledgeServicePrincipal | null> {
    try {
      const proof = options.signer.signIntrospection({ portalIssuer: portal.origin, companyId: options.companyId, tokenDigest });
      const response = await fetcher(`${portal.origin}${PORTAL_INTROSPECT_PATH}`, {
        method: "POST", redirect: "error", signal: AbortSignal.timeout(timeoutMs),
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ token, instanceId: expected.instanceId, companyId: options.companyId, proof }),
      });
      // Only an explicit denial is cached; Portal errors and rate limits are treated like outages.
      if (response.status === 401 || response.status === 403) { remember(tokenDigest, null, now() + negativeTtlMs); return null; }
      if (!response.ok || !response.body) return null;
      const chunks: Buffer[] = [];
      let bytes = 0;
      for await (const chunk of response.body as unknown as AsyncIterable<Uint8Array>) {
        bytes += chunk.byteLength;
        if (bytes > MAX_RESPONSE_BYTES) throw new Error("response too large");
        chunks.push(Buffer.from(chunk));
      }
      const resolved = portalPrincipalFromResponse(JSON.parse(Buffer.concat(chunks, bytes).toString("utf8")), expected, now());
      if (!resolved) { remember(tokenDigest, null, now() + negativeTtlMs); return null; }
      remember(tokenDigest, resolved.principal, Math.min(resolved.expiresAt, now() + cacheTtlMs));
      return resolved.principal;
    } catch {
      // Portal unreachable or malformed: fail closed, but do not cache an outage.
      return null;
    }
  }

  return Object.freeze({
    configured: true as const,
    async resolve(token: string | null | undefined) {
      if (typeof token !== "string") return null;
      const value = token.trim();
      // Only Portal-shaped grants ever leave this instance; static service
      // tokens and junk bearers are never forwarded to Portal.
      if (!PORTAL_GRANT_PATTERN.test(value)) return null;
      const key = digest(value);
      const cached = cache.get(key);
      if (cached && cached.expiresAt > now()) return cached.principal;
      if (cached) cache.delete(key);
      const deniedUntil = denied.get(key);
      if (deniedUntil !== undefined && deniedUntil > now()) return null;
      if (deniedUntil !== undefined) denied.delete(key);
      const pending = inflight.get(key);
      if (pending) return pending;
      if (inflight.size >= maxInflight) return null;
      const request = introspect(value, key).finally(() => inflight.delete(key));
      inflight.set(key, request);
      return request;
    },
  });
}

export interface PortalPrincipalEnvironment {
  readonly TEALBRICK_PORTAL_URL?: string;
  readonly KNOWLEDGE_COMPANY_ID?: string;
  readonly KNOWLEDGE_PORTAL_ORG_ID?: string;
  readonly KNOWLEDGE_PORTAL_PRINCIPALS?: string;
}

/**
 * Enabled by default for Portal-provisioned instances (the Portal binding
 * variables are present). `KNOWLEDGE_PORTAL_PRINCIPALS=off` opts out.
 */
export function portalPrincipalConfig(env: PortalPrincipalEnvironment): { portal: string; companyId: string; portalOrgId: string } | null {
  const mode = env.KNOWLEDGE_PORTAL_PRINCIPALS?.trim() || "auto";
  if (!["auto", "on", "off"].includes(mode)) throw new Error("KNOWLEDGE_PORTAL_PRINCIPALS must be auto, on or off");
  if (mode === "off") return null;
  const portal = env.TEALBRICK_PORTAL_URL?.trim(), companyId = env.KNOWLEDGE_COMPANY_ID?.trim(), portalOrgId = env.KNOWLEDGE_PORTAL_ORG_ID?.trim();
  if (!portal || !companyId || !portalOrgId) {
    if (mode === "on") throw new Error("KNOWLEDGE_PORTAL_PRINCIPALS=on requires TEALBRICK_PORTAL_URL, KNOWLEDGE_COMPANY_ID and KNOWLEDGE_PORTAL_ORG_ID");
    return null;
  }
  return { portal: new URL(portal).origin, companyId, portalOrgId };
}
