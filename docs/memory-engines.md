# Memory engines (GBrain, Hindsight)

Scope note, 4 October 2026. GBrain remains the only wired engine. This
document fixes the boundary a second engine must meet; it does not assert a
deployment or a working Hindsight engine.

Portal treats engines as recipe variants of the one Knowledge product (same
licence, edge, port, health, instance token and agent grant vocabulary). The
canvas card carries `engine: gbrain | hindsight`; Portal selects the matching
template and locks the engine after deployment. Full cross-repo design:
`Tealbrick/DPL-Portal-core:docs/KNOWLEDGE-ENGINES-LICENCE-PRINCIPALS-2026-10-04.md`.

## Boundary

- `program/src/memory-engine.ts` — `MemoryEngine` is exactly the
  `GBrainRuntime` surface the Program calls today (start/close/status, native
  readiness, recall/query/extract-facts, native operations, document and
  research projections, graph reads). `KNOWLEDGE_MEMORY_ENGINE` selects the
  engine; unknown values fail startup.
- Authorization never moves into an engine. The edge and Program authorize the
  partition and the operation first; the engine receives only the authorized
  partition.
- Operations an engine cannot honour fail explicitly
  (`engine_capability_unavailable`) and are not advertised by native
  readiness; they never fall back to different semantics.

## Hindsight (vectorize-io/hindsight, MIT)

Hindsight has no principals, no per-bank access control and auto-creates banks,
so it is private-only behind Knowledge (`HINDSIGHT_API_MCP_ENABLED=false`, one
shared tenant key held by Knowledge).

- `program/src/hindsight-client.ts` builds only bank-scoped retain, recall,
  reflect and document-delete routes. Bank = `tb-` + first 32 hex of
  SHA-256(`knowledge-partition:<normalized partition>`), never caller-supplied.
  Bank listing, chunks/files, aliases, clone, import/export and MCP are never
  called.
- Projections retain with `document_id=knowledge-doc:<id>` and
  `update_mode=replace`, so Knowledge deletes are Hindsight document hard
  deletes. Hindsight has no per-memory hard delete; derived observations are
  re-consolidated by Hindsight (LLM cost).
- `think`/`synthesize` map to reflect and must report model cost; entity,
  timeline, link and graph operations are unavailable on Hindsight.
- Template draft: `deploy/container/railway-template.hindsight.draft.json`
  (Knowledge + `hindsight-api:0.10.2-slim` + `pgvector:0.8.1-pg17`, digests
  pinned, sidecars private).

Licence notes: root `LICENSE` is MIT (Copyright 2025 Vectorize AI, Inc.).
Upstream metadata disagrees in two places (OpenAPI `info.license` Apache-2.0;
control-plane `package.json` ISC); "Hindsight" is a trademark. Images are pulled
unmodified and not redistributed by this repo.

## Before a Hindsight recipe is installable

1. Implement `HindsightMemoryEngine` over the client and select it in
   `buildKnowledgeApp` by `KNOWLEDGE_MEMORY_ENGINE`.
2. Native acceptance against a real Hindsight (retain/recall/reflect/forget,
   partition isolation, outage reporting).
3. Portal model setup writes `HINDSIGHT_API_LLM_*`, `_EMBEDDINGS_*`,
   `_RERANKER_*` to the Hindsight service.
4. Publish the template, then add a Portal recipe with `engine: "hindsight"`.

## GBrain as a separate upstream service (5 October 2026)

GBrain is moving out of the Knowledge container into a separate, pinned,
unmodified upstream service (`gbrain serve --http`). `KNOWLEDGE_GBRAIN_URL` +
`KNOWLEDGE_GBRAIN_ADMIN_TOKEN` select the service topology in `GBrainRuntime`;
Knowledge provisions one OAuth client per partition (and per principal for
native memory) through upstream's admin API. See
[gbrain-upstream-service.md](gbrain-upstream-service.md).
