# Hindsight as a separate, pinned upstream service

Design and implementation, 6 October 2026. Same pattern as
[gbrain-upstream-service.md](gbrain-upstream-service.md): memory engines run as
separate, pinned, unmodified upstream services, and Knowledge is the access and
compatibility layer. Nothing here is released or deployed.

## Pin

| | |
|---|---|
| Upstream | `github.com/vectorize-io/hindsight`, MIT (root `LICENSE`, Copyright 2025 Vectorize AI, Inc.) |
| Release | `v0.10.2` (latest stable on 6 October 2026), tag object `70831d6`, commit `5fc4ce20917b916240cef27c212c387a177f115b` |
| Image | `ghcr.io/vectorize-io/hindsight-api:0.10.2-slim@sha256:3c7b54a7e7dc92c3ad6a6b874aa9b3e96603b2c6fc4b215d9890a93578d2de99` |
| HTTP surface | 99 operations. Vendored: `program/src/engine-surfaces/hindsight-0.10.2.openapi.json` (the live `GET /openapi.json` of the pinned server; identical operation set to `hindsight-docs/static/openapi.json` at the tag) |
| MCP surface | 39 tools (`hindsight_api/mcp_tools.py`), each mapped to the HTTP operation it wraps in `hindsight-0.10.2.json`. The MCP server stays disabled (`HINDSIGHT_API_MCP_ENABLED=false`); Knowledge calls HTTP. |

Upgrading means: new tag and digest, re-vendor both snapshot files, then run the
coverage test and the opt-in parity suite. A new upstream operation fails the
coverage test until it is exposed or excluded with a reason.

## Selection (one engine per deployment)

| Variable | Meaning |
|---|---|
| `KNOWLEDGE_MEMORY_ENGINE` | `gbrain` (default when unset: existing deployments are unchanged) or `hindsight`. Anything else fails startup. |
| `KNOWLEDGE_HINDSIGHT_URL` | Private bare origin, e.g. `http://${{Hindsight.RAILWAY_PRIVATE_DOMAIN}}:8888` |
| `KNOWLEDGE_HINDSIGHT_API_KEY` | Hindsight's `HINDSIGHT_API_TENANT_API_KEY`, shared only with Knowledge |

These mirror `KNOWLEDGE_GBRAIN_URL` / `KNOWLEDGE_GBRAIN_ADMIN_TOKEN`. A missing
URL or key reports the engine `degraded` with that reason; it never falls back
to GBrain. `program/src/memory-engine.ts` (`createMemoryEngine`) chooses
`GBrainRuntime` or `HindsightMemoryEngine` (`program/src/hindsight-engine.ts`);
both implement the `MemoryEngine` boundary.

## Isolation

Hindsight has no principals and no per-bank access control, and it creates
banks on first write. Isolation is therefore owned by Knowledge:

- The bank is `tb-` + the first 32 hex of SHA-256(`knowledge-partition:<normalized partition>`),
  derived only from the partition the edge and Program already authorized.
- A caller `bank_id` or `target_bank_id` is refused. Path parameters may not
  contain `.`/`..` segments, backslashes or control characters, and the built
  URL is re-checked to stay under `/v1/default/banks/<bank>`.
- The two read routes that are not bank-scoped by path are guarded:
  `get_chunk` needs a `<bank>_` chunk id and its response must carry the same
  `bank_id`; `download_file` needs a `banks/<bank>/…` or
  `tenants/<schema>/banks/<bank>/…` key.
- Documents `knowledge-doc:*` and `knowledge-research:*` are Knowledge's
  canonical projections: agents read them, but writes that name them
  (retain, update, delete, multipart `request` metadata) are refused.
- Upstream 4xx `detail` is passed to the agent (validation help) after secret
  redaction, truncated to 2 000 characters; 5xx bodies are never relayed.

## Program surfaces on Hindsight

| MemoryEngine method | Hindsight |
|---|---|
| `projectDocument` / `projectResearchSource` | async `retain` with `document_id=knowledge-doc:<id>` / `knowledge-research:<id>`, `update_mode=replace`, deterministic `operation_id` (identical content replays) |
| `deleteProjection` | `DELETE documents/<id>` (hard delete; 404 = already absent) |
| `extractFacts` | Projection extraction is subsumed by retain; other text is retained as `knowledge-extract:<hash>` |
| `recall` / `query` | `recall_memories` (an entity-only recall is `engine_capability_unavailable`) |
| `listPages` / `getPage` | `list_documents` / `get_document` |
| `getLinks`, `getTimeline`, `traverseGraph`, `getEntityCard` | `engine_capability_unavailable` (use the native surface) |

