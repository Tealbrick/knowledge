"""Knowledge Hermes tool handlers."""

from __future__ import annotations

import json
import os
from pathlib import Path
import urllib.error
import urllib.parse
import urllib.request
from typing import Any


def _json(data: Any) -> str:
    return json.dumps(data, ensure_ascii=False)


def _fail_closed(tool: str, reason: str, **extra: Any) -> str:
    payload = {
        "ok": False,
        "error": "fail_closed",
        "tool": tool,
        "reason": reason,
    }
    payload.update(extra)
    return _json(payload)


def _rules_decision_allows(result: dict[str, Any]) -> bool:
    decision = result.get("decision")
    effect = result.get("effect")
    return (
        result.get("allowed") is True
        or (isinstance(effect, str) and effect.lower() == "allow")
        or (isinstance(decision, str) and decision.lower() in {"allow", "allowed"})
    )


def _rules_decision_denies(result: dict[str, Any]) -> bool:
    decision = result.get("decision")
    effect = result.get("effect")
    return (
        result.get("allowed") is False
        or (isinstance(effect, str) and effect.lower() in {"deny", "denied", "blocked"})
        or (isinstance(decision, str) and decision.lower() in {"deny", "denied", "blocked"})
    )


RUNTIME_CONTRACT_PATH = Path(__file__).with_name("remote-runtime.json")
RUNTIME_CONNECTION_PATH = Path(__file__).with_name("runtime-connection.json")


def _loopback_base_url(value: Any) -> str | None:
    if not isinstance(value, str):
        return None
    candidate = value.strip().rstrip("/")
    if not candidate:
        return None
    parsed = urllib.parse.urlsplit(candidate)
    if (
        parsed.scheme != "http"
        or parsed.hostname not in {"127.0.0.1", "::1", "localhost"}
        or parsed.username is not None
        or parsed.password is not None
        or parsed.query
        or parsed.fragment
        or (parsed.path not in {"", "/"})
    ):
        return None
    return candidate


