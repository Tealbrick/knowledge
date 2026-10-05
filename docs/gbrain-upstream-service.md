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

### Image

- Upstream publishes no image.
- `deploy/gbrain/Dockerfile` builds the **unmodified** upstream tree:
  - fetch the pinned commit by SHA;
  - verify that `git rev-parse HEAD` equals the pin;
  - `bun install --frozen-lockfile`;
  - no patches, no `COPY` of Tealbrick files.
- A manual workflow, when approved, publishes it as
  `ghcr.io/tealbrick/gbrain-upstream:<version>`. Portal recipes reference its
  digest.

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

### Knowledge-side mitigations until upstream PRs land

| Delta | Mitigation in Knowledge |
|---|---|
| A1 remember dedupe | Reject remote `remember` with `visibility:"private"` |
| A6 pending count | Zero `pending_consolidation_count` for agent callers |
| A7 multi-fence strip | Re-strip every facts/takes fence from page/chunk text returned to agents (fail-closed on unclosed fences) |
| A9 out-of-grant edges | Single source per deployment makes this unreachable; drop edges whose origin is null and not in the partition |
| A13 open loops | Omit `open_loops` from entity cards returned to agents |

**Upstream PR bundle**, which cannot be enforced outside GBrain: A1 (remote
writes match world-only targets), A2/A3 (scoped guarded supersede and
`expireFact`), A4 (c)/(d), A7, A9, A13, A6.

**Dropped on rebase**, because upstream already fixed them: A5, A8 (verified by
the parity suite), A10, A12, A14, and all dependency pins.

Two notices problems need fixing:

- **C1:** `.gitignore` `output/` hid `sidecars/gbrain/src/core/output/` from
  the published source. This is moot once the vendored tree is removed. Until
  then it is a notices bug to fix.
- **THIRD_PARTY_NOTICES:** document A5–A14 for as long as the vendored tree
  ships.

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

1. **Freeze writes.** Set Knowledge `KNOWLEDGE_BRAIN_WRITES=paused`. Memory
   writes return 503 and reads continue. Knowledge's canonical documents are
   unaffected.
2. **Snapshot.** Take a Railway volume backup, plus a `tar` of
   `/data/gbrain-home` to the new GBrain volume. The original stays in place.
3. **Upgrade a copy.** On the copy, run the pinned upstream CLI:
   1. `gbrain apply-migrations --yes`, taking v0.48.2 to v0.60.57 schema;
   2. `gbrain migrate --to postgres --url $GBRAIN_DATABASE_URL`.
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
- A GBrain service template has five services: Knowledge, GBrain
  (`ghcr.io/tealbrick/gbrain-upstream@sha256`), pgvector Postgres, SurrealDB
  and Open Notebook.
- `validateTemplate` accepts per engine:
  - GBrain: the existing 3-service embedded set, or the 5-service set with a
    GBrain image and pgvector;
  - Hindsight: hindsight-api plus pgvector.
- All sidecars stay private and pinned by digest.
- The embedded set is retired once no deployment uses it.

## Work items (this PR series)

1. Knowledge: `GBrainRemoteEngine`, the provisioner, the mitigations, engine
   selection in `buildKnowledgeApp`, the opt-in parity suite, the unmodified
   upstream Dockerfile and a template draft.
2. Core: per-engine `validateTemplate` service sets and the GBrain image
   allowlist.
3. Later, after approval: publish the image, PR the upstream bundle, migrate
   Polygonface, and remove `sidecars/gbrain`.
