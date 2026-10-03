# Bookworm OS backports

Knowledge retains GNU gzip and libacl. This build compiles pinned Debian sources
on the same Bookworm base as the runtime. It does not install binaries built for
a newer distribution, and compiler/development packages stay in the builder.

- gzip `1.13-1+deb13u1+tealbrick1~bpo12`: Debian security patches plus upstream
  `e7378c2d421be6a286922374425680bbe9ad8b7d`, which resets shared decoder state
  unconditionally. The Debian patches also address the gzexe temporary-file issue.
- libacl `2.4.0-1+tealbrick1~bpo12`: descriptor-relative and no-follow APIs.
  Legacy pathname APIs retain their historical behavior; this is not blanket
  hardening of tar, coreutils, or other existing consumers.
- GNU tar `1.35+dfsg-3.1+tealbrick1~bpo12`: same GNU tar utility, built from
  Debian's 1.35 source on Bookworm with the upstream CVE-2026-5704 fix chain
  and its `--no-overwrite-dir` regression follow-up. It does not replace tar
  with another implementation.

All downloaded source inputs and vendored upstream patches are SHA-256 pinned
in `build.sh`. Signed source descriptors/signatures are retained, but the build
checks content hashes and does not claim verification against a trusted signing
key. Generated Debian source packages include the applied patch and changelog.

## Export corresponding source

Run `KNOWLEDGE_EXPORT_ONLY=1 sh deploy/container/build-local.sh` from the repository
root. Use the printed directory as `CONTEXT`:

```sh
docker buildx build --platform linux/amd64 \
  --target os-backports-artifacts \
  --output type=local,dest=./os-backports-artifacts \
  --file "$CONTEXT/deploy/container/Dockerfile" "$CONTEXT"
(cd os-backports-artifacts && sha256sum -c metadata/SHA256SUMS)
```

Use the same build inputs/cache for the runtime image and source export. Publish
the complete corresponding-source bundle alongside any distributed image;
`licenses/debian-source-manifest.json` also covers the other Debian dependencies.
The export contains original and locally patched source packages, build recipes,
checksums, build information, and binaries. Only gzip, libacl1, and GNU tar enter runtime.
The package changelog uses build-time metadata, so this recipe does not claim
byte-for-byte reproducibility across independent rebuilds.

The build runs upstream package checks, a source-linked gzip initialization test
with a failing negative control, ACL file/default-directory operations,
symlink rejection, target preservation and descriptor anchoring checks, and
ordinary GNU tar tests for regular files, directories, links, long PAX paths,
exclusions, and sparse files. The generated upstream tar suite omits the `injection` and `skipdir` tests,
while retaining their fixture source files in the corresponding-source bundle.
The build records an unfiltered generated test list and asserts that both titles
are absent before package tests run. Source applicability and ordinary
compatibility are verified; the crafted-archive security trigger is intentionally
untested. A discarded intermediate candidate on 2026-09-28 accidentally ran
both fixtures because Debian rules overrode `TESTSUITEFLAGS`; that candidate
and its artifacts were rejected and are not used. The build
does not replace whole-image scans or application/runtime acceptance tests.
