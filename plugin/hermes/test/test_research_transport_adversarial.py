"""Root adversarial checks of the real bounded Research HTTP transport."""
from contextlib import contextmanager
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import importlib.util
import json
import os
from pathlib import Path
import threading
import time
import unittest
from unittest.mock import patch

PLUGIN = Path(__file__).parents[3] / "plugin/hermes/remote-plugin/knowledge"
SPEC = importlib.util.spec_from_file_location("research_adversarial_fixture", PLUGIN / "research_tools.py")
tools = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(tools)
HANDLERS = {name: handler for name, _schema, handler in tools.RESEARCH_TOOLS}

BASELINE = {"repository": "https://github.com/lfnovo/open-notebook", "release": "1.14.0", "commit": "30c7e2a63e43b7f270fc2c638f0b6246934a53f4", "source": {key: "fixture" for key in ["health", "capabilities", "notebooks", "sources", "notes", "models"]}}


def envelope(**fields):
    return {"provider": "open_notebook", "contractBaseline": BASELINE, "observedVersion": None, **fields}


def receipt(**fields):
    return {"operation": "session", "idempotencyKey": "create-key", "state": "succeeded", "sessionId": "chat_session:local", "answer": None, "errorCode": None, "createdAt": "now", "updatedAt": "now", **fields}


@contextmanager
def server_fixture(payload=None, status=200, drip=False):
    calls = []
    stop = threading.Event()

    class Handler(BaseHTTPRequestHandler):
        def log_message(self, *_args):
            pass

        def do_GET(self):
            calls.append(self.path)
            length = int(self.headers.get("Content-Length", "0"))
            if length:
                self.rfile.read(length)
            try:
                if drip:
                    self.wfile.write(b"HTTP/1.1 200 OK\r\nX-Drip: ")
                    self.wfile.flush()
                    for _ in range(80):
                        if stop.wait(0.02):
                            return
                        self.wfile.write(b"a")
                        self.wfile.flush()
                    return
                body = json.dumps(payload).encode()
                self.send_response(status)
                self.send_header("Content-Type", "application/json")
                self.send_header("Content-Length", str(len(body)))
                self.end_headers()
                self.wfile.write(body)
            except (BrokenPipeError, ConnectionResetError, OSError):
                pass

        do_POST = do_GET

    server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
    server.daemon_threads = True
    worker = threading.Thread(target=server.serve_forever, daemon=True)
    worker.start()
    try:
        with patch.dict(os.environ, {"KNOWLEDGE_BASE_URL": f"http://127.0.0.1:{server.server_port}", "KNOWLEDGE_RESEARCH_SERVICE_TOKEN": "private-service-sentinel"}, clear=True):
            yield calls
    finally:
        stop.set()
        server.shutdown()
        server.server_close()
        worker.join(timeout=2)


class ResearchTransportAdversarialTest(unittest.TestCase):
    def test_absolute_deadline_interrupts_slow_drip_headers_without_post_retry(self):
        with server_fixture(drip=True) as calls, patch.object(tools, "CALL_DEADLINE_SECONDS", 0.12):
            started = time.monotonic()
            result = json.loads(HANDLERS["knowledge_research_chat_create"]({"notebookId": "local", "idempotencyKey": "create-key"}))
            elapsed = time.monotonic() - started
            self.assertLess(elapsed, 0.6, "socket idle timeout is not an absolute deadline")
            self.assertFalse(result["ok"])
            self.assertEqual(result["error"], "reconciliation_required")
            self.assertEqual(result["idempotencyKey"], "create-key")
            self.assertEqual(len(calls), 1)

    def test_successful_create_rejects_wrong_receipt_key_and_nonterminal_state(self):
        for malformed in [receipt(idempotencyKey="another-key"), receipt(state="pending")]:
            with self.subTest(receipt=malformed), server_fixture(envelope(receipt=malformed, replayed=False), status=201) as calls:
                result = json.loads(HANDLERS["knowledge_research_chat_create"]({"notebookId": "local", "idempotencyKey": "create-key"}))
                self.assertFalse(result["ok"])
                self.assertEqual(result["error"], "reconciliation_required")
                self.assertEqual(len(calls), 1)

    def test_history_rejects_wrong_local_session_or_notebook(self):
        for wrong in [{"id": "chat_session:other", "notebookId": "local"}, {"id": "chat_session:local", "notebookId": "other"}]:
            body = envelope(session={**wrong, "title": "chat", "createdAt": "now", "updatedAt": "now"}, messages=[])
            with self.subTest(identity=wrong), server_fixture(body):
                result = json.loads(HANDLERS["knowledge_research_chat_get"]({"notebookId": "local", "sessionId": "chat_session:local"}))
                self.assertFalse(result["ok"])


if __name__ == "__main__":
    unittest.main()
