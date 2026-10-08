# Teal Brick miniapp contract

Knowledge ships one release manifest, [`tealbrick.app.json`](../tealbrick.app.json)
(schema `tealbrick.miniapp/v1`), and serves the standard control endpoints of
`@tealbrick/contract` **0.1.0-alpha.3** (pinned exactly in `program/package.json`).
Portal, the connector and the desktop app read the manifest instead of knowing
Knowledge by name. The older internal descriptor, [`manifest.json`](../manifest.json), is
marked `legacy-descriptor` and is kept only for tools that still read it.

Nothing here changes how existing agents work: Portal **attachments**
(`Authorization: Bearer <attachment>` plus `X-Tealbrick-Agent-Token`, introspected at
`/api/deployment-access/introspect`) and Portal **runtime principals** (`tbkg_`) keep
their routes, scoping and answers. The contract adds a third way in, Portal **app
grants** (`tbag_`), and the control endpoints.

## Manifest

- `kind: "bridge"`, `upstream`: GBrain `0.48.2.0`, MIT. GBrain is vendored and embedded in
  the image (`sidecars/gbrain`), so the manifest declares no GBrain sidecar. The
  contract validator therefore has no sidecar image to match the pin against, and says nothing.
- `runtime.sidecars` is **not** declared. Open Notebook and SurrealDB must share one generated
  password, and alpha.3 cannot express a secret shared between two sidecars. The Railway
  template keeps its three-service topology (see `deploy/container/RAILWAY.md`). This is
  pending contract alpha.4 (`runtime.secrets`, `fromSecret`, sidecar address references,
  `dependsOn`, `healthcheck`, per-sidecar `upstream`). Until then Open Notebook stays
  an env-configured upstream (`KNOWLEDGE_OPEN_NOTEBOOK_*`). The optional Hindsight memory engine
  (`KNOWLEDGE_MEMORY_ENGINE=hindsight`) is likewise env-configured and not declared.
- Instance, tenant and principal variables are the contract names (`TEALBRICK_INSTANCE_TOKEN`,
  `TEALBRICK_TENANT_ID`, `TEALBRICK_PORTAL_ORG_ID`, `TEALBRICK_SERVICE_PRINCIPALS`). The edge treats
  each as the same setting as its Knowledge name (`KNOWLEDGE_INSTANCE_TOKEN`, `KNOWLEDGE_COMPANY_ID`,
  `KNOWLEDGE_PORTAL_ORG_ID`, `KNOWLEDGE_SERVICE_PRINCIPALS`): set either, and both are filled. Two
  different values for one pair stop startup (the message names the variables, never a value).
  `env.allow` lists the existing `KNOWLEDGE_*` Portal variables, the Rules and Open Notebook variables,
  `TEALBRICK_PORTAL_INSTANCE_PROOF` and `TEALBRICK_EMERGENCY_CODE`.
- The release version is the same in `tealbrick.app.json`, `manifest.json` and `program/package.json`
  (a test fails otherwise). The image workflow checks it against the release tag and runs the validator.

```sh
npx --yes @tealbrick/contract@0.1.0-alpha.3 validate tealbrick.app.json \
  --companion path/to/rules-approvals/tealbrick.app.json
```

## Operations

Ids are `knowledge.<resource>.<verb>`. 31 operations: **24 agent**, **7 owner**. Every agent
operation maps onto the same structural route and Portal capability the attachment path uses
(`deploy/container/attachment-auth.mjs`); a test fails if a manifest path and that route table drift.

| Group | Operations (agent) | CRUD |
| --- | --- | --- |
| Documents | `collections.list`, `collections.create`, `documents.search`, `documents.create`, `documents.get` | read; create |
| Brain recall | `brain.context`, `brain.recall`, `brain.entities` (POSTs that only read) | read |
| Memory engine | `engine.tools`, `engine.read` (`POST /api/brain/native/{operation}`), `engine.write` (`POST /api/brain/native/write/{operation}`) | read; create+update+delete |
| Research | `research-notebooks.list/get`, `research-sources.list/get/add/receipt-get`, `research-notes.list/get`, `research-context.get`, `research-chat.session-create/session-get/ask/receipt-get` | read; create (`ask`: create+read) |

