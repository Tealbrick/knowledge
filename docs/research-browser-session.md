# Research browser session (implemented contract)

Status: source and web transport are implemented. Current disposable browser
QA has exercised sign-in, chat creation, send, history, reload, missing-CSRF
rejection, held uncertainty with the original key, receipt reads without
another provider call, and logout. The model is synthetic and loopback-only;
this is not a deployment, live-provider, or human-UAT claim. Repeat acceptance
against the exact release and configuration you intend to deploy.

The bridge is an opt-in, single-operator Research session owned by Knowledge.
It protects the Open Notebook engine routes and the Research chat panel. It
does not provide general Knowledge-app authentication, shared-SaaS tenant
isolation, an Organization Plane login, or a cross-origin parent-frame
handshake.

## Actual server configuration

There are exactly three browser-session environment variables. There is no
`ENABLED` variable and no configurable TTL variable. The bridge is disabled
when all three are absent. If any one is present without the other two,
startup fails with `Invalid Knowledge browser session configuration`; it does
not silently fall back to an incomplete session.

| Environment variable | Actual behavior |
| --- | --- |
| `KNOWLEDGE_BROWSER_OPERATOR_SECRET` | Separate operator login secret. The authority accepts 32–1024 UTF-8 bytes, rejects blank values, stores only its SHA-256 digest, and compares login attempts with a constant-time digest check. It must not be a service, Open Notebook, GBrain, Rules, or provider credential. |
| `KNOWLEDGE_BROWSER_PRINCIPAL_ID` | Exact existing configured `KnowledgeServicePrincipal.principalId`. Startup resolves it through `resolveById`; an unknown, duplicate, malformed, or revoked principal fails closed. Company and capabilities come from the server-side principal binding, not the browser. |
| `KNOWLEDGE_BROWSER_ORIGIN` | One exact origin. It must parse to an origin with `/` as its only path and no credentials/query/hash. HTTPS is accepted generally; HTTP is accepted only for loopback (`127.0.0.1`, `localhost`, or IPv6 loopback). The request host and browser origin are checked separately. |

The values are loaded by `knowledge/program/src/config.ts:37-47,171-175` and
validated when `buildKnowledgeApp` constructs the authority at
`knowledge/program/src/app.ts:977-1004`. The configured principal binding
shape and server-only `resolveById` lookup are in
`knowledge/program/src/knowledge-principal.ts:10-30,96-144`.
The corresponding `KnowledgeConfig` fields are declared at
`knowledge/program/src/types.ts:29-32`.
Startup also rejects reuse of a configured Knowledge service, Open Notebook,
GBrain or Rules credential as the operator code. Other provider credentials
must likewise remain separate; the Program does not inspect arbitrary
provider environments to discover them.

The fixed authority bounds are source constants in
`knowledge/program/src/research-browser-session.ts:8-19`:

- one-hour session TTL (`3,600,000` ms);
- at most 32 in-memory sessions;
- at most eight login attempts per 60-second authority-instance window;
- session IDs and CSRF tokens are 32 random bytes;
- session records retain digests, the configured principal ID, expiry, and the
  in-memory CSRF token; raw operator/service credentials are not persisted.

Restarting the Program clears the in-memory session map and therefore revokes
all browser sessions. The current principal is re-resolved on status,
authentication, and login; removing or changing the configured principal
invalidates an existing session (`research-browser-session.ts:276-297,345-405`).
The production resolver is a startup snapshot: editing environment values is
not hot revocation; a Program restart is required to apply changed grants.
This is a safe single-process local boundary, not a distributed session store
or a multi-user account system.

## Cookie, origin, and CSRF contract

Successful login issues the opaque cookie
`knowledge_research_session` with these exact attributes:

```text
HttpOnly; SameSite=Strict; Path=/api/research; Max-Age=3600
```

`Secure` is appended when `KNOWLEDGE_BROWSER_ORIGIN` is HTTPS. No `Domain`
attribute is set, so the cookie remains host-only. Logout clears the same
cookie path with `Max-Age=0`. The implementation is at
`research-browser-session.ts:374-390` and the clear operation is at
`app.ts:1643-1655`.