`KNOWLEDGE_BRAIN_WRITES=paused` freezes every Hindsight write, as for GBrain.

## Native agent surface (full passthrough)

All 99 upstream operations are accounted for: **80 exposed** (46 read, 34 write)
and **19 excluded with a reason**. `program/src/engine-exposure.ts` is the
single policy; `cd program && npx tsx scripts/engine-coverage-report.ts` prints
the full table.

Excluded:

- Host-level: `health_endpoint_health_get`, `get_readiness`, `get_liveness`
  (Knowledge reports engine health), `metrics_endpoint_metrics_get` (spans every bank).
- Cross-partition: `list_banks`, `clone_bank` (caller-named target),
  `create_bank_alias`, `set_bank_alias_primary`, `delete_bank_alias` (global alias namespace),
  `import_bank_transfer` (upstream restore inserts archive rows verbatim with their own
  `bank_id` when target == manifest source, a cross-bank write; all Knowledge partitions
  share one Hindsight schema).
- Admin/destructive: `delete_bank`, `clear_bank_memories` (partition reset is an operator action).
- Exfiltration: `create_webhook`, `update_webhook` (server-side POSTs of memory to caller-chosen URLs).
- Retired upstream (always 410 at the pin): `export_documents_sync_removed`,
  `get_bank_profile`, `update_bank_disposition`, `add_bank_background`,
  `regenerate_entity_observations`.

The op count is large, so exposure uses discovery rather than one tool per op:

- `GET /api/brain/native/tools` lists every operation the caller may run (name,
  tag, scope, Portal capability, short description, HTTP shape).
  `?operation=<name>` returns that operation's full input schema (OpenAPI
  components as `$defs`); `?query=<text>` searches.
- `POST /api/brain/native/<operation>` with
  `{"partitionKey": "...", "arguments": {<path params>, <query params>, "body": {...}}}`.
  Multipart fields take `{"filename","contentBase64","contentType"}`; binary
  results return base64.
- The agent adapter (`knowledge_brain_tools` / `knowledge_brain_call`), the Eve
  extension and the Hermes plugin accept any discovered operation name.

## Authorization

| Path | Read operations | Write operations |
|---|---|---|
| Portal attachment (`tealbrick_call` via Portal MCP) | **`knowledge:engine:read` (new)** | **`knowledge:engine:write` (new)** |
| Portal runtime grant / service principal | `brain:read` | the op's CRUD capabilities (`knowledge:create`/`update`/`delete`) |

The edge maps each native operation to `knowledge:engine:read` or
`knowledge:engine:write` from the engine's read/write policy, introspects it with
Portal, and forwards with a per-request bearer whose principal holds
`brain:native:read` or `brain:native:write` (Program capabilities that authorize
native engine operations only). Discovery additionally introspects
`knowledge:engine:write`, so a read-only grant discovers reads only. The existing
`knowledge:brain:read` is not widened: it keeps meaning Brain recall/context and
never reaches `/api/brain/native/*`. Operations the engine does not expose are
refused before Portal is contacted. Every write needs an `Idempotency-Key`;
uncertain writes are held for reconciliation.

**Portal must**: issue `knowledge:engine:read` and `knowledge:engine:write`
explicitly in attachment-v1 (suggested: engine read from `read`; engine write
from `create`+`update`+`delete`, all required, because writes include memory
deletion), and add generic connector operations for the native route (for
example `knowledge_memory_tools` → `GET /api/brain/native/tools` with
`knowledge:engine:read`, and `knowledge_memory_call` →
`POST /api/brain/native/<operation>` with the capability from the catalog's
`portalCapability`). Today `apps/portal/src/knowledge-mcp.mjs` exposes only
`knowledge_recall` and `knowledge_context` for memory.

## Security notes (review of 6 October 2026)

Guards applied at the Knowledge boundary before any upstream call. Policy
refusals answer `argument_refused` (HTTP 400); malformed arguments answer
`invalid_params`.

- **Capabilities**: native routes need the new `knowledge:engine:read` /
  `knowledge:engine:write`; existing grants (`knowledge:brain:read`, documents,
  research) are not widened.
