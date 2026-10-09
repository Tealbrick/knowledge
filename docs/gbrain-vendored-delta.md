# Vendored GBrain delta vs upstream, and upstream server mode

Researched 2026-10-05 for the move to an unmodified upstream GBrain service ([gbrain-upstream-service.md](gbrain-upstream-service.md)). Since then, C1 (missing `src/core/output/`) is fixed and A5–A14 are recorded in THIRD_PARTY_NOTICES.

Historical record at v0.60.57.0. The service pin is now v0.60.127.0; the re-check at that pin (A7 upstreamed in v0.60.58, A1/A6/A9/A13 still enforced in Knowledge) is in [gbrain-upstream-service.md](gbrain-upstream-service.md) (section Privacy).

## Sources

- Knowledge: `this repository` at `origin/main` = `ad0d54d5f691`. Vendored tree `sidecars/gbrain`, VERSION 0.48.2.0.
- Vendored history: `git log origin/main -- sidecars/gbrain` has only one commit, `1d36195 Initial public Knowledge 0.1.0 release`. The public repo does not carry the history of the Tealbrick patches.
- Upstream: `github.com/garrytan/gbrain` (default branch `master`, MIT), cloned at `(local research checkout)`.
- Base: `5cfb84f1d3a8` = tag `v0.48.2.0`, dated 2026-09-02 ("voyage:rerank-2.5 default"). Worktree: `(local research checkout)`.
- Latest: release `v0.60.57.0`, published 2026-10-05T04:08Z, at commit `99de5707f6fc` (2026-10-05, merge of PR #6018). The `latest-stable` tag points to the same commit. That is 1312 commits after the base. Worktree: `(local research checkout)`.
- Raw delta, generated with `diff -ruN`, excluding node_modules, .git, dist and build: `gbrain-5cfb84f-vs-vendored.diff`, next to this file. It has 3960 lines over 48 files: +1070/-1773 lines, of which 1596 deleted lines are the missing `src/core/output` (see C1).

## Delta inventory (every changed path)

- Source (24): `package.json`, `bun.lock`, `src/core/{engine,entity-identity,facts-fence,fence-shared,takes-fence,verbs,pglite-engine,postgres-engine}.ts`, `src/core/facts/{forget,write-single}.ts`, `src/core/ops/{facts,links,search,takes}.ts`, `src/core/{pglite,postgres}-engine/{facts,takes}.ts`, `src/core/think/{gather,index}.ts`, `src/core/verbs/entity-card.ts`.
- Tests: 15 modified and 1 new (`test/fence-privacy-boundaries.test.ts`). They are regression tests for the A-items below and add nothing at runtime.
- Missing from the vendored tree: `src/core/output/**` (9 files) and `.env.testing.example`.

## A. Security and scope semantics

"HEAD" means v0.60.57.0. Dispositions: **UP** = upstream PR, **KN** = layer it in Knowledge, **DROP** = remove on rebase. "Outside?" asks whether Knowledge could enforce the item from outside GBrain.

| # | Behaviour (files) | In HEAD? | Outside? | Disposition |
|---|---|---|---|---|
| A1 | **remember: dedupe and supersession are world-only for remote callers.** `verbs.ts` passes `worldOnly: ctx.remote!==false`. `facts/write-single.ts` and `findCandidateDuplicates` (pg and pglite) add `visibility='world'`. Without this, a remote write can return a private fact's id as `duplicate` (an existence oracle), or expire a private fact by superseding it. | **Partial.** `remember` now goes through `persistence/memory-mutations.ts` → `facts/single-prepare.ts::decideSingleFact`. That code filters candidates to the *same visibility* as the new fact. So a remote world write can no longer touch private facts, but a remote *private* write can still match existing private facts. The legacy `writeSingleFact` path still has no filter (`engine-sql/facts.ts::findCandidateDuplicates`). | **No.** The decision and its side effect both happen inside GBrain. | **UP** (small: a "remote ⇒ world-only targets" rule in `decideSingleFact`). Meanwhile KN can stop remote callers from writing `visibility:'private'` through `remember`, which closes the remaining gap. |
| A2 | **Guarded supersession.** `insertFact` takes `supersedeWorldOnly`. Its supersede UPDATE adds `source_id = ctx.source_id` and a world guard, with `RETURNING`. The result is `superseded` only if a row actually changed, otherwise `inserted`. `expireSuperseded` now calls `forgetFactInFence({sourceId, worldOnly, supersededBy})` instead of a bare `UPDATE facts SET superseded_by`. | **No.** `engine-sql/facts.ts` still runs `UPDATE … WHERE id=$supersedeId AND expired_at IS NULL` with no source or visibility guard, and still returns `superseded` unconditionally. The managed path (`managed-fact-write.ts`) groups by visibility. Whether it guards source under lock is UNVERIFIED. | **No** (it is a transactional UPDATE). | **UP** |
| A3 | **`expireFact` scope.** New `opts.sourceId` and `opts.worldOnly` become SQL predicates (pg and pglite). The `engine.ts` interface changes to match. | **No.** The HEAD signature is still `{supersededBy, at}`. | **No.** | **UP** (together with A2) |
| A4 | **forget: re-check under lock and conditional update** (`facts/forget.ts`). (a) The initial SELECT applies scope in SQL: federated `sourceIds[]`, scalar `sourceId`, world-only. (b) Inside `withPageLock` it re-reads the row and requires the same source, entity_slug, row_num, source_markdown_slug and visibility, still unexpired, and the same `sources.local_path`. (c) It rejects the change if the *markdown* fence row is non-world for a remote caller ("markdown is canonical"). (d) It runs a guarded `UPDATE … AND source_id AND row identity AND world RETURNING id` *before* `renameSync`. If no row changed, it unlinks the .tmp file and returns `not_found`. (e) Every legacy fallback uses the scoped `expireFact`. (f) `supersededBy` is written in the same UPDATE. | **Partly superseded.** `forget_fact` and `forget` now go through `submitForgetMutation`, which does `SELECT … FOR UPDATE` on the source and `WHERE id AND source_id AND (remote ⇒ world)` inside one transaction. That covers (a), (e) and much of (b). The fence mirror in `forget.ts` still runs an unguarded `UPDATE … WHERE id=$2` *after* `renameSync`. (c) is absent. Whether (d)'s file-vs-DB ordering still matters under the new withdrawal-first design is UNVERIFIED. | **No.** These are under-lock checks plus file/DB ordering. | **UP** for (c) and (d). Rebase-check (a), (b) and (e) against memory-mutations. Note: Knowledge's managed worker creates sources with `local_path NULL` (`program/src/gbrain-managed-worker.mjs`), so `canFence` is false and only the legacy DB path runs today. |
| A5 | **forget_fact op scope** (`ops/facts.ts`). Remote callers pass the source scope (falling back to `ctx.sourceId` or `'default'`) and `worldOnly`. At 5cfb84f the op passed **no** scope, so a remote caller could expire any fact by guessing its global id. | **Yes.** `memory-mutations.ts:202`: `WHERE id=$1 AND source_id=$2 AND ($3=false OR visibility='world')`. | Partly: Knowledge pins one source per token. Visibility is not covered. | **DROP** on rebase. Keep the test. |
| A6 | **extract pending count is world-only for remote callers** (`ops/facts.ts` `include_pending` → `countUnconsolidatedFacts(src,{worldOnly})`, pg and pglite). Without it, the count of private facts leaks to remote callers. | **No.** HEAD `ops/facts.ts:407` is unchanged. | Yes: drop or zero the field for remote callers in Knowledge. | **UP** (trivial). KN fallback is possible. |
| A7 | **Hardened privacy-fence strip** (`fence-shared.ts::transformPrivacyFences`, `facts-fence.ts`, `takes-fence.ts`). One forward pass strips *every* facts/takes fence. Nested, overlapping or unclosed regions are dropped whole. Without it, the strip handled only the first fence and kept an unclosed fence verbatim, so a second fence or a malformed one leaked to remote `get_page` and chunking. | **No.** HEAD `stripFactsFence` and `stripTakesFence` still use single `indexOf` begin/end. | Only by re-parsing every page body in Knowledge, which is fragile, and chunks are already indexed. | **UP** (high value) |
| A8 | **get_links/get_backlinks private filter by exact (slug, source_id)** (`ops/links.ts`). A public page in another source with the same slug no longer makes a private endpoint visible. An edge whose origin has no `origin_source_id` is dropped. | **Likely yes.** HEAD moved the filtering into SQL by page id (`readPolicyOpts`, `privatePagesFilterFragment`, `privateLinkOriginFilterFragment`). UNVERIFIED by test. | No. | **DROP** if a parity test passes; otherwise **UP**. |
| A9 | **Drop federated edges whose origin page is outside the grant** (`pglite-engine.ts`, `postgres-engine.ts`: `AND (l.origin_page_id IS NULL OR o.id IS NOT NULL)`). | **No.** `engine-sql/links.ts:268,336` still return the edge with its origin redacted to NULL. | No. | **UP** |
| A10 | **takes_list/takes_search hide takes on private pages for remote callers** (`ops/takes.ts`, engine takes SQL). | **Yes.** `readPolicyOpts` plus `engine-sql/takes.ts` `excludePrivate`. | — | **DROP** |
| A11 | **think/gather privacy** (`think/index.ts`, `think/gather.ts`). Every retrieval arm applies `excludePrivate`: hybrid, window floor, both takes arms, graph slugs and the anchor page. Remote page text has its facts/takes fences stripped to world rows. A hydrated anchor replaces a search excerpt matched by page_id. | **Partial.** `excludePrivate` and `requireSafeChunks` reach gather (`gather.ts:131`). Fence stripping of page text, and the private anchor check, are UNVERIFIED. | No. | Rebase-check. **UP** whatever is missing. |
| A12 | **CRAG re-run in `query` keeps `excludePrivate`** (`ops/search.ts`). | **Yes** (`ops/search.ts` around 937). | — | **DROP** |
| A13 | **entity card, remote** (`verbs/entity-card.ts`). Out-, in- and backlink-count edges require both endpoints *and* any origin in the same source, and non-private. Open loops are shown only if backed by an active world fact and every evidence page exists in the source, is live and is non-private. | **Partial.** HEAD has private-page and origin filters on edges. HEAD `open_loops` has **no** remote filter (`entity-card.ts:374`). | No. | **UP** for open loops. Rebase-check the edges. |
| A14 | **Identity-union member links honour federated `allowedSources`** (`entity-identity.ts`). | **Yes** (`entity-identity.ts:344`, also with `excludePrivate`). | — | **DROP** |

The notice file (THIRD_PARTY_NOTICES.md) documents A1–A4 only. **A5–A14 are undocumented** Tealbrick changes and should go into THIRD_PARTY_NOTICES if they are kept.

## B. Dependency pins (`package.json` overrides, `bun.lock`)

| Pin | Base | Vendored | HEAD overrides | Disposition |
|---|---|---|---|---|
| `@ai-sdk/provider-utils` | 4.0.26 (transitive) | 4.0.33, new override (pulls `@ai-sdk/provider` 3.0.12) | 4.0.56 | **DROP** (superseded) |
| `hono` | ^4.12.34 (lock 4.13.0) | 4.13.5, exact | ^4.13.5 | **DROP** |
| `js-yaml` | ^3.15.1 | 3.15.2, exact | ^3.15.2 | **DROP** |

## C. Build and packaging

- **C1 (bug): `src/core/output/` is missing from the public Knowledge source.** Knowledge's root `.gitignore` has `output/`, which also matches `sidecars/gbrain/src/core/output/`. The missing files are `writer.ts`, `scaffold.ts`, `post-write.ts`, `slug-registry.ts` and `validators/*`.
  - Verified: `operations.ts` still loads, with 136 ops, because the imports are dynamic.
  - Inferred effects:
    - `put_page` silently loses `writer_lint` (the import sits in a try/catch).
    - `open_loops` email-citation rendering throws when it reaches `loops.ts:101`. Its import is not in a try.
    - `gbrain integrity` and the `google/*` connector modules fail to import. Both use static imports.
    - An image built from a clean public checkout (`deploy/container/Dockerfile` `COPY sidecars/gbrain`) has the same gaps.
    - The published image digest was probably built from a local tree that still had these files. UNVERIFIED.
  - This is also a corresponding-source completeness gap. Fix in **KN**: add `!sidecars/gbrain/**/output/` to `.gitignore`, or vendor the tree as a pinned archive.
- **C2:** `.env.testing.example` is absent. It is test-only. **DROP**, or restore it with C1.

## D. Other

Tests only (see the inventory). No other behaviour changes were found outside A–C.

## Upstream server and deployment (v0.60.57.0 unless noted)

- **Release:** `v0.60.57.0`, 2026-10-05, commit `99de5707f6fc` (= `latest-stable`). Bun `>=1.4.0`; v0.48.2.0 needed `>=1.3.10`. Binary: `gbrain` → `src/cli.ts`, run from TypeScript source by Bun.
- **Server modes** (`src/cli/help/serve.ts`, `src/commands/serve*.ts`, `docs/mcp/DEPLOY.md`):
  - **stdio**: `gbrain serve [--surface verbs|starter|full] [--access full|read-only] [--source-guard]`.
  - **HTTP**: `gbrain serve --http [--port 3131] [--bind 127.0.0.1] [--public-url URL] [--token-ttl 3600] [--enable-dcr] [--surface …] [--suppress-bootstrap-token] [--fail-fast]`.
    - The bind default is loopback, so a container needs `--bind 0.0.0.0`.
    - v0.48.2.0 already had `--http`, `--port`, `--bind`, `--public-url`, `--token-ttl` and `--enable-dcr` (`src/commands/serve.ts:210-268`).
- **Transport:** MCP **Streamable HTTP**, stateless (`StreamableHTTPServerTransport`, `sessionIdGenerator: undefined`).
  - `POST /mcp` takes requests behind `requireBearerAuth`.
  - `GET /mcp` returns 405, because there is no SSE back-channel.
  - Admin SPA at `/admin`, with an SSE activity feed.
  - `GET /metrics` is admin-gated.
- **Health:** `GET /health` is liveness only. It runs `SELECT 1` and returns `{status:'ok', version, engine}` with 200 (`serve-http-metrics.ts:170-220`). That matches what Knowledge expects in `program/src/gbrain-health.ts`.
- **Auth:** OAuth 2.1 (client_credentials, auth-code + PKCE with owner approval, refresh rotation, optional DCR), plus legacy bearer tokens from the `access_tokens` table.
  - Scopes: `read`, `write`, `admin`, `agent`, `sources_admin`.
  - The owner/admin credential is `GBRAIN_ADMIN_BOOTSTRAP_TOKEN`. Set it for headless runs, because generated tokens are hidden on non-TTY starts.
  - Clients are provisioned with `gbrain mcp grant <name> --source X --federated-read a,b --profile …` or `gbrain mcp admin register …`.
  - Other env vars: `GBRAIN_HTTP_TRUST_PROXY` (set to 1 behind Railway's proxy), `GBRAIN_HTTP_CORS_ORIGIN`, `GBRAIN_HTTP_RATE_LIMIT_{IP,TOKEN,LRU}` (defaults 30 and 60 per 60 s), `GBRAIN_REMOTE_PRIVATE_PAGES=1` (escape hatch that exposes private pages to remote callers; never set it).
- **Storage:**
  - Postgres (with pgvector): `GBRAIN_DATABASE_URL`, preferred, or `DATABASE_URL`. A `DATABASE_URL` that comes from a cwd `.env` file is ignored (`src/core/config.ts:~658`). An env URL forces the postgres engine.
  - PGLite: `database_path` in `$GBRAIN_HOME/.gbrain/config.json` (default `~/.gbrain`). Created by `gbrain init --pglite [--no-embedding]`.
  - PGLite is **single-writer** (lock file). One process only, so no CLI maintenance while `serve` runs (`docs/guides/remote-mcp.md`).
- **Docker:** no official image and no Dockerfile in the repo, only `docker-compose.{ci,test}.yml`.
  - `docs/operations/headless-install.md` sketches `FROM oven/bun:1` → `bun install -g github:garrytan/gbrain#latest-stable` → `gbrain init --pglite` → `gbrain serve`.
  - `docs/mcp/ALTERNATIVES.md` lists Fly.io and Railway ("Bun natively"), paired with Postgres and `GBRAIN_ADMIN_BOOTSTRAP_TOKEN`.
  - Published container image: none found. A GHCR check was not run. UNVERIFIED.
- **Sources (partitions):** a `sources` table (id, name, local_path, config `{federated}`) managed by `gbrain sources add/list/…` and the ops `sources_add`, `sources_list` and `sources_status`.
  - Each OAuth client has a write `source_id` plus a `--federated-read` set (`allowedSources`), and optional `--bound-slug-prefixes`.
  - A per-call `source_id: "__all__"` means "every granted source".
  - Missing client source rows are backfilled to `default`.
- **Remote vs local:** `OperationContext.remote: boolean` (`src/core/ops/contract.ts:409`). Only `remote === false` is trusted.
  - The CLI sets `remote:false` (`src/cli.ts:1503`).
  - **Both** stdio MCP and HTTP MCP set `remote:true`, with `transport: 'stdio'|'http'` used only for `localOnly` gating.
  - Remote callers get private pages excluded (`resolveExcludePrivatePages`, fail-closed, config key opt-out) and world-only facts. That is what the "remote callers" in A1 refers to.
  - Knowledge's managed worker does **not** use `serve --http`. It runs its own `Bun.serve`, imports `src/core/operations.ts` in-process, and builds `ctx` itself: `remote:true`, `allowedSources:[sourceId]`, per-source HMAC token. See `program/src/gbrain-managed-worker.mjs`.
  - That couples Knowledge to internal module paths and to the shape of `OperationContext`. HEAD routes writes through `persistence/memory-mutations.ts` with `request_id` and admission, so this is a major upgrade risk. UNVERIFIED whether a hand-built ctx still satisfies HEAD's write admission.

### What a Railway service would need

- **Image:** build from a pinned commit (`oven/bun:1.4` + `git clone` at the commit SHA, or `bun install -g github:garrytan/gbrain#<sha>`). There is no published image. Keep `--frozen-lockfile`. If Tealbrick patches remain, build from the patched tree.
- **Start command:** `gbrain serve --http --bind 0.0.0.0 --port $PORT --public-url https://<railway-domain> --suppress-bootstrap-token --fail-fast`.
- **Env:**
  - `GBRAIN_ADMIN_BOOTSTRAP_TOKEN` (secret), `GBRAIN_HTTP_TRUST_PROXY=1`.
  - `GBRAIN_DATABASE_URL` for Railway Postgres; the pgvector extension is required, and its availability is UNVERIFIED.
  - Provider keys (`VOYAGE_API_KEY`, `OPENAI_API_KEY` or `ANTHROPIC_API_KEY`), or run keyless.
  - `GBRAIN_HOME=/data`.
- **Volume:** required for PGLite (`/data`, with replicas = 1). With Postgres a volume is still advisable for `$GBRAIN_HOME`: config, admin token file and `validator-lint.jsonl`.
- **Init:** `gbrain init --pglite` or `gbrain init` (postgres) as a pre-deploy step or an idempotent entrypoint step. Then provision clients through `gbrain mcp grant … --url https://…/mcp --admin-token-file …`.
- **Health check:** `/health`.

## MCP operations (for a capability parity suite)

Listed at runtime with `bun -e 'import("./src/core/operations.ts")'` in each worktree. Scope letters: S = in the `starter` surface, L = `localOnly` (denied over HTTP).

- **v0.48.2.0 (vendored base): 136 ops.**
  - **Verbs surface (7):** recall, remember, entity, synthesize, forget, context_pack, delta.
  - **Starter (S):** the verbs plus get_page, put_page, list_pages, capture, search, query, get_backlinks, list_link_sources, traverse_graph, add_timeline_entry, resolve_slugs, get_ingest_log, file_list, file_url, submit_agent, get_agent_job, whoami, request_tools, get_recent_salience, find_anomalies.
  - **read:** entity synthesize get_page list_pages fetch search query search_modes search_by_image get_tags get_links get_backlinks list_link_sources traverse_graph get_timeline get_versions get_brain_identity list_skills get_skill list_brain_skillpack advisor get_raw_data resolve_slugs get_chunks get_ingest_log find_orphans get_calibration_profile takes_list takes_search think takes_scorecard takes_calibration whoami sources_list sources_status request_tools get_recent_salience find_anomalies get_recent_transcripts connectors_status chronicle_day chronicle_on_this_day chronicle_since chronicle_last_seen ontology_get ontology_dimensions ontology_conflicts volunteer_chronicle volunteer_context extraction_pending entity_identity_list recall context_pack delta find_contradictions find_experts find_trajectory code_callers code_callees code_def code_refs code_blast code_flow get_active_schema_pack list_schema_packs schema_stats schema_lint schema_graph schema_explain_type schema_review_orphans open_loops.
  - **write:** remember forget put_page delete_page restore_page capture add_tag remove_tag add_link remove_link add_timeline_entry revert_version put_raw_data log_ingest takes_add takes_update takes_resolve takes_supersede connector_sync ontology_propose extract_entities extraction_review entity_identity_link entity_identity_unlink extract_facts forget_fact loops_close loops_mute loops_unmute.
  - **admin / agent / sources_admin:** purge_deleted_pages search_stats search_tune cache_stats get_stats get_health run_doctor quarantine_list get_status_snapshot sync_brain get_usage file_list file_upload file_url submit_job get_job list_jobs cancel_job retry_job get_job_progress pause_job resume_job replay_job send_job_message submit_agent get_agent_job(agent) get_job_stats sources_add(sources_admin) sources_remove(sources_admin) chronicle_backfill code_traversal_cache_clear migrate_embeddings schema_apply_mutations reload_schema_pack run_onboard run_skillopt.
  - **localOnly (L):** purge_deleted_pages sync_brain file_list file_upload file_url get_recent_transcripts connectors_status connector_sync chronicle_backfill extraction_review entity_identity_link entity_identity_unlink code_traversal_cache_clear migrate_embeddings.
- **v0.60.57.0: 156 ops.** None removed. Added (20): assemble_evidence cancel_write_request delete_skill edit_page get_skill_asset get_skill_policy get_skill_retention get_write_attribution get_write_request import_skill_proposal join_brain leave_brain list_write_requests mute_notice prune_skill_revisions put_skill retain_skill_revision set_skill_policy sources_inspect sync_brain_skills.
- **Parity suite design:**
  - Run each op × {local (`remote:false`), remote single-source, remote federated} × {pglite, postgres}.
  - Seed private and world fixtures plus a same-slug page in another source. Assert that no private id, text or count reaches remote callers. That covers A1–A14.
  - For writes, also assert that rows in other sources and private rows are not modified.
  - Raw per-op TSVs (`name, scope, mutating, localOnly, starter`) are next to this file: `opsrt-gbrain-5cfb84f.tsv`, `opsrt-gbrain-v0.60.57.0.tsv`.

## Recommendation summary

- **Upstream PR bundle**, all items that cannot be enforced outside GBrain: A1 (remote ⇒ world-only dedupe targets), A2/A3 (scoped `expireFact` and guarded supersede UPDATE), A4 (c)/(d) (markdown-visibility recheck and DB-guard-before-rename in the fence mirror), A7 (multi-fence privacy strip), A9 (out-of-grant origin edges), A13 (open loops for remote callers). A6 is trivial.
- **Drop on rebase:** A5, A10, A12, A14, the B pins; probably A8 (verify with a test).
- **Knowledge-side:**
  - Fix C1 now.
  - Reject `visibility:'private'` on remote `remember` until A1 lands.
  - Zero `pending_consolidation_count` for remote callers (A6).
  - Before any upgrade, decide between keeping the in-process worker coupling and moving to upstream `serve --http` with OAuth client grants per Knowledge source.
