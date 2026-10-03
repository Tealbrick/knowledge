#!/bin/bash
set -Eeuo pipefail
umask 022

readonly ROOT=/tmp/os-backports
readonly INPUTS="$ROOT/inputs"
readonly WORK="$ROOT/work"
readonly OUT=/out
readonly DEB_ARCH="$(dpkg --print-architecture)"

mkdir -p "$INPUTS" "$WORK" "$OUT/runtime" "$OUT/sources/upstream/acl" \
  "$OUT/sources/upstream/gzip" "$OUT/sources/upstream/tar" \
  "$OUT/sources/local/acl" "$OUT/sources/local/gzip" \
  "$OUT/sources/local/tar" "$OUT/metadata"

export DEBIAN_FRONTEND=noninteractive
export DEB_BUILD_OPTIONS="${DEB_BUILD_OPTIONS:+$DEB_BUILD_OPTIONS }parallel=2"
export MAKEFLAGS=-j2
apt-get update
apt-get install -y --no-install-recommends \
  autoconf automake autopoint bison build-essential ca-certificates curl \
  debhelper-compat devscripts dh-exec dpkg-dev gettext less libacl1-dev \
  libattr1-dev libselinux1-dev patch quilt texinfo xz-utils

fetch() {
  local url="$1" output="$2" expected="$3"
  curl --fail --location --proto '=https' --tlsv1.2 --retry 3 "$url" -o "$output"
  printf '%s  %s\n' "$expected" "$output" | sha256sum --check --status || {
    printf 'SHA-256 mismatch for %s\n' "$url" >&2
    exit 1
  }
}

# Debian source inputs are pinned individually as well as by the signed .dsc
# descriptors. The local .dsc files are also retained beside the exact tarballs.
fetch https://deb.debian.org/debian/pool/main/a/acl/acl_2.4.0-1.dsc \
  "$INPUTS/acl_2.4.0-1.dsc" b987ebbeb3d498794bad29cd65301b77384978493d8765c94dba8bad8fa325b6
fetch https://deb.debian.org/debian/pool/main/a/acl/acl_2.4.0.orig.tar.xz \
  "$INPUTS/acl_2.4.0.orig.tar.xz" e661131456d2708a01c614a0f400e11d7d1bfaeb6f3e74b75bb980b72f0161a3
fetch https://deb.debian.org/debian/pool/main/a/acl/acl_2.4.0.orig.tar.xz.asc \
  "$INPUTS/acl_2.4.0.orig.tar.xz.asc" 5f4f0b9b78821764fe6b88e32aef6ec519628522c211c36706bcb78d6f3f036b
fetch https://deb.debian.org/debian/pool/main/a/acl/acl_2.4.0-1.debian.tar.xz \
  "$INPUTS/acl_2.4.0-1.debian.tar.xz" 65931c2fb3e821bda67f8d8d72d77e99ac61502748dcdf38b6805fe89339085e

fetch 'https://deb.debian.org/debian/pool/main/g/gzip/gzip_1.13-1+deb13u1.dsc' \
  "$INPUTS/gzip_1.13-1+deb13u1.dsc" 0c25763da4f7242fbe7e9185b69bcb3f986011b04446b66a84c52bbdf731d308
fetch https://deb.debian.org/debian/pool/main/g/gzip/gzip_1.13.orig.tar.xz \
  "$INPUTS/gzip_1.13.orig.tar.xz" 7454eb6935db17c6655576c2e1b0fabefd38b4d0936e0f87f48cd062ce91a057
fetch 'https://deb.debian.org/debian/pool/main/g/gzip/gzip_1.13-1+deb13u1.debian.tar.xz' \
  "$INPUTS/gzip_1.13-1+deb13u1.debian.tar.xz" ffc69d13290009f42dbb4d10a34839350eff3fdaf4be1fda03d10b238ba2f77d

fetch 'https://deb.debian.org/debian/pool/main/t/tar/tar_1.35+dfsg-3.1.dsc' \
  "$INPUTS/tar_1.35+dfsg-3.1.dsc" 5bb58d4966d94c99a9f1b182676089ecc05058d62fdb927f5c07539d9cda4077
fetch https://deb.debian.org/debian/pool/main/t/tar/tar_1.35+dfsg.orig.tar.xz \
  "$INPUTS/tar_1.35+dfsg.orig.tar.xz" 9ae57e981c1e73c0eebc2b26c9b0c4497fe310ef1d516ea430efb5470b71f7a8