- **Engine read and write are two operations** because the manifest cannot classify one path by
  the tool called. A read tool through `engine.write`, or a write tool through `engine.read`, is
  refused (403 `operation_not_granted`). The write alias is the native route itself on the Program; the edge
  rewrites it. `engine.tools` lists write tools only when the same grant also covers `engine.write`.
  `engine.write` needs create, update and delete because the engine write surface spans all three.
- **Owner operations** (`audience: "owner"`) stay in the manifest so Portal, conformance and docs see the
  full list, and are never granted: `documents.update`, `documents.delete`, `documents.access-update`,
  `collections.delete`, `research-notebooks.delete`, `research-sources.delete`, `models.update`. The owner
  reaches them through the app's own session. A grant that lists one is refused with 403
  `{"error":"operation_owner_only"}`.
- **Idempotency.** Research creates already keep durable ledgers in the Program and need an
  `Idempotency-Key`. For `collections.create`, `documents.create` and `engine.write` the edge keeps a ledger
  (`edge-idempotency.sqlite` on the volume): same key and body replays the first answer, the same key with
  another body is 409 `idempotency_key_conflict`, a request still running or whose outcome was never recorded is
  409 `idempotency_in_progress` / `idempotency_outcome_unknown` (never run twice), and a failed answer is not stored.
  Keys are scoped to agent, partition and operation and expire after a day.
- **Not in the manifest, because the routes do not exist yet:** creating notebooks, deleting sources as an agent,
  and promoting a research answer into a document (planned with the Open Notebook research workspace). Document update/delete and
  collection delete exist, but only for the owner session and the older `tbkg_`/static-principal path, so they are owner operations.

## Control endpoints

All served by the contract kit at the edge (`deploy/container/server.ts`, `program/src/contract/`).

| Endpoint | Auth | Notes |
| --- | --- | --- |
| `GET /healthz` | none | `{ok, app, version, major}` plus `service`, `partitionContract`, `capabilities` (see "Known deviation") |
| `GET /.well-known/tealbrick/manifest` | none | the release manifest |
| `GET/POST /.well-known/tealbrick/claim`, `/api/tealbrick/claim` | instance token (Bearer or `X-Knowledge-Instance-Token`) | **one** Ed25519 identity (`instance-claim-identity.json`, never regenerated); browser Origin/Cookie get 403; the first claim pins issuer and tenant in `contract-claim.json`; another issuer or tenant is 409 |
| `GET /.well-known/tealbrick/status` | instance token or settings bearer | `{ok, app, setup, settingsRevision, version}`; `setup`: `starting` while the engine starts, `needs-settings` without models, `unavailable` when configured models have no running engine, else `configured` |
| `GET/PUT /.well-known/tealbrick/settings` | settings bearer (5 min) or instance token or emergency session | the Settings → Models form, below |
| `GET /.well-known/tealbrick/companions` | instance token | Rules binding as the app sees it |
| `GET /.well-known/tealbrick/guidance/1` | any live agent grant | usage guide |
| `POST /auth/launch` | single-use Portal ticket | below |
| `POST /auth/emergency`, `/logout`, `GET /session` | emergency code | below |

Without a configured workspace (`TEALBRICK_TENANT_ID` / `KNOWLEDGE_COMPANY_ID`) the claim stays with the
earlier handler, unchanged (including its `{proof, publicJwk, instanceId, companyId}` answer).
With a workspace the kit answers both claim paths with `{proof}`; Portal Core reads only `proof` and takes
the key from the `GET`.

### Settings

Fields mirror Settings → Models (chat, embedding and reranker: provider, endpoint, model, API key, plus reasoning
effort and vector size). API keys are write-only (`{set, updatedAt}`). The write goes through the same Program
route as the owner UI (`PUT /api/settings/models`: provider readiness probes, engine restart, Research sync), so a
wrong endpoint or key is 422 with per-component `checks` and nothing changes. A model configuration is only valid whole, so a
write that does not complete it (a form that sends one field at a time) is **staged** in
`model-settings.pending.json` (mode 0600) and applied the moment it is complete. The account-sourced provider keys (`providers.openaiApiKey` -> `OPENAI_API_KEY`, `providers.anthropicApiKey` ->
`ANTHROPIC_API_KEY`, `providers.googleApiKey` -> `GOOGLE_GENERATIVE_AI_API_KEY`; all `source: "account"`,
`destination: "provider-env"`) are written by Portal Connections as shared variables of the hosting provider. They are
never written through this endpoint (a `PUT` naming one is 400); a `GET` reports presence only
(`account: {"<key>": {source: "account", set}}`), never a value.

