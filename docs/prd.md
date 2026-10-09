# Knowledge PRD: upstream engine adapters and walled areas

Status: draft for owner review, 2026-10-09.
Scope: the Knowledge miniapp and its upstream memory engines. Related: [memory-engines.md](memory-engines.md), [memory-partitions.md](memory-partitions.md), [miniapp-contract.md](miniapp-contract.md).
Evidence: Knowledge `main`, GBrain `v0.60.57.0`, Hindsight `v0.10.2`, researched 2026-10-09. Items marked UNVERIFIED were not proven from source or a run.

## 1. Problem and goals

A Knowledge owner wants ONE Knowledge that holds all their work and their companies' work. Each agent sees only its walled areas ("walled views"). Knowledge runs one of several upstream memory engines (GBrain, Hindsight; more later). The engines differ in isolation, multi-area read, retrieval, and deletion.

Goals:
1. A standard adapter contract for every upstream engine. The engine DECLARES what it can do.
2. Portal and the Knowledge UI derive every customer option from declared capabilities only. We never offer an option that the engine cannot enforce.
3. Correct, short positioning copy for each engine.
4. A defined walled-area behaviour for each engine.
5. A design note for engine-per-area with cross-engine read (open question, not planned).

Non-goals: changing upstream engines; moving authorization into an engine; mixing engines in one deployment (now).

## 2. Upstream engine adapter contract (standard)

### 2.1 Roles

- **Upstream engine**: an unmodified upstream service (pinned by tag and image digest). It stores and retrieves memory. It never decides who may read what.
- **Adapter**: Knowledge code between the Program (authorization) and the engine. It maps an authorized area to an engine store, translates operations, enforces limits, and declares capabilities.
- **Program / edge**: authorizes principal, operation and area BEFORE the adapter runs. The adapter receives only authorized areas.

Invariant A1: authorization never moves into an engine. Engine-side ACLs are defence in depth only.
Invariant A2: an operation that the engine cannot honour returns `engine_capability_unavailable`. The adapter never emulates another engine's semantics.

### 2.2 Capability declaration

Two layers:

1. **Static (manifest)**. `tealbrick.app.json` lists each supported engine and the capabilities the adapter CAN provide for that pinned version:
   ```json
   "runtime": { "engines": [
     { "id": "gbrain", "version": "0.60.57.0", "capabilities": { ... } },
     { "id": "hindsight", "version": "0.10.2", "capabilities": { ... } }
   ]}
   ```
   Portal reads this at install and engine selection time.
2. **Live (readiness)**. `GET /readyz` (and the native readiness surface) reports the selected engine and each capability as `available`, `needs_model_key`, `needs_embeddings`, `paused`, or `unavailable`. Portal and the Knowledge UI read this at run time.

A live capability can never exceed the static declaration. Readiness must match reality in both directions (see §6, Hindsight entity ops).

### 2.3 Capability vocabulary (closed set, versioned `capabilities: 1`)

| Key | Values | Meaning |
|---|---|---|
| `area.isolation` | `store` \| `acl` | `store`: separate store per area. `acl`: one store, access lists per area. |
| `area.multiRead` | `native` \| `fanout` \| `none` | How a read set of several areas is served. |
| `area.maxReadSet` | integer | Largest read set the adapter serves in one request (≤ 64, kit limit). |
| `area.write` | `single` | Writes always bind to one area. No engine may declare more. |
| `search.keyword` | bool | BM25 or equal. |
| `search.semantic` | bool + `requires: embeddings` | Vector search. |
| `recall.facts` | bool | Fact-level recall with provenance. |
| `graph.typed` | bool | Typed links, traversal, backlinks. |
| `graph.entity` | bool | Entity cards and entity graph. |
| `temporal` | bool | Time windows, timelines, deltas. |
| `reflect` | `none` \| `single-area` \| `read-set` + `requires: chatModel` | Model-written answers over memory. |
| `synthesis.cited` | bool + `requires: chatModel` | Cited answers with sources. |
| `learning.consolidation` | bool | Background observations or mental models. |
| `delete.mode` | `hard` \| `soft` | What a document delete does in the engine. |
| `delete.recoveryHours` | integer \| null | Soft-delete recovery window. |
| `delete.areaPurge` | bool | Whether deleting an area can remove its engine data. |
| `limits.responseBytes` | integer | Response cap. |
| `limits.inFlightPerPrincipal` | integer | Parallel operations per principal. |
| `limits.timeoutsSeconds` | `{default, long}` | Upstream timeouts. |

