# Operating Knowledge memory — candidate contract

The full accuracy/recovery release gate has **not** passed. Healthy processes, successful model probes and document saves are not sufficient proof of useful memory.

## Install → configure models → connect an agent

1. Install the customer-owned runtime with persistent storage and instance-owner authentication. Keep internal GBrain loopback-only. Knowledge manages source-bound internal credentials; agents do not receive a GBrain admin token.
2. Configure chat, embeddings and an optional reranker through owner-authenticated `PUT /api/settings/models`. Provider checks cover dimensions, finite/nonzero vectors and simple semantic contrasts. Keys remain server-side and `GET` returns only key-free values. An update may omit `apiKey` for a connection to keep the key already saved for the same provider and exactly the same `baseUrl`; changing the provider or URL requires the key again (`400 model_api_key_required`), and models sharing a provider must share one URL and key (`400 model_provider_conflict`). Never silently reuse existing vectors after changing embedding models or formats: that requires an explicit migration/reindex decision.
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

For a reasoning-capable local model under a small output-token cap, set the optional owner model setting `chat.reasoningEffort` to `low`. Knowledge forwards this through GBrain's supported provider configuration; it does not replace the extractor or silently raise the model host's resource limits. Omit the setting for models that do not support it.

The customer-owned model gateway queues bursts separately for chat, embeddings and reranking. Each backend retains its bounded concurrency; waiting work is bounded and cancelled requests are removed. Authentication, fixed destinations and token caps remain enforced. The Portal does not run this gateway or hold these model credentials.

After a process crash or a genuinely uncertain write, the extraction receipt stays pending for reconciliation. Do not delete a receipt or change its idempotency key merely to make a failed status disappear: native side effects may already exist.

## Provider configuration and acceptance

Owner model settings accept `provider: "openrouter"` for chat, embeddings and
reranking. Configure the supported endpoint and model IDs for your account.
The managed adapter uses the native provider implementation. OpenRouter entries
in one instance share one endpoint and key because native gateway configuration
is provider-scoped. Existing reranker settings without a provider use
`llama-server-reranker`.

Keys remain server-side; settings reads redact them. Changing embedding model
identity requires an explicit migration/reindex even if vector width stays the
same. Use a disposable index when evaluating a new model configuration.

Evaluate retrieval on representative questions and independently measure
entity resolution, extraction, migration/reindex recovery and agent follow-up
reads. Process health and a small benchmark do not establish broad accuracy.
Bare Program deployments require a trusted owner setup path; verify the full
setup and authorization flow on the actual deployment before production use.
