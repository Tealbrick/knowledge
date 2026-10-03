# Open Notebook source browser

The Research surface uses Open Notebook as its source and model-research
foundation. Its authenticated source browser is a read-only view of the
upstream notebook selected by Knowledge's server-side binding. It is not the
local fallback source list and does not imply that local and upstream records
have been synchronized.

## Setup and authority

Use the [Research browser session setup](research-browser-session.md), with an
existing principal that has `research:read` and a company-owned notebook bound
to an Open Notebook notebook. The browser's company and notebook selectors are
navigation only. The same server principal, capability, company, current owner
and mapping checks used by agent tools authorize every inventory/detail read.

No Open Notebook, GBrain, model or Knowledge service token is delivered to the
browser. Reads use the same-origin HttpOnly session cookie; sign-out removes
the authenticated source surface. The existing single-operator, dedicated
origin and general-app-auth limitations remain unchanged.

## Read contract

- `GET /api/research/notebooks/:notebookId/engine/sources?limit=50&offset=0`
  returns a bounded page of projected source metadata. The API does not return
  a total count or stable snapshot cursor; page navigation must not invent one.
- `GET /api/research/notebooks/:notebookId/engine/sources/:sourceId` returns
  one mapped source with full extracted text. The adapter verifies membership
  in the selected upstream notebook. Provider filesystem paths are omitted.

Inventory ordering is upstream `updated` descending. Concurrent upstream
changes can shift offset pages; this is a browsing view, not a consistent
export. Source text and titles are untrusted evidence, rendered as plain text,
not executed as markup. Empty or not-yet-extracted text is distinct from an
unavailable or unauthorized request.

The inventory/detail surface remains read-only. A separate authenticated
[text-source submission form](research-source-submission.md) uses the existing
durable write API and its original-key receipts. URL/file import, deletion,
extraction configuration, model selection and upstream notebook provisioning
are not added to this UI. Source writes remain separate from read refreshes.

## Verification boundary

Source transport and route-seam tests use disposable fixtures. Manual browser
acceptance runs the pinned Open Notebook API/worker plus SurrealDB locally,
with synthetic sources, and verifies inventory, full detail, safe text and
logout. Record the result for the exact version you deploy; the presence of
this guide alone is not test, deployment or human-UAT proof.
