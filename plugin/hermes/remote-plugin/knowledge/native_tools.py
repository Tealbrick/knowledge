"""Native GBrain through Knowledge; runtime credentials never become tool arguments.

Discover the pinned engine's real schemas, then dispatch native arguments intact.
No automatic retry, redirects, browser tokens, or local Rules bypass.
"""
import http.client
import json
import os
from pathlib import Path
import re
import urllib.parse

BASE = Path(__file__).with_name("runtime-connection.json")
# Doppelganger -> Tealbrick transition: accept both connection schema ids; the
# installer keeps writing the legacy id until every producer/consumer accepts
# the new one. Keep in sync with tools.py, research_tools.py and
# program/src/legacy-ids.ts (removal condition documented there).
RUNTIME_CONNECTION_SCHEMAS = frozenset({"doppelganger.remote-program-connection/v1", "tealbrick.remote-program-connection/v1"})
MAX_BYTES = 8 * 1024 * 1024


def _call(args, operation=None, catalog=False):
    connection = None
    token = os.environ.get("KNOWLEDGE_SERVICE_TOKEN", "")
    try:
        if not token or any(c in token for c in "\r\n"):
            return json.dumps({"ok": False, "error": "service_auth_unavailable"})
        if not isinstance(args, dict):
            raise ValueError()
        allowed = {"partitionKey"} if catalog else {"partitionKey", "arguments", "idempotencyKey"} | ({"operation"} if operation is None else set())
        if set(args) - allowed:
            raise ValueError()
        partition = args.get("partitionKey") or os.environ.get("KNOWLEDGE_PARTITION_KEY")
        if not isinstance(partition, str) or not re.fullmatch(r"[a-z0-9][a-z0-9._/-]{0,255}", partition):
            raise ValueError()
        base = os.environ.get("KNOWLEDGE_BASE_URL", "")
        if not base and BASE.is_file():
            record = json.loads(BASE.read_text())
            if record.get("schemaVersion") in RUNTIME_CONNECTION_SCHEMAS and record.get("unitId") == "knowledge":
                base = record.get("baseUrl", "")
        url = urllib.parse.urlsplit(base)
        if url.username or url.password or url.query or url.fragment or url.path not in ("", "/") or not url.hostname:
            raise ValueError()
        if url.scheme != "https" and not (url.scheme == "http" and url.hostname in ("127.0.0.1", "localhost", "::1")):
            raise ValueError()
        headers = {"Authorization": "Bearer " + token, "Accept": "application/json"}
        body = None
        if catalog:
            path = "/api/brain/native/tools?" + urllib.parse.urlencode({"partitionKey": partition})
        else:
            operation = operation or args.get("operation")
            if not isinstance(operation, str) or not re.fullmatch(r"[a-z][a-z_]{0,63}", operation):
                raise ValueError()
            native_args = args.get("arguments")
            if not isinstance(native_args, dict):
                raise ValueError()
            key = args.get("idempotencyKey")
            if operation in ("remember", "forget") and not key:
                return json.dumps({"ok": False, "error": "idempotency_key_required"})
            if key is not None:
                if not isinstance(key, str) or not re.fullmatch(r"[A-Za-z0-9._:-]{1,200}", key):
                    raise ValueError()
                headers["Idempotency-Key"] = key
            path = "/api/brain/native/" + operation
            headers["Content-Type"] = "application/json"
            body = json.dumps({"partitionKey": partition, "arguments": native_args}).encode()
            if len(body) > 1024 * 1024:
                raise ValueError()
        cls = http.client.HTTPSConnection if url.scheme == "https" else http.client.HTTPConnection
        connection = cls(url.hostname, url.port, timeout=610)
        connection.request("GET" if catalog else "POST", path, body=body, headers=headers)
        response = connection.getresponse()
        # Do not forward a service credential to redirects or emit HTML/proxy errors.
        if 300 <= response.status < 400:
            return json.dumps({"ok": False, "error": "redirect_rejected"})
        raw = response.read(MAX_BYTES + 1)
        if len(raw) > MAX_BYTES:
            raise ValueError()
        value = json.loads(raw)
        if not isinstance(value, dict) or not isinstance(value.get("ok"), bool):
            raise ValueError()
        if response.status >= 400 and value["ok"]:
            raise ValueError()
        return json.dumps(value).replace(token, "[REDACTED]")
    except (ValueError, TypeError):
        return json.dumps({"ok": False, "error": "invalid_configuration_arguments_or_response"})
    except Exception:
        return json.dumps({"ok": False, "error": "native_memory_unavailable", "suggestion": "Do not retry a write with a new key; reconcile the existing receipt."})
    finally:
        if connection:
            connection.close()


def _schema(name, description, properties, required):
    return {"name": name, "description": description, "parameters": {"type": "object", "properties": properties, "required": required, "additionalProperties": False}}


PARTITION = {"type": "string", "description": "Authorized Knowledge partition; omit only if configured in KNOWLEDGE_PARTITION_KEY."}
ARGUMENTS = {"type": "object", "description": "Exact native arguments from knowledge_brain_tools; do not add source_id, identity or auth."}
NATIVE_TOOLS = (
    ("knowledge_brain_tools", _schema("knowledge_brain_tools", "Discover all native memory schemas, grants and usage guidance from the pinned GBrain engine. Research has separate tools.", {"partitionKey": PARTITION}, []), lambda args=None, **kw: _call(args or {}, catalog=True)),
    ("knowledge_brain_call", _schema("knowledge_brain_call", "Invoke a discovered native memory operation unchanged, including remember, recall, entity, synthesize, forget, context_pack, delta, query, graph and page reads. Writes require a stable idempotencyKey; never automatically retry uncertain writes.", {"partitionKey": PARTITION, "operation": {"type": "string"}, "arguments": ARGUMENTS, "idempotencyKey": {"type": "string"}}, ["operation", "arguments"]), lambda args=None, **kw: _call(args or {})),
    ("brain_think", _schema("brain_think", "Run GBrain's actual think synthesis, NOT context retrieval. First discover think's native schema. Supply arguments.question; inspect synthesis status and gaps. Native remote mode cannot persist a take or page.", {"partitionKey": PARTITION, "arguments": ARGUMENTS}, ["arguments"]), lambda args=None, **kw: _call(args or {}, operation="think")),
)
