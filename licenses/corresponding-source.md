# Corresponding source and replacement

`corresponding-source.json` records downloaded source archives and SHA-256 hashes for the bundled image-processing and CSS components. Distribute these exact archives beside any public binary image. A source URL or local archive is not proof that Tealbrick has published the source bundle. Verify every archive against its recorded hash.

## Image inventory and corresponding source

The image identity used to collect the Debian inventory is recorded in
`debian-source-manifest.json` (`image` and `imageTag`). Treat that reference as an
inventory reference, not a registry digest or a public release claim. The current
inventory contains **76 Debian binary packages / 61 source package-version pairs**
on Debian 12 (linux/amd64), with Node 24.21.0 and Bun 1.3.13. Exact installed
versions are in `debian-image-packages.tsv`; installed copyright and common
licence texts are in `debian-image-notices.tar.gz`.

For native OS backports, the manifest's `archivePath` resolves within the
corresponding-source bundle. Preserve each generated Debian source descriptor,
original archive, Debian patch archive, build recipe, build information and
checksums. The source-export and runtime image must consume the same package
build stage. See [OS backport instructions](../deploy/container/OS-BACKPORTS.md).

A final image must be checked against these inventories and notice contents;
record its resulting digest and binary/source correspondence outside the image
to avoid a self-referential embedded image hash. A subsequent rebuild does not
inherit earlier verification merely because its package versions look similar.
The archived inputs remain preparation artifacts until they are published next
to the binary release and their unauthenticated download is verified.

The JavaScript notices cover the 334 installed package copies (320 unique name/version pairs) in `/app/knowledge/program/node_modules` and `/app/knowledge/sidecars/gbrain/node_modules`. The notice texts and hashes are in `dependencies.json` and `dependency-license-texts.json`; this inventory was filtered against the inspected image. These runtime reconciliations do not establish public publication, a byte-identical rebuild, licence compatibility clearance for every use, or human UAT.

## libheif-js 1.19.8

The exact npm gitHead is `fe8e9c29440b839910be9dc32e8d2b826c8217ca`. Its `scripts/install.js` downloads the `libheif-emscripten` v1.19.8 binaries. That release points to libheif submodule `5e9deb19fe6b3768af0bb8e9e5e8438b15171bf3`. The included build workflow uses Emscripten **3.1.61**, builds both JavaScript and WASM, and applies `USE_UNSAFE_EVAL=0` to the upstream CI script. libheif's build script defaults to libde265 **1.0.15**, with AOM disabled. All these source inputs and the original workflow are recorded in the manifest. Tealbrick has not modified these library sources.

Reconstruction: extract the libheif-emscripten archive, place the recorded libheif source in its `libheif` directory, and follow `.github/workflows/emscripten.yml`. The upstream script fetches libde265 1.0.15; use the archived version rather than a newer version. Then run the wrapper's `scripts/install.js` against the locally produced equivalent distribution and its documented bundling step. The wrapper script uses esbuild and Node module polyfills; their dependency declarations are in the wrapper's package.json. This documents upstream's process; a byte-identical reconstruction has not been verified.

The JS/WASM library remains a replaceable module under GBrain's `node_modules/libheif-js`. Recipients may replace it with their modified build and rebuild the image. Tealbrick imposes no restriction on modification or reverse engineering for debugging modifications to these LGPL components. Preserve the supplied LGPL and GPL texts. Distribute corresponding source/build inputs for the library and its linked LGPL components with the binaries.

## Lightning CSS 1.33.0

The exact npm gitHead is `1d680fa14e9a089c92dc0929f869d6757ae91c30`. Its source archive includes the Rust implementation, Cargo manifests/lockfile and Node build scripts for the MPL-covered native module. Use that archive for both the JavaScript package and the matching Linux native packages. Preserve the MPL notice and licence; make the covered source available with the binary release. Tealbrick has not modified its sources. The archive is source evidence, not a claim of a reproduced native binary.

## Node, Bun, and WebKit source inputs

Node 24.21.0 and Bun 1.3.13 have their own bundled third-party notices. Their source archives and checksums are in `runtime-source-manifest.json`. Bun statically links LGPL JavaScriptCore/WebKit. The exact WebKit build-source revision and its inclusion/exclusion record are also in that manifest. The archived sources preserve the ability to modify and relink the LGPL code; byte-identical rebuilt-binary verification has not been performed.

**Publication remains pending:** publish the source and notice set beside the exact binary release, verify unauthenticated access and archive hashes, and reconcile any rebuilt final image. The existing archives are preparation evidence only.
