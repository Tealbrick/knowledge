#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PLUGIN_NAME="knowledge"
SOURCE_DIR="${SCRIPT_DIR}/remote-plugin/${PLUGIN_NAME}"
PROGRAM_BASE_URL="${KNOWLEDGE_BASE_URL:-}"
HERMES_PLUGIN_DIR="${HERMES_PLUGIN_DIR:-}"

usage() {
  cat <<'EOF'
Usage: install-remote-hermes-plugin.sh [plugin-directory] [--program-base-url http://127.0.0.1:PORT]

Installs the Knowledge Agent adapter. Supplying a loopback Program URL also
installs the Product-owned runtime connection and registers its API endpoint.
It never installs a presentation surface or starts a Program.
EOF
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --program-base-url)
      PROGRAM_BASE_URL="${2:-}"
      shift 2
      ;;
    --help|-h)
      usage
      exit 0
      ;;
    --*)
      echo "Unknown option: $1" >&2
      usage >&2
      exit 2
      ;;
    *)
      if [[ -n "${HERMES_PLUGIN_DIR}" ]]; then
        echo "Plugin directory was supplied more than once." >&2
        exit 2
      fi
      HERMES_PLUGIN_DIR="$1"
      shift
      ;;
  esac
done

if [[ -z "${HERMES_PLUGIN_DIR}" ]]; then
  HERMES_HOME="${HERMES_HOME:-${HOME}/.hermes}"
  HERMES_PLUGIN_DIR="${HERMES_HOME}/plugins"
else
  HERMES_HOME="${HERMES_HOME:-$(cd "$(dirname "${HERMES_PLUGIN_DIR}")" && pwd)}"
fi

TARGET_DIR="${HERMES_PLUGIN_DIR}/${PLUGIN_NAME}"
CONFIG_FILE="${HERMES_HOME}/config.yaml"
REGISTRY_FILE="${HERMES_HOME}/doppelganger/registry.json"

if [[ ! -f "${SOURCE_DIR}/plugin.yaml" || ! -f "${SOURCE_DIR}/__init__.py" || ! -f "${SOURCE_DIR}/tools.py" || ! -f "${SOURCE_DIR}/research_tools.py" || ! -f "${SOURCE_DIR}/remote-runtime.json" ]]; then
  echo "Remote Hermes plugin source is incomplete: ${SOURCE_DIR}" >&2
  exit 1
fi

if [[ -n "${PROGRAM_BASE_URL}" ]]; then
  PROGRAM_BASE_URL="$(python3 - "${PROGRAM_BASE_URL}" <<'PY'
import sys
from urllib.parse import urlsplit

value = sys.argv[1].strip().rstrip("/")
parsed = urlsplit(value)
valid = (
    parsed.scheme == "http"
    and parsed.hostname in {"127.0.0.1", "::1", "localhost"}
    and parsed.username is None
    and parsed.password is None
    and not parsed.query
    and not parsed.fragment
    and parsed.path in {"", "/"}
)
if not valid:
    raise SystemExit("Knowledge remote Program URL must be a plain loopback http URL.")
print(value)
PY
)"
fi

mkdir -p "${HERMES_PLUGIN_DIR}"
TMP_DIR="${TARGET_DIR}.tmp.$$"
rm -rf "${TMP_DIR}"
mkdir -p "${TMP_DIR}"
cp -R "${SOURCE_DIR}/." "${TMP_DIR}/"
rm -rf "${TARGET_DIR}"
mv "${TMP_DIR}" "${TARGET_DIR}"

python3 - "${CONFIG_FILE}" "${PLUGIN_NAME}" <<'PY'
from pathlib import Path
import re
import sys

config_file = Path(sys.argv[1])
plugin_name = sys.argv[2]
config_file.parent.mkdir(parents=True, exist_ok=True)
text = config_file.read_text(encoding="utf-8") if config_file.exists() else ""
if re.search(rf"(?m)^\s*-\s*{re.escape(plugin_name)}\s*$", text):
    raise SystemExit(0)
if not text.strip():
    config_file.write_text(f"plugins:\n  enabled:\n  - {plugin_name}\n", encoding="utf-8")
elif "plugins:" not in text:
    config_file.write_text(text.rstrip() + f"\nplugins:\n  enabled:\n  - {plugin_name}\n", encoding="utf-8")
elif "  enabled:" not in text:
    config_file.write_text(text.rstrip() + f"\n  enabled:\n  - {plugin_name}\n", encoding="utf-8")
else:
    config_file.write_text(text.rstrip() + f"\n  - {plugin_name}\n", encoding="utf-8")
PY

if [[ -n "${PROGRAM_BASE_URL}" ]]; then
  python3 - "${TARGET_DIR}/runtime-connection.json" "${REGISTRY_FILE}" "${PROGRAM_BASE_URL}" <<'PY'
import json
from pathlib import Path
import sys

connection_file = Path(sys.argv[1])
registry_file = Path(sys.argv[2])
base_url = sys.argv[3]

connection_file.write_text(
    json.dumps(
        {
            "schemaVersion": "doppelganger.remote-program-connection/v1",
            "unitId": "knowledge",
            "baseUrl": base_url,
            "healthPath": "/healthz",
        },
        indent=2,
    )
    + "\n",
    encoding="utf-8",
)

registry = json.loads(registry_file.read_text(encoding="utf-8")) if registry_file.exists() else {
    "contractVersion": "1.1.0",
    "units": [],
    "contributions": [],
}
if not isinstance(registry.get("units"), list):
    registry["units"] = []
if not isinstance(registry.get("contributions"), list):
    registry["contributions"] = []

old_unit = next((unit for unit in registry["units"] if unit.get("unitId") == "knowledge"), {})
unit = {"unitId": "knowledge", "name": "Knowledge"}
unit["enabled"] = old_unit.get("enabled") if isinstance(old_unit.get("enabled"), bool) else False
unit["deployment"] = {
    "baseUrl": base_url,
    "healthPath": "/healthz",
    "programBaseUrlEnv": "KNOWLEDGE_BASE_URL",
}
registry["units"] = [entry for entry in registry["units"] if entry.get("unitId") != "knowledge"] + [unit]

legacy_ids = {
    "knowledge.control",
    "knowledge.workspace",
    "knowledge.settings",
    "knowledge.diagnostics",
}
registry["contributions"] = [
    entry
    for entry in registry["contributions"]
    if entry.get("unitId") != "knowledge" and entry.get("id") not in legacy_ids
]

registry_file.parent.mkdir(parents=True, exist_ok=True)
temporary = registry_file.with_suffix(".json.tmp")
temporary.write_text(json.dumps(registry, indent=2) + "\n", encoding="utf-8")
temporary.replace(registry_file)
PY
fi

echo "Installed ${PLUGIN_NAME} into ${TARGET_DIR}"
echo "Enabled ${PLUGIN_NAME} in ${CONFIG_FILE}"
if [[ -n "${PROGRAM_BASE_URL}" ]]; then
  echo "Registered remote Knowledge Program API endpoint in ${REGISTRY_FILE}"
else
  echo "Knowledge remote runtime is not activated: supply --program-base-url or KNOWLEDGE_BASE_URL after the Program is reachable."
fi
