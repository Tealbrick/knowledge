# GBrain as a separate, pinned upstream service

Design, 5 October 2026. Implements the architecture decision recorded in the
Forge docs for `tealbrick`: Knowledge memory engines run as **separate, pinned,
unmodified upstream services**. Knowledge is the unified access and
compatibility layer. Nothing here is released.

Evidence:

- [gbrain-vendored-delta.md](gbrain-vendored-delta.md) — the vendored-tree diff and
  upstream server mode.
- The integration map in this PR's description.

Upstream is `github.com/garrytan/gbrain`, MIT. It is vendored today at
`v0.48.2.0` (`5cfb84f`) for the embedded topology, which is frozen there. The
service topology is pinned to `v0.60.127.0` (`40174843796a`, re-pinned from
`v0.60.57.0` on 9 October 2026 for dev; see [Bump routine](#bump-routine)).

## Today

`sidecars/gbrain` is vendored with 14 Tealbrick privacy/scope patches (A1–A14).
The notices document only A1–A4.

The Program spawns `program/src/gbrain-managed-worker.mjs` under Bun. That
worker imports GBrain's *internal* modules, hand-builds `OperationContext`,
and runs PGlite under `/data/gbrain-home`. It also adds two custom tools:

- `knowledge_native`
- `knowledge_delete_projection`

This couples Knowledge to GBrain internals, which blocks upgrades, and it
breaks the unmodified-upstream rule.

## Target

```
agent ─▶ Knowledge edge + Program (authZ, partitions, policy, mitigations)
            │  MCP Streamable HTTP, OAuth client_credentials, one client per partition
            ▼
         GBrain service: upstream gbrain@<pinned sha>, `gbrain serve --http`, private networking
            │
         Postgres + pgvector (private)
```

### Pin

- Current pin: `v0.60.127.0` = `40174843796aed968eee60b41c866f48a360a5bd`.
  Previous pin: `v0.60.57.0` (`99de5707f6fc`). Do not pin to `v0.48.2.0`,
  where `forget_fact` lets a remote caller expire any fact by ID (delta A5).
- Pin by commit SHA, never by `latest-stable`. Upstream releases several times
  a day and moves that tag.
- Runtime: upstream needs Bun `>=1.4.0`. The GBrain service image uses
  `oven/bun:1.4.0-debian`, pinned by digest. The Knowledge image keeps its own
  Bun for the frozen embedded worker; the service pin does not change it.

### Build (decided 5 October: Railway builds from source, no GHCR)

- `Tealbrick/gbrain` (public, created 5 October) mirrors upstream
  **unmodified**. Its protected, locked, slash-free release branch
  `release-gbrain-v0.60.127.0` is at `dc973103936d6d7d03fd0fb0dd59f7b36d34bb93`.
  That is upstream `40174843796aed968eee60b41c866f48a360a5bd` plus one commit
  that adds only a separate `tealbrick/` root directory (5 files). The previous
  branch `release-gbrain-v0.60.57.0` (`ed79444a1545`) stays for rollback.
  - `tealbrick/Dockerfile`, which builds the checked-out upstream tree;
  - `tealbrick/entrypoint.sh`;
  - `tealbrick/verify-unmodified.sh`, which proves no upstream file differs;
  - a README with provenance.
- Railway builds it the way it builds Knowledge and Marketplace: root directory
  `/`, `RAILWAY_DOCKERFILE_PATH=tealbrick/Dockerfile`.
- Portal pins the branch and revision and verifies at deploy time that the
  branch is protected and resolves exactly to that revision.
- Upgrading means a new release branch at a newer upstream tag, plus the same
  one-directory commit.

### Run

- Command:
  `gbrain serve --http --bind :: --port 3131 --public-url http://${RAILWAY_PRIVATE_DOMAIN}:3131 --suppress-bootstrap-token --fail-fast`
- Environment:
  - `GBRAIN_DATABASE_URL`, pointing at private pgvector Postgres.
  - `GBRAIN_ADMIN_BOOTSTRAP_TOKEN`, generated in the template and shared only
    with Knowledge.
  - `GBRAIN_HOME=/data` on a volume.
  - Model provider env (see Models).
- Never set `GBRAIN_REMOTE_PRIVATE_PAGES`.
- No public domain.

### Auth: GBrain's own

Knowledge holds the bootstrap credential and provisions through upstream's
admin HTTP API. Every MCP call carries a bearer from a client bound to exactly
one GBrain source.

1. `POST /admin/login {token}` opens an admin session cookie.
2. One *operator* client, scopes `read write sources_admin`, used only for
   `sources_add`.
3. For each Knowledge partition:
   1. `sources_add id=kb-<sha256(partition)[0:24]>`. This is the same source ID
      as today, so migrated data keeps its keys.
   2. `POST /admin/api/register-client` with `{name, source, scopes:"read write", grantTypes:["client_credentials"]}`.
4. Native memory writes get one client per `(partition, principal)`, so that
   `remember`/`forget` ownership and `delta` cursors stay per principal, as
   the managed worker's `kc-<sha256(principal)>` clientId did.
5. Client credentials are stored under `<dataDir>/gbrain-remote-clients.json`
   (mode 0600). Access tokens come from `/token` client_credentials and are
   cached until expiry.

### Isolation

- There is one GBrain service per Knowledge deployment (per workspace), so the
  deployment policy against shared engines still holds.
- Inside it, upstream's own source binding, plus `remote:true` semantics,
  enforce partition and visibility. Knowledge still authorizes the partition
  and operation first.

### Capability exposure via `MemoryEngine`

- `GBrainRemoteEngine` implements the same `MemoryEngine` surface:
  - Program tools map 1:1 onto upstream ops (`put_page`, `extract_facts`,
    `recall`, `query`, `list_pages`, `entity`, `get_page`, `get_links`,
    `traverse_graph`, `get_timeline`, `find_trajectory`).
  - `deleteProjection` is `delete_page` plus `forget` for the projection's
    session facts. This replaces the custom tool.
  - Native memory calls upstream's verbs directly. The custom
    `knowledge_native` tool goes away.
- The full upstream catalog is reachable:
  - Every non-`localOnly`, non-admin upstream op is exposed through the native
    route, after Knowledge policy maps it to a capability.
  - Ops Knowledge cannot safely expose return
    `engine_capability_unavailable`.
  - So does anything upstream lacks at the pin.

**Implemented 6 October 2026; re-pinned 9 October.** Coverage at the pin
(v0.60.127.0): 161 upstream operations, 89 exposed (64 read, 25 write), 72
excluded with reasons (43 need admin, sources_admin or agent scope; 9
localOnly/cliOnly over HTTP; 5 publish-gated; 15 policy exclusions: source
enumeration, OAuth-client identity, `request_tools`, the brain-wide skill
registry, open loops per A13, `put_pages` and `rate_answer`). The five
operations new since v0.60.57.0 are classified as:

| Operation | Upstream | Knowledge |
|---|---|---|
| `wanted_pages` | read, source-scoped, private pages filtered | exposed (read) |
| `put_pages` | write, batch of pages in one request | excluded: the reserved-projection guard covers `put_page` only |
| `rate_answer` | write, retunes shared ranking | excluded: off by default upstream, and its `answer_id` arrives only in `_meta`/notice blocks the native route does not relay |
| `takes_remove`, `takes_rebuild` | localOnly | excluded (refused over HTTP) |

New parameters on exposed operations pass through, except per-item
`visibility:"private"` in `remember.items`, which is refused like the
top-level field. `purge_deleted_pages` became cliOnly (it was already
excluded for its admin scope). Before this change only
the 21 native-memory v1 operations were reachable (135 unaccounted). Page
content writes to `knowledge-docs/` and `knowledge-research/` are refused, as
are `local_file`, `trusted_extraction`, `image_path`, non-http(s)
`search_by_image.image_url`, `think`/`synthesize` `model`, `think.save`/`take`,
`request_tools.surface`, explicit calibration `holder`, and private visibility on
`extract_facts`/`ontology_propose` (`argument_refused`). The opt-in parity suite proves upstream's own `tools/list`
lists all 88 for a read+write partition client and that none is refused for
scope. Table: `cd program && npx tsx scripts/engine-coverage-report.ts`.

### Privacy (decided 5 October: upstream PR + enforce in Knowledge now)

Unmodified upstream at the pin lacks seven of the vendored fixes. The fix bundle
is proposed upstream, and Knowledge enforces equivalents in its access layer now
(`program/src/gbrain-privacy.ts`, applied to every service result before it
leaves Knowledge). So vanilla GBrain is safe behind Knowledge today.

| Delta | Enforcement in Knowledge (service topology) |
|---|---|
| A1/A2/A3 remember dedupe and supersession | `remember` with `visibility:"private"` is refused. World writes can only match world targets under upstream's same-visibility rule. |
| A4 (c)/(d) forget fence mirror | Only runs for sources with a local path. Knowledge sources are created without one, so upstream's DB-guarded path is used. |
| A6 pending count | `pending_consolidation_count` is withheld |
| A7 multi-fence strip | Every facts/takes fence is stripped from all returned text. Nested, overlapping or unclosed fences drop everything they could contain. Upstream also refuses remote writes containing fences, and Knowledge escapes literal marker text in canonical projections. Upstream has its own hardened strip since v0.60.58; Knowledge keeps its strip as defence in depth. |
| A9 out-of-grant edges | Rows naming another source are dropped. One partition source per client. |
| A13 open loops | Entity-card `open_loops` are withheld |

**Upstream PR bundle:** not submitted (Martin, 5 October). Knowledge's
enforcement layer is the control. Re-evaluate at every GBrain pin bump with the
parity suite and `gbrain-vendored-delta.md`. The fixes it would carry:

- A1: remote writes match only world targets.
- A2/A3: scoped, guarded supersede and `expireFact`.
- A4 (c)/(d).
- A6.
- A7.
- A9.
- A13.

**Dropped on rebase**, because upstream already fixed them: A5, A8 (verified by
the parity suite), A10, A12, A14, and all dependency pins. At v0.60.127.0 A7
is upstream too, and A11 has an upstream equivalent (code reading).

For as long as the vendored tree ships:

- **C1:** fixed. `sidecars/gbrain/src/core/output/` is restored.
- **THIRD_PARTY_NOTICES:** now records A5–A14.

### Models

- Upstream reads model configuration from env and `config.json`. Knowledge's
  Settings → Models stays the single owner surface.
- In remote mode, saving model settings maps to `GBRAIN_*` provider variables
  that Portal writes to the GBrain service. This uses the same
  variables-then-redeploy path Portal already uses for Knowledge.
- The embedding model and dimensions stay locked after first data, as today.
  The template passes them at first init (`GBRAIN_INIT_ARGS`, default
  `--no-embedding`).
- Fact extraction model: since v0.60.118 upstream defaults background
  extraction to `anthropic:claude-haiku-5-5` when no model is set and the
  reasoning tier resolves through Anthropic. It is a brain config key
  (`facts.extraction_model`), not an environment variable. Making it an
  explicit Knowledge model setting needs the Settings → Models to GBrain
  service path (Portal variables plus an owner-side `gbrain config set` in the
  entrypoint). That is open follow-up work; until then, no Anthropic key is set
  on the GBrain service, so the default cannot spend silently.

### Parity suite

- `program/src/gbrain-remote.parity.test.ts` runs only when
  `KNOWLEDGE_GBRAIN_PARITY=1`. It starts the pinned upstream
  `gbrain serve --http` against a temp PGlite home, provisions through the admin
  API, and asserts:
  - every `MemoryEngine` method round-trips;
  - native verbs work end to end;
  - source isolation: a client for source X cannot read or write Y;
  - remote privacy: no private fact ID, text or count reaches an agent.
- Each Knowledge mitigation has a unit test against recorded upstream
  responses.
- Run it: `cd program && KNOWLEDGE_GBRAIN_PARITY_REPO=<upstream checkout at the
  pin, after bun install --frozen-lockfile> npx vitest run src/gbrain-service.parity.test.ts`.
  Last run: 9 October 2026, v0.60.127.0, Bun 1.4.0, 14/14 passed.

### Upstream behaviour at v0.60.127.0 that Knowledge handles

- **Notice blocks.** Tool results keep the JSON result in `content[0]` and
  append model-facing notice blocks (`[gbrain notice <code> ...]`, for example
  the one-time `behavior_changes` notice on an upgraded brain) and retrieval
  evidence lines as extra text blocks. `gbrain-transport.ts` reads the result
  from the first non-notice block. Before this fix, the first call per client
  on an upgraded brain returned the raw result object, so a canonical write
  could miss the current revision.
- **`write_outcome_unknown`** (v0.60.123). The database session dropped during
  write admission. Canonical projection writes replay once with the same
  `request_id` (upstream reads the retained request; it never admits twice).
  Native callers get upstream's envelope, whose fix is `get_write_request`.
- **`put_page` refusals.** A slug ending `.md`/`.mdx` is refused (Knowledge
  slugs never end that way). Content that drops dated Timeline rows is refused
  unless `drop_timeline: true` (v0.60.105). Knowledge's canonical projections
  send `drop_timeline: true`, because the Knowledge document is canonical.
  Agent writes get the refusal.
- **Credential redaction** (v0.60.31). `recall`, `context_pack`, `delta` and
  `entity` return `<REDACTED:pattern>` in place of stored credentials. The
  parity suite checks it.

## Bump routine

Prod follows every step. A dev re-pin (like the 9 October move to
v0.60.127.0) may skip the wait in step 2.

1. A new upstream tag appears. Pick a tag, never `latest-stable`. Resolve its
   full commit SHA.
2. Wait 24-48 hours. Upstream often ships a fix release within a day.
3. Read the "Behavior changes" table and the CHANGELOG entries between the
   current pin and the tag. Note new error codes, refusals, result shapes and
   model defaults.
4. Diff the operation list: run the snapshot method recorded in
   `program/src/engine-surfaces/gbrain-<version>.json` against the new tag.
   Classify every new operation in `engine-exposure.ts` (exposed read, exposed
   write with CRUD capabilities, or excluded with a reason; when unsure,
   exclude). Check new parameters on exposed operations against
   `gbrainServiceArgumentRefusal`.
5. Make a new release branch `release-gbrain-v<tag>` in `Tealbrick/gbrain`:
   upstream at the SHA, unmodified, plus the `tealbrick/` commit. Run
   `tealbrick/verify-unmodified.sh`. Copy the classic branch protection of the
   previous release branch (locked, admins enforced, one review, linear
   history, no force push or deletion).
6. Move every pin site: the snapshot file, `engine-exposure.ts`, the draft
   template, this document, `docs/memory-engines.md`,
   `THIRD_PARTY_NOTICES.md`. `deploy/container/gbrain-service-pin.test.mjs`
   fails until they agree.
7. Run the parity suite against `gbrain serve --http` at the new pin and the
   full CI lane.
8. Prod only: rehearse the migration on a copy of the prod volume (schema
   upgrade, graduation plan and confirm, counts and digests), then roll out.

## Migration (existing customer instance, zero-loss, reversible)

The live instance has PGlite at `/data/gbrain-home` (v0.48.2 schema). All
writes go through Knowledge. No data is deleted at any step.

0. **Precondition.** Polygonface first runs the Knowledge 0.2.x upgrade, then
   this release. The migration is run by the rollout session, never ad hoc.
1. **Freeze writes.** Set Knowledge `KNOWLEDGE_BRAIN_WRITES=paused`.
   - Every GBrain write (projection, extraction, remember/forget, delete)
     returns `brain_writes_paused`.
   - The projection ledger keeps those records pending and retries them after
     the freeze.
   - Reads continue, and Knowledge's canonical documents are unaffected.
2. **Snapshot.** Take a Railway volume backup, plus a `tar` of
   `/data/gbrain-home` to the new GBrain volume. The original stays in place.
3. **Upgrade a copy.** On the copy, run the pinned upstream CLI:
   1. `gbrain apply-migrations --yes`, taking v0.48.2 to v0.60.127 schema
      (forward-only; rollback is the snapshot);
   2. move PGlite to Postgres. On the current pin this is "graduation":
      `gbrain migrate --to postgres --url $GBRAIN_DATABASE_URL --plan` prints a
      plan hash, then `--yes --expect <plan_hash>` runs it with the source
      quiesced. Not yet rehearsed.
   3. **Keep private (decided 5 October).** No fact's visibility is changed.
      Existing privately extracted facts keep `visibility='private'`. Under the
      service topology every caller is remote, so they are retained but not
      served. Nothing deletes them through MCP; an owner-CLI maintenance step
      on the GBrain service removes them when their canonical record is
      deleted.
      New extraction under the service topology writes partition-world facts,
      which Knowledge serves only inside the partition.
4. **Verify.** For every `kb-*` source, counts must match between the
   pre-migration PGlite (old binary, read-only) and Postgres:
   - pages, chunks with embeddings, facts by visibility/expired, links,
     timeline, takes;
   - plus `content_hash` samples.
   Any mismatch aborts.
5. **Cut over.** Set `KNOWLEDGE_GBRAIN_URL` and
   `KNOWLEDGE_GBRAIN_ADMIN_TOKEN` (references to the GBrain service). Knowledge
   then provisions clients for its existing partitions. The source IDs are
   unchanged.
6. **Check.** The parity smoke runs read-only against live data. Then remove
   the write freeze.
7. **Rollback,** at any point before step 6 completes: unset the two variables
   and redeploy. Knowledge falls back to the untouched embedded
   `/data/gbrain-home`. After writes resume, rollback means replaying from
   Knowledge's projection ledger. Canonical documents and sources re-project
   automatically. Agent `remember` writes made after cutover are exported from
   Postgres with `gbrain export` before rollback.
8. **Retire.** After a soak period, a later release removes the embedded
   worker, `sidecars/gbrain` and the Bun runtime from the Knowledge image.
   `/data/gbrain-home` is kept until the customer confirms.

## Portal template variants

- Knowledge recipes keep `engine: gbrain | hindsight`.
- A GBrain service template has five services:
  - Knowledge;
  - GBrain, built from source (`Tealbrick/gbrain`, protected release branch,
    `tealbrick/Dockerfile`);
  - pgvector Postgres;
  - SurrealDB;
  - Open Notebook.
- `validateTemplate` accepts per engine:
  - GBrain: the existing 3-service embedded set, or the 5-service set with the
    source-built GBrain plus pgvector;
  - Hindsight: hindsight-api plus pgvector.
- Image sidecars stay private and pinned by digest. The GBrain sidecar is
  pinned by protected branch and revision instead.
- The embedded set is retired once no deployment uses it.

## Work items (this PR series)

1. **Knowledge (this PR):**
   - `GBrainServiceConnection` and the service topology;
   - the privacy enforcement layer;
   - the write freeze;
   - the opt-in parity suite;
   - the template draft.
2. **`Tealbrick/gbrain`:** done. The unmodified mirror plus `tealbrick/`
   packaging is on a protected, locked release branch.
3. **Core:** per-engine topologies, with the source-built GBrain sidecar
   verified by protected branch and revision.
4. **After approval:**
   - publish the Railway template and add the Portal recipe;
   - run the Polygonface migration through the rollout session, after the
     0.2.x upgrade;
   - remove `sidecars/gbrain`.
