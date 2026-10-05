# Customer runtime authorization

Implemented source contract, 17 September 2026. This document does not assert a
deployment, licence purchase, real agent acceptance, or human UAT.

## Portal-validated runtime principals (default for Portal-provisioned instances)

Implemented source contract, 4 October 2026 (Tealbrick runtime-principal-v1).
When `TEALBRICK_PORTAL_URL`, `KNOWLEDGE_COMPANY_ID` and
`KNOWLEDGE_PORTAL_ORG_ID` are set (Portal sets them at provisioning), the edge
and Program also accept `Authorization: Bearer tbkg_<43 chars>`: a 15-minute,
instance-bound grant that Portal mints for an agent whose saved canvas tether to
this Knowledge node carries CRUD actions. No per-agent environment variable or
redeploy is involved.

- Only bearers matching `tbkg_` are ever sent to Portal; static service tokens
  and unknown bearers never leave the instance.
- On a cache miss the instance POSTs `{token, instanceId, companyId, proof}` to
  `<portal>/api/runtime/knowledge-principal/introspect`. `proof` is a 60-second
  EdDSA JWT signed by this instance's claim key (`instance-claim-identity.json`),
  bound to the Portal audience, instance, company and the grant's SHA-256 digest.
  Portal verifies it with the public key registered when the app was claimed.
- Portal recomputes the answer from live state on every introspection: saved
  canvas wire, licence, agent, app registration, runtime connection and runtime
  credential. Canvas CRUD maps one-to-one onto `knowledge:create|read|update|delete`;
  read also grants `brain:read`. `brain:write` and `research:*` are never derived.
