import {
  GRANT_ERROR_CODES,
  APP_GRANT_INTROSPECT_PATH,
  createGrantGuard,
  createGrantVerifier,
  routeOperation,
  tokenDigest,
  type GrantResult,
  type GrantVerifier,
  type Manifest,
  type OperationAuditEvent,
} from "@tealbrick/contract";

import { parseEdgePartitionClaim } from "../partition-authority.js";
import type { ContractAudit } from "./audit.js";

/**
 * Agent access with Portal app grants (`tbag_`), verified by the contract kit.
 *
 * An agent reaches Knowledge through the Teal Brick connector with ONE Portal credential,
 * `Authorization: Bearer tbag_...`. The kit (`createGrantVerifier`, mode "l1", wire "app-grant-v1") asks Portal Core
 * `POST /api/runtime/app-grant/introspect` whether the grant is live and which manifest operations it covers.
 * This module adds what Knowledge needs on top of the kit and nothing else:
 *
 * - the per-edge memory partition (`partitionKey`) a grant may carry. The kit's app-grant parser refuses unknown
 *   answer keys, so the claim is read from the raw Portal answer by a thin `fetch` wrapper, removed before the kit
 *   parses it, and bound to the grant's digest. A present but malformed claim denies; it never falls back to the
 *   default partition. The grammar and the `<companyId>/<key>` binding are the attachment path's (partition-authority.ts).
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
const MAX_ENTRIES = 2_000;
const MAX_ANSWER_BYTES = 32_768;

function singleHeader(headers: Record<string, string | string[] | undefined>, name: string): string | undefined {
  const value = headers[name];
  return typeof value === "string" ? value : undefined;
}

const isRecord = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value);

type PartitionEntry = { readonly claim: ReturnType<typeof parseEdgePartitionClaim>; readonly until: number };

/** Wraps fetch for the kit: lifts `partitionKey` out of the Portal answer so the kit's strict parser accepts it. */
function partitionCapturingFetch(base: typeof fetch, sink: Map<string, PartitionEntry>, now: () => number): typeof fetch {
  return (async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
    const response = await base(input, init);
    if (!response.ok) return response;
    let token: unknown;
    try { token = JSON.parse(String(init?.body ?? "")).token; } catch { token = undefined; }
    const text = await response.text();
    const passthrough = () => new Response(text, { status: response.status, headers: { "content-type": response.headers.get("content-type") ?? "application/json" } });
    if (typeof token !== "string" || text.length > MAX_ANSWER_BYTES) return passthrough();
    let data: unknown;
    try { data = JSON.parse(text); } catch { return passthrough(); }
    if (!isRecord(data)) return passthrough();
    const claim = parseEdgePartitionClaim(data);
    const { partitionKey: _removed, ...rest } = data;
    const expiresAt = typeof data.expiresAt === "number" && Number.isFinite(data.expiresAt) ? data.expiresAt : now() + 60_000;
    if (sink.size >= MAX_ENTRIES) {
      for (const [key, entry] of sink) if (entry.until <= now()) sink.delete(key);
      while (sink.size >= MAX_ENTRIES) sink.delete(sink.keys().next().value as string);
    }
    sink.set(tokenDigest(token), { claim, until: Math.max(expiresAt, now()) + 5_000 });
    return new Response(JSON.stringify(rest), { status: response.status, headers: { "content-type": "application/json" } });
  }) as typeof fetch;
}

const deny = (status: 401 | 403 | 503, error: string): AppGrantAdmission => ({
  ok: false, status, error, headers: status === 401 ? { "www-authenticate": 'Bearer error="invalid_token"' } : {},
});

export function createAppGrantAuthority(options: AppGrantOptions): AppGrantAuthority {
  const { manifest, portal } = options;
  const now = options.now ?? Date.now;
  const sink = new Map<string, PartitionEntry>();
  let verifier: GrantVerifier | null = null;
  if (portal) {
    try {
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
          fetch: partitionCapturingFetch(options.fetch ?? fetch, sink, now),
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

  const partitionFor = (headers: Record<string, string | string[] | undefined>): PartitionEntry["claim"] | null => {
    const token = /^Bearer\s+(\S+)$/u.exec(singleHeader(headers, "authorization")?.trim() ?? "")?.[1];
    const entry = token ? sink.get(tokenDigest(token)) : undefined;
    return entry && entry.until > now() ? entry.claim : null;
  };

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
      const claim = partitionFor(request.headers);
      if (!claim || !claim.ok) {
        record("denied", 403, "partition_claim_invalid", null);
        return deny(403, "partition_claim_invalid");
      }
      const auditId = record("admitted", null, null, claim.partitionKey);
      return {
        ok: true,
        admitted: { operation: operation.id, agentId: grant.agentId, orgId: portal!.orgId, expiresAt: grant.expiresAt, partitionKey: claim.partitionKey, grant, auditId },
      };
    },
    async recheck(request, admitted) {
      if (!verifier) return null;
      try {
        const grant = await verifier.verifyGrant({ headers: request.headers });
        if (!grant.ok || !verifier.authorizeOperation(grant, admitted.operation).allowed) return null;
        const claim = partitionFor(request.headers);
        if (!claim || !claim.ok || claim.partitionKey !== admitted.partitionKey) return null;
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
