#!/bin/sh
set -eu
task_app=$(CDPATH= cd -- "$(dirname -- "$0")/../.." && pwd)
# Support both a standalone miniapp checkout and the LABS portfolio layout.
if [ -d "$task_app/.sdk/doppelganger-ui" ]; then
  task_sdk="$task_app/.sdk/doppelganger-ui"
else
  task_sdk="$task_app/../.sdk/doppelganger-ui"
fi
if [ ! -f "$task_app/program/package.json" ] || [ ! -f "$task_sdk/package.json" ]; then
  printf "%s\n" "Knowledge source or bundled UI SDK is missing" >&2
  exit 1
fi
task_context=$(mktemp -d -t knowledge-image)
printf 'Disposable build context: %s\n' "$task_context"
mkdir -p "$task_context/program" "$task_context/sidecars" "$task_context/deploy" "$task_context/.sdk"
cp "$task_app/program/package.json" "$task_app/program/pnpm-lock.yaml" "$task_app/program/tsconfig.json" "$task_context/program/"
cp "$task_app/LICENSE" "$task_app/THIRD_PARTY_NOTICES.md" "$task_context/"
cp -R "$task_app/licenses" "$task_context/"
cp "$task_app/program/LICENSE" "$task_context/program/"
for task_part in src web; do
  rsync -a --exclude=node_modules --exclude='.env*' --exclude=test-results --exclude=playwright-report --exclude=preview-dist --exclude=dist --exclude=web-dist "$task_app/program/$task_part" "$task_context/program/"
done
rsync -a --exclude=node_modules --exclude=.git --exclude='.env*' --exclude=.gbrain --exclude='*.sqlite*' "$task_app/sidecars/gbrain" "$task_context/sidecars/"
rsync -a --exclude=node_modules --exclude=.git "$task_sdk" "$task_context/.sdk/"
mkdir -p "$task_context/deploy/container"
rsync -a --exclude=.git "$task_app/deploy/container/os-backports" "$task_context/deploy/container/"
for task_part in Dockerfile Dockerfile.dockerignore railway.json server.ts entrypoint.mjs attachment-auth.mjs browser-auth.mjs package.json LICENSE; do
  cp "$task_app/deploy/container/$task_part" "$task_context/deploy/container/"
done
cp "$task_app/deploy/container/Dockerfile.dockerignore" "$task_context/.dockerignore"
if [ "${KNOWLEDGE_EXPORT_ONLY:-0}" = 1 ]; then exit 0; fi
docker build --platform "${KNOWLEDGE_BUILD_PLATFORM:-linux/amd64}" -f "$task_context/deploy/container/Dockerfile" -t "${1:-tealbrick-knowledge:local-0.1.0}" "$task_context"
