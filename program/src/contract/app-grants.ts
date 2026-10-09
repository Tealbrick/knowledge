import {
  GRANT_ERROR_CODES,
  APP_GRANT_INTROSPECT_PATH,
  createGrantGuard,
  createGrantVerifier,
  routeOperation,
  type GrantResult,
  type GrantVerifier,
  type Manifest,
  type OperationAuditEvent,
} from "@tealbrick/contract";

import { parseEdgePartitionClaim, parseReadPartitionKeys } from "../partition-authority.js";
import type { ContractAudit } from "./audit.js";
import { effectiveReadPartitions, grantReadPartitionKeys, readSetIntrospection, samePartitionSet, type ReadPartitionKeys, type ReadSetIntrospection } from "./read-partitions.js";

/**
 * Agent access with Portal app grants (`tbag_`), verified by the contract kit.
 *
 * An agent reaches Knowledge through the Teal Brick connector with ONE Portal credential,
 * `Authorization: Bearer tbag_...`. The kit (`createGrantVerifier`, mode "l1", wire "app-grant-v1") asks Portal Core
 * `POST /api/runtime/app-grant/introspect` whether the grant is live and which manifest operations it covers.
 * This module adds what Knowledge needs on top of the kit and nothing else:
 *
 * - the per-edge memory partition a grant carries. The kit's app-grant parser exposes the Portal answer's
 *   `partitionKey` as `GrantResult.partitionKey` (string, explicit `null`, or absent as `undefined`; manifest
 *   `runtime.partitions` declares that Knowledge binds it). A present but malformed claim denies; it never falls back to
 *   the default partition. The grammar and the `<companyId>/<key>` binding are the attachment path's (partition-authority.ts).
 * - the contract 2 read set (`readPartitionKeys`, manifest `runtime.partitions.contract: 2`): writes stay bound to
 *   `partitionKey`; reads may use every partition of the read set. The kit's `effectiveReadPartitions` gives the set;
 *   a set that is exactly `[partitionKey]` is the contract 1 grant and keeps the contract 1 path byte for byte. Each
 *   key must match the edge grammar and the set must contain the write key, or the grant is refused.
 * - live re-verification at dispatch (the kit's positive cache is off: every check asks Portal), so a slow upload
 *   cannot outlive a revocation or a re-scoped edge.
 * - metadata-only audit rows.
 *
 * Fail closed everywhere: no grant, a malformed grant, another tenant, an operation the grant does not name, an owner
 * operation, an app (companion) principal or Portal down all deny. The existing attachment path is untouched.
 */

export interface AppGrantPortal {
  readonly url: string;
  readonly deploymentId: string;
  readonly orgId: string;
  readonly tenantId: string;
  readonly instanceProof: string;
}

export interface AppGrantOptions {
  readonly manifest: Manifest;
  readonly portal: AppGrantPortal | null;
  readonly audit?: ContractAudit;
  readonly fetch?: typeof fetch;
  readonly now?: () => number;
}

type VerifiedGrant = GrantResult & { ok: true };

export interface AdmittedGrant {
  readonly operation: string;
  readonly agentId: string;
  readonly orgId: string;
  /** Epoch ms the Portal answer is valid until (at most 60 s ahead). */
  readonly expiresAt: number;
  /** Validated per-edge partition key; null = the workspace default partition. */
  readonly partitionKey: string | null;
  /**
   * Contract 2 only, when wider than `[partitionKey]`: the validated read set (contains `partitionKey`; null = the
   * workspace default partition). Absent = reads stay in `partitionKey` (contract 1).
   */
  readonly readPartitionKeys?: ReadPartitionKeys;
  readonly grant: VerifiedGrant;
  readonly auditId: string;
}

export type AppGrantAdmission =
  | { readonly ok: true; readonly admitted: AdmittedGrant }
  | { readonly ok: false; readonly status: 401 | 403 | 503; readonly error: string; readonly headers: Record<string, string> };

export interface AppGrantAuthority {
  readonly configured: boolean;
  /** An agent presented a Portal app grant (`Authorization: Bearer tbag_...`). */
  presented(headers: Record<string, string | string[] | undefined>): boolean;
  /** Operation id the manifest maps this request to, or undefined. */
  operationFor(method: string, rawUrl: string): string | undefined;
  /** Verify the grant for the operation the request maps to. Never throws. */
  admit(request: { method: string; url: string; headers: Record<string, string | string[] | undefined> }): Promise<AppGrantAdmission>;
  /** Live re-verification for the same operation, agent and partition; null on any change or denial. */
  recheck(request: { headers: Record<string, string | string[] | undefined> }, admitted: AdmittedGrant): Promise<AdmittedGrant | null>;
  /** Whether the admitted grant also covers another operation (read from the same verified grant). */
  covers(admitted: AdmittedGrant, operation: string): boolean;
  /** Any live grant for this deployment (the guidance endpoint). */
  verifyAny(request: { headers: Record<string, string | string[] | undefined> }): Promise<{ ok: true } | { ok: false; status: 401 | 403 | 503; error: string }>;
  complete(auditId: string, status: number): void;
}

