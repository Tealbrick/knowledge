# Submit a text source to Open Notebook Research

This browser workflow uses Knowledge's existing mapped Open Notebook write
contract. Configure the [operator session](research-browser-session.md), a
server-owned notebook binding, and the dedicated Research write ledger first.
The browser form requires both Research read and write capability so it can
display the result. The write/receipt API itself requires `research:write`.
New submissions also wait for a successful mapped inventory read. A loading
or failed inventory disables new writes, but does not disable checks for an
already-pending source receipt.

## What is submitted

The form sends only `{title, content}` to
`POST /api/research/notebooks/:notebookId/engine/sources`, with the existing
same-origin cookie, CSRF token and a newly generated `Idempotency-Key`.
The server chooses the upstream notebook; the caller cannot override company,
principal, model, external notebook, credentials or processing options.
Title is bounded to 4 KiB UTF-8 and content to 512 KiB UTF-8. Blank text is
rejected. URL/file uploads, embedding, transformations and model selection are
not enabled by this form. Creating this bounded text source does not request
a model invocation.

## Receipt-first behavior

Before sending, the tab saves a pending reference scoped to principal, company
and Knowledge notebook. It stores no source title/content or credentials.
If reference storage is unavailable or malformed, writes remain disabled.

Only an explicit succeeded receipt confirms completion. Inventory refresh is
a separate read, not the source-write outcome. If refresh fails after a
successful receipt, do not re-create the source; retry the inventory read.

If the response is lost, rejected by a gateway, malformed or otherwise
unconfirmed, the original key remains pending. Reload or sign in again and
use **Check source receipt**, which only performs:

`GET /api/research/notebooks/:notebookId/engine/write-receipts/:key`

Pending or uncertain receipts do not resend work. A missing receipt does not
prove a request never ran. The UI offers no reset/new-key shortcut for an
unresolved submission. An explicit rejected receipt is terminal; a generic
HTTP error without a validated receipt is not treated as one.

Tab-local storage preserves the reference across reload, not browser data
erasure or every cross-tab/session workflow. It is not an authorization source
or a distributed submission lock. Preserve the displayed key for manual
recovery; clearing storage or submitting the same content under another key
can create a duplicate and is not a reconciliation procedure.

## Boundaries

The server write ledger remains the durable execution authority. Upstream has
no general idempotency guarantee: a process crash or upstream timeout may need
operator reconciliation. The accepted API refuses same-key ambiguous replay;
the browser does not automatically retry POST requests or claim exactly-once
provider execution.

General Knowledge login, legacy CRUD authorization, shared-SaaS tenancy and
deployment require separate verification on the target installation.
