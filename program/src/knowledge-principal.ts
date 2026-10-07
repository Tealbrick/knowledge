import { createHash, timingSafeEqual } from "node:crypto";

import {
  normalizeKnowledgePartitionKey,
  type KnowledgeBoundPartition,
  type KnowledgePartitionBreadth,
  type KnowledgePartitionGrant,
} from "./partition-authority.js";

/**
 * An explicit server-side grant for a Knowledge service principal.
 *
 * The token is accepted only while constructing the resolver and is never
 * returned from resolution. Callers must not derive any of these fields from
 * request headers, query parameters, or request bodies.
 */
export interface KnowledgeServicePrincipalBinding {
  readonly token: string;
  readonly principalId: string;
  readonly companyId: string;
  readonly capabilities: readonly string[];
  /** Optional Fleet/Portal-issued partition grants. */
  readonly partitionGrants?: readonly KnowledgePartitionGrant[];
}

export interface KnowledgeServicePrincipal {
  readonly kind: "service";
  readonly principalId: string;
  readonly companyId: string;
  readonly capabilities: readonly string[];
  readonly partitionGrants?: readonly KnowledgePartitionGrant[];
  /**
   * Set only for a Portal edge with a non-default memory partition. The
   * principal's grants are exact on `boundPartition.partitionKey`; selectors
   * naming the workspace are narrowed to it. Never configurable statically.
   */
  readonly boundPartition?: KnowledgeBoundPartition;
}

export interface KnowledgePrincipalResolver {
  readonly configured: boolean;
  /** Resolve only the supplied bearer token; no caller-provided identity is accepted. */
  readonly resolve: (token: string | null | undefined) => KnowledgeServicePrincipal | null;
  /** Resolve a configured server principal by its stable ID; browser sessions use this for revocation checks. */
  readonly resolveById?: (principalId: string | null | undefined) => KnowledgeServicePrincipal | null;
}

interface StoredBinding {
  readonly tokenDigest: Buffer;
  readonly principal: KnowledgeServicePrincipal;
}

const MAX_IDENTIFIER_LENGTH = 128;
const MAX_CAPABILITY_LENGTH = 128;
const BINDING_KEYS = new Set(["token", "principalId", "companyId", "capabilities", "partitionGrants"]);

function digest(token: string): Buffer {
  return createHash("sha256").update(token).digest();
}

function identifier(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const normalized = value.trim();
  if (!normalized || normalized.length > MAX_IDENTIFIER_LENGTH || /\s/u.test(normalized)) return null;
  return normalized;
}

function capabilities(value: unknown): readonly string[] | null {
  if (!Array.isArray(value)) return null;
  const normalized: string[] = [];
  const seen = new Set<string>();
  for (const item of value) {
    if (typeof item !== "string") return null;
    const capability = item.trim();
    if (!capability || capability.length > MAX_CAPABILITY_LENGTH || seen.has(capability)) return null;
    seen.add(capability);
    normalized.push(capability);
  }
  return Object.freeze(normalized);
}

function partitionGrants(value: unknown): readonly KnowledgePartitionGrant[] | null {
  if (!Array.isArray(value)) return null;
  const normalized: KnowledgePartitionGrant[] = [];
  const seen = new Set<string>();
  for (const item of value) {
    if (!item || typeof item !== "object" || Array.isArray(item)) return null;
    const record = item as Record<string, unknown>;
    const keys = Object.keys(record);
    const allowedKeys = new Set(["partitionKey", "breadth", "maxDepth", "capabilities"]);
    if (keys.some((key) => !allowedKeys.has(key)) || !["partitionKey", "breadth", "maxDepth"].every((key) => key in record)) return null;
    const partitionKey = normalizeKnowledgePartitionKey(record.partitionKey);
    const breadth = record.breadth;
    const maxDepth = record.maxDepth;
    if (
      !partitionKey ||
      (breadth !== "exact" && breadth !== "descendants") ||
      (maxDepth !== null && (!Number.isSafeInteger(maxDepth) || (maxDepth as number) < 0 || (maxDepth as number) > 64))
    ) return null;
    const grantCapabilities = record.capabilities === undefined ? undefined : capabilities(record.capabilities);
    if (record.capabilities !== undefined && !grantCapabilities) return null;
    const identity = `${partitionKey}\u0000${breadth}`;
    if (seen.has(identity)) return null;
    seen.add(identity);
    normalized.push(Object.freeze({
      partitionKey,
      breadth: breadth as KnowledgePartitionBreadth,
      maxDepth: maxDepth as number | null,
      ...(grantCapabilities ? { capabilities: grantCapabilities } : {}),
    }));
  }
  return Object.freeze(normalized);
}