The authority enforces the configured origin, request host, and Fetch Metadata
headers (`research-browser-session.ts:299-325`): when Fetch Metadata is present,
GET permits `same-origin` or `none`; writes permit only `same-origin`. Missing
Fetch Metadata is allowed for compatible clients. Normal same-origin GETs may
omit Origin, but must still carry the exact configured Host; a present Origin
must match exactly. Writes always require an exact Origin. A POST or
DELETE with a browser session also requires `X-CSRF-Token` matching the
session verifier (`:326-330,393-414`). A server-to-server bearer request with
no browser headers remains supported when the browser bridge is configured.

Research paths are excluded from the old wildcard-CORS response and receive
`cache-control: no-store` (`knowledge/program/src/app.ts:306-308,1392-1406`).
When the browser session is configured, the web shell sets
`frame-ancestors 'self'`; without it the historical shell remains broad
(`app.ts:1568-1574`). The browser packet therefore supports same-origin
`/embed` only; it does not establish safe cross-origin embedding.

Cookie scope is host-wide, not port-isolated. Do not serve untrusted apps on
other ports of the same hostname and treat this as isolation from them. Use a
dedicated trusted HTTPS origin for a deployment. `Path=/api/research` also
sends the cookie to legacy Research routes; those routes do not consume this
session authority and remain outside this authentication claim. The legacy
local notebook/source CRUD and ask APIs still need the general authorization
packet before shared-service exposure.

## Actual session API

All three lifecycle routes are registered in
`knowledge/program/src/app.ts:1597-1655`.

### `GET /api/research/browser-session`

This is a `200` no-store status response. When disabled it returns:

```json
{"enabled":false,"authenticated":false,"principal":null,"csrfToken":null,"expiresAt":null}
```

When enabled but no valid cookie is present, `enabled` is `true` and the
remaining values are null. An authenticated response contains only the
server-attested `{principalId, companyId, capabilities}`, a per-session
`csrfToken`, and an ISO `expiresAt`. It never returns a bearer, operator
secret, Open Notebook token, GBrain token, or provider credential. Invalid or
revoked cookies are reduced to unauthenticated status.

### `POST /api/research/browser-session`

The request body must contain exactly one key, `secret`, whose value is a
string. The route caps the entire raw JSON body at 4096 bytes before parsing;
the configured valid code is 32–1024 bytes. Oversized raw bodies return 413.
The secret belongs in
the same-origin request body only; do not put it in a URL, query string,
redirect, source file, frontend environment variable, or log. Successful
login returns `200`, the status object, and the `Set-Cookie` header above.

Malformed bodies return `400 invalid_browser_session_request`. Bad secrets
return `401 browser_session_login_failed`; rate limiting returns `429
browser_session_rate_limited`; origin/host/fetch-site failures return their
`403 browser_session_*` code. Error responses do not reveal whether a
principal, company, or secret was almost correct.

### `DELETE /api/research/browser-session`

Logout requires a valid cookie, exact same-origin request, and matching
`X-CSRF-Token`. It returns `200` unauthenticated status and clears the
host-only cookie. Disabled lifecycle routes return `404
browser_session_disabled`; invalid cookie/CSRF/origin errors are mapped by
`browserSessionErrorStatus` (`research-browser-session.ts:417-423`).

The lifecycle routes are intentionally not classified as Knowledge domain
operations, so they do not trigger a central Rules decision. The explicit
Research engine/chat routes remain subject to the normal Rules pre-handler when
Rules is configured (`research-browser-session.test.ts:216-221` and
`app.ts:1408-1468`). Rules remains optional: without a central binding,
standalone Knowledge uses its own app-owned authority; with a configured
binding, a Rules denial or outage blocks covered effects.

## Engine and chat authorization

`knowledge/program/src/open-notebook-routes.ts:225-290` now accepts either:

1. the existing server-to-server bearer resolved by the configured principal
   resolver; or
2. a browser cookie session, only when no Authorization header is supplied.