fetch 'https://deb.debian.org/debian/pool/main/t/tar/tar_1.35+dfsg-3.1.debian.tar.xz' \
  "$INPUTS/tar_1.35+dfsg-3.1.debian.tar.xz" 0d0278034b82ed84dce04a461879b6e1871e4cb416a0ff04d3d35ff05fc30a53

readonly GZIP_FIX=e7378c2d421be6a286922374425680bbe9ad8b7d.patch
printf '%s  %s\n' \
  de7bb5c805e24517d9e2d4e99f0e51ed75abce004db96124e91ec0f9830d5bfc \
  "$ROOT/patches/$GZIP_FIX" | sha256sum --check --status || {
  printf 'SHA-256 mismatch for vendored gzip fix %s\n' "$GZIP_FIX" >&2
  exit 1
}

cp "$INPUTS/acl_2.4.0-1.dsc" "$INPUTS/acl_2.4.0.orig.tar.xz" \
  "$INPUTS/acl_2.4.0.orig.tar.xz.asc" \
  "$INPUTS/acl_2.4.0-1.debian.tar.xz" "$OUT/sources/upstream/acl/"
cp "$INPUTS/gzip_1.13-1+deb13u1.dsc" "$INPUTS/gzip_1.13.orig.tar.xz" \
  "$INPUTS/gzip_1.13-1+deb13u1.debian.tar.xz" "$OUT/sources/upstream/gzip/"
cp "$ROOT/patches/$GZIP_FIX" "$OUT/sources/upstream/gzip/"
cp "$INPUTS/tar_1.35+dfsg-3.1.dsc" "$INPUTS/tar_1.35+dfsg.orig.tar.xz" \
  "$INPUTS/tar_1.35+dfsg-3.1.debian.tar.xz" "$OUT/sources/upstream/tar/"
cp "$ROOT/patches/tar/"*.patch "$OUT/sources/upstream/tar/"

