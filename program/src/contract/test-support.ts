import { operationsAllowedBy, type Manifest } from "@tealbrick/contract";

export const PORTAL = { url: "https://portal.fixture.invalid", deploymentId: "dep-1", orgId: "org-1", tenantId: "ws-1", instanceProof: "p".repeat(40) } as const;
export const grantToken = (letter: string) => `tbag_${letter.repeat(43)}`;

export interface FakeGrant {
  readonly agentId?: string;
  readonly actions: readonly ("create" | "read" | "update" | "delete")[];
  /** Raw extras the Portal answer carries (for example partitionKey). */
  readonly extra?: Record<string, unknown>;
  /** Operation ids; defaults to every operation the actions cover (what Core's grant map yields). */
  readonly operations?: readonly string[];
  /** Leave `partitionKey` out of the answer, as Portal Core does today. By default the fake states `partitionKey: null`. */
  readonly omitPartitionKey?: boolean;
  readonly overrides?: Record<string, unknown>;
  readonly status?: number;
}

/** A fake Portal Core: POST /api/runtime/app-grant/introspect. Counts calls so tests can prove "never contacted". */
export function fakePortalFetch(manifest: Manifest, grants: Record<string, FakeGrant>) {
  const calls: { url: string; token: string; headers: Headers }[] = [];
  const fetchImpl = (async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
    const body = JSON.parse(String(init?.body ?? "{}")) as { token: string };
    calls.push({ url: String(input), token: body.token, headers: new Headers(init?.headers) });
    const grant = grants[body.token];
    if (!grant) return new Response('{"error":"app_grant_denied"}', { status: 403, headers: { "content-type": "application/json" } });
    if (grant.status) return new Response("{}", { status: grant.status });
    const agentId = grant.agentId ?? "agent-1";
    const answer: Record<string, unknown> = {
      authorized: true, principalId: `tealbrick-agent:${agentId}`, agentId, orgId: PORTAL.orgId, workspaceId: PORTAL.tenantId,
      deploymentId: PORTAL.deploymentId, product: "knowledge", productTenantId: PORTAL.tenantId,
      actions: grant.actions, operations: grant.operations ?? operationsAllowedBy(manifest, grant.actions),
      capabilityRevision: 1, expiresAt: Date.now() + 60_000, partitionKey: null, ...grant.extra, ...grant.overrides,
    };
    if (grant.omitPartitionKey) delete answer.partitionKey;
    return Response.json(answer);
  }) as typeof fetch;
  return { fetchImpl, calls };
}