Browser-shaped requests are checked for same-origin before either path is
used. Without a configured browser session, an engine request carrying an
`Origin` is rejected as `403 research_origin_denied`; a server-to-server
bearer without browser headers remains available. After resolution, both paths
use the same capability, mapped-notebook, current-owner, and company checks at
`open-notebook-routes.ts:293-326,328-365`. A URL `companyId` remains a UI
selector and cannot grant access.

The browser reuses the existing server-selected Open Notebook chat routes:

- `POST /api/research/notebooks/:notebookId/engine/chat/sessions`, exact body
  `{}` or `{title}`, `Idempotency-Key`, `research:write`;
- `GET /api/research/notebooks/:notebookId/engine/chat/sessions/:sessionId`,
  `research:read`;
- `POST /api/research/notebooks/:notebookId/engine/chat/sessions/:sessionId/messages`,
  exact body `{message}`, `Idempotency-Key`, CSRF, and both read/write
  capabilities;
- `GET /api/research/notebooks/:notebookId/engine/chat/receipts/:key`, for
  same-key receipt reconciliation.

`open-notebook-chat-routes.ts:38-164` keeps the model, mapped upstream
notebook, context, and previous history server-selected. The SQLite chat
ledger holds pending/uncertain claims and rejects a new-key retry after an
ambiguous result. Provider retry behavior remains upstream-controlled; the
browser UI does not claim exactly-once provider execution.

## Current browser transport and UI

The current browser transport is `knowledge/program/web/src/research-chat-api.ts`:

- `:40-58` uses `credentials: "same-origin"`, `cache: "no-store"`,
  `redirect: "error"`, a 45-second request deadline, a 4 MiB response-body cap, and no Authorization
  header;
- `:60-72` strictly parses status and sends only the login `secret` body or
  logout CSRF header;
- `:89-104` sends the exact engine paths, CSRF/idempotency headers, and
  validates receipt/session/history envelopes without reflecting arbitrary
  server bodies.

`ResearchChatPanel.tsx` checks status on mount/focus, clears the login
input after submission, exposes sign-in/sign-out, and refuses to treat the
selected URL company as authority. Its authenticated workspace stores only a scoped local
session ID and pending idempotency reference in `sessionStorage`; it does
not store credentials or message text. It disables duplicate writes,
checks the same receipt key after pending/uncertain responses, renders
server history, and keeps the local no-model fallback separate. The panel is
mounted independently of notebook selection in `ResearchView.tsx`; the legacy
records mount only when their separate disclosure opens.

Chat writes require both `research:read` and `research:write`. The separate
source inventory/detail surface requires only `research:read`; see the
[source browser guide](research-source-browser.md).
Notebook navigation now comes from the authenticated mapped-notebook discovery
route, not the old URL-company notebook list. The app workspace selector
continues to affect the separately opened local records, but cannot select or
grant engine scope. Sign-in is available even when that local workspace is
empty. See [notebook discovery](research-notebook-discovery.md).

## Evidence boundary and remaining gates

Current root QA reports a disposable browser fixture proving sign-in, chat
session creation, message send, history, reload, and missing-CSRF `403`. The
source suites independently cover cookie flags, exact body validation,
principal revocation, origin/host/Fetch Metadata rejection, rate limits,
expiry/store bounds, logout, and the no-credential browser transport:

```sh
pnpm --dir knowledge/program test:program -- research-browser-session.test.ts
pnpm --dir knowledge/program test:web -- research-chat-api.test.ts
```

The uncertain browser execution stays held through reload; reading the receipt
does not retry or reconcile the provider. A failed request without a readable
receipt also stays held, including authentication failures that may have
occurred during the server's post-dispatch recheck. Do not clear the reference
or send a new key on the assumption that no work happened. There is no automatic
uncertain-write reconciliation UI in this packet. No live Open Notebook
provider, paid call, deployed service, customer data, shared-SaaS tenant
isolation, general Knowledge authentication, or human UAT is established by
the source or disposable fixture evidence. Engine/service credentials stay
server-side. The separate operator code is entered transiently in the login
form, sent in the same-origin request body and cleared; it is not saved in
browser storage. The public code in the opt-in browser fixture is synthetic
test data, never a default for the Program.
