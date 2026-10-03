"""Check installed plugin discovery, schemas and Research declaration parity."""
import importlib.util
import json
import os
from pathlib import Path
import re
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch

ROOT = Path(__file__).parents[3]
PLUGIN = ROOT / "plugin/hermes/remote-plugin/knowledge"


def load_plugin(plugin_dir=PLUGIN):
    name = "knowledge_registration_fixture"
    for key in list(sys.modules):
        if key == name or key.startswith(name + "."):
            del sys.modules[key]
    spec = importlib.util.spec_from_file_location(name, plugin_dir / "__init__.py", submodule_search_locations=[str(plugin_dir)])
    module = importlib.util.module_from_spec(spec)
    sys.modules[name] = module
    spec.loader.exec_module(module)
    return module


class ResearchRegistrationTest(unittest.TestCase):
    def test_fresh_installed_package_registers_and_rejects_missing_service_credential(self):
        with tempfile.TemporaryDirectory(prefix="knowledge-installed-research-") as directory:
            home = Path(directory) / "fixture-hermes"
            environment = {"PATH": os.environ["PATH"], "HERMES_HOME": str(home), "PYTHONDONTWRITEBYTECODE": "1"}
            subprocess.run([str(ROOT / "plugin/hermes/install-remote-hermes-plugin.sh"), "--program-base-url", "http://127.0.0.1:9"], env=environment, capture_output=True, check=True, timeout=10)
            installed = home / "plugins/knowledge"
            self.assertTrue((installed / "research_tools.py").is_file())
            plugin = load_plugin(installed)
            handlers = {}

            class Context:
                def register_tool(self, **item):
                    handlers[item["name"]] = item["handler"]

            plugin.register(Context())
            with patch.dict(os.environ, environment, clear=True):
                result = json.loads(handlers["knowledge_research_context_get"]({"notebookId": "local-notebook"}))
                discovery = json.loads(handlers["knowledge_research_notebooks_discover"]({}))
                note = json.loads(handlers["knowledge_research_note_get"]({"notebookId": "local-notebook", "noteId": "note:fixture"}))
            self.assertFalse(result["ok"])
            self.assertEqual(result["error"], "service_auth_unavailable")
            self.assertFalse(discovery["ok"])
            self.assertEqual(discovery["error"], "service_auth_unavailable")
            self.assertFalse(note["ok"])
            self.assertEqual(note["error"], "service_auth_unavailable")

    def test_plugin_registers_the_declared_research_tools_with_strict_schemas(self):
        plugin = load_plugin()
        registrations = []

        class Context:
            def register_tool(self, **kwargs):
                registrations.append(kwargs)

        plugin.register(Context())
        names = [item["name"] for item in registrations]
        self.assertEqual(len(names), len(set(names)))
        manifest = json.loads((ROOT / "manifest.json").read_text())
        self.assertEqual(set(names), set(manifest["plugin"]["tools"]))
        runtime = json.loads((PLUGIN / "remote-runtime.json").read_text())
        research = runtime["research"]["requiredTools"]
        self.assertEqual(len(research), 13)
        contracts = sys.modules[plugin.__name__ + ".research_tools"].RESEARCH_CONTRACTS
        self.assertEqual(set(research), set(contracts))
        declarations = (ROOT / "plugin/hermes/plugin.yaml").read_text().split("tool_contract:\n", 1)[1]
        for name, contract in contracts.items():
            block = re.search(r"^  " + re.escape(name) + r":\n((?:    .*\n)*)", declarations, re.MULTILINE)
            self.assertIsNotNone(block, name)
            self.assertIn(f"    method: {contract['method']}\n", block[1])
            self.assertIn(f"    path: {contract['path']}\n", block[1])
            self.assertIn("    auth_env: KNOWLEDGE_RESEARCH_SERVICE_TOKEN\n", block[1])
            for capability in contract["capabilities"]:
                self.assertIn(f'"{capability}"', block[1])
        for yaml_path in [PLUGIN / "plugin.yaml", ROOT / "plugin/hermes/plugin.yaml"]:
            text = yaml_path.read_text()
            for name in research:
                self.assertEqual(text.count(f"  - {name}\n"), 1)
        for item in registrations:
            if item["name"] not in research:
                continue
            schema = item["schema"]["parameters"]
            self.assertFalse(schema["additionalProperties"])
            if item["name"] == "knowledge_research_notebooks_discover":
                self.assertEqual(schema["required"], [])
                self.assertEqual(set(schema["properties"]), {"limit", "offset"})
            else:
                self.assertIn("notebookId", schema["required"])
            if item["name"] == "knowledge_research_note_get":
                self.assertEqual(set(schema["required"]), {"notebookId", "noteId"})
                self.assertEqual(set(schema["properties"]), {"notebookId", "noteId"})
            self.assertTrue(callable(item["handler"]))
            self.assertEqual(item["toolset"], "knowledge")
            self.assertFalse({"token", "context", "modelId", "companyId", "actor", "baseUrl"} & set(schema["properties"]))
        for name in ["knowledge_research_source_create", "knowledge_research_chat_create", "knowledge_research_chat_send"]:
            schema = next(item["schema"] for item in registrations if item["name"] == name)
            self.assertIn("idempotencyKey", schema["parameters"]["required"])


if __name__ == "__main__":
    unittest.main()
