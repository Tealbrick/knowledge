# Authenticated Research notebook discovery

Open Notebook is the Research engine. The primary Research view now opens its
existing operator sign-in before any notebook is selected. After sign-in,
notebook navigation is built from server-authorized mappings; it no longer
depends on the old local notebook list or the app's company selector.

## Contract

`GET /api/research/engine/notebooks?limit=50&offset=0` uses the existing
Knowledge service principal or same-origin Research cookie and requires
`research:read`. Company is obtained from the principal, never a query field.
The response projects only local Knowledge notebook `id`, `name`, and
`description`, with `pagination: {limit, offset, hasMore}` and provider
`open_notebook`. Upstream IDs and service credentials remain server-side.
The mapping registry is capped at 200 entries; API limit is 1–50 and offset
0–200. Missing local descriptions normalize to an empty string. Body-bearing
GETs and unknown query selectors are rejected. A principal identity, company
or capability-set change across the Rules boundary fails closed.

The inventory is a list of configured mappings, filtered against current
local ownership. It is not upstream discovery, a health check, or proof that
the configured upstream service is running the pinned version. Selecting a
notebook invokes the existing protected source/history routes, which still
perform their own current authorization and upstream membership checks.

The page uses the same sign-in as source browsing, text submission and chat.
There is no second login, browser bearer, automatic notebook provisioning,
or caller-selectable external notebook. Empty, denied and unavailable states
are explicit; none substitutes local records or a public upstream list.

## Operator setup

Use the [connection guide](open-notebook-connection.md) to configure a local
Knowledge notebook owned by the intended company, its server-side Open
Notebook mapping and a principal with `research:read`. Enable the existing
[browser session](research-browser-session.md) on a dedicated trusted origin.
Source/chat writes additionally require their existing write grants and
receipt stores. Seeing an empty mapping list after sign-in is a configuration
state, not a reason to enter an engine or provider token into the browser.

Local records remain available in a collapsed, separately labelled section.
Their requests run only when that section opens. They retain the older
local-first authorization boundary and must not be exposed as authenticated
shared-service CRUD merely because Research engine sign-in is enabled.

## Navigation and recovery

Notebook selection is local to the authenticated principal/company component.
Identity or grant changes unmount the old workspace. Loading, refresh and
discovery failure hide the old workspace; stale responses cannot restore it.
Pages are bounded to 50 entries in the browser and support explicit previous,
next and refresh actions. Names/descriptions render as text, never HTML.

Switching or refreshing clears unsent source/chat drafts. Submitted request
references remain in session storage under their principal/company/notebook
scope, without source text, message text or credentials. Returning to the
original notebook restores those references and permits only original-key
receipt checks until the outcome is confirmed. Navigation never retries a
POST. Logout removes the protected workspace immediately.

This packet does not provide whole-app authentication, SaaS accounts, live
deployment, customer migration or human UAT. Verify these separately on the
target installation.
