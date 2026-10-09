# Per-edge memory partitions

Implemented source contract, 7 October 2026 (contract 1) and 9 October 2026
(contract 2, read-many / write-one). Knowledge side of Tealbrick/portal-core#38
(phase 1, same workspace only) and of the "one Knowledge, walled views per agent"
decision. This document does not assert a deployment or human UAT.

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
| Research engine routes | The minted Research bearer is exact on the partition. Notebooks of other partitions are not listed and answer 404 `not_found`, like a notebook that does not exist. |

A partitioned caller may name its workspace id; that always means its own
partition. It never reaches the workspace data.

## Contract 2: read sets (read-many / write-one)

`tealbrick.app.json` declares `runtime.partitions: {"contract": 2}`. An edge can
then also carry a read set: Portal sends `readPartitionKeys` next to
`partitionKey`, on the same three paths:

| Path | Field read by Knowledge |
| --- | --- |
| Portal attachments | `readPartitionKeys` in every `/api/deployment-access/introspect` answer |
| App grants (`tbag_`) | `readPartitionKeys` in the `/api/runtime/app-grant/introspect` answer (`GrantResult.readPartitionKeys`, `effectiveReadPartitions` of `@tealbrick/contract` 0.1.0-alpha.5) |
| Runtime principals (`tbkg_`) | `readPartitionKeys` in the `/api/runtime/knowledge-principal/introspect` answer |

Rules:

- `partitionKey` stays the write partition. `readPartitionKeys` lists 1 to 64
  unique entries; each is `null` (the workspace default partition) or an edge
  key with the grammar above. It must contain the write key. Anything else
  fails closed, like a malformed `partitionKey`.
- No `readPartitionKeys`, or a read set that is exactly the write key, is the
  contract 1 grant. It takes the contract 1 code path and gets the same
  answers, byte for byte.
- All introspections of one request (extra Research capabilities, optional
  native capabilities, the dispatch re-check) must report the same write key
  and the same read set, or the request is denied.

The principal of such an edge has an exact grant on the write partition with
all its capabilities, plus an exact, read-only grant on each other partition of
the read set (`knowledge:read`, `brain:read`, `research:read`,
`brain:native:read` only). `GET /api/knowledge/partitions` lists them.

Behaviour:

| Surface | Contract 2 |
| --- | --- |
| Writes: create, update and delete of documents and collections, Research sources, chat sessions and turns, memory-engine writes, `extract-facts` | Write partition only. A selector that names another partition is refused (403); an object of another partition answers 404 `not_found`. |
| `collections` (list), `search` | A request that names the workspace (or the write partition) covers every partition of the read set. Naming one read partition (`workspace/key`) covers only that one. Search within a collection of a read partition reads that partition. |
| `documents/{id}`, `collections/{id}`, trees, revisions | Readable when the object lives in any partition of the read set. |
| Research notebooks, sources, notes, context, chat sessions | Notebooks of every read partition are listed and readable; writes (sources, chat sessions, turns, receipts) only in notebooks of the write partition. |
| `/api/brain/recall`, `/api/brain/context`, `/api/brain/entities` | One engine call per read partition (its own GBrain source or Hindsight bank, derived as for one partition), merged. An entity by slug is read from the first read partition that has it. |
| `/api/brain/native/*` reads | Lookups, lists and searches (for example `recall`, `search`, `get_page`, `recall_memories`, `list_documents`) run once per read partition and merge. Reads that keep state or spend model budget (`delta`, `context_pack`, `synthesize`, `think`, `reflect` and the other administration views) run in one partition: the write partition, or the read partition named in `partitionKey`. |

Merge rule (`program/src/brain-read-view.ts`): when every item has a numeric
engine score, items are ordered by score, highest first, ties by read-set order
(write partition first) and then by the engine's order. Otherwise the lists
are interleaved by rank. Exact duplicates are dropped, and the result is capped
at the requested `limit`. The partition of each item is kept internally and is
never added to an answer. Only partitions of the read set are ever queried. A
merged Program answer is `ok` only when every partition answered; the answers
of the partitions that did answer are still merged. A native lookup that is
not a list takes the first partition that answers.

At the instance edge, contract 2 reads of attachments and app grants go to the
Program with a per-request bearer that carries the read set, so the Program
applies the rules above. Contract 2 writes keep the contract 1 edge path, bound
to the write partition. Runtime principals reach the Program directly.

Contract 1 grants and the owner are not affected. Rules policy can only narrow
this further (per operation and partition); it never widens a read set.

## Uniform not-found and random ids

An object id that does not exist, or that lives outside the partitions the
caller may use for the operation (the read set for reads, the write partition
for writes), gets one answer on every agent path: 404 `{"error":"not_found"}`.
The lookup work is the same in both cases. A caller without the capability at
all gets 403 before any object lookup, for any id. A partition named directly
(a path or `partitionKey` selector) that the caller may not use stays a 403
refusal.

New object ids are random: the prefix and 20 base32 characters from the system
random generator (`kdoc_…`, `kcol_…`, `krev_…`, `notebook_…` and so on), so ids
of one partition reveal nothing about another. Ids of earlier releases
(`kdoc_0001`) stay valid; every reader treats ids as opaque strings.

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
| `GET /healthz` (public, the recipe `healthPath`) | `capabilities.edgePartitions: true`, `capabilities.readPartitions: true`, `partitionContract: 2` |
| `GET /api/status` | `capabilities.edgePartitions: true`, `capabilities.readPartitions: true`, `partitionContract: 2` |
| `GET /bootstrap.json` | `capabilities.edgePartitions: true`, `capabilities.readPartitions: true`, `partitionContract: 2` |

Portal must refuse to save or issue a partitioned edge (and must not send
`partitionKey`) unless `/healthz` answers `partitionContract >= 1`. An
instance without these fields is older than this contract.

Portal must also refuse to save or issue an edge with a read set (and must
not send `readPartitionKeys`) unless `/healthz` answers `partitionContract >= 2`
(or `capabilities.readPartitions: true`).

Deploy this Knowledge release before Portal issues partitioned edges. An older
instance edge ignores `partitionKey` in the introspection answer and would
treat a partitioned attachment as a default one. An older Program rejects a
runtime-principal answer that contains `partitionKey`, which fails closed.

Read sets: an instance before contract 2 fails closed on `readPartitionKeys`
on the runtime-principal path (an unknown answer field) and on the app-grant
path (the 0.1.0-alpha.4 kit refuses unknown fields), but an older attachment
edge ignores the field and serves only the write partition. Portal therefore
gates read sets on `partitionContract >= 2`.

The served manifest (`/.well-known/tealbrick/manifest`) declares
`runtime.partitions: {contract: 2}`. The Program pins `@tealbrick/contract`
0.1.0-alpha.5, which validates that declaration and parses `readPartitionKeys`
on the app-grant path.
