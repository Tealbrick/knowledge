# Memory engines (GBrain, Hindsight)

Updated 6 October 2026. Both engines are wired behind one boundary;
`KNOWLEDGE_MEMORY_ENGINE` selects one per deployment (GBrain when unset, so
existing deployments are unchanged). Nothing here asserts a deployment.

Portal treats engines as recipe variants of the one Knowledge product (same
licence, edge, port, health, instance token and agent grant vocabulary). The
canvas card carries `engine: gbrain | hindsight`; Portal selects the matching
template and locks the engine after deployment. Full cross-repo design:
`Tealbrick/DPL-Portal-core:docs/KNOWLEDGE-ENGINES-LICENCE-PRINCIPALS-2026-10-04.md`.

## Boundary

- `program/src/memory-engine.ts` — `MemoryEngine` is the `GBrainRuntime`
  surface the Program calls (start/close/status, native readiness,
  recall/query/extract-facts, document and research projections, page and
  graph reads) plus `nativeOperation` / `nativeOperationPolicy`, the engine's
  agent surface. `createMemoryEngine(config)` builds `GBrainRuntime` or
  `HindsightMemoryEngine`; unknown engine values fail startup.
- Authorization never moves into an engine. The edge and Program authorize the
  partition and the operation first; the engine receives only the authorized
  partition.
- Operations an engine cannot honour fail explicitly
  (`engine_capability_unavailable`) and are not advertised by native
  readiness; they never fall back to different semantics.

## Full upstream surface for agents

`program/src/engine-exposure.ts` holds, per pinned engine, every upstream
operation (vendored snapshots in `program/src/engine-surfaces/`) as either
exposed (read/write scope, Portal capability, CRUD capabilities) or excluded
with a reason. `scripts/engine-coverage-report.ts` prints the table;
`engine-coverage.test.ts` and `deploy/container/native-memory-edge.test.mjs`
fail if any upstream operation is unaccounted for or unreachable.

| Engine | Pin | Upstream | Exposed (read/write) | Excluded |
|---|---|---:|---:|---:|
| GBrain service | v0.60.57.0 | 156 | 88 (63/25) | 68 |
| Hindsight service | v0.10.2 | 99 | 80 (46/34) | 19 |

The embedded managed GBrain worker (vendored v0.48.2, the default topology)
keeps its fixed 21-operation native-memory v1 contract.

Agents reach the surface through `GET /api/brain/native/tools` (discovery;
`?operation=` describes, `?query=` searches) and
`POST /api/brain/native/<operation>`. Portal attachments need the new
**`knowledge:engine:read`** for reads and **`knowledge:engine:write`** for
writes (`knowledge:brain:read` keeps meaning recall/context only); Portal runtime
grants keep the CRUD mapping (`brain:read`, `knowledge:create`/`update`/`delete`).
Argument guards, concurrency and timeout bounds: see the security notes in
[hindsight-upstream-service.md](hindsight-upstream-service.md).

## Hindsight (vectorize-io/hindsight, MIT)

See [hindsight-upstream-service.md](hindsight-upstream-service.md). Hindsight
has no principals, no per-bank access control and auto-creates banks, so it is
private-only behind Knowledge (`HINDSIGHT_API_MCP_ENABLED=false`, one shared
tenant key held by Knowledge). The bank is `tb-` + first 32 hex of
SHA-256(`knowledge-partition:<normalized partition>`), never caller-supplied.
Template draft: `deploy/container/railway-template.hindsight-service.draft.json`.

Licence notes: root `LICENSE` is MIT (Copyright 2025 Vectorize AI, Inc.).
Upstream metadata disagrees in two places (OpenAPI `info.license` Apache-2.0;
control-plane `package.json` ISC); "Hindsight" is a trademark. Images are pulled
unmodified and not redistributed by this repo.

## GBrain as a separate upstream service (5 October 2026)

GBrain is moving out of the Knowledge container into a separate, pinned,
unmodified upstream service (`gbrain serve --http`). `KNOWLEDGE_GBRAIN_URL` +
`KNOWLEDGE_GBRAIN_ADMIN_TOKEN` select the service topology in `GBrainRuntime`;
Knowledge provisions one OAuth client per partition (and per principal for
native memory) through upstream's admin API. See
[gbrain-upstream-service.md](gbrain-upstream-service.md).
