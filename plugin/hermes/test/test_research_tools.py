"""Disposable loopback coverage for the authenticated Knowledge Research tools."""

from __future__ import annotations

import importlib.util
import json
import os
from pathlib import Path
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import unittest
from unittest.mock import patch


ROOT = Path(__file__).parents[3]
MODULE_PATH = ROOT / "plugin/hermes/remote-plugin/knowledge/research_tools.py"
SPEC = importlib.util.spec_from_file_location("knowledge_research_tools_fixture", MODULE_PATH)
assert SPEC and SPEC.loader
research_tools = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(research_tools)

TOKEN = "research-test-token-<&-sentinel"
BASELINE = {
    "repository": "open-notebook",
    "release": "v1.14.0",
    "commit": "30c7e2a63e43b7f270fc2c638f0b6246934a53f4",
    "source": {
        "health": "api/main.py",
        "capabilities": "api/routers/capabilities.py",
        "notebooks": "api/routers/notebooks.py",
        "sources": "api/routers/sources.py",
        "notes": "api/routers/notes.py",
        "models": "api/models.py",
    },
}


def envelope(**fields):
    return {"provider": "open_notebook", "contractBaseline": BASELINE, "observedVersion": None, **fields}


def source_record(*, title="Alpha", full_text=None):
    record = {
        "id": "source:alpha",
        "title": title,
        "topics": [],
        "asset": {"url": None},
        "embedded": False,
        "embeddedChunks": 0,
        "insightsCount": 0,
        "fileAvailable": None,
        "created": "2026-09-06T00:00:00Z",
        "updated": "2026-09-06T00:00:00Z",
        "commandId": None,
        "status": None,
    }
    if full_text is not None:
        record["fullText"] = full_text
    return record


def note_record(*, note_id="note:alpha", title="Alpha note", content="Saved note content"):
    return {
        "id": note_id,
        "title": title,
        "content": content,
        "noteType": "human",
        "created": "2026-09-06T00:00:00Z",
        "updated": "2026-09-06T00:00:00Z",
        "commandId": None,
    }


def receipt(key, *, state="succeeded", operation=None, session_id=None):
    result = {
        "idempotencyKey": key,
        "state": state,
        "sourceId": "source:created" if operation is None else None,
        "errorCode": "upstream_rejected" if state == "rejected" else ("ambiguous_response" if state == "uncertain" else None),
        "createdAt": "2026-09-06T00:00:00Z",
        "updatedAt": "2026-09-06T00:00:00Z",
    }
    if operation is not None:
        result.update({
            "operation": operation,
            "sessionId": session_id or "chat_session:alpha",
            "answer": None if operation == "session" else {"id": "answer-1", "type": "ai", "content": "done"},
        })
        result.pop("sourceId")
    if state != "succeeded":
        result["sourceId"] = None
    return result


class _FixtureHandler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def log_message(self, *_args):
        return

    def do_GET(self):  # noqa: N802 - stdlib handler API
        self._handle()

    def do_POST(self):  # noqa: N802 - stdlib handler API
        self._handle()

    def _handle(self):
        length = int(self.headers.get("Content-Length", "0"))
        body = self.rfile.read(length) if length else b""
        fixture = self.server.fixture
        fixture.calls.append({
            "method": self.command,
            "path": self.path,
            "headers": {key.lower(): value for key, value in self.headers.items()},
            "body": body,
        })
        status, headers, payload = fixture.respond(self.command, self.path, body)
        if payload == "__stall__":
            time.sleep(1.0)
            return
        if payload == "__oversize__":
            self.send_response(status)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(research_tools.MAX_RESPONSE_BYTES + 1))
            self.end_headers()
            return
        encoded = payload if isinstance(payload, bytes) else json.dumps(payload, separators=(",", ":")).encode()
        self.send_response(status)
        self.send_header("Content-Type", headers.get("Content-Type", "application/json"))
        self.send_header("Content-Length", str(len(encoded)))
        for key, value in headers.items():
            if key.lower() != "content-type":
                self.send_header(key, value)
        self.end_headers()
        self.wfile.write(encoded)


