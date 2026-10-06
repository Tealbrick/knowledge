# Third-party notices

The [distribution notice bundle](licenses/README.md) contains retained source
license mappings, package declarations and corresponding-source records. The
published image's attached SBOM and release receipt identify the exact final
dependency set; source inventories do not by themselves establish a later
image's contents.

Tealbrick’s original contributions use the root MIT licence. That licence does not replace third-party copyright notices or the terms of separately licensed components.

## Bundled memory engine

Component: GBrain, version 0.48.2.0. Recorded upstream revision: `5cfb84f1d3a809c70064c292c23db3d538d5c551`.

Tealbrick source modifications (2026-09-25): the remember operation prevents remote callers from using private facts as duplicate or supersession targets. Fact deduplication and expiration carry optional world-visibility and source-scope constraints, enforced in both the PostgreSQL and PGlite SQL paths. Fence-based forget rechecks source, visibility, row identity, and source path under the page lock; its conditional SQL update must succeed before the canonical fence file is replaced. Supersession links are written with the guarded expiration, and the result reports whether the old fact was actually superseded. These changes are in the vendored GBrain source; the recorded upstream revision is the baseline, not a claim that the source tree is unmodified.

Further Tealbrick modifications in the vendored tree (recorded 2026-10-05 from a diff against the recorded upstream revision): forget_fact applies the caller's source scope and world-only visibility (A5); remote extraction pending counts are world-only (A6); every facts/takes privacy fence is stripped for remote callers, with nested, overlapping or unclosed fences dropped whole (A7); get_links/get_backlinks private filtering uses the exact (slug, source) pair (A8); federated links whose origin page is outside the caller's grant are dropped (A9); takes_list/takes_search hide takes on private pages from remote callers (A10); think/gather retrieval applies private-page exclusion and fence stripping on every arm (A11); query's corrective re-run keeps private exclusion (A12); remote entity cards require same-source, non-private endpoints and world-fact-backed open loops (A13); identity-union member links honour federated allowed sources (A14). Upstream v0.60.57.0 already contains equivalents of A5, A10, A12 and A14. `src/core/output/` is unmodified upstream source; it was missing from earlier source snapshots because of a repository ignore rule and is restored. See `docs/gbrain-upstream-service.md` for the move to an unmodified upstream GBrain service.

Local dependency security overrides (2026-09-25) pin `@ai-sdk/provider-utils` 4.0.33, `hono` 4.13.5, and `js-yaml` 3.15.2 to address dependency advisories.

Copyright (c) 2026 Garry Tan. MIT licensed. The full required text is retained at [sidecars/gbrain/LICENSE](sidecars/gbrain/LICENSE) and must accompany source and image distributions containing this component. Other nested component licences also remain applicable.

## Vendored engine interface snapshots

`program/src/engine-surfaces/hindsight-0.10.2.openapi.json` is the unmodified OpenAPI document served by Hindsight (`vectorize-io/hindsight`) v0.10.2, tag commit `5fc4ce20917b916240cef27c212c387a177f115b`, and `hindsight-0.10.2.json` lists its MCP tools. Copyright (c) 2025 Vectorize AI, Inc. MIT licensed; the full text is retained at [program/src/engine-surfaces/hindsight-LICENSE.txt](program/src/engine-surfaces/hindsight-LICENSE.txt). The OpenAPI `info.license` field names Apache-2.0; the repository licence is MIT. "Hindsight" is a trademark of Vectorize AI. The Hindsight service itself is pulled unmodified by image digest and is not redistributed by this repository.

`program/src/engine-surfaces/gbrain-0.60.57.0.json` lists the operation names, scopes and transport gates of GBrain v0.60.57.0 (`99de5707f6fc0916f43b4c167802a5f8d9ea0cf0`), MIT, Copyright (c) 2026 Garry Tan.

## Additional components in the prepared runtime inventory

The prepared runtime inventory identifies `libheif-js` 1.19.8 (LGPL-3.0),
`lightningcss` and its Linux binaries 1.33.0 (MPL-2.0), and `caniuse-lite`
1.0.30001810 (CC-BY-4.0). Retain their licence and attribution notices.
Verified source archives and replacement/build guidance are listed in
[licenses/corresponding-source.md](licenses/corresponding-source.md). These
source materials are preparation evidence until the exact published image and
its corresponding-source bundle are reconciled. These licences do not change
the licence selected for independently authored Tealbrick code.

## Remaining review

The final image release receipt must reconcile its Debian package entries, Node,
Bun and JavaScript dependency inventory against `licenses/` and the attached
SBOM. Do not treat a source-side inventory as proof of an image build or
publication.

## Bundled fonts

The public Knowledge candidate uses Geist and Geist Mono (Copyright (c) 2023 Vercel, in collaboration with basement.studio) under SIL Open Font License 1.1, the faces the Teal Brick Portal serves. They are supplied by the `@tealbrick/ui` npm package; the complete licence text ships in its `assets/fonts/licenses/Geist-OFL.txt` and is copied into the web distribution. Font files retain their original embedded ownership metadata. Inter, Cormorant Garamond, JetBrains Mono and Switzer are no longer bundled. The Teal Brick mark and app icons in that package are Tealbrick brand artwork.