const GRANT_PRESENTED = /^Bearer\s+tbag_[A-Za-z0-9_-]{1,512}$/u;
function singleHeader(headers: Record<string, string | string[] | undefined>, name: string): string | undefined {
  const value = headers[name];
  return typeof value === "string" ? value : undefined;
}

/**
 * The partition a grant answer binds. Unlike the attachment path (an absent key is the default partition there), a
 * `tbag_` answer must state it: a string binds `<companyId>/<key>`, an explicit `null` is the default company scope,
 * an ABSENT key is refused (`partition_binding_required`) and a malformed one is refused (`partition_claim_invalid`).
 * A Portal that does not send the key gets no access, never the default.
 */
type GrantPartitionClaim =
  | { readonly ok: true; readonly partitionKey: string | null }
  | { readonly ok: false; readonly reason: "absent" | "invalid" };

export function parseGrantPartitionClaim(partitionKey: string | null | undefined): GrantPartitionClaim {
  if (partitionKey === undefined) return { ok: false, reason: "absent" };
  if (partitionKey === null) return { ok: true, partitionKey: null };
  const claim = parseEdgePartitionClaim({ partitionKey });
  return claim.ok ? claim : { ok: false, reason: "invalid" };
}

/**
 * The read set a verified grant carries beyond its write partition: undefined for contract 1 (absent, or exactly
 * `[partitionKey]`), the validated set otherwise, null when it is malformed for Knowledge (refuse).
 */
export function grantReadSet(grant: VerifiedGrant, partitionKey: string | null, presented: ReadPartitionKeys | undefined): ReadPartitionKeys | undefined | null {
  if (presented === undefined) return undefined;
  const reads = effectiveReadPartitions({ ...grant, partitionKey, readPartitionKeys: presented });
  if (!reads) return null;
  const parsed = parseReadPartitionKeys(reads, partitionKey);
  if (!parsed) return null;
  return parsed.length === 1 ? undefined : parsed;
}

function grantToken(headers: Record<string, string | string[] | undefined>): string | null {
  const value = singleHeader(headers, "authorization");
  const match = typeof value === "string" ? /^Bearer\s+(tbag_[A-Za-z0-9_-]{1,512})$/u.exec(value.trim()) : null;
  return match?.[1] ?? null;
}

const deny = (status: 401 | 403 | 503, error: string): AppGrantAdmission => ({
  ok: false, status, error, headers: status === 401 ? { "www-authenticate": 'Bearer error="invalid_token"' } : {},
});

