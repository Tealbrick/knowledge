# Distribution notices

`dependencies.json` and `dependency-license-texts.json` are source-side license
inventory inputs for the Program and GBrain dependency trees. They do not claim
to be the final image SBOM; the published image's attached SBOM and release
receipt are authoritative for the exact built dependency set. Three
publisher-declared SPDX licences without standalone complete licence files use
explicitly labelled standard terms and preserve supplied copyright-bearing
package files in `package-declarations/`; no copyright holder or year is
inferred. This JavaScript inventory does not cover Debian packages, Node, Bun,
fonts, or corresponding-source obligations.

`debian-image-packages.tsv` records the intended Debian binary and source
package versions. `debian-source-manifest.json` maps those packages to exact
source package/version pairs. `debian-image-notices.tar.gz` contains the
corresponding Debian notice files. Reconcile these records against the final
published image before making a release-compliance claim.

Node and Bun notices are retained as `node-LICENSE.txt` and `bun-LICENSE.txt`.
The Bun notice identifies statically linked LGPL JavaScriptCore/WebKit; the
corresponding upstream source records and hashes are in
`runtime-source-manifest.json`. A later image rebuild must be reconciled again.

Font licences are preserved beside the fonts in `.sdk/doppelganger-ui/assets/fonts/licenses/` and copied into the web distribution.

Native Bookworm backports retain their generated Debian source packages, upstream archives, applied patches, build recipe and checksums in the corresponding-source bundle; `archivePath` is relative to that bundle root, not a public download URL. The exact backports and build/export instructions are in `deploy/container/OS-BACKPORTS.md`. The ACL upgrade supplies safer APIs without changing legacy pathname callers.
