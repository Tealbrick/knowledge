#!/bin/sh
set -eu

tar_bin=${1:-tar}
version=$($tar_bin --version | sed -n '1p')
case "$version" in
  *"tar (GNU tar) 1.35"*) ;;
  *) printf 'unexpected tar build: %s\n' "$version" >&2; exit 1 ;;
esac

tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT HUP INT TERM
mkdir -p "$tmp/input/dir/sub" "$tmp/output"
printf 'regular payload\n' > "$tmp/input/dir/sub/file"
ln "$tmp/input/dir/sub/file" "$tmp/input/dir/hardlink"
ln -s dir/sub/file "$tmp/input/symlink"
long_name=$(printf '%095d' 0)
printf 'long path payload\n' > "$tmp/input/dir/sub/${long_name}"

(
  cd "$tmp/input"
  "$tar_bin" --format=pax -cf "$tmp/ordinary.tar" dir symlink
)
"$tar_bin" -tf "$tmp/ordinary.tar" > "$tmp/list"
grep -F 'dir/sub/file' "$tmp/list" >/dev/null
grep -F 'dir/hardlink' "$tmp/list" >/dev/null
grep -F 'symlink' "$tmp/list" >/dev/null
"$tar_bin" -xf "$tmp/ordinary.tar" -C "$tmp/output"
cmp "$tmp/input/dir/sub/file" "$tmp/output/dir/sub/file"
cmp "$tmp/input/dir/sub/${long_name}" "$tmp/output/dir/sub/${long_name}"
test "$(stat -c '%i' "$tmp/output/dir/sub/file")" = \
  "$(stat -c '%i' "$tmp/output/dir/hardlink")"
test "$(readlink "$tmp/output/symlink")" = 'dir/sub/file'

mkdir "$tmp/excluded"
(
  cd "$tmp/input"
  "$tar_bin" --format=pax --exclude=dir/sub -cf "$tmp/excluded.tar" dir symlink
)
"$tar_bin" -tf "$tmp/excluded.tar" > "$tmp/excluded-list"
! grep -F 'dir/sub/file' "$tmp/excluded-list" >/dev/null

truncate -s 16777216 "$tmp/input/sparse"
printf 'sparse tail\n' | dd of="$tmp/input/sparse" bs=1 seek=16777100 conv=notrunc status=none
(
  cd "$tmp/input"
  "$tar_bin" --format=pax --sparse -cf "$tmp/sparse.tar" sparse
)
"$tar_bin" -xf "$tmp/sparse.tar" -C "$tmp/output"
cmp "$tmp/input/sparse" "$tmp/output/sparse"

printf 'GNU tar ordinary archive, links, long PAX path, exclusion, and sparse-file controls passed\n'
