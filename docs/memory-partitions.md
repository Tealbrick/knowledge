# Per-edge memory partitions

Implemented source contract, 7 October 2026. Knowledge side of
Tealbrick/portal-core#38 (phase 1, same workspace only). This document does not
assert a deployment or human UAT.

A workspace owner can give each canvas edge to a Knowledge node its own memory
partition, for example `personal`. An agent on the `personal` edge never reads
or writes the workspace (`default`) data, and an agent on a default edge never
reaches `personal`.

## Claim

Portal sends `partitionKey` (the bare key) only for a non-default partition.
Knowledge consumes it from:

| Path | Field read by Knowledge |
| --- | --- |
| Portal attachments (instance edge) | `partitionKey` in every `/api/deployment-access/introspect` answer |
| Runtime principals (`tbkg_` grants) | `partitionKey` in the `/api/runtime/knowledge-principal/introspect` answer |

Knowledge does not decode the attachment JWT; Portal already fails introspection
with `deployment_grant_changed` when the JWT claim, the stored binding and the
current edge disagree. `partitionGrants[0].partitionKey` stays the workspace
`companyId`; Knowledge requires that and narrows it itself.

Rules:

- No claim: unchanged behaviour. The partition is
  `normalizeKnowledgePartitionKey(companyId)`.
- With a claim: the effective partition is
  `normalizeKnowledgePartitionKey(`${companyId}/${partitionKey}`)`.
- The key must match `^[a-z][a-z0-9-]{0,39}$` and must not be `default`.
  Anything else that is present (`null`, uppercase, `/`, `..`, too long, a
  non-string) fails closed (401 at the edge, a denied runtime principal). It
  never falls back to the default partition.
- All introspections for one request (extra Research capabilities, optional
  native capabilities and the dispatch re-check) must report the same key, or
  the request is denied.

## Isolation

Every agent grant is exact on the effective partition (`breadth: exact`,
`maxDepth: 0`). There is no parent or child access in either direction.

| Route family | Enforcement |
| --- | --- |
| `/api/companies/{companyId}/knowledge/collections\|search` (attachments) | The edge rewrites the workspace id to the partition. A `workspace/key` path is accepted only for the edge's own key. |
| `/api/knowledge/collections/{id}/documents`, `/api/knowledge/documents/{id}` (attachments) | The edge checks that the collection or document lives in exactly the edge's partition. |
| Runtime principals (all direct-runtime routes) | The principal's grant is exact on the partition. A selector that names the workspace id (path `companyId`, `companyId`/`partitionKey` query or body, Brain `scopeRef`) is narrowed to the partition; any other selector is denied. |
| `/api/brain/recall`, `/api/brain/context`, `/api/brain/entities` | The edge forces `partitionKey` (and `scopeRef`) to the partition. |
| `/api/brain/native/*` | The edge forces the partition; the minted bearer is exact on it. |
| Research engine routes | The minted Research bearer is exact on the partition. Notebooks of other partitions are not listed and return `notebook_scope_denied`. |

A partitioned caller may name its workspace id; that always means its own
partition. It never reaches the workspace data.

## Shared namespace

Edge keys share the hierarchical partition namespace: the edge partition
`personal` is the sub-partition `workspace/personal`. Therefore:

- The Program refuses to start when a static `KNOWLEDGE_SERVICE_PRINCIPALS`
  entry holds a `descendants` grant that reaches the direct children of the
  edge workspace (`KNOWLEDGE_COMPANY_ID`). Such a grant would see every edge
  partition. Use `exact` grants. The error names the principal and the grant.
- An exact static (Fleet) grant on `workspace/key` names the same storage as an
  edge with key `key`. Do not reuse a Fleet sub-partition name as an edge key.
- The owner listing shows only edge-key partitions: one segment under the
  workspace that matches the edge key grammar. Deeper keys and children that a
  static principal names are not shown.

## Storage and migration

Knowledge records were already partitioned by hierarchical `companyId`
(collections, documents, Research notebooks and sources, links and bindings).
A partition's records are stored under `companyId = workspace/key`. No column or
snapshot field was added.

- Existing rows keep `companyId = workspace` and belong to the default
  partition. The upgrade rewrites nothing, and it is forward-only and lossless.
- Owner requests (no principal) that name a `workspace/key` scope are
  canonicalised (lowercase, normalised) before the handler runs, so owner rows
  and agent rows land in the same partition. Top-level company ids are not
  changed.
- Document and collection IDs are global. Ownership checks always compare the
  record's partition, so an ID from another partition is denied.
- Deleting a partition in the Portal registry does not delete Knowledge data
  (`dataDeleted: false`). If the same key is registered again, that edge
  reaches the same data again.

## Engines

Each effective partition maps to its own engine scope through the existing
derivations. These derivations did not change, so default data keeps its IDs.

- GBrain source: `kb-` + first 24 hex characters of `sha256(partition)`.
- Hindsight bank: `tb-` + first 32 hex characters of
  `sha256("knowledge-partition:" + partition)`.
- Open Notebook: bindings are per Knowledge notebook and keyed by the notebook's
  partition. `KNOWLEDGE_OPEN_NOTEBOOK_BINDINGS` accepts a canonical
  `workspace/key` `companyId`. Knowledge does not create a partition notebook
  automatically.

A remote GBrain that uses `KNOWLEDGE_GBRAIN_PARTITION_TOKENS` needs a token for
each `workspace/key` partition. Without one, the partition reports
`brain_partition_binding_required`; it does not use another credential.

## Owner UI

The owner browser session keeps full access. The workspace card has a
**Memory partition** selector, with **Workspace (default)** selected by default.
The Memory view always sends its partition (`partitionKey`), including the
workspace itself, so the default view never mixes in edge partitions.
The options are the default, the partitions found in storage, and the keys in
`KNOWLEDGE_PARTITIONS` (an optional comma- or space-separated allowlist; an
invalid key stops startup). The list comes from the owner-only
`GET /api/companies/{companyId}/knowledge/partitions`. A principal gets 403
there; agents use `GET /api/knowledge/partitions`, which shows only their own
grant. With the default selected, Library and Research send the same requests
as before.

## Revocation bound

The instance caches a runtime principal for at most 5 seconds (or Portal's
shorter `expiresAt`). A partition or capability edit on the canvas reaches an
already-admitted `tbkg_` grant within 5 seconds. Attachments are introspected
on every request and re-checked at dispatch.

## Rollout gate (for Lead · Portal)

Knowledge advertises support on three surfaces. Portal reads the first one:

| Surface | Fields |
| --- | --- |
| `GET /healthz` (public, the recipe `healthPath`) | `capabilities.edgePartitions: true`, `partitionContract: 1` |
| `GET /api/status` | `capabilities.edgePartitions: true`, `partitionContract: 1` |
| `GET /bootstrap.json` | `capabilities.edgePartitions: true`, `partitionContract: 1` |

Portal must refuse to save or issue a partitioned edge (and must not send
`partitionKey`) unless `/healthz` answers `partitionContract >= 1`. An
instance without these fields is older than this contract.

Deploy this Knowledge release before Portal issues partitioned edges. An older
instance edge ignores `partitionKey` in the introspection answer and would
treat a partitioned attachment as a default one. An older Program rejects a
runtime-principal answer that contains `partitionKey`, which fails closed.
