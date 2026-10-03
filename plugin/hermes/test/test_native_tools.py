import http.server
import importlib.util
import json
import os
from pathlib import Path
import threading
import unittest
from unittest.mock import patch

FILE = Path(__file__).parents[3] / "plugin/hermes/remote-plugin/knowledge/native_tools.py"
spec = importlib.util.spec_from_file_location("knowledge_native_fixture", FILE)
native = importlib.util.module_from_spec(spec)
spec.loader.exec_module(native)


class NativeAdapterTest(unittest.TestCase):
    def test_missing_auth_and_non_loopback_http_fail_closed(self):
        with patch.dict(os.environ, {}, clear=True):
            self.assertEqual(json.loads(native._call({}, catalog=True))["error"], "service_auth_unavailable")
        with patch.dict(os.environ, {"KNOWLEDGE_SERVICE_TOKEN": "fixture", "KNOWLEDGE_PARTITION_KEY": "fixture-a", "KNOWLEDGE_BASE_URL": "http://foreign.test"}, clear=True):
            self.assertFalse(json.loads(native._call({}, catalog=True))["ok"])

    def test_real_http_preserves_arguments_and_never_redirects_or_retries(self):
        calls = []

        class Handler(http.server.BaseHTTPRequestHandler):
            def do_POST(self):
                body = json.loads(self.rfile.read(int(self.headers["Content-Length"])))
                calls.append((self.path, dict(self.headers), body))
                self.send_response(302 if body["arguments"].get("redirect") else 200)
                self.send_header("Location", "http://foreign.test/steal")
                self.end_headers()
                self.wfile.write(json.dumps({"ok": True, "data": body["arguments"]}).encode())

            def log_message(self, *args):
                pass

        server = http.server.ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        thread = threading.Thread(target=server.serve_forever, daemon=True)
        thread.start()
        try:
            with patch.dict(os.environ, {"KNOWLEDGE_SERVICE_TOKEN": "fixture-token", "KNOWLEDGE_PARTITION_KEY": "fixture-a", "KNOWLEDGE_BASE_URL": "http://127.0.0.1:" + str(server.server_port)}, clear=True):
                result = json.loads(native.NATIVE_TOOLS[2][2]({"arguments": {"question": "Fixture?", "rounds": 1}}))
                self.assertTrue(result["ok"])
                self.assertEqual(calls[0][0], "/api/brain/native/think")
                self.assertEqual(calls[0][2], {"partitionKey": "fixture-a", "arguments": {"question": "Fixture?", "rounds": 1}})
                self.assertEqual(calls[0][1]["Authorization"], "Bearer fixture-token")
                self.assertEqual(json.loads(native._call({"operation": "remember", "arguments": {"fact": "x"}}))["error"], "idempotency_key_required")
                self.assertEqual(len(calls), 1)
                self.assertEqual(json.loads(native._call({"operation": "recall", "arguments": {"redirect": True}}))["error"], "redirect_rejected")
                self.assertEqual(len(calls), 2)
        finally:
            server.shutdown()
            server.server_close()
            thread.join()