function normalizedBinding(value: unknown): StoredBinding | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record);
  if (keys.some((key) => !BINDING_KEYS.has(key)) || !["token", "principalId", "companyId", "capabilities"].every((key) => key in record)) return null;

  const token = typeof record.token === "string" ? record.token.trim() : "";
  const principalId = identifier(record.principalId);
  // Reserved for Portal-validated runtime principals: a static entry must never share their
  // identity (native memory ownership, cursors and receipts are keyed by principalId).
  if (principalId?.startsWith("tealbrick-agent:")) return null;
  const companyId = identifier(record.companyId);
  const grantCapabilities = capabilities(record.capabilities);
  if (!token || !principalId || !companyId || !grantCapabilities) return null;
  const grantList = Object.prototype.hasOwnProperty.call(record, "partitionGrants")
    ? partitionGrants(record.partitionGrants)
    : undefined;
  if (Object.prototype.hasOwnProperty.call(record, "partitionGrants") && !grantList) return null;

  const principal: KnowledgeServicePrincipal = Object.freeze({
    kind: "service",
    principalId,
    companyId,
    capabilities: grantCapabilities,
    ...(grantList ? { partitionGrants: grantList } : {}),
  });
  return Object.freeze({ tokenDigest: digest(token), principal });
}

/**
 * Build a fail-closed resolver from explicit grants.
 *
 * Any malformed entry, duplicate token, or duplicate principal identity
 * invalidates the complete set. Multiple principals may intentionally belong
 * to the same company, while competing credentials for one principal are
 * rejected. This avoids silently selecting one of two competing authorities
 * after a configuration mistake.
 */
export function createKnowledgePrincipalResolver(
  bindings: readonly KnowledgeServicePrincipalBinding[],
): KnowledgePrincipalResolver {
  const stored: StoredBinding[] = [];
  const tokenDigests = new Set<string>();
  const principalIds = new Set<string>();
  let valid = Array.isArray(bindings) && bindings.length > 0;

  if (valid) {
    for (const binding of bindings) {
      const normalized = normalizedBinding(binding);
      if (!normalized) {
        valid = false;
        break;
      }
      const digestKey = normalized.tokenDigest.toString("hex");
      if (tokenDigests.has(digestKey) || principalIds.has(normalized.principal.principalId)) {
        valid = false;
        break;
      }
      tokenDigests.add(digestKey);
      principalIds.add(normalized.principal.principalId);
      stored.push(normalized);
    }
  }

  if (!valid) {
    return Object.freeze({ configured: false, resolve: () => null, resolveById: () => null });
  }

  return Object.freeze({
    configured: true,
    resolve(token: string | null | undefined) {
      if (typeof token !== "string" || !token.trim()) return null;
      const actualDigest = digest(token.trim());
      let resolved: KnowledgeServicePrincipal | null = null;
      // Compare every configured digest so a match does not short-circuit the
      // number of constant-time comparisons performed for this resolver.
      for (const binding of stored) {
        const matches = actualDigest.length === binding.tokenDigest.length && timingSafeEqual(actualDigest, binding.tokenDigest);
        if (matches && !resolved) resolved = binding.principal;
      }
      return resolved;
    },
    resolveById(principalId: string | null | undefined) {
      if (typeof principalId !== "string" || !principalId.trim()) return null;
      return stored.find((binding) => binding.principal.principalId === principalId.trim())?.principal ?? null;
    },
  });
}