**Models from provider keys.** When the owner has saved no Settings → Models, Knowledge builds its model configuration
from those variables at boot. Precedence: **saved Settings → Models, then provider environment, then not configured.**
Chat prefers Anthropic, then OpenAI, then Google (`claude-sonnet-5`, `gpt-4.1-mini`, `gemini-2.5-flash`). Embeddings prefer
OpenAI (`text-embedding-3-small`, 1536), then Google (`gemini-embedding-2`, 768); Anthropic has no embeddings API, so an
Anthropic-only account stays not configured (`issue: "embedding_provider_required"`) until an OpenAI or Google key is
connected or the owner sets models up. A brain that already exists keeps its embedding model: if that provider's key is
gone the configuration is withheld (`embedding_key_missing`) instead of switching vector spaces. The values stay in
process memory: nothing is written to the data volume, logged or returned. `GET /api/settings/models` reports
`source`: `knowledge-settings`, `provider-env` (connections carry `keySource: "provider-env"`) or `not-configured`.
A save in Settings → Models never reuses a provider-env key (the owner enters the key) and from then on takes precedence.

## Agent grants

`Authorization: Bearer tbag_...` is verified by the kit (`createGrantVerifier`, mode `l1`, wire `app-grant-v1`) against
Portal Core `POST /api/runtime/app-grant/introspect`, live at admission **and again at dispatch** (the kit cache is off),
so a revocation or a re-scoped edge cannot be outlived by a slow upload. Then the request goes through the
unchanged attachment admission: the same collection/document ownership checks, body-field allow-lists, Brain scope
rewrite and per-request Research/engine bearer.

- **Partition binding (fail closed).** The grant answer must state the per-edge memory partition. `partitionKey: "<key>"`
  is validated with the attachment grammar and binds to `<companyId>/<key>` exactly as an attachment does; the default edge
  never reaches a child, a child never reaches the default or a sibling. An explicit `partitionKey: null` is the default
  company scope. An **absent** `partitionKey` is refused with 403 `partition_binding_required` and never falls back to the
  default or unpartitioned scope; a present but malformed claim is refused with 403 `partition_claim_invalid`. The same
  check runs again at dispatch. **`tbag_` grants are refused until Core sends `partitionKey`; agents keep the
  attachment-grant path meanwhile** (the attachment path is unchanged). The kit's strict app-grant parser rejects unknown
  answer keys, so a thin `fetch` wrapper lifts the claim out of the raw answer before the kit parses it
  (`program/src/contract/app-grants.ts`).
- **Errors** (kit codes): 401 `grant_required|grant_invalid|grant_expired|grant_denied|grant_revoked`; 403
  `operation_not_granted|operation_unknown|operation_owner_only|companion_not_declared`; 503
  `grant_verification_unavailable|portal_unconfigured`. Knowledge adds 403 `partition_claim_invalid`, 403 `partition_binding_required`, 403
  `request_denied` (a path or selector for another partition), 404 `not_found` (an id that is absent **or** in another
  partition, so existence does not leak) and 404 `operation_not_found` (no such engine tool).
- **Audit.** `contract-audit.sqlite` on the volume, metadata only: kind, operation, agent id, partition, outcome, status,
  error code. Never a token, payload, setting value or free text. Emergency logins and launches are audited there too.
- L2 (the signed grant JWT) is not enabled: Portal Core does not mint it yet. The kit's L2 verifier is a drop-in
  once the claim carries `jwksUri` (`l2GrantOptionsFromClaim`).

## Framing (Portal settings view)

Portal's canvas settings view iframes the deployed app's own standalone settings page (`/?view=settings`). The manifest
sets `frontend.embed` to `{"allowed": true, "frameAncestors": "portal-origins"}`. Every HTML page the app serves answers
with `frame-ancestors 'self' <Portal origin>`, where the origin is derived from `TEALBRICK_PORTAL_URL` (origin only, no
path; `'self'` only when it is unset or unusable; never `*`). The web shell (`/`, `/embed`) and the "session ended" page of
the browser edge both carry it: a framed navigation whose session expired lands on the session page, so it must be
frameable by Portal too (its Portal link already targets the top window). No other page is HTML.

## Launch and emergency access

