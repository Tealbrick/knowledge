#!/bin/sh
set -eu

source_dir=${1:?gzip source directory is required}
gzip_bin=${2:?built gzip binary is required}
source_file="$source_dir/unlzh.c"

# CVE-2026-41992 is fixed only when both shared decode tables are cleared on
# every LZH decoder start. Clearing them only for an empty Huffman block leaves
# the LZW -> LZH poisoned-state sequence reachable.
body=$(sed -n '/^huf_decode_start ()/,/^}/p' "$source_file")
printf '%s\n' "$body" | grep -Eq 'memzero *\(left, *\(2 \* NC - 1\) \* sizeof \*left\);'
printf '%s\n' "$body" | grep -Eq 'memzero *\(right, *\(2 \* NC - 1\) \* sizeof \*right\);'

version=$($gzip_bin --version | sed -n '1p')
case "$version" in
  'gzip 1.13') ;;
  *) printf 'Unexpected gzip binary: %s\n' "$version" >&2; exit 1 ;;
esac

config_file=$(find "$source_dir" -type f -name config.h -print -quit)
if [ -z "$config_file" ]; then
  printf 'Generated gzip config.h was not found under %s\n' "$source_dir" >&2
  exit 1
fi
config_dir=${config_file%/*}
test_dir=$(mktemp -d)
trap 'rm -rf "$test_dir"' EXIT HUP INT TERM

cc -Wall -Wextra -Werror -ffunction-sections -fdata-sections \
  -I"$config_dir" -I"$source_dir" \
  /tmp/os-backports/tests/gzip-reset-init.c \
  -Wl,--gc-sections -o "$test_dir/gzip-reset-init"
"$test_dir/gzip-reset-init"

# Negative control: the same source-linked harness must fail when the required
# start initialization is removed from an otherwise identical source copy.
sed \
  -e '/memzero *(left, *(2 \* NC - 1) \* sizeof \*left);/d' \
  -e '/memzero *(right, *(2 \* NC - 1) \* sizeof \*right);/d' \
  "$source_file" > "$test_dir/unlzh.c"
cc -Wall -Wextra -Werror -ffunction-sections -fdata-sections \
  -I"$test_dir" -I"$config_dir" -I"$source_dir" \
  /tmp/os-backports/tests/gzip-reset-init.c \
  -Wl,--gc-sections -o "$test_dir/gzip-reset-init-without-reset"
cc -E -I"$test_dir" -I"$config_dir" -I"$source_dir" \
  /tmp/os-backports/tests/gzip-reset-init.c > "$test_dir/gzip-reset-init.i"
grep -Fq "# 1 \"$test_dir/unlzh.c\"" "$test_dir/gzip-reset-init.i"
if "$test_dir/gzip-reset-init-without-reset"; then
  printf '%s\n' 'gzip reset negative control unexpectedly passed' >&2
  exit 1
fi

printf '%s\n' 'gzip LZW-poisoned shared table reset and built binary version verified'
