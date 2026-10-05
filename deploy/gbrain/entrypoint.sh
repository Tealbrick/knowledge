#!/bin/sh
# Owner-side provisioning for an unmodified upstream GBrain service, then serve.
# Upstream allows source creation only from its trusted local CLI, so this runs
# before `serve` (PGlite is single-writer; Postgres is fine either way).
#
# Required: GBRAIN_ADMIN_BOOTSTRAP_TOKEN (shared only with Knowledge)
#           KNOWLEDGE_GBRAIN_SOURCES  comma-separated kb-* source ids (one per Knowledge partition)
# Storage:  GBRAIN_DATABASE_URL (Postgres with pgvector)  or  PGlite under $GBRAIN_HOME
# Models:   GBRAIN_INIT_ARGS (first init only; embedding model/dimensions are immutable after)
set -eu
GBRAIN_ROOT=${GBRAIN_ROOT:-/opt/gbrain}
gbrain() { bun run "$GBRAIN_ROOT/src/cli.ts" "$@"; }

: "${GBRAIN_ADMIN_BOOTSTRAP_TOKEN:?GBRAIN_ADMIN_BOOTSTRAP_TOKEN is required}"
: "${KNOWLEDGE_GBRAIN_SOURCES:?KNOWLEDGE_GBRAIN_SOURCES is required}"
if [ -n "${GBRAIN_REMOTE_PRIVATE_PAGES:-}" ]; then echo "GBRAIN_REMOTE_PRIVATE_PAGES must not be set for Knowledge" >&2; exit 1; fi

if [ ! -f "$GBRAIN_HOME/.gbrain/config.json" ]; then
  if [ -n "${GBRAIN_DATABASE_URL:-}" ]; then gbrain init --non-interactive ${GBRAIN_INIT_ARGS:---no-embedding}
  else gbrain init --pglite ${GBRAIN_INIT_ARGS:---no-embedding}; fi
fi
gbrain apply-migrations --yes --no-autopilot-install

old_ifs=$IFS; IFS=,
for source in $KNOWLEDGE_GBRAIN_SOURCES; do
  case "$source" in kb-[a-f0-9]*) ;; *) echo "Refusing non-Knowledge source id: $source" >&2; exit 1;; esac
  if ! out=$(gbrain sources add "$source" --name "knowledge-$source" 2>&1); then
    case "$out" in *source_id_taken*) ;; *) echo "$out" >&2; exit 1;; esac
  fi
done
IFS=$old_ifs

exec bun run "$GBRAIN_ROOT/src/cli.ts" serve --http --bind "${GBRAIN_BIND:-::}" --port "${PORT:-3131}" \
  --public-url "${GBRAIN_PUBLIC_URL:-http://localhost:${PORT:-3131}}" --suppress-bootstrap-token --fail-fast
