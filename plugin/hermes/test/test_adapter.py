import importlib.util
import json
import os
from pathlib import Path
import subprocess
import tempfile
import unittest
from unittest.mock import patch


ROOT = Path(__file__).parents[3]
TOOLS_PATH = ROOT / "plugin" / "hermes" / "remote-plugin" / "knowledge" / "tools.py"
SPEC = importlib.util.spec_from_file_location("knowledge_tools", TOOLS_PATH)
assert SPEC and SPEC.loader
tools = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(tools)


class KnowledgeHermesAdapterTest(unittest.TestCase):
    def test_adapter_discovers_installed_remote_connection_without_environment(self):
        with tempfile.TemporaryDirectory() as directory:
            connection = Path(directory) / "runtime-connection.json"
            connection.write_text(
                json.dumps(
                    {
                        "schemaVersion": "doppelganger.remote-program-connection/v1",
                        "unitId": "knowledge",
                        "baseUrl": "http://127.0.0.1:5310",
                        "healthPath": "/healthz",
                    }
                ),
                encoding="utf-8",
            )
            with patch.dict(os.environ, {"KNOWLEDGE_BASE_URL": ""}, clear=False), patch.object(
                tools, "RUNTIME_CONNECTION_PATH", connection
            ):
                self.assertEqual(tools._base_url(), "http://127.0.0.1:5310")

            connection.write_text(
                json.dumps(
                    {
                        "schemaVersion": "doppelganger.remote-program-connection/v1",
                        "unitId": "knowledge",
                        "baseUrl": "https://knowledge.example.test:5310",
                    }
                ),
                encoding="utf-8",
            )
            with patch.dict(os.environ, {"KNOWLEDGE_BASE_URL": ""}, clear=False), patch.object(
                tools, "RUNTIME_CONNECTION_PATH", connection
            ):
                self.assertIsNone(tools._base_url())

    def test_ingest_run_is_governed_and_calls_the_real_program_route(self):
        calls = []

        def request(method, url, body=None, **_kwargs):
            calls.append((method, url, body))
            return {"ok": True, "created": 1}

        with patch.dict(os.environ, {"KNOWLEDGE_BASE_URL": "http://127.0.0.1:4311"}, clear=False), patch.object(
            tools, "_rules_gate", return_value=None
        ), patch.object(tools, "_request_url", side_effect=request):
            result = json.loads(tools._make_handler("knowledge_ingest_run", tools.CONTRACTS["knowledge_ingest_run"])(
                {"companyId": "acme", "collectionId": "source-docs"}
            ))

        self.assertEqual(result, {"ok": True, "created": 1})
        self.assertEqual(
            calls,
            [("POST", "http://127.0.0.1:4311/api/companies/acme/knowledge/ingest-runs", {"collectionId": "source-docs", "actor": {"kind": "agent", "id": "doppelganger-agent"}})],
        )

    def test_installer_uses_hermes_home_for_plugin_and_config(self):
        installer = ROOT / "plugin" / "hermes" / "install-remote-hermes-plugin.sh"
        with tempfile.TemporaryDirectory() as directory:
            home = Path(directory) / "hermes-home"
            environment = dict(os.environ, HERMES_HOME=str(home))
            completed = subprocess.run([str(installer)], check=True, capture_output=True, text=True, env=environment)
            self.assertIn(f"{home}/plugins/knowledge", completed.stdout)
            self.assertTrue((home / "plugins" / "knowledge" / "plugin.yaml").is_file())
            self.assertIn("- knowledge", (home / "config.yaml").read_text(encoding="utf-8"))
            self.assertFalse((home / "plugins" / "knowledge" / "runtime-connection.json").exists())

    def test_installer_registers_remote_program_and_retires_legacy_webview(self):
        installer = ROOT / "plugin" / "hermes" / "install-remote-hermes-plugin.sh"
        with tempfile.TemporaryDirectory() as directory:
            home = Path(directory) / "hermes-home"
            registry_file = home / "doppelganger" / "registry.json"
            registry_file.parent.mkdir(parents=True)
            registry_file.write_text(
                json.dumps(
                    {
                        "units": [{"unitId": "knowledge", "enabled": True, "deployment": {"localProgram": {"command": "obsolete"}}}],
                        "contributions": [
                            {"id": "knowledge.workspace", "unitId": "knowledge", "renderer": {"kind": "webview"}},
                            {"id": "other.surface", "unitId": "other"},
                        ],
                    }
                ),
                encoding="utf-8",
            )
            environment = dict(os.environ, HERMES_HOME=str(home))
            subprocess.run(
                [str(installer), "--program-base-url", "http://127.0.0.1:5310"],
                check=True,
                capture_output=True,
                text=True,
                env=environment,
            )

            connection = json.loads((home / "plugins" / "knowledge" / "runtime-connection.json").read_text(encoding="utf-8"))
            self.assertEqual(connection["baseUrl"], "http://127.0.0.1:5310")
            registry = json.loads(registry_file.read_text(encoding="utf-8"))
            unit = next(unit for unit in registry["units"] if unit["unitId"] == "knowledge")
            self.assertTrue(unit["enabled"])
            self.assertEqual(
                unit["deployment"],
                {"baseUrl": "http://127.0.0.1:5310", "healthPath": "/healthz", "programBaseUrlEnv": "KNOWLEDGE_BASE_URL"},
            )
            self.assertNotIn("localProgram", unit["deployment"])
            self.assertEqual(
                [entry["id"] for entry in registry["contributions"]],
                ["other.surface"],
            )

    def test_brain_recall_supports_native_fact_filters_without_forcing_search(self):
        tool_schema = next(schema for name, schema, _handler in tools.TOOLS if name == "brain_recall")

        self.assertEqual(tool_schema["parameters"]["required"], ["scopeRef"])
        for field in ["entity", "sessionId", "since", "supersessions", "includeExpired", "includePending", "budgetTokens", "grep"]:
            self.assertIn(field, tool_schema["parameters"]["properties"])
        self.assertFalse(tool_schema["parameters"]["additionalProperties"])
        self.assertEqual(
            tool_schema["parameters"]["properties"]["purpose"]["enum"],
            ["task", "thread", "entity", "general"],
        )
        self.assertIn("stable scopeRef", tool_schema["description"])

    def test_zero_argument_gets_never_send_a_body(self):
        calls = []

        def request(method, url, body=None, **_kwargs):
            calls.append((method, url, body))
            return {"ok": True}

        with patch.object(tools, "_base_url", return_value="http://127.0.0.1:9999"), patch.object(
            tools, "_request_url", side_effect=request
        ):
            tools._make_handler("knowledge_health", tools.CONTRACTS["knowledge_health"])({})
            tools._make_handler("knowledge_status", tools.CONTRACTS["knowledge_status"])({})

        self.assertEqual(calls[0], ("GET", "http://127.0.0.1:9999/healthz", None))
        self.assertEqual(calls[1], ("GET", "http://127.0.0.1:9999/api/status", None))

    def test_notebook_list_uses_company_scoped_program_route(self):
        calls = []

        def request(method, url, body=None, **_kwargs):
            calls.append((method, url, body))
            return {"ok": True}

        with patch.object(tools, "_base_url", return_value="http://127.0.0.1:9999"), patch.object(
            tools, "_rules_gate", return_value=None
        ), patch.object(tools, "_request_url", side_effect=request):
            result = json.loads(tools._make_handler(
                "knowledge_research_notebooks_list",
                tools.CONTRACTS["knowledge_research_notebooks_list"],
            )({"companyId": "safe/company"}))

        self.assertTrue(result["ok"])
        self.assertEqual(
            calls,
            [("GET", "http://127.0.0.1:9999/api/companies/safe%2Fcompany/research/notebooks", None)],
        )

    def test_owned_notebook_declarations_match_company_scoped_program_route(self):
        plugin_yaml = (ROOT / "plugin" / "hermes" / "plugin.yaml").read_text(encoding="utf-8")
        self.assertIn(
            "path: /api/companies/:companyId/research/notebooks",
            plugin_yaml,
        )
    def test_tool_schemas_expose_crud_and_brain_required_fields(self):
        schemas = {name: schema["parameters"] for name, schema, _handler in tools.TOOLS}

        self.assertEqual(schemas["knowledge_health"]["additionalProperties"], False)
        self.assertEqual(schemas["knowledge_docs_collections_create"]["required"], ["companyId", "name"])
        self.assertEqual(schemas["knowledge_docs_create"]["required"], ["collectionId", "title"])
        self.assertEqual(schemas["knowledge_docs_read"]["required"], ["documentId"])
        self.assertEqual(schemas["knowledge_bindings_remove"]["required"], ["bindingId"])
        self.assertEqual(schemas["brain_entity_profile"]["required"], ["slug"])
        self.assertEqual(schemas["brain_graph_traverse"]["required"], ["slug"])


if __name__ == "__main__":
    unittest.main()