export function createAppGrantAuthority(options: AppGrantOptions): AppGrantAuthority {
  const { manifest, portal } = options;
  const now = options.now ?? Date.now;
  let verifier: GrantVerifier | null = null;
  let readSets: ReadSetIntrospection = readSetIntrospection(options.fetch ?? fetch, "");
  if (portal) {
    try {
      readSets = readSetIntrospection(options.fetch ?? fetch, new URL(APP_GRANT_INTROSPECT_PATH, portal.url).href);
      verifier = createGrantVerifier({
        mode: "l1",
        manifest,
        introspect: {
          wire: "app-grant-v1",
          url: new URL(APP_GRANT_INTROSPECT_PATH, portal.url).href,
          deploymentId: portal.deploymentId,
          product: manifest.app.id,
          instanceProof: portal.instanceProof,
          tenantId: portal.tenantId,
          orgId: portal.orgId,
          // Every check asks Portal: admission and dispatch must see a revocation or a re-scoped edge at once.
          cacheTtlMs: 0,
          fetch: readSets.fetch,
          ...(options.now ? { now } : {}),
        },
        ...(options.now ? { now } : {}),
      });
    } catch {
      // An unusable binding (for example a proof the kit refuses) never degrades to "allow".
      verifier = null;
    }
  }
  const guard = verifier
    ? createGrantGuard({
        verifier,
        manifest,
        audit: (event: OperationAuditEvent) => {
          options.audit?.record({ kind: "grant", operation: event.operation, actor: event.principal ?? null, outcome: "denied", status: event.status, code: event.error });
        },
      })
    : null;

  const authority: AppGrantAuthority = {
    configured: verifier !== null,
    presented(headers) {
      const value = singleHeader(headers, "authorization");
      return typeof value === "string" && value.length < 8_192 && GRANT_PRESENTED.test(value.trim());
    },
    operationFor(method, rawUrl) {
      let pathname: string;
      try { pathname = new URL(rawUrl, "http://knowledge.invalid").pathname; } catch { return undefined; }
      return routeOperation(manifest, method.toUpperCase() === "HEAD" ? "GET" : method, pathname);
    },
    async admit(request) {
      if (!guard || !verifier) {
        options.audit?.record({ kind: "grant", outcome: "denied", status: 503, code: "portal_unconfigured" });
        return deny(503, "portal_unconfigured");
      }
      let checked;
      try {
        checked = await guard.check({ method: request.method, url: request.url, headers: request.headers });
      } catch {
        return deny(503, GRANT_ERROR_CODES.unavailable);
      }
      if (!checked.ok) {
        if ("skip" in checked && checked.skip) return deny(403, GRANT_ERROR_CODES.unknownOperation);
        const failure = checked as { status: 401 | 403 | 503; error: string; headers: Record<string, string> };
        if (failure.error === GRANT_ERROR_CODES.unknownOperation) {
          options.audit?.record({ kind: "grant", outcome: "denied", status: failure.status, code: failure.error });
        }
        return { ok: false, status: failure.status, error: failure.error, headers: failure.headers };
      }
      const { grant, operation } = checked.context;
      const record = (outcome: string, status: number | null, code: string | null, partition: string | null) =>
        options.audit?.record({ kind: "grant", operation: operation.id, actor: grant.agentId ?? grant.principal, partition, outcome, status, code }) ?? "";
      // Only agent principals reach Knowledge today; a companion app principal has no operation here.
      if (grant.principalKind !== "agent" || !grant.agentId) {
        record("denied", 403, GRANT_ERROR_CODES.notCompanion, null);
        return deny(403, GRANT_ERROR_CODES.notCompanion);
      }
      const claim = parseGrantPartitionClaim(grant.partitionKey);
      if (!claim.ok) {
        // Absent is not "default": a Portal that does not state the partition gets no access at all.
        const code = claim.reason === "absent" ? "partition_binding_required" : "partition_claim_invalid";
        record("denied", 403, code, null);
        return deny(403, code);
      }
      const reads = grantReadSet(grant, claim.partitionKey, grantReadPartitionKeys(grant, grantToken(request.headers), readSets));
      if (reads === null) {
        record("denied", 403, "partition_claim_invalid", null);
        return deny(403, "partition_claim_invalid");
      }
      const auditId = record("admitted", null, null, claim.partitionKey);
      return {
        ok: true,
        admitted: { operation: operation.id, agentId: grant.agentId, orgId: portal!.orgId, expiresAt: grant.expiresAt, partitionKey: claim.partitionKey,
          ...(reads ? { readPartitionKeys: reads } : {}), grant, auditId },
      };
    },
    async recheck(request, admitted) {
      if (!verifier) return null;
      try {
        const grant = await verifier.verifyGrant({ headers: request.headers });
        if (!grant.ok || !verifier.authorizeOperation(grant, admitted.operation).allowed) return null;
        const claim = parseGrantPartitionClaim(grant.partitionKey);
        if (!claim.ok || claim.partitionKey !== admitted.partitionKey) return null;
        // A read set edited mid-request never re-scopes it either.
        const reads = grantReadSet(grant, claim.partitionKey, grantReadPartitionKeys(grant, grantToken(request.headers), readSets));
        if (reads === null || !samePartitionSet(reads, admitted.readPartitionKeys)) return null;
        if (grant.principalKind !== "agent" || grant.agentId !== admitted.agentId) return null;
        return { ...admitted, expiresAt: grant.expiresAt, grant };
      } catch {
        return null;
      }
    },
    covers(admitted, operation) {
      return verifier?.authorizeOperation(admitted.grant, operation).allowed === true;
    },
    async verifyAny(request) {
      if (!verifier) return { ok: false, status: 503, error: "portal_unconfigured" };
      try {
        const grant = await verifier.verifyGrant({ headers: request.headers });
        if (grant.ok) return { ok: true };
        const decision = verifier.authorizeOperation(grant, manifest.operations[0]!.id);
        return decision.allowed ? { ok: false, status: 401, error: GRANT_ERROR_CODES.denied } : { ok: false, status: decision.status as 401 | 403 | 503, error: decision.error as string };
      } catch {
        return { ok: false, status: 503, error: GRANT_ERROR_CODES.unavailable };
      }
    },
    complete(auditId, status) {
      if (auditId) options.audit?.complete(auditId, status);
    },
  };
  return authority;
}
