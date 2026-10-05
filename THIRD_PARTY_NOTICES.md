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

Local dependency security overrides (2026-09-25) pin `@ai-sdk/provider-utils` 4.0.33, `hono` 4.13.5, and `js-yaml` 3.15.2 to address dependency advisories.

Copyright (c) 2026 Garry Tan. MIT licensed. The full required text is retained at [sidecars/gbrain/LICENSE](sidecars/gbrain/LICENSE) and must accompany source and image distributions containing this component. Other nested component licences also remain applicable.

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

The public Knowledge candidate uses Geist and Geist Mono (Copyright (c) 2023 Vercel, in collaboration with basement.studio) under SIL Open Font License 1.1, the faces the Teal Brick Portal serves. The complete licence text is included in `.sdk/tealbrick-ui/assets/fonts/licenses/Geist-OFL.txt`. Font files retain their original embedded ownership metadata. Inter, Cormorant Garamond, JetBrains Mono and Switzer are no longer bundled. The Teal Brick mark and app icons (`.sdk/tealbrick-ui/assets/tealbrick-mark.*`, `tealbrick-tile.svg`, `icons/`) are Tealbrick brand artwork.
