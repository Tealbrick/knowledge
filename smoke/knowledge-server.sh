#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

pnpm --dir "$ROOT/program" test
pnpm --dir "$ROOT/program" typecheck
