import { createHash } from "node:crypto";

import type { FastifyRequest } from "fastify";

import type { KnowledgeServicePrincipal } from "./knowledge-principal.js";

/**
 * A partition is the server-authorized scope for Knowledge records and Brain
 * source data. Keys are hierarchical (`org/project/person`) so Fleet can
 * issue one grant for an exact partition or a bounded subtree.
 */
export type KnowledgePartitionBreadth = "exact" | "descendants";

export interface KnowledgePartitionGrant {
  readonly partitionKey: string;
  readonly breadth: KnowledgePartitionBreadth;
  /** 0 means the grant's own key; null means unlimited descendant depth. */
  readonly maxDepth: number | null;
  /** When omitted, the principal's capability is the grant's ceiling. */
  readonly capabilities?: readonly string[];
}

export interface KnowledgePartitionDecision {
  readonly allowed: boolean;
  readonly partitionKey: string;
  readonly grant: KnowledgePartitionGrant | null;
  readonly reason: "allowed" | "invalid_partition" | "missing_capability" | "outside_grant";
}

const PARTITION_KEY_MAX = 256;
const PARTITION_SEGMENT = /^[a-z0-9][a-z0-9._-]*$/u;
const SOURCE_ID_MAX_HEX = 24;

/** Canonicalize a Fleet/Portal key before comparing or deriving storage scope. */
export function normalizeKnowledgePartitionKey(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const normalized = value.trim().toLowerCase();
  if (
    !normalized ||
    normalized.length > PARTITION_KEY_MAX ||
    normalized.startsWith("/") ||
    normalized.endsWith("/") ||
    normalized.split("/").some((segment) => !PARTITION_SEGMENT.test(segment))
  ) {
    return null;
  }
  return normalized;
}

/**
 * Portal per-edge memory partition (`partitionKey` claim). The same grammar
 * Portal enforces on its registry; `default` is reserved for "no claim".
 */
export const EDGE_PARTITION_KEY = /^[a-z][a-z0-9-]{0,39}$/u;

/**
 * Advertised on /healthz, /api/status and /bootstrap.json so Portal can refuse
 * partitioned edges to an instance that would ignore the claim (rollout gate).
 */
export const EDGE_PARTITION_CONTRACT = 1;
export const EDGE_PARTITION_SUPPORT = Object.freeze({
  capabilities: Object.freeze({ edgePartitions: true as const }),
  partitionContract: EDGE_PARTITION_CONTRACT,
});

/**
 * Edge keys share the hierarchical namespace: `workspace/key` is also a
 * sub-partition. A static descendants grant that reaches the workspace's
 * direct children would therefore see every edge partition. True when it does.
 */
export function grantReachesEdgePartitions(grant: KnowledgePartitionGrant, workspace: string): boolean {
  const base = normalizeKnowledgePartitionKey(workspace);
  const key = normalizeKnowledgePartitionKey(grant.partitionKey);
  if (!base || !key || grant.breadth !== "descendants") return false;
  if (base !== key && !base.startsWith(`${key}/`)) return false;
  return grant.maxDepth === null || partitionDepth(base) + 1 - partitionDepth(key) <= grant.maxDepth;
}

/**
 * True for a hierarchical `workspace/key` scope that is already canonical, i.e.
 * unchanged by `normalizeKnowledgePartitionKey` (lower-case, trimmed, bounded,
 * no empty, dot-leading or traversal segments). Plain ids return false; callers
 * pair this with their own plain-id check.
 */
export function isCanonicalPartitionScope(value: unknown): value is string {
  return typeof value === "string" && value.includes("/") && normalizeKnowledgePartitionKey(value) === value;
}

/** Canonical form of a hierarchical (`a/b`) scope; anything else is returned unchanged. */
export function canonicalHierarchicalScope(value: unknown): unknown {
  if (typeof value !== "string" || !value.includes("/")) return value;
  return normalizeKnowledgePartitionKey(value) ?? value;
}

export type EdgePartitionClaim =
  | { readonly ok: true; readonly partitionKey: string | null }
  | { readonly ok: false };

/**
 * Parse Portal's optional `partitionKey` claim from an attachment, introspection
 * or runtime-principal answer. Absent means the workspace default partition.
 * Present but malformed (wrong type, `default`, uppercase, `/`, `..`, too long)
 * fails closed: callers must deny, never fall back to the default partition.
 */
export function parseEdgePartitionClaim(record: unknown): EdgePartitionClaim {
  if (!record || typeof record !== "object" || Array.isArray(record)) return { ok: false };
  if (!Object.prototype.hasOwnProperty.call(record, "partitionKey")) return { ok: true, partitionKey: null };
  const value = (record as Record<string, unknown>).partitionKey;
  return typeof value === "string" && EDGE_PARTITION_KEY.test(value) && value !== "default"
    ? { ok: true, partitionKey: value }
    : { ok: false };
}

/**
 * The storage/engine partition an edge-bound caller works in: the workspace
 * partition without a claim (unchanged behaviour), else its `company/key` child.
 */
export function effectiveKnowledgePartition(companyId: string, partitionKey: string | null): string | null {
  const base = normalizeKnowledgePartitionKey(companyId);
  if (!base) return null;
  if (partitionKey === null) return base;
  if (!EDGE_PARTITION_KEY.test(partitionKey) || partitionKey === "default") return null;
  return normalizeKnowledgePartitionKey(`${companyId}/${partitionKey}`);
}

