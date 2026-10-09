# Operating Knowledge memory — candidate contract

The full accuracy/recovery release gate has **not** passed. Healthy processes, successful model probes and document saves are not sufficient proof of useful memory.

## Install → configure models → connect an agent

1. Install the customer-owned runtime with persistent storage and instance-owner authentication. Keep internal GBrain loopback-only. Knowledge manages source-bound internal credentials; agents do not receive a GBrain admin token.
2. Configure chat, embeddings and an optional reranker through owner-authenticated `PUT /api/settings/models`. Provider checks cover dimensions, finite/nonzero vectors and simple semantic contrasts. Keys remain server-side and `GET` returns only key-free values. An update may omit `apiKey` for a connection to keep the key already saved for the same provider and exactly the same `baseUrl`; changing the provider or URL requires the key again (`400 model_api_key_required`), and models sharing a provider must share one URL and key (`400 model_provider_conflict`). Never silently reuse existing vectors after changing embedding models or formats: that requires an explicit migration/reindex decision. Settings -> Models offers each model from a list (see [Model picker](#model-picker-settings---models)); the list does not change these rules.
3. Pair the agent through the supported customer attachment path, with an explicit partition and least-privilege capabilities. Agent data grants do not authorize changing model credentials.
4. Write canonical documents/sources. Inspect `GET /api/brain/indexing?partitionKey=...` for durable projection receipts. Automatic extraction is enabled unless explicitly disabled; a document's 201 response does not mean every fact has been extracted.
5. Test actual retrieval, then repeat with a second independently scoped principal to verify isolation.

## Agent calls

Prefer the [native memory API](native-memory-contract.md) for faithful engine
schemas/results: `GET /api/brain/native/tools` then
`POST /api/brain/native/:operation`. It exposes all seven canonical memory
verbs plus advanced reads and true synthesis. The routes below remain
compatibility/projection APIs, not aliases for the complete native contract.

- `POST /api/brain/context`: native semantic document query. Required `scopeRef` and `query`; optional `limit` (1–100), `expand`, and `detail` (`low`, `medium`, `high`). Native expansion is no longer forcibly disabled.
- `POST /api/brain/recall`: `query` activates native semantic page retrieval; `grep` is a separate literal fact filter. Optional `entity`, `sessionId`, `includeExpired` and `budgetTokens` preserve native filtering. Results contain facts and, when queried, document results.
- `POST /api/brain/extract-facts`: scoped extraction using `text`, `partitionKey` and stable `sessionId`. Historical content can supply `validFrom` and `sourceSlug`. Use `Idempotency-Key` for retry identity. Never resubmit an uncertain write under a different key.
- `GET /api/knowledge/documents/:id`: read a cited canonical document. A retrieved chunk is not necessarily the entire relevant passage.
- The scoped Brain entity endpoint exposes native cards, aliases, graph links and timelines. Resolution/update quality still needs evaluation.

## Result semantics

`ok: true` means an operation completed, not that it answered the question. Inspect `status` and native `retrieval` metadata: `vector_enabled`, `expansion_applied`, `degraded`, `crag.confidence`, and `token_budget`. Confidence is a routing signal, not a correctness guarantee.

On weak evidence, refine the query using distinctive terms from the user's question and read the returned canonical document. Do not invent an answer from unrelated high-vector-score chunks. Abstain when no support is found. Keep first-pass retrieval scores separate from multi-tool agent-task scores.

## Local model latency and capacity

The managed adapter has separate bounded foreground and extraction lanes. Document indexing can progress while extraction waits for a local model; deletes wait for earlier work on both lanes. Internal response heartbeats allow slow operations to finish and record their receipts. Transport ceilings are 30 minutes for extraction, 10 minutes for semantic retrieval and 2 minutes for other native operations. Native provider deadlines also apply. These ceilings are not latency promises, and an API save is still not proof that all extraction has finished.

For a reasoning-capable local model under a small output-token cap, set the optional owner model setting `chat.reasoningEffort` to `low`. Knowledge forwards this through GBrain's supported provider configuration; it does not replace the extractor or silently raise the model host's resource limits. Omit the setting for models that do not support it. The default OpenAI chat model (`gpt-6-luna`) already starts with `low` reasoning effort when its models come from the account's OpenAI key; a saved owner setting always wins.

The customer-owned model gateway queues bursts separately for chat, embeddings and reranking. Each backend retains its bounded concurrency; waiting work is bounded and cancelled requests are removed. Authentication, fixed destinations and token caps remain enforced. The Portal does not run this gateway or hold these model credentials.

After a process crash or a genuinely uncertain write, the extraction receipt stays pending for reconciliation. Do not delete a receipt or change its idempotency key merely to make a failed status disappear: native side effects may already exist.

## Provider configuration and acceptance

Owner model settings accept `provider: "openrouter"` for chat, embeddings and
reranking. Configure the supported endpoint and model IDs for your account.
The managed adapter uses the native provider implementation. OpenRouter entries
in one instance share one endpoint and key because native gateway configuration
is provider-scoped. Existing reranker settings without a provider use
`llama-server-reranker`.

`provider: "anthropic"` (chat) and `provider: "google"` (Gemini chat and
embeddings) use the provider's native API on its official host only; the
endpoint is fixed and need not be sent. Anthropic has no embeddings API, so with
Anthropic chat the owner must choose another embedding provider (OpenAI,
OpenRouter, Google or a self-hosted server); a save that names Anthropic for
embeddings is refused with `embedding_provider_required`. Google embeddings
default to `gemini-embedding-2` at 768 dimensions. A reasoning effort is not
available for Anthropic or Google chat models.

Keys remain server-side; settings reads redact them. Changing embedding model
identity requires an explicit migration/reindex even if vector width stays the
same. Use a disposable index when evaluating a new model configuration.

Evaluate retrieval on representative questions and independently measure
entity resolution, extraction, migration/reindex recovery and agent follow-up
reads. Process health and a small benchmark do not establish broad accuracy.
Bare Program deployments require a trusted owner setup path; verify the full
setup and authorization flow on the actual deployment before production use.

## Model picker (Settings -> Models)

Settings -> Models offers a dropdown per role (chat, embedding, reranker when
the provider has one) instead of free text. All routes below are owner-only:
they sit behind the same `x-knowledge-settings-token` check as
`/api/settings/models`, so an agent credential (app grant, attachment or
runtime principal) gets `403 settings_owner_required`.

- `GET /api/settings/models/available?provider=<provider>&role=chat|embedding|rerank`
  lists the models the owner may pick. Knowledge asks the provider with the key
  it already holds: the saved Settings key for that provider (with its saved
  endpoint), else the provider-env key (`OPENAI_API_KEY`, `ANTHROPIC_API_KEY`,
  `GOOGLE_GENERATIVE_AI_API_KEY`) at the official endpoint. A key typed in the
  browser is never used for a list. OpenAI-compatible providers (OpenAI,
  OpenRouter, Ollama, llama-server) use `GET {baseUrl}/v1/models`, Anthropic
  `GET https://api.anthropic.com/v1/models` (`x-api-key`, `anthropic-version`),
  Google `models.list` (`x-goog-api-key`). Lists are cached for 10 minutes per
  provider, endpoint and key fingerprint (a SHA-256 hash; the key is not kept
  in the cache key).
- The answer carries model ids only: `models` (allowed ids), `recommended`,
  `recommendedDimensions` (embedding), `reasoningEffort` (`supported`,
  `options`, `recommended`), `listing` (`provider`, `manifest` or `none`),
  `freeTextOnly`, `keySource` (`knowledge-settings`, `provider-env` or `none`)
  and the active manifest `source` and `version`. It never carries a key or an
  upstream error body. A refused key gives `error: "provider_key_invalid"`
  (upstream 401/403); any other failure gives `error: "provider_unreachable"`.
  Then, and when no key is held, the picker offers the manifest's own exact ids.
- Role filtering: `allowed = filterModels(listed, provider, role, manifest)`
  (`@tealbrick/contract/models`); the recommendation is shown only when it is
  allowed. OpenAI, Anthropic and Google lists are always filtered. OpenRouter,
  Ollama and llama-server lists are filtered when the manifest has an entry for
  that role, else shown as listed; without a list they offer free text only.
- Reasoning effort keeps the engine rule: chat only, and only for OpenAI,
  OpenRouter and Ollama. The options are the levels the engine accepts
  (`none`, `minimal`, `low`, `medium`, `high`); a manifest `xhigh` or `max`
  recommendation is clamped to `high`.
- The UI preselects the recommendation and labels it "Recommended". "Other
  model (advanced)" reveals a free-text field. A saved model that is not in the
  list opens in that field, so no saved setting is changed by the picker. Every
  save still runs the readiness checks (the canary) before it is stored.
- Save precedence is unchanged: saved Settings -> provider env -> not configured.

### Model manifest sources

The recommendations come from a `tealbrick.models/1` manifest. Three sources
compete through `selectModelManifest([portal, appLocal])`; the highest valid
`version` wins, and on a tie the earlier source wins:

1. Portal: `GET ${TEALBRICK_PORTAL_URL}/.well-known/tealbrick/models` (public,
   no credentials, redirects refused, 256 KB cap). A 404, a timeout (3 s) or an
   invalid body counts as absent. The answer is cached for 10 minutes. A
   settings request waits at most 1.5 s for the first fetch, then answers
   without it while the fetch fills the cache.
2. App-local owner setting: `PUT /api/settings/models/manifest` with
   `{"manifest": <JSON text or object>}`. It is validated with
   `parseModelManifest`; an invalid one is refused with
   `400 model_manifest_invalid` and `errors: [{path, message}]` and is not
   stored. It is stored as `model-manifest.json` (mode 0600) in the data
   directory. `DELETE /api/settings/models/manifest` removes it.
3. The bundled `defaultModelManifest` of the pinned `@tealbrick/contract`.

`GET /api/settings/models` reports `manifest: {source, version, effectiveAt,
portal: {status, version?}, appLocal: {status, version?}, bundledVersion}` and
`embeddingLock` (the embedding model an existing memory already uses, or null).

## Changing the embedding model (re-index)

Knowledge never changes the vector space of an existing memory silently. When
the memory engine already holds vectors (`embeddingLock` is set), a save with a
different embedding provider, model or vector size is refused with
`409 embedding_migration_required`, and Settings -> Models shows a warning with
the guided steps instead of saving. The owner can keep the current embedding
model ("Keep the current embedding model") and still save the other settings.

The engine's re-embedding operation (`migrate_embeddings`) is CLI-only: it is
refused on every agent and HTTP transport, it can cost money and it runs for a
long time. Knowledge therefore has no owner button that starts it. The operator
runs it on the installation:

1. Stop agent traffic and stop Knowledge, so nothing else opens the memory
   database. Keep the data volume.
2. In the image, with the same data volume, the provider key of the new
   embedding model in the environment and `GBRAIN_HOME=/data/gbrain-home`, run
   from `/app/knowledge/sidecars/gbrain`:
   `bun run src/cli.ts migrate embeddings --to <provider:model> --dim <N> --dry-run`.
   Check the plan and the cost estimate.
3. Run the same command with `--yes` instead of `--dry-run`. A stopped run
   resumes when you run the same command again. `... migrate embeddings --status`
   shows the progress.
4. Start Knowledge. `embeddingLock` now names the new model. Save the new
   embedding model in Settings -> Models; the save runs the readiness checks.

Hindsight-engine installations read their embedding model from the Hindsight
service (`HINDSIGHT_API_EMBEDDINGS_*`, see
[hindsight-upstream-service.md](hindsight-upstream-service.md)); re-index there.