build_source() {
  local name="$1" dsc="$2" version="$3" summary="$4"
  local source_dir="$WORK/$name"
  mkdir -p "$source_dir"
  cp "$INPUTS/$dsc" "$source_dir/"
  # dpkg-source needs both checksum-referenced tarballs beside the descriptor.
  case "$name" in
    acl)
      cp "$INPUTS/acl_2.4.0.orig.tar.xz" "$INPUTS/acl_2.4.0.orig.tar.xz.asc" \
        "$INPUTS/acl_2.4.0-1.debian.tar.xz" "$source_dir/"
      ;;
    gzip)
      cp "$INPUTS/gzip_1.13.orig.tar.xz" "$INPUTS/gzip_1.13-1+deb13u1.debian.tar.xz" "$source_dir/"
      ;;
  esac
  dpkg-source -x "$source_dir/$dsc" "$source_dir/source"
  (
    cd "$source_dir/source"
    if [[ "$name" == gzip ]]; then
      cp "$ROOT/patches/$GZIP_FIX" \
        debian/patches/e7378c2d421be6a286922374425680bbe9ad8b7d.patch
      printf '%s\n' e7378c2d421be6a286922374425680bbe9ad8b7d.patch \
        >> debian/patches/series
      QUILT_PATCHES=debian/patches quilt push
    fi
  DEBFULLNAME='Teal Brick Build' DEBEMAIL='build@localhost' \
      dch --newversion "$version" --distribution bookworm "$summary"
    dpkg-buildpackage --build=full --no-sign
  )
  mkdir -p "$OUT/packages/$name"
  cp "$source_dir"/*.deb "$OUT/packages/$name/"
  cp "$source_dir"/*.dsc "$source_dir"/*.orig.tar.* "$source_dir"/*.debian.tar.* \
    "$source_dir"/*.buildinfo "$OUT/sources/local/$name/"
}

build_source acl acl_2.4.0-1.dsc '2.4.0-1+tealbrick1~bpo12' \
  'Backport ACL 2.4.0 to Bookworm for its descriptor-relative and no-follow APIs.'
build_source gzip 'gzip_1.13-1+deb13u1.dsc' '1.13-1+deb13u1+tealbrick1~bpo12' \
  'Backport Debian Bookworm gzip fixes and apply upstream CVE-2026-41992 state reset.'

build_tar() {
  local version='1.35+dfsg-3.1+tealbrick1~bpo12'
  local source_dir="$WORK/tar"
  local preflight_dir="$WORK/tar-preflight"
  local patch_name
  local patch_names=(
    CVE-2026-5704-dependent_p1.patch
    CVE-2026-5704-dependent_p2.patch
    CVE-2026-5704-regression.patch
    CVE-2026-5704.patch
  )
  local patch_hashes=(
    1c4849044c32cd6cf6f71c007face80950c72f4386c6df750dceea4a080ade58
    f523b30eb75aff76961f0f57035cd2903db9200afdfb1541beee50e23858a3aa
    5fa7c5544a095be5c7fbc497e5ae7832b64bb93984e7dd6f0efb9abde4307cdf
    6193e6e9bd44d53bb196c3bfbaa2963eceddfe755e569d0d6ea0dd6948870397
  )

  mkdir -p "$source_dir"
  cp "$INPUTS/tar_1.35+dfsg-3.1.dsc" "$source_dir/"
  cp "$INPUTS/tar_1.35+dfsg.orig.tar.xz" \
    "$INPUTS/tar_1.35+dfsg-3.1.debian.tar.xz" "$source_dir/"
  dpkg-source -x "$source_dir/tar_1.35+dfsg-3.1.dsc" "$source_dir/source"

  # The source is GNU tar throughout. This Debian packaging of 1.35 is built
  # natively on Bookworm rather than replacing tar with another implementation.
  # Preserve the upstream patch files verbatim in the source receipt. Their
  # test-list hunks are applied by the generated local integration patch below.
  for i in "${!patch_names[@]}"; do
    patch_name="${patch_names[$i]}"
    printf '%s  %s\n' "${patch_hashes[$i]}" "$ROOT/patches/tar/$patch_name" \
      | sha256sum --check --status || {
      printf 'SHA-256 mismatch for pinned tar patch %s\n' "$patch_name" >&2
      exit 1
    }
    awk '
      /^diff --git / {
        skip = ($0 == "diff --git a/tests/Makefile.am b/tests/Makefile.am") ||
          ($0 == "diff --git a/tests/testsuite.at b/tests/testsuite.at")
      }
      !skip { print }
    ' "$ROOT/patches/tar/$patch_name" > "$source_dir/${patch_name}.bookworm"
    cp "$source_dir/${patch_name}.bookworm" \
      "$source_dir/source/debian/patches/$patch_name"
    printf '%s\n' "$patch_name" >> "$source_dir/source/debian/patches/series"
  done
  cp "$ROOT/patches/tar/bookworm-testsuite-list.patch" \
    "$source_dir/source/debian/patches/"
  printf '%s\n' bookworm-testsuite-list.patch \
    >> "$source_dir/source/debian/patches/series"

  (
    cd "$source_dir/source"
    export QUILT_PATCH_OPTS=--fuzz=0
    QUILT_PATCHES=debian/patches quilt push -a
    DEBFULLNAME='Teal Brick Build' DEBEMAIL='build@localhost' \
      dch --newversion "$version" --distribution bookworm \
      'Backport GNU tar 1.35 and apply upstream CVE-2026-5704 fixes.'
  )
  chown -R node:node "$source_dir"
  # Autotest generation refreshes Makefile.in and testsuite in place. Do that
  # only in a disposable copy so dpkg-source sees a clean Debian source tree.
  rm -rf "$preflight_dir"
  mkdir -p "$preflight_dir"
  cp -a "$source_dir/source/." "$preflight_dir/"
  chown -R node:node "$preflight_dir"
  (
    cd "$preflight_dir"
    # Generate, but do not execute, the suite as the same unprivileged account
    # used for the Debian build. Preserve the actual selected list as evidence.
    runuser -u node -- ./configure --disable-silent-rules
    runuser -u node -- make -C tests testsuite
    runuser -u node -- sh -c './tests/testsuite --list > tar-testsuite-selected.txt'
    if grep -E 'skip file injection|skip directory members' \
      "$preflight_dir/tar-testsuite-selected.txt"; then
      printf 'Prohibited archive-fixture test registered in generated suite\n' >&2
      exit 1
    fi
    test -s "$preflight_dir/tar-testsuite-selected.txt"
    cp "$preflight_dir/tar-testsuite-selected.txt" \
      "$OUT/metadata/tar-testsuite-selected.txt"
  )
  (
    cd "$source_dir/source"
    runuser -u node -- dpkg-buildpackage --build=full --no-sign
  )

  mkdir -p "$OUT/packages/tar"
  cp "$source_dir"/*.deb "$OUT/packages/tar/"
  cp "$source_dir"/*.dsc "$source_dir"/*.orig.tar.* \
    "$source_dir"/*.debian.tar.* "$source_dir"/*.buildinfo \
    "$OUT/sources/local/tar/"
  cp "$source_dir/source/debian/patches/"*.patch "$OUT/sources/local/tar/"
}

build_tar

apt-get install -y --no-install-recommends \
  "$OUT/packages/gzip/gzip_1.13-1+deb13u1+tealbrick1~bpo12_${DEB_ARCH}.deb" \
  "$OUT/packages/acl/libacl1_2.4.0-1+tealbrick1~bpo12_${DEB_ARCH}.deb" \
  "$OUT/packages/acl/libacl1-dev_2.4.0-1+tealbrick1~bpo12_${DEB_ARCH}.deb" \
  "$OUT/packages/tar/tar_1.35+dfsg-3.1+tealbrick1~bpo12_${DEB_ARCH}.deb"

cp "$OUT/packages/gzip/gzip_1.13-1+deb13u1+tealbrick1~bpo12_${DEB_ARCH}.deb" \
  "$OUT/packages/acl/libacl1_2.4.0-1+tealbrick1~bpo12_${DEB_ARCH}.deb" \
  "$OUT/packages/tar/tar_1.35+dfsg-3.1+tealbrick1~bpo12_${DEB_ARCH}.deb" \
  "$OUT/runtime/"
cc -Wall -Wextra -Werror /tmp/os-backports/tests/acl-at-nofollow.c \
  -lacl -o "$WORK/acl-at-nofollow"
"$WORK/acl-at-nofollow"
/bin/sh /tmp/os-backports/tests/gzip-state-reset.sh "$WORK/gzip/source" /usr/bin/gzip
/bin/sh /tmp/os-backports/tests/tar-compatibility.sh /usr/bin/tar

cat > "$OUT/metadata/README.txt" <<'EOF'
Native Bookworm binary backports for container OS utilities.

gzip: Debian 1.13-1+deb13u1 source, local version 1.13-1+deb13u1+tealbrick1~bpo12.
Its Debian patch series carries CVE-2026-41991 and the initial CVE-2026-41992 fix;
the pinned upstream e7378c2 patch moves the state reset into huf_decode_start.
This is not a claim that all gzip vulnerabilities are fixed.

ACL: Debian ACL 2.4.0-1 source, local version 2.4.0-1+tealbrick1~bpo12.
The source provides descriptor-relative operations and explicit no-follow flags;
existing legacy API behavior and consumers are not changed by this package build.

tar: Debian GNU tar 1.35+dfsg-3.1 source, local version
1.35+dfsg-3.1+tealbrick1~bpo12, built natively on Bookworm. The ordered
upstream chain contains commits 112ead79312ea308e58414b74623f101b8c06f0b,
b009124ffde415515081db844d7a104e1d1c6c58,
4e742fc8674064a9fa00d4483d06aca48d5b0463, and
b8d8a61b25588caca4efaf9bdd2e3f1a49da77e3. The `injection` and `skipdir`
fixture files remain in corresponding source, but their `m4_include` entries
are omitted from the generated test suite. The build records an unfiltered
test-list proof before the package suite runs. Ordinary archive compatibility
tests and the remaining upstream suite run on the native-built GNU tar binary.

A discarded intermediate candidate on 2026-09-28 ran both fixtures because
Debian rules override the TESTSUITEFLAGS environment value. That candidate
was rejected and its artifacts are not used. This recipe excludes the tests
structurally in the generated suite before package checks.
EOF
cp /tmp/os-backports/build.sh /tmp/os-backports/tests/* "$OUT/metadata/"
(
  cd "$OUT"
  find . -type f ! -path './metadata/SHA256SUMS' -print0 \
    | sort -z | xargs -0 sha256sum
) > "$ROOT/SHA256SUMS"
mv "$ROOT/SHA256SUMS" "$OUT/metadata/SHA256SUMS"
