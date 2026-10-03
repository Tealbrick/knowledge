# Open Notebook notes in Research

Open Notebook LM is Research's foundation. Its saved notes are distinct from
local Research outputs and canonical Knowledge documents. Reading a note does
not generate content, run a transformation or promote it into Documents.

## Read-only browser contract

Sign in using the existing [Research session](research-browser-session.md),
select an authorized mapped notebook, then choose **Browse notes**. This loads
the upstream notebook's note inventory only on demand. Selecting a note reads
its saved body through a separate notebook-scoped endpoint:

- `GET /api/research/notebooks/:notebookId/engine/notes`
- `GET /api/research/notebooks/:notebookId/engine/notes/:noteId`

Open Notebook v1.14.0's notebook-filtered list omits note bodies by default.
A null body in that list is therefore **not evidence that a saved note is
empty**. Knowledge retrieves detail after verifying membership in the mapped
upstream notebook; it does not call the global note endpoint without that
check. A failed detail read is displayed as unavailable, not as an empty note
or a substituted local output.

The same server principal, `research:read`, company ownership and notebook
mapping authorize both routes. Browser selectors are not authority. Requests
use the same-origin HttpOnly session; no provider or service bearer is sent to
the browser. A 403 is an in-session access denial; only 401 requests session
renewal/sign-in. Source inventory/detail follow this same distinction.

Inventory is bounded to 500 notes and displayed in pages of 20. The browser
transport limits each response to 4 MiB and each note body to 512 KiB UTF-8;
oversized or malformed results fail closed instead of showing a partial list.
Page navigation is local; note detail is a separate scoped read. This is a
browsing view, not a stable export or unlimited collection viewer.

Notes render as escaped plain text, including embedded HTML and Markdown.
Human/AI labels reflect upstream metadata, not a verified author identity or
quality guarantee. Refresh hides old content; logout, scope changes, closing
the panel and switching notes cancel or ignore late responses. Note text is
not saved in browser storage.

## Boundaries

This packet does not add note editing, deletion, generation, transformations,
podcasts, promotion, notebook provisioning or full Open Notebook feature parity.
The dedicated-origin/single-operator and general-app authentication limits in
the session guide remain. Verify the exact deployed version; documentation
is not a deployment or human-UAT claim.