/**
 * A principal bound to one non-default edge partition. Requests that name the
 * workspace (`alias`) are narrowed to `partitionKey`; nothing else is rewritten,
 * so the workspace partition itself is never reachable.
 */
export interface KnowledgeBoundPartition {
  readonly alias: string;
  readonly partitionKey: string;
}

export function boundPartitionFor(companyId: string, partitionKey: string | null): KnowledgeBoundPartition | null {
  if (partitionKey === null) return null;
  const alias = normalizeKnowledgePartitionKey(companyId);
  const effective = effectiveKnowledgePartition(companyId, partitionKey);
  return alias && effective ? Object.freeze({ alias, partitionKey: effective }) : null;
}

/** Map a caller-supplied partition selector through the principal's bound-partition alias. */
export function narrowPartitionSelector(value: unknown, bound: KnowledgeBoundPartition | undefined): unknown {
  if (!bound || typeof value !== "string" || !value.trim()) return value;
  return normalizeKnowledgePartitionKey(value) === bound.alias ? bound.partitionKey : value;
}

export function partitionDepth(partitionKey: string): number {
  return partitionKey.split("/").length - 1;
}

function grantMatches(grant: KnowledgePartitionGrant, partitionKey: string): boolean {
  const grantKey = normalizeKnowledgePartitionKey(grant.partitionKey);
  if (!grantKey) return false;
  if (grant.breadth === "exact") return grantKey === partitionKey;
  if (partitionKey !== grantKey && !partitionKey.startsWith(`${grantKey}/`)) return false;
  const relativeDepth = partitionDepth(partitionKey) - partitionDepth(grantKey);
  return grant.maxDepth === null || relativeDepth <= grant.maxDepth;
}

/**
 * Derive the opaque source id used by GBrain. The raw partition key is kept
 * in Knowledge metadata/frontmatter, while the sidecar receives a bounded
 * identifier that is safe for its source-id grammar and does not disclose the
 * tenant name in a URL or upstream log.
 */
export function knowledgePartitionSourceId(partitionKey: string): string {
  const normalized = normalizeKnowledgePartitionKey(partitionKey);
  if (!normalized) throw new Error("Invalid Knowledge partition key");
  return `kb-${createHash("sha256").update(normalized, "utf8").digest("hex").slice(0, SOURCE_ID_MAX_HEX)}`;
}

export function effectiveKnowledgePartitionGrants(
  principal: KnowledgeServicePrincipal,
): readonly KnowledgePartitionGrant[] {
  if (principal.partitionGrants !== undefined) return principal.partitionGrants;
  // Compatibility mode: an old principal is still limited to its old company
  // scope. It does not silently gain descendant access.
  return Object.freeze([
    Object.freeze({
      partitionKey: principal.companyId,
      breadth: "exact" as const,
      maxDepth: 0,
    }),
  ]);
}

/** Explicit legacy write grants cover C/U/D, never read. New grants are independent. */
function includesKnowledgeCapability(capabilities: readonly string[], capability: string): boolean {
  return capabilities.includes(capability) ||
    (["knowledge:create", "knowledge:update", "knowledge:delete"].includes(capability) && capabilities.includes("knowledge:write"));
}

export function authorizeKnowledgePartition(
  principal: KnowledgeServicePrincipal | null | undefined,
  requestedPartition: unknown,
  capability: string,
): KnowledgePartitionDecision {
  const partitionKey = normalizeKnowledgePartitionKey(requestedPartition);
  if (!partitionKey) {
    return { allowed: false, partitionKey: "", grant: null, reason: "invalid_partition" };
  }
  if (!principal || !includesKnowledgeCapability(principal.capabilities, capability)) {
    return { allowed: false, partitionKey, grant: null, reason: "missing_capability" };
  }
  const grant = effectiveKnowledgePartitionGrants(principal)
    .filter((candidate) => {
      if (!grantMatches(candidate, partitionKey)) return false;
      return candidate.capabilities === undefined || includesKnowledgeCapability(candidate.capabilities, capability);
    })
    .sort((left, right) => {
      const depthDelta = partitionDepth(right.partitionKey) - partitionDepth(left.partitionKey);
      if (depthDelta !== 0) return depthDelta;
      if (left.breadth === right.breadth) return 0;
      return left.breadth === "exact" ? -1 : 1;
    })[0] ?? null;
  return grant
    ? { allowed: true, partitionKey, grant, reason: "allowed" }
    : { allowed: false, partitionKey, grant: null, reason: "outside_grant" };
}

export function partitionGrantSummaries(principal: KnowledgeServicePrincipal): readonly Record<string, unknown>[] {
  return effectiveKnowledgePartitionGrants(principal).map((grant) => ({
    partitionKey: normalizeKnowledgePartitionKey(grant.partitionKey),
    breadth: grant.breadth,
    maxDepth: grant.maxDepth,
    capabilities: grant.capabilities ? [...grant.capabilities] : [...principal.capabilities],
  }));
}

export function bearerToken(request: Pick<FastifyRequest, "headers">): string | null {
  const value = request.headers.authorization;
  if (Array.isArray(value) || typeof value !== "string") return null;
  const match = /^Bearer\s+([^\s]+)$/iu.exec(value.trim());
  return match?.[1] ?? null;
}

declare module "fastify" {
  interface FastifyRequest {
    /** Set only after server-side principal and partition checks pass. */
    knowledgePartitionKey?: string;
  }
}