New keys need a contract minor bump. Unknown keys are ignored by Portal (never shown).

### 2.4 Derivation rules for Portal and the Knowledge UI

1. Show an option only if it is declared in the manifest for the selected engine.
2. Enable it only if readiness reports `available`. Show `needs_model_key` as a setup step, not as a feature.
3. Edge editor: offer a read set of more than one area only if `area.multiRead != none`, and cap it at `area.maxReadSet`.
4. Edge editor: show "Reflect across areas" only if `reflect = read-set`. With `single-area`, reflect uses the edge's write area only, and the UI says so.
5. Delete dialogs state `delete.mode` and `delete.recoveryHours` in plain words. Area delete states `delete.areaPurge` (today: false, data stays).
6. Engine choice at install shows the positioning line (§3) and the capability difference, not marketing.
7. Agent tool lists (`/api/brain/native/tools`) follow the same rules: exposed ops ⊆ declared capabilities.

### 2.5 Conformance

Each declared capability has a conformance check in the adapter suite. Mandatory for every engine:
- area leak tests: write in area A, read from an edge without A (search, get, recall, graph, temporal, reflect) returns nothing and uniform 404 for direct ids;
- read-set tests: edge with `{write:A, read:[A,B]}` sees A and B, never C;
- write binding: a write with any other area is refused;
- `engine_capability_unavailable` for every undeclared op;
- readiness truthfulness: each `available` capability passes one live call.

### 2.6 Adding an engine (checklist)

1. Pin upstream by tag and digest; record licence and provenance.
2. Map area → store (or ACL) deterministically from the effective partition key.
3. Declare static capabilities; implement readiness.
4. Classify every upstream op: exposed read, exposed write, or excluded (with reason).
5. Pass §2.5 conformance in CI.
6. Write the positioning line (§3) from upstream's own words.

## 3. Engine positioning (correction)

A common assumption is "GBrain = company memory, Hindsight = relational/social graph". The upstream projects do not describe themselves that way:

- GBrain calls itself first a memory you control for the agent you already use. Company use is secondary, and its typed knowledge graph (people, companies, deals) is a headline feature. So GBrain is the MORE relational engine.
- Hindsight calls itself learning memory: agents that learn, not just remember (retain, recall, reflect). Graph links are one of four recall strategies, not the product.

Customer copy (proposal, owner to sign off):
- **GBrain**: "A sourced, correctable knowledge brain. Pages and facts with sources, hybrid search, a typed graph of people and companies, and cited answers."
- **Hindsight**: "A learning memory. It keeps what agents see, recalls it by meaning, keyword, entity and time, and forms observations that improve as it learns."
- When to choose: GBrain for documents, facts, relations and audit of sources. Hindsight for agents that must improve from experience and for strict separate stores per area.

## 4. Walled areas per engine

### 4.1 Common rules (all engines)

- Edge grant: `{write: <key>, read: [<keys>]}` with `read ∋ write`, 1..64 keys (kit `readPartitionKeys`, manifest `runtime.partitions.contract: 2`). Contract 1 (one area) stays the default.
- Writes bind to `write`. A write that names another area is refused.
- Reads (get, list, search, collections, research, recall, context) are filtered to the read set. Direct ids outside the read set return uniform 404. Ids are random (no sequence leak).
- Rules may only narrow (per operation and area).
- Every merged result row carries its `area` label so the agent can cite the wall it came from.
- Area delete in Portal removes the registry entry only. Engine data stays (`delete.areaPurge = false`). The UI must say so (§2.4.5).

### 4.2 GBrain

| Topic | Behaviour |
|---|---|
| Isolation | `acl`: one Postgres store per deployment, one source per area, one OAuth client per area (and per area+principal for native memory), each bound to one source. |
| Multi-area read (0.5.0) | `fanout`: one call per area through that area's client, then merge (§4.4). Same code path as Hindsight. |
| Multi-area read (later) | `native`: the read set belongs to the GBrain OAuth client, not the request (verified on a live `serve --http`, including live rescope). `source_id: "__all__"` searches the whole client set in one ranked query; a per-call `source_id` may name one source inside the set; arrays are rejected and `source_ids` is ignored. Knowledge therefore keeps one GBrain client per distinct read set and picks the token per request. Preconditions: move to the service topology on current upstream (the embedded v0.48.2 worker cannot write on current upstream); relax the privacy filter that drops rows from other sources so it allows granted sources only; leak tests pass. |
| Reflect / synthesis | `synthesize`, `think` per area in 0.5.0 (`single-area`). With native federated read: `read-set`. |
| Graph | Typed graph per area. Links never cross areas in 0.5.0. Note: the HTTP service does not extract links on write; graph quality depends on explicit links or operator extraction (UNVERIFIED on our topology). |
| Delete | `soft`, 72 h recovery; upstream purge later (purge on the HTTP service UNVERIFIED). Facts of the document are withdrawn first. |
| Limits | 2 MiB response, 4 in flight per principal, 60 s / 300 s. |