- `POST /auth/launch` keeps the Portal ticket flow and the HttpOnly `knowledge_browser` session. New: a form `route` must be a
  manifest `frontend.routes` entry (`/?view=library`, `/?view=settings`) and is kept exactly, else 400 `invalid_route`; a
  `route` stated by Portal in the redeem answer wins. A foreign or missing Origin is 403 `launch_origin_required` (was 401).
  A ticket is also refused locally on replay. `purpose: "settings"` (Portal's server-side relay, JSON or form, no browser Origin)
  returns `{tokenType, settingsBearer, expiresAt, purpose, workspaceId}` (5 minutes, never a cookie), accepted only by the status and settings endpoints.
- When the deployment has a separate app-to-Portal proof (`TEALBRICK_PORTAL_INSTANCE_PROOF`) only that goes out, in
  `X-Tealbrick-Instance-Proof`; otherwise the instance token goes out as before (legacy header, and the same value in the generic header).
- **Emergency code.** `TEALBRICK_EMERGENCY_CODE` (random, at least 128 bits, generated by the deployer, never stored by
  Portal; a weak code stops startup) enables `POST /auth/emergency`: one owner session of 15 minutes, once per session, audited,
  rate limited per client (the right-most `X-Forwarded-For` entry, one trusted proxy) with a global backstop of failed attempts
  while a correct code is still accepted. The app shows an "Emergency access" banner for the whole session and the relaunch page
  offers the code form. Rotate by redeploying with a new value. Unset, the routes answer 404.

## Companions

`rules-approvals` is a soft companion (`enhances`). Knowledge already evaluates governed writes at the Rules gateway
(`KNOWLEDGE_RULES_*` / `RULES_*`), so it declares one unlock, `knowledge.rules.governed-writes`, requiring the edge
`knowledge → rules-approvals` with create+read on `rules-approvals.gateway.evaluate`. The earlier `dependencies` on
other apps are dropped: Knowledge needs none. The "governed promotion" unlock of the contract waits for the promote route above.
Portal does not send effective unlocks yet, so none is reported effective.

## Conformance

```sh
tealbrick-conformance portal --manifest tealbrick.app.json --port 28550 --env-out .conformance.env &
set -a; . ./.conformance.env; set +a
# the app: the real edge, on a fresh data directory, with the fake-Portal environment
cd program && PORT=28551 HOST=127.0.0.1 KNOWLEDGE_DATA_DIR=/tmp/knowledge-conformance KNOWLEDGE_GBRAIN_AUTOSTART=false \
  TEALBRICK_EMERGENCY_CODE="$(node -p "require('@tealbrick/contract').generateEmergencyCode()")" \
  node --import tsx ../deploy/container/server.ts &
tealbrick-conformance run --app http://127.0.0.1:28551 --manifest tealbrick.app.json --companion path/to/rules-approvals/tealbrick.app.json \
  --audit-command "sqlite3 -json /tmp/knowledge-conformance/contract-audit.sqlite 'select * from contract_audit'" --slow --json
```

Result with `@tealbrick/conformance` 0.1.0-alpha.1 (with the Rules companion descriptor): 25 pass, 1 fail, 11 skip.

**Known deviation, `control.healthz`.** The check wants `/healthz` to be exactly `{ok, app, version, major}`. Knowledge
also answers `service`, `partitionContract` and `capabilities.edgePartitions`, because Portal Core reads those
from the public `/healthz` to decide whether it may save a partitioned edge. Dropping them would make Core
refuse every partitioned edge. The fields go when Core reads partition support from the manifest or an authenticated endpoint.

The other skips are the checks the runner cannot run against an app alone (connector, desktop, runtime-config ack, unlocks,
account tokens, Portal logout, human UI states), plus L2.

## For Portal and the packages

- The manifest carries everything the Knowledge-specific adapters derived: operations with CRUD and audience, settings, routes,
  claim path and tenant variable. The attachment and runtime-principal paths still work and are not deprecated here; remove
  Portal's Knowledge adapters only after agents move to `tbag_` grants.
- For a deployment Portal registers as a manifest app, Core should set `TEALBRICK_TENANT_ID`, `TEALBRICK_INSTANCE_TOKEN` and
  `TEALBRICK_PORTAL_ORG_ID` (or keep the Knowledge names; both work). The redeem answer may name the workspace as `companyId` (today)
  or `productTenantId`; both are accepted, and it must equal the bound workspace.
- Core may add `partitionKey` to the app-grant answer for a partitioned edge. Until the kit's parser accepts the key natively, the
  thin wrapper described above carries it.