- **GBrain service**:
  - `search_by_image.image_url` must be http(s); `image_path` is refused
    everywhere (upstream `loadImageInput` reads host files, including `file://`).
  - `think`/`synthesize` `model` is refused (paid LLM and host `claude-cli`
    selection belong to model settings); `think.save` / `think.take` are refused.
  - `request_tools.surface` is refused (and `request_tools` stays excluded).
  - `visibility:"private"` is refused on `remember`, `extract_facts`, `ontology_propose`.
  - `get_calibration_profile.holder` is refused (only the default holder).
  - Existing: `source_id`, `capture.local_file`, `extract_entities.trusted_extraction`,
    page content writes under `knowledge-docs/` and `knowledge-research/`.
- **Hindsight**:
  - `import_bank_transfer` is excluded (cross-bank write, see above).
  - Import/merge conflict modes allow only `skip` / `new-id`; `replace` is refused.
  - `audit_log_enabled` (field or `HINDSIGHT_API_AUDIT_LOG_ENABLED` form) is refused
    in `update_bank_config` and `import_bank_template`.
  - `export_documents` and `export_bank_transfer` are writes (they create an
    operation and a stored archive).
  - Existing: caller `bank_id`/`target_bank_id`, path traversal, cross-bank
    `get_chunk`/`download_file`, canonical projection documents.
- **Resource bounds**:
  - At most 4 native operations in flight per principal; beyond that 429
    `too_many_requests` with `retry-after`.
  - Upstream timeout 60 s; 300 s only for long operations (Hindsight: reflect,
    retain_memories, file_retain, dry_run_extract_memories, create/refresh
    mental model, import_documents, import_bank_template; GBrain: think,
    synthesize, query, assemble_evidence, extract_facts, extract_entities,
    remember, capture, put_page).
  - Responses stay capped at 8 MiB (Hindsight) and 2 MiB (GBrain MCP transport).

Tests: `native-guards.test.ts`, `hindsight-engine.test.ts`,
`engine-coverage.test.ts`, `deploy/container/native-memory-edge.test.mjs`.

## Models

Hindsight reads `HINDSIGHT_API_LLM_*`, `HINDSIGHT_API_EMBEDDINGS_*` and
`HINDSIGHT_API_RERANKER_*` from its own service. Portal model setup writes them
(Settings → Models stays the owner surface). `HINDSIGHT_API_RERANKER_PROVIDER=none`
**fails startup at 0.10.2**; the template uses `rrf`, which needs no model.

Needs a real model key: fact extraction quality in retain, `reflect`, mental
model create/refresh, consolidation and observations, `dry_run_extract_memories`,
knowledge pages. Needs an embeddings provider: retain and recall. With
`HINDSIGHT_API_LLM_PROVIDER=mock` and an OpenAI-compatible embeddings fixture,
retain/recall/list/read/directive/document round trips work end to end and
`reflect` returns `mock response`.

## Evidence

- `program/src/engine-coverage.test.ts`: 100 % accounted for both engines; every
  exposed operation maps to one Portal capability at the edge; every exposed
  operation reaches a fake pinned upstream through the Program with read/write
  authorization, in the partition's bank (Hindsight) or source (GBrain).
- `deploy/container/native-memory-edge.test.mjs`: the same through the real
  container edge with a Portal attachment, plus write-denial, foreign partition,
  excluded-op (no Portal call) and bank/source injection checks.
- `program/src/hindsight-service.parity.test.ts` (opt-in,
  `KNOWLEDGE_HINDSIGHT_PARITY_URL` / `_KEY`): against the real pinned server,
  projection, partition isolation, retain/read/recall, directive round trip,
  projection hard delete, and a sweep proving all exposed operations are
  routed to live upstream handlers. Run 6 October 2026 against Hindsight
  0.10.2 from the tag source (embedded pg0, mock LLM, embeddings fixture): 7/7.
  The edge suite's opt-in live case retained and recalled through a Portal
  attachment on the same server.

## Before a Hindsight recipe is installable

1. Portal: `knowledge:engine:read` / `knowledge:engine:write` and the generic memory connector operations.
2. Portal model setup writes the Hindsight provider variables.
3. Run the parity suite against the template's image digest on Railway (the
   local run used the tag source because the local container VM had no disk
   space for the image).
4. Publish `deploy/container/railway-template.hindsight-service.draft.json`, then
   add the Portal recipe with `engine: "hindsight"`.
