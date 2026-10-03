# Open Notebook Research connection

Open Notebook is Knowledge's Research engine; GBrain owns Brain. The first
wired engine provides authenticated, mapped upstream notebook reads and durable
text-source creation.
Scoped engine chat is now implemented separately; see the
[Research agent contract](research-agent-contract.md). It does not replace the
legacy local ask/chat path or automatically deploy/configure Open Notebook.
Keep the Program loopback/private: older domain routes still require
general authentication/object-authorization work before remote exposure.

## Trusted server configuration

Configure these on the Knowledge server, never in browser code or a URL:

- `KNOWLEDGE_OPEN_NOTEBOOK_BASE_URL`: dedicated Open Notebook API origin.
- `KNOWLEDGE_OPEN_NOTEBOOK_TOKEN`: upstream service credential.
- `KNOWLEDGE_SERVICE_PRINCIPALS`: JSON array of explicit Knowledge credentials
  and grants. Entries have exactly `token`, `principalId`, `companyId` and
  `capabilities`. Reads require `research:read`; writes/receipts require the
  separate `research:write` grant.
- `KNOWLEDGE_OPEN_NOTEBOOK_BINDINGS`: JSON array whose entries have exactly
  `knowledgeNotebookId`, `companyId`, and `externalNotebookId`.
- `KNOWLEDGE_RESEARCH_WRITE_LEDGER_PATH`: absolute dedicated SQLite file.
  Defaults to `research-writes.sqlite` under the data directory outside tests;
  tests must explicitly supply a disposable path. Opened only with a configured
  engine and a write-capable principal. Back it up with notebook configuration;
  deleting it destroys duplicate protection. Do not point it at the main DB.

Example shapes only; replace identifiers and supply independently generated
credentials through your secret manager. Do not use these placeholders:

```json
[{"token":"REPLACE_WITH_KNOWLEDGE_SERVICE_SECRET","principalId":"research-agent","companyId":"company-alpha","capabilities":["research:read"]}]
```

```json
[{"knowledgeNotebookId":"EXISTING_LOCAL_NOTEBOOK_ID","companyId":"company-alpha","externalNotebookId":"notebook:EXISTING_UPSTREAM_ID"}]
```

The local notebook must already exist in that company. The mapping is an
operator-owned configuration decision, not a client request parameter. Duplicate
local or upstream notebook mappings fail closed. One upstream notebook cannot
be accidentally shared by two company mappings. Multiple agents can have
independent credentials for the same company. Restart with updated bindings
to revoke/change credentials; this packet has no dynamic credential admin API.

## Agent-facing read routes

Send the **Knowledge** service bearer, not the Open Notebook credential:

- `GET /api/research/notebooks/:notebookId/engine`
- `GET /api/research/notebooks/:notebookId/engine/sources`
- `GET /api/research/notebooks/:notebookId/engine/notes`
- `GET /api/research/notebooks/:notebookId/engine/notes/:noteId`
- `GET /api/research/notebooks/:notebookId/engine/sources/:sourceId`
- `GET /api/research/notebooks/:notebookId/engine/context`

The first ID is the local Knowledge notebook ID. Source IDs are validated
against that mapped upstream notebook; there is no global inventory proxy.
Source listing accepts only `limit` (1–100, default 50) and `offset`
(0–10,000,000, default 0), with fixed newest-updated-first ordering. Its response
includes pagination values; clients must request subsequent pages explicitly.
Responses identify `provider: open_notebook`, the supported contract baseline
and `observedVersion: null`. A successful request proves that operation, not
the service version, model availability or whole Research feature parity.
Local filesystem paths and service credentials are excluded from responses.

Open Notebook's filtered notes list omits bodies. The note-detail route checks
the requested note's membership in the mapped upstream notebook before and
after retrieving its body, within one deadline. It rejects scope/query/body
overrides and never substitutes list metadata for saved content. See the
[notes browser contract](research-notes-browser.md). Agents reach the same
operation through `knowledge_research_note_get` in the thirteen-tool
[Research contract](research-agent-contract.md).

