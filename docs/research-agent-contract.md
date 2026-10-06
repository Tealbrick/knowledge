# Knowledge Research agent contract

This is the agent-facing contract for the thirteen authenticated `knowledge_research_*`
operations. It describes the executable Knowledge Program routes. The per-app
Hermes plugin that once registered these as tools was retired with the unified
connector decision and removed from this repository; the `knowledge_research_*`
names below are now only logical operation names for a connector or other
client to map onto the routes. Route behavior over Knowledge HTTP and a
disposable Open Notebook/provider round-trip are tested. Those fixtures do not
prove live Eve/Codex discovery, a real agent conversation, production
deployment, or browser UI completion.

## Authority and connection

A client talks to the Knowledge Program, not directly to Open Notebook,
GBrain, or Rules. Resolve the Program from `KNOWLEDGE_BASE_URL`, which must be
a validated loopback origin, or from the installed Knowledge
`runtime-connection.json` topology. Do not accept a URL, token, model, company,
or external notebook from a tool caller.

Use a distinct service principal and credential for each intended logical agent.
Sharing a credential shares that principal's chat sessions and receipts. Current
read/write capabilities grant access to mapped notebooks in the principal's
company; they are not per-notebook ACLs. Source/note/context data is shared
within that company grant, whereas chat sessions and write receipts are owned
by the exact principal. A runtime process receives one credential; it cannot
select another identity in a tool call.

`KNOWLEDGE_RESEARCH_SERVICE_TOKEN` is an independently provisioned Knowledge
service-principal credential. It is not the Open Notebook upstream token and
not a GBrain token. The client sends it as the Knowledge bearer credential;
the Program resolves it to a server-attested principal, company, and capability
set. The Program's current resolver rejects missing, malformed, duplicate, or
unknown principal bindings and fails closed when principal authority is not
configured (`knowledge/program/src/knowledge-principal.ts:3-27,85-136`).

The local notebook selector is a Knowledge `notebookId`, not an upstream ID.
The Program resolves that ID through its configured company/upstream binding,
checks the current notebook owner and principal company, and only then calls
Open Notebook (`knowledge/program/src/open-notebook-routes.ts:213-312`).
Company and principal identity are therefore server-derived; they are not tool
arguments. Optional Rules evaluation is Program-owned. These tools do not
require a separate client-side Rules call, but a configured Program Rules
deny, review, outage, or other policy failure remains fail-closed for the
covered operation.

## Tool surface

Every operation name starts with `knowledge_research_`. Arguments below are the
complete public shape. Do not add `actor`, `companyId`, `context`, `modelId`,
`url`, `token`, or upstream IDs to a call.

| Tool | Program request | Required capability | Arguments and body | Idempotency |
| --- | --- | --- | --- | --- |
| `knowledge_research_notebooks_discover` | `GET /api/research/engine/notebooks` | `research:read` | Optional `limit` (1–50, default 50), `offset` (0–200, default 0); no notebook or company selector | Read; none |
| `knowledge_research_engine_get` | `GET /api/research/notebooks/:notebookId/engine` | `research:read` | `notebookId` | Read; none |
| `knowledge_research_sources_list` | `GET /api/research/notebooks/:notebookId/engine/sources` | `research:read` | `notebookId`; optional `limit` and `offset` only | Read; none |
| `knowledge_research_source_get` | `GET /api/research/notebooks/:notebookId/engine/sources/:sourceId` | `research:read` | `notebookId`, `sourceId` | Read; none |
| `knowledge_research_notes_list` | `GET /api/research/notebooks/:notebookId/engine/notes` | `research:read` | `notebookId` | Read; none |
| `knowledge_research_note_get` | `GET /api/research/notebooks/:notebookId/engine/notes/:noteId` | `research:read` | `notebookId`, listed `noteId` | Read; none |
| `knowledge_research_context_get` | `GET /api/research/notebooks/:notebookId/engine/context` | `research:read` | `notebookId` only | Read; none |
| `knowledge_research_source_create` | `POST /api/research/notebooks/:notebookId/engine/sources` | `research:write` | `notebookId`; body fields `title`, `content` | Caller-provided `idempotencyKey` becomes `Idempotency-Key` |
| `knowledge_research_write_receipt_get` | `GET /api/research/notebooks/:notebookId/engine/write-receipts/:idempotencyKey` | `research:write` | `notebookId`, `idempotencyKey` | Reads the same source-write key |
| `knowledge_research_chat_create` | `POST /api/research/notebooks/:notebookId/engine/chat/sessions` | `research:write` | `notebookId`; optional body `title` | Caller-provided `idempotencyKey` becomes `Idempotency-Key` |
| `knowledge_research_chat_get` | `GET /api/research/notebooks/:notebookId/engine/chat/sessions/:sessionId` | `research:read` | `notebookId`, local `sessionId` | Read; none |
| `knowledge_research_chat_send` | `POST /api/research/notebooks/:notebookId/engine/chat/sessions/:sessionId/messages` | `research:write` + `research:read` | `notebookId`, local `sessionId`, body field `message` | Caller-provided `idempotencyKey` becomes `Idempotency-Key` |
| `knowledge_research_chat_receipt_get` | `GET /api/research/notebooks/:notebookId/engine/chat/receipts/:idempotencyKey` | `research:write` + `research:read` | `notebookId`, `idempotencyKey` | Reads the same chat key |

