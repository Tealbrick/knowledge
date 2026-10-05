# Research deployment and acceptance

Status, 13 September 2026: source-backed setup instructions, not a deployment
receipt. The native Knowledge image has passed Documents and GBrain projection
checks. Open Notebook Research in that image test was unconfigured. A container
health check must not turn this into a Research-ready claim.

## Two distinct access paths

The Portal attachment edge authorizes Documents and Brain operations and, when
Portal issues `knowledge:research:read` / `knowledge:research:write` on the
attachment, the Research engine routes (notebook discovery, notebook, sources,
notes, context, source writes and receipts, chat sessions, messages and
receipts). Chat send and chat receipts need both grants. The edge introspects
every required grant, then forwards the call with a per-request bearer that the
Program resolves to a principal bound to `KNOWLEDGE_COMPANY_ID` with exactly
those capabilities; notebook mapping and workspace checks still apply. Local
Research CRUD (`/api/research/summary`, legacy ask/chat) is not reachable by
attachments. Portal must start issuing the `knowledge:research:*` capabilities
before agents can use this path. Do not work around a missing grant by giving
the instance-wide `KNOWLEDGE_INSTANCE_TOKEN` to Eve or another agent.

Standalone Research has a separate, existing service-principal contract. At the
container edge, operator diagnostics require the instance header **and** the
scoped Research bearer; the Program validates the latter. A remote Portal agent
cannot currently use this path without additional integration. A complete
canvas Research hookup needs server-attested Research capabilities, a bridge to
the Program's principal resolver, notebook provisioning, expiry/revocation and
cross-workspace tests. Never forward the Open Notebook password to an agent.

## Provision one isolated stack per workspace

Use [compose.yaml](compose.yaml) for the three services and pinned upstream
images. Keep Open Notebook and SurrealDB on their private service network. Only
the authenticated Knowledge edge is eligible for a private external route.

Retain all three volumes: Knowledge `/data`, Open Notebook `/app/data`, and
SurrealDB `/mydata`. Knowledge's main store, GBrain home, source-write ledger
and chat ledger belong to the same exclusive workspace deployment. Sharing one
GBrain store between workspace deployments is unsupported.

Generate fresh independent secrets for the instance edge, Open Notebook API,
Open Notebook encryption key, SurrealDB and each Research service principal.
Store them in deployment secret configuration, not canvas JSON, URLs, source
control or examples. The encryption key must survive redeployment with its data.
Never load another agent's credentials to make a test pass.

Start SurrealDB and verify readiness; start Open Notebook and verify both its
API and command worker. The source-create endpoint requires the worker even
when the API health endpoint succeeds. Start Knowledge with the private API
origin and matching API credential. Compose health dependencies do not replace
the operation checks below. Establish resource headroom before adding these
services to the existing four-GiB Coolify test guest; the single Knowledge
startup peak alone was approximately 1.1 GiB.

## Models: Settings -> Models configures Research

Knowledge -> Settings -> Models is the single place to set model providers.
Saving there (and every Knowledge start, including after an upgrade) also
configures this deployment's Open Notebook: one encrypted credential per
provider named `tealbrick-knowledge-<provider>`, the chat and embedding models
linked to it, and Open Notebook's default chat, transformation, tools,
large-context and embedding models. The provider key stays on the server: it is
sent only to Open Notebook (stored encrypted) and is never written to
`/data/research-settings.json`, returned to a browser, or logged. The save
response and the settings page show the Research status; a Research failure
never undoes the memory save and is retried on the next start.

- Open Notebook needs `OPEN_NOTEBOOK_ENCRYPTION_KEY` to store the key; without
  it the status is `encryption_not_configured`.
- Ollama maps to `ollama` (without `/v1`), llama-server to `openai_compatible`.
- If Open Notebook already has a different default embedding model and holds
  sources or notes, Knowledge does not switch it (status
  `embedding_migration_required`): existing vectors would stop matching. Chat
  still follows the new models.
- Knowledge never deletes a model it did not create. If Open Notebook already
  has a same-name model on another key (or none), the status is
  `model_conflict` with a hint; remove that model in Open Notebook or pick a
  different model. The save still succeeds and the next start retries.
