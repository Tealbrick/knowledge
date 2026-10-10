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
export const EDGE_PARTITION_CONTRACT = 2;
export const EDGE_PARTITION_SUPPORT = Object.freeze({
  capabilities: Object.freeze({ edgePartitions: true as const, readPartitions: true as const }),
  partitionContract: EDGE_PARTITION_CONTRACT,
});

/** Contract 2: at most this many entries in a read set (`readPartitionKeys`), as in @tealbrick/contract. */
export const MAX_READ_PARTITIONS = 64;

/**
 * Capabilities a read-only partition grant carries (contract 2 read sets). A read set never grants
 * create, update, delete, research writes or native engine writes.
 */
export const READ_CAPABILITIES: ReadonlySet<string> = new Set(["knowledge:read", "brain:read", "research:read", "brain:native:read"]);

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

export type EdgeReadPartitionsClaim =
  | { readonly ok: true; readonly readPartitionKeys: readonly (string | null)[] | undefined }
  | { readonly ok: false };

/**
 * Parse Portal's optional contract 2 read set (`readPartitionKeys`) of an attachment, introspection or
 * runtime-principal answer. Absent stays `undefined` (contract 1: reads stay in the write partition).
 * Present, it must be 1..64 unique entries, each `null` (the workspace default scope) or an edge key,
 * and it must contain the write key (`partitionKey`, `null` = default). Anything else fails closed.
 */
export function parseEdgeReadPartitionsClaim(record: unknown, writeKey: string | null): EdgeReadPartitionsClaim {
  if (!record || typeof record !== "object" || Array.isArray(record)) return { ok: false };
  if (!Object.prototype.hasOwnProperty.call(record, "readPartitionKeys")) return { ok: true, readPartitionKeys: undefined };
  const list = parseReadPartitionKeys((record as Record<string, unknown>).readPartitionKeys, writeKey);
  return list ? { ok: true, readPartitionKeys: list } : { ok: false };
}

/** A contract 2 read set relative to its write key, or null when it is malformed (deny). */
export function parseReadPartitionKeys(value: unknown, writeKey: string | null): readonly (string | null)[] | null {
  if (!Array.isArray(value) || value.length < 1 || value.length > MAX_READ_PARTITIONS) return null;
  for (const key of value) {
    if (key !== null && !(typeof key === "string" && EDGE_PARTITION_KEY.test(key) && key !== "default")) return null;
  }
  if (new Set(value).size !== value.length || !value.includes(writeKey)) return null;
  return Object.freeze([...value] as (string | null)[]);
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
  /** The write partition. */
  readonly partitionKey: string;
  /**
   * Contract 2 only (a read set wider than the write partition): every effective partition the
   * principal may read, the write partition first. Absent means reads stay in `partitionKey`.
   */
  readonly readPartitions?: readonly string[];
}

export function boundPartitionFor(companyId: string, partitionKey: string | null): KnowledgeBoundPartition | null {
  if (partitionKey === null) return null;
  const alias = normalizeKnowledgePartitionKey(companyId);
  const effective = effectiveKnowledgePartition(companyId, partitionKey);
  return alias && effective ? Object.freeze({ alias, partitionKey: effective }) : null;
}

/**
 * The scope an edge claim binds: the effective write partition, the bound partition (selectors naming the
 * workspace are narrowed to the write partition) and the effective read partitions (write partition first).
 *
 * Contract 1 (no read set) and a read set that equals the write key give exactly the contract 1 result:
 * `bound` is null for the default partition and `{alias, partitionKey}` otherwise, with no `readPartitions`.
 * A wider read set (contract 2) always binds, also for a default write partition, and carries `readPartitions`.
 */
export type EdgeScope =
  | { readonly ok: true; readonly write: string; readonly bound: KnowledgeBoundPartition | null; readonly readPartitions: readonly string[] }
  | { readonly ok: false };

export function edgeScopeFor(companyId: string, partitionKey: string | null, readPartitionKeys?: readonly (string | null)[]): EdgeScope {
  const alias = normalizeKnowledgePartitionKey(companyId);
  const write = effectiveKnowledgePartition(companyId, partitionKey);
  if (!alias || !write) return { ok: false };
  if (readPartitionKeys === undefined) {
    const bound = partitionKey === null ? null : boundPartitionFor(companyId, partitionKey);
    return partitionKey !== null && !bound ? { ok: false } : { ok: true, write, bound, readPartitions: Object.freeze([write]) };
  }
  if (!readPartitionKeys.includes(partitionKey)) return { ok: false };
  const reads: string[] = [write];
  for (const key of readPartitionKeys) {
    const effective = effectiveKnowledgePartition(companyId, key);
    if (!effective) return { ok: false };
    if (!reads.includes(effective)) reads.push(effective);
  }
  if (reads.length === 1) return edgeScopeFor(companyId, partitionKey);
  return { ok: true, write, bound: Object.freeze({ alias, partitionKey: write, readPartitions: Object.freeze(reads) }), readPartitions: Object.freeze(reads) };
}

/**
 * Partition grants for an edge principal: exact on the write partition with every capability, plus (contract 2)
 * an exact, read-only grant on each other partition of the read set. Nothing ever has breadth or depth.
 */