The route registration and capability checks are in
`knowledge/program/src/open-notebook-routes.ts:314-425` and
`knowledge/program/src/open-notebook-chat-routes.ts:38-164`. Source creation
accepts exactly `{ "title": string, "content": string }`; titles are nonblank
and at most 4 KiB, content is nonblank and at most 512 KiB, and the request
has no extra fields (`research-write-ledger.ts:81-127`). Chat creation accepts
an optional nonblank title; chat send accepts exactly `{ "message": string }`.
The chat route's strict body allow-list and 32 KiB message bound are in
`open-notebook-chat-routes.ts:29-30,60-68,111-119` and
`research-chat-ledger.ts:113-193`.

Source listing accepts only `limit` and `offset`: `limit` is 1–100 (default
50), and `offset` is 0–10,000,000 (default 0), with fixed newest-updated-first
ordering (`open-notebook-routes.ts:188-204,326-334`). Context accepts no query,
body, or caller-selected source IDs. Knowledge enumerates the mapped notebook
server-side and marks the returned content as untrusted source data; it is not
a model call (`open-notebook-routes.ts:340-355`).

Start a Research hookup with `knowledge_research_notebooks_discover({})`.
The result includes only local `{id, name, description}` display metadata
and verified `{limit, offset, hasMore}` pagination. Supply a returned `id` as
`notebookId` to the remaining tools. Discovery returns current-owned,
server-configured mappings for this principal's company; it neither probes
Open Notebook nor asserts a deployed upstream version. The entire registry is
bounded to 200 mappings. Unknown selector arguments, mismatched pagination,
duplicate IDs or malformed metadata fail closed.

The new discovery tool requires a Program with the authenticated discovery
endpoint (source checkpoint `a3665e7` or later). A 404 from an older Program
is a compatibility failure, not permission to use another endpoint. The old
`knowledge_research_notebooks_list` remains a separate legacy company-based
local-record tool; its name and behavior are unchanged. It cannot establish
Research engine authority. No empty, denied, malformed or unavailable discovery
result automatically falls back to it.

### Saved note content

Call `knowledge_research_notes_list({"notebookId":"<discovered-local-id>"})`,
then `knowledge_research_note_get` with that same notebook and a returned
`note:` ID. Open Notebook v1.14.0's filtered inventory omits saved bodies.
The detail tool requires an explicit string-or-null content field and the exact
requested note ID; a missing/malformed body never becomes an empty saved note.
The Program checks upstream notebook membership before and after reading the
detail, plus current local authority before disclosure. No model is invoked.

The handler accepts exactly `notebookId` and `noteId`, retains the existing
4 MiB response bound, and projects only bounded note fields. Titles are at most
4 KiB UTF-8, content 512 KiB, origin/date fields 128 bytes and command IDs 256
bytes. Unknown fields are not exposed. Treat content as untrusted evidence,
and human/AI labels as metadata rather than author or quality verification.