def _runtime_contract() -> dict[str, Any]:
    try:
        contract = json.loads(RUNTIME_CONTRACT_PATH.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return {}
    return contract if isinstance(contract, dict) else {}


def _connection_base_url() -> str | None:
    try:
        connection = json.loads(RUNTIME_CONNECTION_PATH.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return None
    if not isinstance(connection, dict):
        return None
    if connection.get("schemaVersion") != "doppelganger.remote-program-connection/v1":
        return None
    if connection.get("unitId") != "knowledge":
        return None
    return _loopback_base_url(connection.get("baseUrl"))


def _base_url() -> str | None:
    contract = _runtime_contract()
    program = contract.get("program") if isinstance(contract.get("program"), dict) else {}
    env_name = program.get("baseUrlEnv") if isinstance(program.get("baseUrlEnv"), str) else "KNOWLEDGE_BASE_URL"
    return _loopback_base_url(os.environ.get(env_name)) or _connection_base_url()


def _rules_gate(tool: str, args: dict[str, Any], posture: str | None) -> str | None:
    if not posture:
        return None
    rules_base = os.environ.get("RULES_BASE_URL", "").strip().rstrip("/")
    if not rules_base:
        return _fail_closed(
            tool,
            "RULES_BASE_URL is required before governed Knowledge tools can run.",
            posture=posture,
        )
    payload = {
        "method": "doppelganger.knowledge.tool",
        "params": {
            "tool": tool,
            "posture": posture,
            "actor": args.get("actor", {"id": "doppelganger-agent"}),
            "target": args.get("target", {}),
            "arguments": args,
        },
    }
    result = _request_url(
        "POST",
        f"{rules_base}/api/rules/gateway/evaluate",
        payload,
        auth_env="RULES_INTERNAL_AUTH_TOKEN",
    )
    if isinstance(result, dict) and result.get("ok") is False:
        return _json(result)
    if isinstance(result, dict):
        if _rules_decision_allows(result):
            return None
        if _rules_decision_denies(result):
            return _fail_closed(tool, "Rules Approvals denied the Knowledge tool call.", decision=result)
    return _fail_closed(tool, "Rules Approvals returned an invalid decision.", decision=result)


def _request_url(
    method: str,
    url: str,
    body: dict[str, Any] | None = None,
    *,
    auth_env: str | None = None,
) -> Any:
    headers = {"accept": "application/json"}
    data = None
    if body is not None and method.upper() != "GET":
        data = json.dumps(body).encode("utf-8")
        headers["content-type"] = "application/json"
    if auth_env:
        token = os.environ.get(auth_env, "").strip()
        if token:
            headers["authorization"] = f"Bearer {token}"
    request = urllib.request.Request(url, data=data, method=method.upper(), headers=headers)
    try:
        with urllib.request.urlopen(request, timeout=8) as response:
            text = response.read().decode("utf-8")
    except urllib.error.HTTPError as exc:
        text = exc.read().decode("utf-8", errors="replace")
        return {"ok": False, "error": "http_error", "status": exc.code, "body": text}
    except Exception as exc:
        return {"ok": False, "error": "request_failed", "message": str(exc)}
    if not text.strip():
        return {"ok": True}
    try:
        return json.loads(text)
    except Exception:
        return {"ok": True, "text": text}


def _fill_path(path: str, args: dict[str, Any]) -> tuple[str, dict[str, Any]]:
    remaining = dict(args)
    for key in ("companyId", "collectionId", "documentId", "bindingId"):
        token = f":{key}"
        if token in path:
            value = remaining.pop(key, None)
            if value is None:
                raise ValueError(f"{key} is required")
            path = path.replace(token, urllib.parse.quote(str(value), safe=""))
    return path, remaining


def _program_call(tool: str, contract: dict[str, Any], args: dict[str, Any]) -> str:
    denied = _rules_gate(tool, args, contract.get("posture"))
    if denied:
        return denied
    base = _base_url()
    if not base:
        return _fail_closed(
            tool,
            "Knowledge remote Program discovery requires a loopback KNOWLEDGE_BASE_URL or installed runtime connection.",
        )
    try:
        path, remaining = _fill_path(contract["path"], args)
    except ValueError as exc:
        return _fail_closed(tool, str(exc))
    method = contract["method"]
    url = f"{base}{path}"
    if method == "GET":
        if remaining:
            query = urllib.parse.urlencode(
                {key: value for key, value in remaining.items() if value is not None},
                doseq=True,
            )
            if query:
                url = f"{url}?{query}"
        body = None
    else:
        if method in {"POST", "PATCH", "PUT", "DELETE"} and not contract.get("view_only") and "actor" not in remaining:
            remaining["actor"] = {"kind": "agent", "id": "doppelganger-agent"}
        body = remaining
    result = _request_url(method, url, body)
    return _json(result)


def _schema(name: str, description: str, parameters: dict[str, Any] | None = None) -> dict[str, Any]:
    return {
        "name": name,
        "description": description,
        "parameters": parameters or {
            "type": "object",
            "properties": {},
            "additionalProperties": True,
        },
    }


CONTRACTS: dict[str, dict[str, Any]] = {
    "knowledge_health": {"method": "GET", "path": "/healthz"},
    "knowledge_status": {"method": "GET", "path": "/api/status"},
    "knowledge_docs_collections_list": {"method": "GET", "path": "/api/knowledge/collections", "posture": "governed_read"},
    "knowledge_docs_collections_create": {"method": "POST", "path": "/api/companies/:companyId/knowledge/collections", "posture": "governed_write"},
    "knowledge_docs_search": {"method": "GET", "path": "/api/companies/:companyId/knowledge/search", "posture": "governed_read"},
    "knowledge_docs_tree": {"method": "GET", "path": "/api/knowledge/collections/:collectionId/tree", "posture": "governed_read"},
    "knowledge_docs_create": {"method": "POST", "path": "/api/knowledge/collections/:collectionId/documents", "posture": "governed_write"},
    "knowledge_docs_read": {"method": "GET", "path": "/api/knowledge/documents/:documentId", "posture": "governed_read"},
    "knowledge_docs_update": {"method": "PATCH", "path": "/api/knowledge/documents/:documentId", "posture": "governed_write"},
    "knowledge_docs_revisions_list": {"method": "GET", "path": "/api/knowledge/documents/:documentId/revisions", "posture": "governed_read"},
    "knowledge_docs_access_get": {"method": "GET", "path": "/api/knowledge/documents/:documentId/access", "posture": "governed_read"},
    "knowledge_docs_access_update": {"method": "PUT", "path": "/api/knowledge/documents/:documentId/access", "posture": "governed_write"},
    "knowledge_ingest_run": {"method": "POST", "path": "/api/companies/:companyId/knowledge/ingest-runs", "posture": "governed_write"},
    "knowledge_research_notebooks_list": {"method": "GET", "path": "/api/companies/:companyId/research/notebooks", "posture": "governed_read"},
    "knowledge_bindings_create": {"method": "POST", "path": "/api/bindings", "posture": "governed_cross_plugin_mutation"},
    "knowledge_bindings_list": {"method": "GET", "path": "/api/bindings", "posture": "governed_read"},
    "knowledge_bindings_remove": {"method": "DELETE", "path": "/api/bindings/:bindingId", "posture": "governed_cross_plugin_mutation"},
    "brain_context_for_task": {"method": "POST", "path": "/api/brain/context", "posture": "governed_brain_context"},
    "brain_context_for_thread": {"method": "POST", "path": "/api/brain/context", "posture": "governed_brain_context"},
    "brain_recall": {"method": "POST", "path": "/api/brain/recall", "posture": "governed_brain_read"},
    "brain_query": {"method": "POST", "path": "/api/brain/context", "posture": "governed_brain_read"},
    "brain_entity_profile": {"method": "GET", "path": "/api/brain/entities", "posture": "governed_brain_read"},
    "brain_graph_traverse": {"method": "GET", "path": "/api/brain/entities", "posture": "governed_brain_read"},
}

PROGRAM_TOOL_DESCRIPTIONS: dict[str, str] = {
    "brain_recall": (
        "Recall Brain memories for a concrete task, thread, entity, or workspace scope. "
        "Always provide a stable scopeRef. Omit query for hot facts or an entity/session/temporal lookup; "
        "add query for hybrid page retrieval. Respect search_degraded and native provenance."
    ),
    "brain_query": (
        "Query Brain context for a concrete scope. Always provide a stable scopeRef and query."
    ),
    "brain_context_for_task": (
        "Build Brain context for a task. Provide its stable task scopeRef and the exact context query."
    ),
    "brain_context_for_thread": (
        "Build Brain context for a thread. Provide its stable thread scopeRef and the exact context query."
    ),
}

BRAIN_CONTEXT_PARAMETERS: dict[str, Any] = {
    "type": "object",
    "properties": {
        "scopeRef": {
            "type": "string",
            "minLength": 1,
            "description": "Stable scope, for example task:KYB-287, thread:<id>, or workspace:default.",
        },
        "purpose": {
            "type": "string",
            "enum": ["task", "thread", "entity", "general"],
            "description": "How the returned context will be used; defaults to general.",
        },
        "query": {"type": "string", "minLength": 1, "description": "Exact retrieval question or search text."},
        "sourceIds": {"type": "array", "items": {"type": "string"}},
        "partitionKey": {"type": "string", "minLength": 1},
        "limit": {"type": "integer", "minimum": 1, "maximum": 100},
        "expand": {"type": "boolean"},
        "detail": {"type": "string", "enum": ["low", "medium", "high"]},
    },
    "required": ["scopeRef", "query"],
    "additionalProperties": False,
}

BRAIN_RECALL_PARAMETERS: dict[str, Any] = {
    **BRAIN_CONTEXT_PARAMETERS,
    "required": ["scopeRef"],
    "properties": {
        **{key: value for key, value in BRAIN_CONTEXT_PARAMETERS["properties"].items() if key not in {"expand", "detail"}},
        "entity": {"type": "string", "maxLength": 512},
        "sessionId": {"type": "string", "maxLength": 512},
        "grep": {"type": "string", "maxLength": 2000},
        "since": {"type": "string", "maxLength": 128},
        "includeExpired": {"type": "boolean"},
        "supersessions": {"type": "boolean"},
        "includePending": {"type": "boolean"},
        "budgetTokens": {"type": "integer", "minimum": 256, "maximum": 32000},
    },
}


def _object_schema(
    properties: dict[str, Any] | None = None,
    required: list[str] | None = None,
) -> dict[str, Any]:
    schema: dict[str, Any] = {
        "type": "object",
        "properties": properties or {},
        "additionalProperties": False,
    }
    if required:
        schema["required"] = required
    return schema


STRING_ID = {"type": "string", "minLength": 1}
OPTIONAL_TEXT = {"type": "string"}
KNOWLEDGE_ACTOR = _object_schema(
    {
        "kind": {"type": "string", "enum": ["agent", "app", "import", "operator"]},
        "id": STRING_ID,
    },
    ["id"],
)
SOURCE_CONFIG = _object_schema(
    {
        "provider": {"type": "string", "enum": ["native", "github_repo", "forgejo_repo"]},
        "owner": STRING_ID,
        "repo": STRING_ID,
        "branch": STRING_ID,
        "rootPath": {"type": "string"},
        "apiBaseUrl": {"type": "string"},
        "tokenEnvVar": STRING_ID,
        "secretName": STRING_ID,
    },
    ["provider"],
)
DOCUMENT_FIELDS = {
    "title": STRING_ID,
    "summary": OPTIONAL_TEXT,
    "body": OPTIONAL_TEXT,
    "parentDocumentId": STRING_ID,
    "bodyFormat": OPTIONAL_TEXT,
    "status": OPTIONAL_TEXT,
    "sourcePath": OPTIONAL_TEXT,
    "actor": KNOWLEDGE_ACTOR,
}
ACCESS_GRANT = _object_schema(
    {
        "principalType": STRING_ID,
        "principalId": STRING_ID,
        "role": STRING_ID,
    },
    ["principalType", "principalId", "role"],
)

PROGRAM_TOOL_PARAMETERS: dict[str, dict[str, Any]] = {
    "knowledge_health": _object_schema(),
    "knowledge_status": _object_schema(),
    "knowledge_docs_collections_list": _object_schema(),
    "knowledge_docs_collections_create": _object_schema(
        {
            "companyId": STRING_ID,
            "name": STRING_ID,
            "description": OPTIONAL_TEXT,
            "sourceConfig": SOURCE_CONFIG,
        },
        ["companyId", "name"],
    ),
    "knowledge_docs_search": _object_schema(
        {
            "companyId": STRING_ID,
            "q": {"type": "string"},
            "collectionId": STRING_ID,
            "excludeDocumentId": STRING_ID,
            "limit": {"type": "integer", "minimum": 1},
        },
        ["companyId"],
    ),
    "knowledge_docs_tree": _object_schema({"collectionId": STRING_ID}, ["collectionId"]),
    "knowledge_docs_create": _object_schema(
        {
            "collectionId": STRING_ID,
            **DOCUMENT_FIELDS,
        },
        ["collectionId", "title"],
    ),
    "knowledge_docs_read": _object_schema({"documentId": STRING_ID}, ["documentId"]),
    "knowledge_docs_update": _object_schema(
        {
            "documentId": STRING_ID,
            **DOCUMENT_FIELDS,
        },
        ["documentId"],
    ),
    "knowledge_docs_revisions_list": _object_schema({"documentId": STRING_ID}, ["documentId"]),
    "knowledge_docs_access_get": _object_schema({"documentId": STRING_ID}, ["documentId"]),
    "knowledge_docs_access_update": _object_schema(
        {
            "documentId": STRING_ID,
            "accessMode": OPTIONAL_TEXT,
            "inheritFromParent": {"type": "boolean"},
            "grants": {"type": "array", "items": ACCESS_GRANT},
        },
        ["documentId"],
    ),
    "knowledge_ingest_run": _object_schema(
        {"companyId": STRING_ID, "collectionId": STRING_ID},
        ["companyId"],
    ),
    "knowledge_research_notebooks_list": _object_schema({"companyId": STRING_ID}, ["companyId"]),
    "knowledge_bindings_create": _object_schema(
        {
            "ownerPlugin": STRING_ID,
            "ownerType": STRING_ID,
            "ownerId": STRING_ID,
            "artifactType": STRING_ID,
            "artifactId": STRING_ID,
            "relationshipType": STRING_ID,
            "summary": OPTIONAL_TEXT,
            "createdBy": OPTIONAL_TEXT,
            "rulesDecisionRef": OPTIONAL_TEXT,
            "metadata": {"type": "object", "additionalProperties": True},
        },
        ["ownerPlugin", "ownerType", "ownerId", "artifactType", "artifactId", "relationshipType"],
    ),
    "knowledge_bindings_list": _object_schema(
        {
            "ownerPlugin": STRING_ID,
            "ownerType": STRING_ID,
            "ownerId": STRING_ID,
            "artifactType": STRING_ID,
            "artifactId": STRING_ID,
        }
    ),
    "knowledge_bindings_remove": _object_schema({"bindingId": STRING_ID}, ["bindingId"]),
    "brain_context_for_task": BRAIN_CONTEXT_PARAMETERS,
    "brain_context_for_thread": BRAIN_CONTEXT_PARAMETERS,
    "brain_recall": BRAIN_RECALL_PARAMETERS,
    "brain_query": BRAIN_CONTEXT_PARAMETERS,
    "brain_entity_profile": _object_schema({"slug": STRING_ID}, ["slug"]),
    "brain_graph_traverse": _object_schema(
        {
            "slug": STRING_ID,
            "depth": {"type": "integer", "minimum": 1, "maximum": 4},
            "direction": {"type": "string", "enum": ["in", "out", "both"]},
            "linkType": STRING_ID,
        },
        ["slug"],
    ),

}


def _make_handler(tool: str, contract: dict[str, Any]):
    def _handler(args: dict[str, Any] | None = None, **_kw) -> str:
        return _program_call(tool, contract, args or {})

    return _handler


TOOLS = tuple(
    (
        name,
        _schema(
            name,
            PROGRAM_TOOL_DESCRIPTIONS.get(name, f"Call Knowledge Program API tool `{name}`."),
            PROGRAM_TOOL_PARAMETERS.get(name),
        ),
        _make_handler(name, contract),
    )
    for name, contract in CONTRACTS.items()
)