- `KNOWLEDGE_OPEN_NOTEBOOK_CHAT_MODEL_ID` remains an optional override; when it
  is unset, Research chat uses the synced model without a restart.

## Bind notebooks and identity

When `KNOWLEDGE_COMPANY_ID` is set and no binding exists for that workspace,
saving models also creates a local Research notebook owned by that workspace
and a new upstream notebook, and records the binding in
`/data/research-settings.json`. It takes effect immediately. The steps below
remain for extra notebooks or deployments without a bound workspace;
`KNOWLEDGE_OPEN_NOTEBOOK_BINDINGS` is an optional addition, and the union of
configured and saved bindings fails closed on any duplicate mapping.

1. Create a local Knowledge notebook owned by the intended workspace company
   ID, and a new upstream notebook in this deployment's Open Notebook. Retain
   the returned IDs; never invent them or select a notebook from another test.
2. Set `KNOWLEDGE_OPEN_NOTEBOOK_BINDINGS` to an array of exact objects with
   `knowledgeNotebookId`, `companyId`, `externalNotebookId`. The external ID has
   the upstream `notebook:` prefix. Duplicate local or upstream mappings fail
   closed. This is server configuration, not a tool-call selector.
3. Set `KNOWLEDGE_SERVICE_PRINCIPALS` to exact objects with `token`,
   `principalId`, `companyId`, `capabilities`. Use a distinct principal per agent.
   Discovery/reads require `research:read`; source/chat writes require
   `research:write`; chat send and chat receipts require both. These grants
   cover the company's mapped notebooks, not per-notebook ACLs.
4. Keep `KNOWLEDGE_RESEARCH_WRITE_LEDGER_PATH` and
   `KNOWLEDGE_RESEARCH_CHAT_LEDGER_PATH` on persistent storage, separate from
   each other and the main database. Defaults are `/data/research-writes.sqlite`
   and `/data/research-chat.sqlite` when `KNOWLEDGE_DATA_DIR=/data`.
5. Restart Knowledge with the reviewed mapping/principal configuration. Current
   standalone credential changes require restart; this is not a dynamic Portal
   grant or an automatically refreshed attachment.

## Model-backed chat

Settings -> Models provisions the provider and models (see above). To pin a
different Open Notebook language model, set `KNOWLEDGE_OPEN_NOTEBOOK_CHAT_MODEL_ID`
to its `model:<id>` record ID; a provider's model name alone is not that ID.
The caller cannot select the model or supply its own context/source IDs.

Plain-text source creation can run with embedding and transformations disabled;
it needs no model credential. That success is not an embedding/search-generation
or Research chat test. GBrain extraction and embeddings also require their own
configuration and evidence; a projected document page is not an extracted
entity/fact or successful semantic query.

## Acceptance sequence

Use synthetic content and a disposable principal. Record source/image digest,
service release IDs, workspace, operation receipt IDs and result codes without
tokens or source bodies in shared logs.

| Check | Required evidence |
| --- | --- |
| Private service health | SurrealDB ready; Open Notebook API and worker running; Knowledge edge rejects missing credentials |
| Notebook discovery | Only the current principal's mapped local notebook is returned |
| Source create | Production Research route returns durable receipt; same key/body replays without duplicate upstream source |
| Context read | Exact synthetic content returned through Knowledge, marked untrusted source data; `modelInvoked: false` |
| Chat | Principal-owned session and server-selected model; saved answer and turn receipt from a real provider invocation |
| Restart | Notebook mapping, source, chat ownership and receipts survive service restart with the retained volumes |
| Isolation | Missing/wrong principal and foreign-company notebook requests denied; another principal cannot read private chat receipts |
| Ambiguity | Held/uncertain write cannot be retried under a new key; inspect existing receipt and upstream evidence |
| Portal attachment | Agent with `knowledge:research:read`/`write` reaches only its workspace's mapped notebooks; missing grant is denied; never replaced with an instance-wide secret |

For exact endpoints and request shapes, use the
[Research agent contract](../../docs/research-agent-contract.md). For the
existing keyless native fixture, use
[Open Notebook runtime validation](../../docs/open-notebook-runtime-validation.md).
Neither fixture discovery nor a scripted API request proves an actual Eve
conversation. Record the final model/tool invocation separately.