- The answer must name this instance, company and Portal organization, and carry
  exactly one `exact`, depth-0 grant on this instance's partition no wider than
  the principal; anything else is rejected. Positive answers are cached for at
  most 30 seconds (or Portal's shorter `expiresAt`), explicit denials (401/403)
  for 5 seconds in a separate cache, and Portal errors, rate limits and outages
  are not cached. Revocation therefore takes effect within 30 s.
- Only requests on the direct-runtime route allowlist can trigger an
  introspection, and at most 32 run concurrently; above that, lookups fail
  closed. Static principals may not use the reserved `tealbrick-agent:` prefix.
- The resolved principal (`tealbrick-agent:<agentId>`) is an ordinary service
  principal: route admission, partition authorization, per-operation capability
  checks and actor provenance are unchanged.
- `KNOWLEDGE_PORTAL_PRINCIPALS=off` disables this path; `on` makes the missing
  Portal binding a startup error. `KNOWLEDGE_SERVICE_PRINCIPALS` remains for
  operator-managed service credentials.
- A Portal-bound instance can be claimed for its bound company before any static
  principal or data exists.

## Direct admission and grants

The container admits `Authorization: Bearer <Knowledge service-principal token>`
only after resolving that token against `KNOWLEDGE_SERVICE_PRINCIPALS`, and only
to the route allowlist below. The Program independently validates the operation
and resource partition. Neither an agent label, forwarded identity header, Portal
token nor the presence of a bearer header grants authority.

Generate a distinct high-entropy token of at least 32 characters per agent and
keep it in the customer runtime's secret store. The existing resolver accepts
nonempty legacy tokens for compatibility; this is not permission to provision
weak customer credentials. Never reuse or deliver the instance recovery token.

Example server-side configuration, with a placeholder token:

```json
[
  {
    "token": "<random-customer-runtime-secret>",
    "principalId": "example-agent",
    "companyId": "example-workspace",
    "capabilities": ["knowledge:create", "knowledge:read"],
    "partitionGrants": [
      {
        "partitionKey": "example-workspace",
        "breadth": "exact",
        "maxDepth": 0,
        "capabilities": ["knowledge:create", "knowledge:read"]
      }
    ]
  }
]
```

Each additional agent uses a separate principal, token and explicitly granted
partition or instance. Existing `another-workspace` access requires an explicit permitted grant;
pairing never renames or automatically shares that existing scope.

All sixteen CRUD subsets are valid, including none. `knowledge:write` remains an
explicit compatibility alias for Create/Update/Delete, never Read. Both the
principal capability ceiling and matching partition ceiling must permit the
operation. A narrower partition ceiling still limits a legacy writer.

Configured bearer requests are always checked, including when
`KNOWLEDGE_PARTITION_AUTH_REQUIRED=false` retains the operator/browser legacy
path. The flag requires a bearer on the general Program domain when true; do not
enable it blindly on an existing browser deployment. Mapped Research keeps its
existing independent bearer/session/mapping checks. Static principal changes,
including revocation, become effective at a controlled Program restart.

The trusted customer connector verifies its short-lived signed Portal config
and entitlement independently and intersects those grants with this app-local
ceiling. Knowledge does not introspect hosted Portal for these direct calls and
does not claim to verify that Portal configuration itself. No licence is implied
by app-token admission.

## Initial direct route surface

Company path identifiers in this initial edge allowlist are simple alphanumeric,
underscore, dot, colon or hyphen identifiers; use separate flat customer test
partitions. Encoded path separators/traversal are rejected. Internal partition
grants continue to support the existing hierarchical model.

| Method and route | Required app capability | Request |
| --- | --- | --- |
| GET `/api/knowledge/partitions` | Valid principal | Returns own configured non-secret grants |
| GET `/api/companies/:companyId/knowledge/collections` | `knowledge:read` | Does not create a default collection for scoped readers |
| POST same | `knowledge:create` | `{ "name": "...", "description": "..." }`; agent-created collections are native |
| GET `/api/companies/:companyId/knowledge/search` | `knowledge:read` | Existing search query contract |
| DELETE `/api/knowledge/collections/:collectionId` | `knowledge:delete` | No body |
| GET `/api/knowledge/collections/:collectionId/tree` | `knowledge:read` | No body |
| POST `/api/knowledge/collections/:collectionId/documents` | `knowledge:create` | `{ "title": "...", "body": "...", "bodyFormat": "markdown" }` |
| GET `/api/knowledge/documents/:documentId` | `knowledge:read` | No body |
| PATCH same | `knowledge:update` | Supported document fields such as `{ "title": "...", "body": "..." }` |
| DELETE same | `knowledge:delete` | No body |
| GET `/api/knowledge/documents/:documentId/revisions` | `knowledge:read` | No body |
| GET `/api/research/engine/notebooks` | `research:read` | Existing mapped notebook discovery contract |
| GET/POST `/api/research/notebooks/:notebookId/engine/...` | Existing `research:read`/`research:write` contract | Mapping, ownership and idempotency/receipt checks unchanged |
| GET `/api/brain/entities`, POST `/api/brain/context`, POST `/api/brain/recall` | `brain:read` | Explicit permitted `companyId`/`partitionKey`/`scopeRef` |

The direct edge does not expose global status/events, generic collection listing,
Boardstate/admin routes, access-policy mutation, repository source configuration,
ingest or extraction. Those remain separate explicitly governed/operator paths.
Do not advertise unsupported tools as effective connector capabilities.

Document create/update provenance uses the authenticated principal even when a
caller supplies a different `actor`. Cross-partition objects, parent references,
and conflicting selectors fail closed. Update-only/Delete-only responses expose
`{id, updated:true}` / `{id, deleted:true}` receipts, not existing document content.
Follow-up receipt hardening extends this rule to collection deletion
(`{id, deleted:true}`). Internal access-policy PUT and owner-binding POST remain
excluded by the direct-runtime edge; they nevertheless return bounded receipts
for configured no-Read principals: `{documentId, updated:true}`, or
`{id, documentId, bound:true}` / `{id, collectionId, bound:true}`. The independent
Read check respects both principal and partition-grant ceilings. Read-authorized
and unscoped operator responses are unchanged. See the canary evidence document
for the source/runtime deployment boundary.
Omit `Content-Type: application/json` when sending no body, including DELETE.

## Existing-instance operator claim

Only a trusted customer operator using `X-Knowledge-Instance-Token` may call the
claim endpoint. Agent bearer and browser-session authority cannot sign. Requests
with browser `Origin` or `Cookie` headers are rejected even with the instance
header. Do not send that instance token to Portal.

1. GET `/api/tealbrick/claim` returns `{instanceId, publicJwk}`. Pin these public
   fields into the operator's Portal registration challenge alongside the
   selected workspace/node/binding and internal company scope.
2. Portal supplies a nonce; POST `/api/tealbrick/claim` with exactly
   `{portalIssuer, nonce, companyId}`. Issuer is a canonical HTTPS origin
   (loopback HTTP is permitted for fixtures), nonce is 16–256 base64url characters,
   and companyId must already exist locally or be an explicitly configured
   principal/grant scope. Scope existence checks never create a default record.
3. Send only the returned proof/public identity metadata to Portal. Portal must
   verify the pinned key, nonce, audience, scope, instance, expiry, owner-bound
   challenge and one-time challenge use.

The result is `{proof, publicJwk, instanceId, companyId}`. The compact JWT header
is `{alg:"EdDSA", typ:"JWT"}`; payload is:

```json
{
  "typ": "tealbrick-app-claim",
  "version": 1,
  "aud": "https://portal.example",
  "nonce": "<challenge nonce>",
  "instanceId": "<persistent UUID>",
  "companyId": "example-workspace",
  "iat": 0,
  "exp": 300
}
```

Actual timestamps use current Unix seconds, with a fixed 300-second lifetime.
Ed25519 private key and instance ID persist in
`$KNOWLEDGE_DATA_DIR/instance-claim-identity.json` with mode 0600. Unsafe permission
or malformed identity storage fails startup. Back up this identity with the
instance data; it is distinct from principal tokens, Research secrets and
entitlements. App signing proves operator-controlled instance/scope metadata,
not software purchase or an agent grant.

## Audit and diagnostics

The Program writes customer-local bounded metadata to
`$KNOWLEDGE_DATA_DIR/authorization-audit.sqlite`, separate from domain snapshots
and Research ledgers. It keeps the latest 10,000 entries, mode 0600, with random
event ID, time, attested principal, partition, registered route template,
operation capability, admission/denial and response status. No token, URL query,
request body, document content or arbitrary request headers are recorded.

General scoped admission writes fail closed if the initial audit write fails.
A completion-write failure cannot undo a dispatched operation and is logged as
a fixed metadata event. Mapped Research retains its existing authorization flow
and completion audit; it does not gain a new atomic cross-ledger guarantee.
Edge-rejected unknown tokens/routes do not reach this Program audit. The local
connector must also audit its own config/grant denials; this database is not a
complete cross-system trace by itself.

Fastify logs registered route templates/methods rather than raw URLs or request
bodies, and redacts error messages/stacks and headers. No content-bearing
diagnostics are automatically shipped to Portal.

## Verification

From `program`, run `corepack pnpm@9.15.4 typecheck` and
`corepack pnpm@9.15.4 test:program`. From the repository root, run:

```sh
node --test deploy/container/edge.test.mjs \
  deploy/container/browser-auth.test.mjs \
  deploy/container/browser-edge.test.mjs \
  deploy/container/customer-runtime-edge.test.mjs
```

Disposable tests cover all sixteen CRUD subsets both with and without mandatory
general bearer mode, cross-partition denial, principal-vs-actor provenance,
no-read mutation confidentiality, no implicit collection creation on Read,
raw-route/forwarded-header bypass, actual container-edge behavior, separate
Research grants, claim-admin isolation, proof signature/metadata/expiry,
identity persistence, static-token removal after restart, metadata audit
persistence/bounds and synthetic secret/content marker absence from logs.