export function edgePartitionGrants(scope: Extract<EdgeScope, { ok: true }>, capabilities: readonly string[]): readonly KnowledgePartitionGrant[] {
  const readOnly = Object.freeze(capabilities.filter((capability) => READ_CAPABILITIES.has(capability)));
  return Object.freeze([
    Object.freeze({ partitionKey: scope.write, breadth: "exact" as const, maxDepth: 0, capabilities: Object.freeze([...capabilities]) }),
    ...(readOnly.length ? scope.readPartitions.filter((partition) => partition !== scope.write)
      .map((partition) => Object.freeze({ partitionKey: partition, breadth: "exact" as const, maxDepth: 0, capabilities: readOnly })) : []),
  ]);
}

/**
 * Contract 2 read view: a read whose selector is the principal's own (write) partition — usually by naming the
 * workspace — reads every partition of its read set that the capability is granted on. Any other selection
 * (an explicit read partition, a write, a contract 1 principal) reads exactly one partition (null).
 */
export function readViewFor(
  principal: KnowledgeServicePrincipal | null | undefined,
  partitionKey: string,
  capability: string,
  authorized: (partition: string) => boolean = (partition) => authorizeKnowledgePartition(principal, partition, capability).allowed,
): readonly string[] | null {
  const bound = principal?.boundPartition;
  if (!bound?.readPartitions || bound.readPartitions.length < 2 || partitionKey !== bound.partitionKey) return null;
  if (!READ_CAPABILITIES.has(capability)) return null;
  const view = bound.readPartitions.filter(authorized);
  return view.length > 1 ? Object.freeze(view) : null;
}

/**
 * Contract 2: the one partition a READ names directly, when it is a partition of the principal's read set other than
 * its write partition. `direct` holds the request's normalized direct selectors (path/query/body companyId and
 * partitionKey, Brain scopeRef), after the workspace alias was narrowed to the write partition. Two shapes qualify:
 * exactly [P], or the write partition (the principal's own workspace) plus P. The read then reads exactly P, never the
 * whole read set. Anything else is null and keeps today's resolution and refusals unchanged: a write capability, a
 * contract 1 principal (no read set), P outside the read set, or two different read partitions.
 * This only selects; the caller still authorizes P (the principal's read-only grant on P).
 */
export function namedReadPartition(bound: KnowledgeBoundPartition | undefined, capability: string, direct: readonly string[]): string | null {
  if (!bound?.readPartitions || bound.readPartitions.length < 2 || !READ_CAPABILITIES.has(capability)) return null;
  const named = [...new Set(direct)].filter((partition) => partition !== bound.partitionKey);
  if (named.length !== 1) return null;
  const partition = named[0]!;
  return bound.readPartitions.includes(partition) ? partition : null;
}

/**
 * Contract 2 on the instance edge: the effective partition a read selector names, or null (refuse). Readable are the
 * workspace (the whole read view), an effective partition of the read set (`workspace/key`, the workspace for a null
 * entry) and a bare edge key of the read set as Portal states it in the grant (`key`), which maps to `workspace/key`.
 * A bare key outside the read set, or any other value, is null, so a selector never reaches another partition.
 */
export function edgeReadSelector(value: unknown, companyId: string, readPartitionKeys: readonly (string | null)[]): string | null {
  const key = normalizeKnowledgePartitionKey(value);
  const workspace = normalizeKnowledgePartitionKey(companyId);
  if (!key || !workspace) return null;
  if (key === workspace) return workspace;
  for (const entry of readPartitionKeys) {
    const effective = effectiveKnowledgePartition(companyId, entry);
    if (effective && (key === effective || (entry !== null && key === entry))) return effective;
  }
  return null;
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

/**
 * Uniform not-found: whether an object in `partition` must look absent to this principal for an operation needing
 * `capability`. True when no grant on that partition allows any capability of the same kind (reads: the read
 * capabilities; writes: everything else), so the principal cannot even learn that the object exists. A partition it
 * may write but not with this exact capability (a narrowed grant) stays a 403 refusal, as does a capability the
 * principal lacks entirely.
 */
export function partitionHiddenFrom(
  principal: KnowledgeServicePrincipal | null | undefined,
  partition: string,
  capability: string,
): boolean {
  const decision = authorizeKnowledgePartition(principal, partition, capability);
  if (decision.allowed || decision.reason !== "outside_grant" || !principal) return false;
  const reads = READ_CAPABILITIES.has(capability);
  const held = new Set(principal.capabilities.flatMap((held) =>
    held === "knowledge:write" ? ["knowledge:create", "knowledge:update", "knowledge:delete"] : [held]));
  return ![...held].filter((held) => READ_CAPABILITIES.has(held) === reads)
    .some((held) => authorizeKnowledgePartition(principal, partition, held).allowed);
}

/** Whether the principal holds a capability at all (in any partition); no partition is consulted. */
export function principalHoldsCapability(principal: KnowledgeServicePrincipal | null | undefined, capability: string): boolean {
  return !!principal && includesKnowledgeCapability(principal.capabilities, capability);
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
    /**
     * Contract 2: set only for a read of the principal's own partition when its read set is wider (see
     * readViewFor); every entry passed the same partition authorization. Lists, search and Brain reads use it.
     */
    knowledgeReadPartitions?: readonly string[];
  }
}