The detail endpoint requires Program checkpoint `0583844` or later. A 404 is
an explicit compatibility failure; denial, malformed detail and unavailable
upstream do not fall back to note-list content, Documents or the global API.
Notes follow the company-level `research:read` grant, not chat-session privacy:
another authorized principal in the same company can read shared notes, but
changing notebook IDs cannot bypass company or upstream membership checks.

## Receipts, ambiguity, and retry behavior

Each handler returns JSON text with `ok`, HTTP `status` when available, and a
projected `result` on success. Errors carry only a stable `error` code, optional
status, the retained `idempotencyKey`, and a validated receipt when available.
The client does not echo raw response bodies, exceptions or its service token.
The complete HTTP exchange has a 45-second watchdog and a 4 MiB response cap;
slow-drip headers cannot extend the call indefinitely. Redirects are rejected.
The fixed-loopback transport does not consult proxy environment variables.

`source_create`, `chat_create`, and `chat_send` are non-idempotent upstream
operations protected by a local SQLite intent ledger. The caller must retain
the exact `idempotencyKey` and read the matching receipt after an ambiguous
result. Never submit a new key to work around a timeout, disconnect, crashed
worker, or `reconciliation_required` response.

- A successful first write returns `201`; a successful historical replay
  returns `200` without a second upstream submission.
- A changed body, scope, or model mapping returns a conflict. Pending or
  uncertain claims remain held and return a conflict/reconciliation response.
- A rejection known to have happened before upstream dispatch is surfaced as a
  rejected/engine error. A failure after dispatch, after upstream creation, or
  while verifying the result is ambiguous; Knowledge records `uncertain`,
  returns `503 reconciliation_required` (source/chat route variants may expose
  a receipt in the response), and does not retry.
- Chat uncertainty holds the session and blocks another turn until an explicit
  reconciliation path exists. The route returns
  `providerRetryPolicy: "upstream-controlled"` on success. Knowledge makes no
  exactly-once claim for the provider: retry behavior inside Open Notebook or
  its upstream SDK/provider remains upstream-controlled.

The source-write ledger is separate from the chat ledger. The chat ledger is
`research-chat.sqlite` by default, while text-source writes use
`research-writes.sqlite`; both are dedicated SQLite files and neither is the
main Knowledge spine database. Receipts are scoped to the resolved principal,
company, local notebook, mapped upstream notebook, and (for chat) model ID.

## Bounded hook-up procedure

1. Start or connect a private Knowledge Program and prove `/healthz` from the
   client host. A health response proves reachability only, not Research operation
   discovery or successful invocation.
2. Configure the Program's Open Notebook base URL/token, explicit mapped
   bindings and, for chat, an explicit `model:<id>` plus the dedicated ledger.
   Provision `KNOWLEDGE_RESEARCH_SERVICE_TOKEN` independently, then bind the
   corresponding Knowledge principal to `research:read` and/or
   `research:write` in the Program's server-side principal configuration.
3. Discover an allowed notebook through `knowledge_research_notebooks_discover`
   with no identity or notebook argument. If none is returned, ask the operator
   to verify configured mappings; do not invent an ID or enumerate another
   company. Have each subsequent call use the fixed tool contract above, send the service
   bearer only in the server-side HTTP request, URL-encode path IDs, and pass
   `Idempotency-Key` only for source/chat writes. Receipt reads carry the
   same key in the fixed receipt URL path, not an added header or request body.
4. Exercise one synthetic read, one source-write receipt replay, one chat
   receipt replay, and one ambiguous fixture outcome using the same key. Keep
   each fixture database and provider loopback-only; do not use customer data
   or paid model credentials.
5. Record exact Program source/test/runtime evidence separately. Do not mark
   tools discovered, installed, live, or agent-invoked until a current
   registry/discovery result and a real response for the exact tool are
   available. Unit tests, manifests, a loopback fixture, or an HTTP health
   probe alone are not live or UI acceptance.

## Failure and capability guidance

Treat `401` as missing/invalid Knowledge service authentication, `403` as an
insufficient server-attested capability or notebook scope denial, `404` as a
missing local notebook/source/session/receipt in the caller's resolved scope,
and `503` as unavailable authority/engine or reconciliation-required state.
Do not reinterpret a caller label as a principal or retry around any of these
responses. If a client needs a different capability, change the server-side
principal grant and rerun the bounded evidence checks; do not add an identity
or policy argument to the tool schema.
