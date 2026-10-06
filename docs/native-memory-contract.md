# Knowledge native memory contract — 2026-09-18

Knowledge remains a wrapper: **GBrain owns memory; Open Notebook owns research**.
This candidate adds a versioned, authenticated native memory surface without
editing upstream algorithms or replacing either engine. The bundled GBrain
pin remains 0.48.2.0. This is a Knowledge adapter upgrade, not a new engine version.

## Discovery and execution

Use a Knowledge service-principal bearer with an explicit authorized partition:

- `GET /api/brain/native/tools?partitionKey=your-partition`
- `POST /api/brain/native/remember` with body
  `{"partitionKey":"your-partition","arguments":{"fact":"Vega prefers tea.","provenance":"User statement, 2026-09-18","entity":"Vega"}}`
  and a stable `Idempotency-Key` header.
- All other operations use the same POST envelope with their native arguments.

The catalog is built from the pinned engine's real operation definitions. It
includes native parameter names, types, descriptions, required fields,
annotations, required Knowledge capabilities and usage guidance. Read it;
do not guess camelCase substitutes for native snake_case parameters.

Supported operations (21):

- Canonical protocol v1: `remember`, `recall`, `entity`, `synthesize`, `forget`,
  `context_pack`, `delta`.
- Retrieval: `query`, `search`, `get_page`, `list_pages`, `get_chunks`, `resolve_slugs`.
- Relationships/time: `get_links`, `get_backlinks`, `traverse_graph`,
  `get_timeline`, `find_trajectory`.
- Synthesis/takes: `think`, `takes_list`, `takes_search`.

Success responses wrap the unchanged native result in `data`, with `engine`,
`engineVersion`, `operation`, and native response `metadata`. Native error
fields and protocol version are preserved inside `error`, with configured
credentials redacted. Unknown parameters, source overrides and unadvertised
operations fail closed. This does **not** advertise every upstream administrative,
local-file, ingestion, graph-writing, or automation operation. Existing canonical
document, projection and extraction routes still own those Knowledge workflows.

## Authority and durability

Every native route requires a server-resolved principal even when legacy
partition enforcement is disabled. Read/catalog operations require `brain:read`;
`remember` requires both `knowledge:create` and `knowledge:update` because it
can supersede; `forget` requires `knowledge:delete`. Legacy `knowledge:write`
explicitly covers C/U/D. Each capability must also fit the partition grant.

Since 6 October 2026 the operation set and each operation's read/write scope and
CRUD capabilities come from the selected engine's policy
(`program/src/engine-exposure.ts`): the pinned GBrain service and Hindsight
expose their full upstream surface minus documented exclusions; the embedded
managed worker keeps the 21 operations above. A read is also admitted for a
principal holding `brain:native:read`, and a write for `brain:native:write`;
the container edge grants these for one request to a Portal attachment holding
`knowledge:engine:read` / `knowledge:engine:write`. Every write
requires an idempotency key. See [memory-engines.md](memory-engines.md).

The Program signs a five-minute, operation-specific internal capability bound
to the partition-derived source and a hashed principal identity. The worker
does not receive a browser identity assertion or a caller-selected source.
Session cursors inherit source/principal/session isolation. Source injection,
host administration, private takes holders and local persistence are not granted.
Optional Rules policy sees `knowledge.brain.native.<operation>`, without fact
content in the policy payload. Bounded operation metadata is logged without
provider credentials or memory text.

`remember` and `forget` require an idempotency key (1–200 characters, letters,
digits, `.`, `_`, `:`, `-`). Exact retries replay the original receipt. Reusing a
key with changed arguments fails. Uncertain writes remain held for reconciliation;
never bypass them with a fresh key. Production needs persistent `KNOWLEDGE_DATA_DIR`
and the configured Knowledge database; back up `brain-native-receipts.sqlite`
together with Knowledge and GBrain state. In-memory test configuration is not a
durability guarantee. There is no automatic retry of engine writes. `delta`
is stateful delivery with native at-least-once semantics, not exactly once.

Managed native operations have a ten-minute transport deadline and internal
heartbeats. Provider deadlines still apply. Upstream administration and external
GBrain servers do not automatically gain this signed adapter contract; an
unattested external runtime returns unavailable.

## Preserve native meaning

- This API uses **native remote semantics**. `world` means visible to authorized
  callers within the partition, not publicly accessible on the internet.
  `private` remains native local-owner-only. `include_private` cannot widen
  remote reads. Existing private projections are not silently migrated or
  exposed; their legacy scoped read APIs remain separate.
- Native `remember` without embeddings can return `degraded_dedup: true`.
  It must not be reported as semantic deduplication/supersession success.
- In a DB-only source, remembering a fact about a new entity does not necessarily
  create a full entity page. Cards need actual entity pages. Knowledge's
  existing document/extraction lifecycle is separate; do not fabricate cards.
- `forget` expires a fact. It does not erase the canonical document or other
  evidence containing that statement.
- `think` really invokes native reasoning. Remote `save`/`take` requests remain
  subject to upstream's refusal to persist; read permission is not write permission.
- `synthesize` needs a configured model. Missing models produce native errors;
  extractive fallback and synthesis warnings are not hidden or relabelled.
- Search results are evidence candidates. Use `get_page(include_content:true)`
  or chunks before answering when a snippet is insufficient.

## Agent hookup and compatibility

Use the standalone agent adapter (`adapters/agent`: MCP and Eve extension)
configured with a runtime-only `KNOWLEDGE_SERVICE_TOKEN`, `KNOWLEDGE_BASE_URL`,
and optionally `KNOWLEDGE_PARTITION_KEY`. Native transport permits HTTPS or
loopback HTTP, never credential-forwarding redirects. Upstream engine/provider
keys never become tool arguments. The per-app Hermes remote plugin that also
carried this surface was retired in favour of the unified connector and removed
from this repository.

1. Call `knowledge_brain_tools({"partitionKey":"your-partition"})`.
2. Call `knowledge_brain_call({"operation":"recall","partitionKey":"your-partition","arguments":{"entity":"Vega"}})`.
3. For mutations add `idempotencyKey` alongside `operation` and `arguments`.

Breaking correction: the old `brain_think(scopeRef, query)` alias was
misleading context retrieval. Native `think` is invoked through
`knowledge_brain_call` with `{"operation":"think","arguments":{"question":"..."}}`.
Other harnesses can consume the HTTP catalog/dispatch contract, but this source
change alone does not publish or upgrade the separate Teal Brick npm packages,
Portal attachment catalogs, or already-installed agent tools.

## Verification and release gate

From this repository root:

```sh
corepack pnpm@9.15.4 --dir program typecheck:program
corepack pnpm@9.15.4 --dir program exec vitest run --exclude 'web/**' --maxWorkers=2
bun program/scripts/verify-native-memory.ts
corepack pnpm@9.15.4 --dir program exec tsx scripts/verify-native-runtime.ts
```

The two native scripts use disposable databases; the runtime script strips
provider credentials and checks the real signed/SSE worker path plus HTTP auth,
durable receipts and restarts. These tests are not a model-accuracy benchmark.
Run the seven-case model-backed benchmark, same-source direct-GBrain comparison,
and actual installed-agent flow before claiming accuracy or live acceptance.
