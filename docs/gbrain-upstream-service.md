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
`v0.48.2.0` (`5cfb84f`), and the latest stable is `v0.60.57.0` (`99de570`).

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

- Pin to `v0.60.57.0` (`99de5707f6fc`) or a later stable tag. Do not pin to
  `v0.48.2.0`, where `forget_fact` lets a remote caller expire any fact by ID
  (delta A5).
- Pin by commit SHA, never by `latest-stable`.

### Build (decided 5 October: Railway builds from source, no GHCR)

- `Tealbrick/gbrain` (public, created 5 October) mirrors upstream
  **unmodified**. Its protected, locked, slash-free release branch
  `release-gbrain-v0.60.57.0` is at `ed79444a1545d913d04a34288a1a3ab84a7deb25`.
  That is upstream `99de570` plus one commit that adds only a separate
  `tealbrick/` root directory (5 files):
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
| A7 multi-fence strip | Every facts/takes fence is stripped from all returned text. Nested, overlapping or unclosed fences drop everything they could contain. Upstream also refuses remote writes containing fences, and Knowledge escapes literal marker text in canonical projections. |
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
the parity suite), A10, A12, A14, and all dependency pins.

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
   1. `gbrain apply-migrations --yes`, taking v0.48.2 to v0.60.57 schema;
   2. `gbrain migrate --to postgres --url $GBRAIN_DATABASE_URL`.
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