### 4.3 Hindsight

| Topic | Behaviour |
|---|---|
| Isolation | `store`: one bank per area. Hindsight has no principals or per-bank access lists, so Knowledge is the only wall. Caller bank ids are refused. |
| Multi-area read | `fanout` only. Every recall route has one bank in the path; there is no bank list. N calls, then merge (§4.4). |
| Reflect | `single-area`: reflect runs on the write area only. Cross-bank reflect is not possible upstream; a fan-out of reflect answers would be several model calls with no shared reasoning, so we do not offer it. |
| Observations, mental models | Per bank. They never mix areas. Shown per area. |
| Entity / graph | Upstream has entity and graph ops. Knowledge readiness reports them unavailable while the native passthrough exposes them: fix readiness to match (§6). |
| Delete | `hard`: the document and its extracted memories are removed and cannot be restored. Text sent to extract-facts is not linked to a document and stays. |
| Limits | 8 MiB response, 4 in flight per principal, 60 s / 300 s. Recall token budget clamped 256–32000. |

### 4.4 Fan-out merge (both engines in 0.5.0)

1. Run per-area calls in parallel, bounded by `limits.inFlightPerPrincipal` (4).
2. Split the token or row budget across areas, then merge.
3. Rank with reciprocal rank fusion on per-area rank lists. Raw scores are not comparable across stores.
4. Deduplicate by Knowledge document id (copies of one source in two areas show once, with both area labels).
5. Partial failure: return the rows that succeeded plus a per-area status; never a silent drop.
6. Main risk: ranking quality across areas. Measure with a fixed query set before release.

### 4.5 Research (Open Notebook)

Separate from both engines. Notebooks are bound per area. Reads filter by the read set. Projections of research sources into the engine follow the engine's area rules.

### 4.6 Customer options derived (example)

| Option in Portal / UI | GBrain 0.5.0 | Hindsight 0.5.0 |
|---|---|---|
| Edge reads several areas | yes (fan-out) | yes (fan-out) |
| Reflect / cited answer across areas | no (write area only) | no (write area only) |
| Typed graph | yes | no (until readiness fix) |
| Learning observations | no | yes, per area |
| Restore deleted document | yes, 72 h | no |
| Area delete removes data | no | no |

## 5. Design note: engine per area, cross-engine read (open question)

Idea: each area picks its own engine (for example area A on Hindsight, area B on GBrain), and an edge read set may span engines.

What it needs:
- One deployment running several engines (today one engine per deployment, locked after deploy).
- A normalized result schema across engines (row, area, kind, source, time).
- The §4.4 fan-out merge, extended across engines (RRF works because it uses ranks, not scores).
- Capability intersection: an edge's options are the intersection of the capabilities of all engines in its read set. For example, typed graph is off if any area is on Hindsight.
- Mixed delete semantics shown per area.

Risks: cost (two engines, two model and embedding bills, two stores to back up); weaker ranking across engines; harder support; no upstream help.

Open questions for the owner:
1. Is there a real case where one area needs learning memory and another needs a typed graph inside the same Knowledge? Or are two Knowledge deployments, each with one engine, enough?
2. Should a later connector read across Knowledge deployments instead, with the same fan-out merge?

Recommendation: not now. Ship §4 fan-out first; it is the same merge code. Revisit after 0.5.0 ranking results and one real owner case.

## 6. Open items

| Item | Owner | Status |
|---|---|---|
| GBrain federated read | Knowledge | verified: per-client read set; one client per distinct read set |
| GBrain upgrade to latest upstream | Knowledge | service topology pinned by SHA to latest-stable, no carried patches; embedded worker frozen |
| Hindsight readiness vs exposed entity ops mismatch | Knowledge | to fix in 0.5.x |
| Area delete leaves engine data (`areaPurge`) | Knowledge + Portal | decide: owner-only purge op or documented residue |
| Extract-facts text residue in Hindsight | Knowledge | document; link to source doc if possible |
| Manifest `runtime.engines` and readiness capability keys | Kit + Knowledge | kit proposal after owner sign-off |
| Portal derivation of options (§2.4) | Portal | after kit proposal |