Authentication and notebook ownership run before optional Rules. Configured
Rules receives the resolved principal/company; deny, review and outage stay
fail-closed. No Rules binding is required for the standalone read path.
Engine errors never silently fall back to the local store.

### Research context for agents

The context route accepts no query/body selectors. Knowledge enumerates the
mapped notebook, chooses full content, and asks Open Notebook to build that
context using only the enumerated IDs. It validates every returned source/note,
rejects missing/foreign/duplicate records, then rechecks membership and the
Knowledge principal/owner before returning. This closes the upstream builder's
arbitrary-ID configuration boundary; browser/agent context is never forwarded.

Context contains projected sources (`id`, `title`, `fullText`, typed insights),
notes (`id`, `title`, `content`) and upstream `tokenCount`/`charCount` estimates.
The counts describe the upstream assembly; token counts can use upstream's
offline word-count fallback. They are not a model quota/billing guarantee.
`modelInvoked: false` distinguishes this operation from a generated answer.
`contentTrust: untrusted-source-data` marks documents/notes as evidence, never
instructions that can grant tools, change scope or override operator policy.

The first bounded policy supports at most 100 sources and 100 notes, with one
total adapter deadline and the configured response byte cap. Larger notebooks
return `413 research_context_limit_exceeded`, not a silently partial context.
Membership changes produce `409`; missing upstream items produce `502`.
Membership is rechecked, but upstream has no atomic snapshot/revision contract:
content may change during assembly. Responses are `Cache-Control: no-store`.

This context operation does not create a chat session or call a model. Separate
engine chat routes implement principal-owned sessions, turn receipts and an
operator-pinned model. Their availability requires additional configuration and
their own model-path acceptance; context success does not prove chat works.
Legacy local ask/chat remains a separate degraded path.

## Agent-facing text-source writes

`POST /api/research/notebooks/:notebookId/engine/sources` accepts exactly
`{"title":"Research observation","content":"Source text"}` with a Knowledge
service bearer and an `Idempotency-Key` header. Title is nonblank and at most
4096 UTF-8 bytes; content is nonblank and at most 512 KiB. Keys are 1–256 ASCII
characters: start alphanumeric, followed by alphanumerics or `_.:/-`.
Reuse the same key for the same logical request. Keys are scoped to the stable
principal/company, and cannot be reused for another notebook mapping/body.

The upstream notebook is server-selected. Embedding, transformations, deletion
and async processing are fixed off; no model/provider credential is needed.
Open Notebook's command worker is still required. The response is a durable
receipt, not a browser-visible upstream credential or full raw source.

- `201`: source created and membership verified; `replayed: false`.
- `200`: successful historical receipt replay; no additional write. It does
  not prove that a source still exists upstream.
- `409`: changed request/mapping or existing pending/uncertain/rejected claim.
- `503` with `reconciliation_required`: the outcome may be committed upstream.
  Do not submit a new key to work around it.

Inspect `GET /api/research/notebooks/:notebookId/engine/write-receipts/:idempotencyKey`
(URL-encode the key). Only the original principal in the same company/mapping
can read it. SQLite persists claims across restarts and arbitrates concurrent
processes using the same dedicated file. This is not a distributed ledger for
independent replicas/files, nor a claim of upstream exactly-once execution.
After a crash or uncertain response, the key stays held. Automatic recovery and
an evidence-based reconciliation action are not implemented; an operator must
inspect upstream before any recovery decision. Never delete a claim to retry.

## Remaining acceptance

The [real native runtime fixture](open-notebook-runtime-validation.md) now
exercises actual Open Notebook storage and these mapped read routes with
synthetic data. This does not deploy a service.

Neither unit/HTTP fixtures nor a disposable real runtime are a deployed service.
The [container Research runbook](../deploy/container/RESEARCH-SETUP.md) separates
standalone Research configuration from the currently narrower Portal attachment.
Full first hookup still requires deployed credentials, mapped notebooks, model
configuration and exact-path acceptance. Explicit reconciliation of uncertain
writes remains unfinished. Legacy local ask/chat remains degraded; no migration
or deployment is implicit.