class LoopbackFixture:
    def __init__(self):
        self.calls = []
        self.callback = lambda _method, _path, _body: (200, {}, envelope())
        self.server = ThreadingHTTPServer(("127.0.0.1", 0), _FixtureHandler)
        self.server.daemon_threads = True
        self.server.fixture = self
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)

    @property
    def url(self):
        return f"http://127.0.0.1:{self.server.server_port}"

    def respond(self, method, path, body):
        return self.callback(method, path, body)

    def start(self):
        self.thread.start()

    def close(self):
        self.server.shutdown()
        self.server.server_close()
        self.thread.join(timeout=2)


class ResearchToolsTest(unittest.TestCase):
    def setUp(self):
        self.fixture = LoopbackFixture()
        self.fixture.start()
        self.environment = patch.dict(
            os.environ,
            {
                research_tools.RESEARCH_SERVICE_TOKEN_ENV: TOKEN,
                research_tools.KNOWLEDGE_BASE_URL_ENV: self.fixture.url,
            },
            clear=True,
        )
        self.environment.start()
        self.handlers = {name: handler for name, _schema, handler in research_tools.RESEARCH_TOOLS}

    def tearDown(self):
        self.environment.stop()
        self.fixture.close()

    def call(self, name, args):
        return json.loads(self.handlers[name](args))

    def test_registration_strict_arguments_and_no_dispatch(self):
        self.assertEqual(set(self.handlers), set(research_tools.RESEARCH_CONTRACTS))
        self.assertEqual(self.call("knowledge_research_context_get", {"notebookId": "nb-a", "token": TOKEN}), {"ok": False, "error": "invalid_arguments"})
        self.assertEqual(self.call("knowledge_research_context_get", {}), {"ok": False, "error": "invalid_arguments"})
        self.assertEqual(self.fixture.calls, [])

    def test_notebook_discovery_uses_fixed_route_defaults_and_local_projection(self):
        payload = {
            "provider": "open_notebook",
            "notebooks": [{"id": "notebook:alpha", "name": "Alpha", "description": "Local summary"}],
            "pagination": {"limit": 50, "offset": 0, "hasMore": False},
        }
        self.fixture.callback = lambda _method, _path, _body: (200, {}, payload)
        result = self.call("knowledge_research_notebooks_discover", {})
        self.assertTrue(result["ok"])
        self.assertEqual(result["result"], payload)
        self.assertEqual(self.fixture.calls[0]["method"], "GET")
        self.assertEqual(self.fixture.calls[0]["path"], "/api/research/engine/notebooks?limit=50&offset=0")
        self.assertEqual(self.fixture.calls[0]["headers"]["authorization"], f"Bearer {TOKEN}")
        self.assertNotIn("contractBaseline", result["result"])
        self.assertNotIn("observedVersion", result["result"])

        explicit = self.call("knowledge_research_notebooks_discover", {"limit": 2, "offset": 4})
        self.assertFalse(explicit["ok"])
        self.assertEqual(explicit["error"], "malformed_response")
        self.assertEqual(self.fixture.calls[-1]["path"], "/api/research/engine/notebooks?limit=2&offset=4")

    def test_notebook_discovery_rejects_scope_inputs_and_bounds_before_dispatch(self):
        for args in [
            {"notebookId": "nb-a"},
            {"companyId": "company-beta"},
            {"principalId": "other"},
            {"url": "http://evil.example"},
            {"limit": 0},
            {"limit": 51},
            {"offset": -1},
            {"offset": 201},
            {"limit": True},
            {"unexpected": False},
        ]:
            self.assertEqual(self.call("knowledge_research_notebooks_discover", args), {"ok": False, "error": "invalid_arguments"}, args)
        self.assertEqual(self.fixture.calls, [])

    def test_notebook_discovery_rejects_unknown_fields_duplicates_and_mismatched_pagination(self):
        base = {
            "provider": "open_notebook",
            "notebooks": [{"id": "notebook:alpha", "name": "Alpha", "description": "Local"}],
            "pagination": {"limit": 50, "offset": 0, "hasMore": False},
        }
        cases = [
            {**base, "contractBaseline": {"release": "provider-private"}},
            {**base, "notebooks": [{"id": "notebook:alpha", "name": "A", "description": ""}, {"id": "notebook:alpha", "name": "B", "description": ""}]},
            {**base, "pagination": {"limit": 49, "offset": 0, "hasMore": False}},
            {**base, "pagination": {"limit": 50, "offset": 1, "hasMore": False}},
            {**base, "pagination": {"limit": 50, "offset": 0, "hasMore": True}},
            {**base, "notebooks": [{"id": "notebook:alpha", "name": "A", "description": "", "externalNotebookId": "provider-private"}]},
            {**base, "notebooks": [{"id": "notebook:alpha", "name": "", "description": ""}]},
        ]
        for payload in cases:
            self.fixture.callback = lambda _method, _path, _body, payload=payload: (200, {}, payload)
            result = self.call("knowledge_research_notebooks_discover", {})
            self.assertFalse(result["ok"], payload)
            self.assertEqual(result["error"], "malformed_response", payload)

        too_many = {
            "provider": "open_notebook",
            "notebooks": [{"id": f"notebook:{index}", "name": "N", "description": ""} for index in range(51)],
            "pagination": {"limit": 50, "offset": 0, "hasMore": True},
        }
        self.fixture.callback = lambda _method, _path, _body: (200, {}, too_many)
        self.assertEqual(self.call("knowledge_research_notebooks_discover", {})["error"], "malformed_response")

        for payload in [
            {**base, "notebooks": [{"id": "notebook:alpha", "name": "A", "description": ""}, {"id": "notebook:beta", "name": "B", "description": ""}], "pagination": {"limit": 1, "offset": 0, "hasMore": False}},
            {**base, "pagination": {"limit": 1, "offset": 200, "hasMore": False}},
            {**base, "pagination": {"limit": 1, "offset": 199, "hasMore": True}},
        ]:
            self.fixture.callback = lambda _method, _path, _body, payload=payload: (200, {}, payload)
            result = self.call("knowledge_research_notebooks_discover", {"limit": payload["pagination"]["limit"], "offset": payload["pagination"]["offset"]})
            self.assertEqual(result["error"], "malformed_response", payload)

    def test_notebook_discovery_redacts_runtime_token_in_local_fields(self):
        self.fixture.callback = lambda _method, _path, _body: (200, {}, {
            "provider": "open_notebook",
            "notebooks": [{"id": "notebook:alpha", "name": TOKEN, "description": f"summary {TOKEN}"}],
            "pagination": {"limit": 50, "offset": 0, "hasMore": False},
        })
        result = self.call("knowledge_research_notebooks_discover", {})
        self.assertTrue(result["ok"])
        self.assertNotIn(TOKEN, json.dumps(result))
        self.assertEqual(result["result"]["notebooks"][0]["name"], "[REDACTED]")

    def test_notebook_discovery_pagination_and_auth_errors_do_not_fallback_or_retry(self):
        page = {
            "provider": "open_notebook",
            "notebooks": [{"id": "notebook:last", "name": "Last", "description": ""}],
            "pagination": {"limit": 1, "offset": 199, "hasMore": False},
        }
        self.fixture.callback = lambda _method, _path, _body: (200, {}, page)
        result = self.call("knowledge_research_notebooks_discover", {"limit": 1, "offset": 199})
        self.assertTrue(result["ok"])
        self.assertEqual(result["result"]["pagination"], page["pagination"])

        empty = {"provider": "open_notebook", "notebooks": [], "pagination": {"limit": 1, "offset": 200, "hasMore": False}}
        self.fixture.callback = lambda _method, _path, _body: (200, {}, empty)
        result = self.call("knowledge_research_notebooks_discover", {"limit": 1, "offset": 200})
        self.assertTrue(result["ok"])
        self.assertEqual(result["result"]["notebooks"], [])

        for status in (404, 403):
            self.fixture.callback = lambda _method, _path, _body, status=status: (status, {}, {"error": "credential-or-scope-detail"})
            before = len(self.fixture.calls)
            result = self.call("knowledge_research_notebooks_discover", {})
            self.assertEqual(result["error"], "knowledge_http_error")
            self.assertEqual(result["status"], status)
            self.assertEqual(len(self.fixture.calls), before + 1)

        before = len(self.fixture.calls)
        with patch.dict(os.environ, {research_tools.KNOWLEDGE_BASE_URL_ENV: self.fixture.url}, clear=True):
            self.assertEqual(self.call("knowledge_research_notebooks_discover", {})["error"], "service_auth_unavailable")
        self.assertEqual(len(self.fixture.calls), before)
        with patch.dict(os.environ, {research_tools.RESEARCH_SERVICE_TOKEN_ENV: "", research_tools.KNOWLEDGE_BASE_URL_ENV: self.fixture.url}, clear=True):
            self.assertEqual(self.call("knowledge_research_notebooks_discover", {})["error"], "service_auth_unavailable")
        self.assertEqual(len(self.fixture.calls), before)

    def test_note_get_uses_fixed_scoped_route_and_preserves_escaped_body_as_data(self):
        content = "</script>\u2028 untrusted note text"
        payload = envelope(note=note_record(title="A <display>", content=content))
        self.fixture.callback = lambda _method, _path, _body: (200, {}, payload)
        result = self.call("knowledge_research_note_get", {"notebookId": "notebook:alpha", "noteId": "note:alpha"})
        self.assertTrue(result["ok"])
        self.assertEqual(result["result"]["note"]["content"], content)
        self.assertEqual(result["result"]["note"]["title"], "A <display>")
        self.assertEqual(self.fixture.calls[0]["method"], "GET")
        self.assertEqual(self.fixture.calls[0]["path"], "/api/research/notebooks/notebook%3Aalpha/engine/notes/note%3Aalpha")
        self.assertEqual(self.fixture.calls[0]["headers"]["authorization"], f"Bearer {TOKEN}")
        self.assertEqual(self.fixture.calls[0]["body"], b"")

    def test_note_get_rejects_scope_credentials_and_foreign_ids_before_dispatch(self):
        for args in [
            {"notebookId": "notebook:alpha"},
            {"notebookId": "notebook:alpha", "noteId": "source:foreign"},
            {"notebookId": "notebook:alpha", "noteId": "note:../foreign"},
            {"notebookId": "notebook:alpha", "noteId": "note:"},
            {"notebookId": "../foreign", "noteId": "note:alpha"},
            {"notebookId": "notebook:alpha", "noteId": "note:alpha", "companyId": "company-beta"},
            {"notebookId": "notebook:alpha", "noteId": "note:alpha", "url": "http://evil.example"},
            {"notebookId": "notebook:alpha", "noteId": "note:alpha", "token": TOKEN},
        ]:
            self.assertEqual(self.call("knowledge_research_note_get", args), {"ok": False, "error": "invalid_arguments"}, args)
        self.assertEqual(self.fixture.calls, [])

    def test_note_get_requires_exact_id_and_explicit_content_and_bounds_projection(self):
        cases = []
        cases.append(note_record(note_id="note:other"))
        missing_content = note_record()
        missing_content.pop("content")
        cases.append(missing_content)
        cases.append(note_record(content=42))
        cases.append(note_record(title="界" * 2049))
        cases.append(note_record(content="界" * 262145))
        cases.append({**note_record(), "noteType": "x" * 129})
        cases.append({**note_record(), "created": "x" * 129})
        cases.append({**note_record(), "updated": "x" * 129})
        cases.append({**note_record(), "commandId": "x" * 257})
        cases.append(note_record(note_id="source:foreign"))
        for malformed in cases:
            self.fixture.callback = lambda _method, _path, _body, malformed=malformed: (200, {}, envelope(note=malformed))
            result = self.call("knowledge_research_note_get", {"notebookId": "notebook:alpha", "noteId": "note:alpha"})
            self.assertFalse(result["ok"], malformed)
            self.assertEqual(result["error"], "malformed_response", malformed)

    def test_note_get_auth_errors_do_not_fallback_or_retry_and_missing_config_fails_closed(self):
        for status in (401, 403, 404, 502):
            self.fixture.callback = lambda _method, _path, _body, status=status: (status, {}, {"error": "private-provider-detail"})
            before = len(self.fixture.calls)
            result = self.call("knowledge_research_note_get", {"notebookId": "notebook:alpha", "noteId": "note:alpha"})
            self.assertFalse(result["ok"])
            self.assertEqual(result["error"], "knowledge_http_error")
            self.assertEqual(result["status"], status)
            self.assertEqual(len(self.fixture.calls), before + 1)

        before = len(self.fixture.calls)
        with patch.dict(os.environ, {research_tools.KNOWLEDGE_BASE_URL_ENV: self.fixture.url}, clear=True):
            self.assertEqual(self.call("knowledge_research_note_get", {"notebookId": "notebook:alpha", "noteId": "note:alpha"})["error"], "service_auth_unavailable")
        self.assertEqual(len(self.fixture.calls), before)

    def test_note_get_redacts_runtime_token_in_projected_note_fields(self):
        self.fixture.callback = lambda _method, _path, _body: (200, {}, envelope(note=note_record(title=TOKEN, content=f"body {TOKEN}")))
        result = self.call("knowledge_research_note_get", {"notebookId": "notebook:alpha", "noteId": "note:alpha"})
        self.assertTrue(result["ok"])
        self.assertNotIn(TOKEN, json.dumps(result))
        self.assertEqual(result["result"]["note"]["title"], "[REDACTED]")

    def test_context_nested_counts_and_secret_redaction(self):
        self.fixture.callback = lambda _method, _path, _body: (200, {}, envelope(
            context={
                "sources": [{
                    "id": "source:alpha",
                    "title": TOKEN,
                    "fullText": f"untrusted {TOKEN}",
                    "insights": [{"id": "insight-1", "insightType": "summary", "content": "safe"}],
                }],
                "notes": [],
                "tokenCount": 4,
                "charCount": 27,
            },
            contextPolicy="server-selected-full-content",
            contentTrust="untrusted-source-data",
            modelInvoked=False,
        ))
        result = self.call("knowledge_research_context_get", {"notebookId": "nb-a"})
        self.assertTrue(result["ok"])
        self.assertEqual(result["result"]["context"]["tokenCount"], 4)
        self.assertEqual(result["result"]["context"]["charCount"], 27)
        self.assertNotIn(TOKEN, json.dumps(result))
        self.assertEqual(result["result"]["contextPolicy"], "server-selected-full-content")
        self.assertFalse(result["result"]["modelInvoked"])

    def test_nullable_note_and_chat_history_scope_are_validated(self):
        self.fixture.callback = lambda _method, _path, _body: (200, {}, envelope(notes=[{
            "id": "note:alpha", "title": "Note", "content": "text", "noteType": None,
            "created": "2026-09-06T00:00:00Z", "updated": "2026-09-06T00:00:00Z", "commandId": None,
        }]))
        result = self.call("knowledge_research_notes_list", {"notebookId": "nb-a"})
        self.assertTrue(result["ok"])
        self.assertIsNone(result["result"]["notes"][0]["noteType"])

        self.fixture.callback = lambda _method, _path, _body: (200, {}, envelope(
            session={"id": "chat_session:other", "title": "Other", "notebookId": "nb-b", "createdAt": "now", "updatedAt": "now"},
            messages=[],
        ))
        result = self.call("knowledge_research_chat_get", {"notebookId": "nb-a", "sessionId": "chat_session:alpha"})
        self.assertFalse(result["ok"])
        self.assertEqual(result["error"], "malformed_response")

    def test_source_write_fixed_body_header_and_replay_statuses(self):
        def respond(_method, _path, body):
            is_replay = len(self.fixture.calls) > 1
            return (200 if is_replay else 201, {}, envelope(
                receipt=receipt("source-key"), replayed=is_replay,
            ))

        self.fixture.callback = respond
        first = self.call("knowledge_research_source_create", {"notebookId": "nb-a", "title": "Title", "content": "Body", "idempotencyKey": "source-key"})
        second = self.call("knowledge_research_source_create", {"notebookId": "nb-a", "title": "Title", "content": "Body", "idempotencyKey": "source-key"})
        self.assertTrue(first["ok"])
        self.assertEqual(first["status"], 201)
        self.assertFalse(first["result"]["replayed"])
        self.assertTrue(second["ok"])
        self.assertEqual(second["status"], 200)
        self.assertTrue(second["result"]["replayed"])
        request = self.fixture.calls[0]
        self.assertEqual(json.loads(request["body"]), {"title": "Title", "content": "Body"})
        self.assertEqual(request["headers"]["authorization"], f"Bearer {TOKEN}")
        self.assertEqual(request["headers"]["idempotency-key"], "source-key")

    def test_chat_replay_may_omit_provider_retry_policy(self):
        self.fixture.callback = lambda _method, _path, _body: (200, {}, envelope(
            receipt=receipt("chat-key", operation="message", session_id="chat_session:alpha"), replayed=True,
        ))
        result = self.call("knowledge_research_chat_send", {
            "notebookId": "nb-a", "sessionId": "chat_session:alpha", "message": "hello", "idempotencyKey": "chat-key",
        })
        self.assertTrue(result["ok"])
        self.assertTrue(result["result"]["replayed"])
        self.assertNotIn("providerRetryPolicy", result["result"])

    def test_rejected_gateway_receipt_is_not_reported_as_ambiguous(self):
        self.fixture.callback = lambda _method, _path, _body: (502, {}, envelope(
            receipt=receipt("source-key", state="rejected"), errorCode="upstream_rejected",
        ))
        result = self.call("knowledge_research_source_create", {
            "notebookId": "nb-a", "title": "Title", "content": "Body", "idempotencyKey": "source-key",
        })
        self.assertFalse(result["ok"])
        self.assertEqual(result["error"], "knowledge_http_error")
        self.assertEqual(result["status"], 502)
        self.assertEqual(result["receipt"]["state"], "rejected")

    def test_redirect_overflow_and_invalid_input_are_bounded(self):
        self.fixture.callback = lambda _method, path, _body: (302, {"Location": "http://127.0.0.1:9/secret"}, envelope()) if path.endswith("/engine") else (200, {}, "__oversize__")
        redirected = self.call("knowledge_research_engine_get", {"notebookId": "nb-a"})
        self.assertFalse(redirected["ok"])
        self.assertEqual(redirected["error"], "redirect_rejected")
        oversized = self.call("knowledge_research_sources_list", {"notebookId": "nb-a"})
        self.assertFalse(oversized["ok"])
        self.assertEqual(oversized["error"], "response_too_large")
        count = len(self.fixture.calls)
        invalid = self.call("knowledge_research_source_create", {"notebookId": "nb-a", "title": "x", "content": "y", "idempotencyKey": "k", "extra": True})
        self.assertEqual(invalid["error"], "invalid_arguments")
        self.assertEqual(len(self.fixture.calls), count)

    def test_explicit_discovery_and_runtime_file_fail_closed(self):
        with patch.dict(os.environ, {research_tools.RESEARCH_SERVICE_TOKEN_ENV: TOKEN, research_tools.KNOWLEDGE_BASE_URL_ENV: "   "}, clear=True):
            result = self.call("knowledge_research_engine_get", {"notebookId": "nb-a"})
            self.assertEqual(result["error"], "service_discovery_unavailable")
        with patch.dict(os.environ, {research_tools.RESEARCH_SERVICE_TOKEN_ENV: TOKEN}, clear=True), patch.object(research_tools, "RUNTIME_CONNECTION_PATH", Path("/tmp/definitely-missing-knowledge-runtime-connection.json")):
            result = self.call("knowledge_research_engine_get", {"notebookId": "nb-a"})
            self.assertEqual(result["error"], "service_discovery_unavailable")

    def test_post_timeout_is_ambiguous_and_not_retried(self):
        self.fixture.callback = lambda _method, _path, _body: (201, {}, "__stall__")
        with patch.object(research_tools, "CALL_DEADLINE_SECONDS", 0.1):
            result = self.call("knowledge_research_source_create", {
                "notebookId": "nb-a", "title": "Title", "content": "Body", "idempotencyKey": "source-key",
            })
        self.assertFalse(result["ok"])
        self.assertEqual(result["error"], "reconciliation_required")
        self.assertEqual(result["idempotencyKey"], "source-key")
        self.assertEqual(len(self.fixture.calls), 1)


if __name__ == "__main__":
    unittest.main()
