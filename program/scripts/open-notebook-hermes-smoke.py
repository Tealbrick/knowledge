"""Exercise actual registered Hermes handlers against a disposable Knowledge HTTP app.

The parent owns all fixture data/processes. Input comes on stdin; credentials
are delivered only in the private subprocess environment. No model is external.
"""
import importlib.util
import json
import os
from pathlib import Path
import sys


def main():
    if os.environ.get("KNOWLEDGE_OPEN_NOTEBOOK_FIXTURE") != "disposable":
        raise RuntimeError("fixture_opt_in_required")
    fixture = json.load(sys.stdin)
    plugin_dir = Path(__file__).resolve().parents[2] / "plugin/hermes/remote-plugin/knowledge"
    name = "knowledge_native_hermes_fixture"
    spec = importlib.util.spec_from_file_location(name, plugin_dir / "__init__.py", submodule_search_locations=[str(plugin_dir)])
    plugin = importlib.util.module_from_spec(spec)
    sys.modules[name] = plugin
    spec.loader.exec_module(plugin)
    handlers = {}

    class Context:
        def register_tool(self, **item):
            handlers[item["name"]] = item["handler"]

    plugin.register(Context())
    discovered = json.loads(handlers["knowledge_research_notebooks_discover"]({}))
    assert discovered.get("ok") is True and discovered.get("status") == 200
    allowed = discovered["result"]["notebooks"]
    assert len(allowed) == 1 and allowed[0]["id"] == fixture["notebookId"]
    assert set(allowed[0]) == {"id", "name", "description"}
    assert discovered["result"]["pagination"] == {"limit": 50, "offset": 0, "hasMore": False}
    # Use the ID returned by the authenticated tool, not the test input.
    notebook = {"notebookId": allowed[0]["id"]}

    def call(suffix, args, status=200):
        result = json.loads(handlers["knowledge_research_" + suffix]({**notebook, **args}))
        if result.get("ok") is not True or result.get("status") != status:
            raise RuntimeError(f"handler_{suffix}_failed_{result.get('error', 'unknown')}_{result.get('status', 'none')}")
        return result["result"]

    call("engine_get", {})
    call("sources_list", {"limit": 10, "offset": 0})
    source = call("source_get", {"sourceId": fixture["sourceId"]})
    assert source["source"]["fullText"] == fixture["marker"]
    notes = call("notes_list", {})["notes"]
    assert len(notes) == 1 and notes[0]["id"] == fixture["noteId"] and notes[0]["content"] is None
    note_id = notes[0]["id"]
    saved_note = call("note_get", {"noteId": note_id})
    assert saved_note["note"]["id"] == note_id and saved_note["note"]["content"] == fixture["noteBody"]
    context = call("context_get", {})
    assert fixture["marker"] in json.dumps(context)
    receipt = call("write_receipt_get", {"idempotencyKey": fixture["writeReceiptKey"]})
    assert receipt["receipt"]["state"] == "succeeded"
    source_args = {"idempotencyKey": "hermes-source-fixture", "title": "Hermes synthetic source", "content": "Hermes fixture source content"}
    new_source = call("source_create", source_args, 201)
    assert call("source_create", source_args)["replayed"] is True
    created_receipt = call("write_receipt_get", {"idempotencyKey": source_args["idempotencyKey"]})
    assert created_receipt["receipt"]["sourceId"] == new_source["receipt"]["sourceId"]
    created_source = call("source_get", {"sourceId": new_source["receipt"]["sourceId"]})
    assert created_source["source"]["fullText"] == source_args["content"]
    session_args = {"idempotencyKey": "hermes-chat-fixture", "title": "Hermes synthetic chat"}
    chat = call("chat_create", session_args, 201)
    local_session = chat["receipt"]["sessionId"]
    assert call("chat_create", session_args)["replayed"] is True
    message_args = {"sessionId": local_session, "idempotencyKey": "hermes-message-fixture", "message": "Summarize my research."}
    answer = call("chat_send", message_args, 201)
    assert "KNOWLEDGE_FAKE_CHAT_OK" in answer["receipt"]["answer"]["content"]
    assert call("chat_send", message_args)["replayed"] is True
    assert len(call("chat_get", {"sessionId": local_session})["messages"]) == 2
    assert call("chat_receipt_get", {"idempotencyKey": "hermes-message-fixture"})["receipt"]["state"] == "succeeded"
    original = os.environ["KNOWLEDGE_RESEARCH_SERVICE_TOKEN"]
    os.environ["KNOWLEDGE_RESEARCH_SERVICE_TOKEN"] = os.environ["KNOWLEDGE_FIXTURE_SIBLING_TOKEN"]
    sibling = json.loads(handlers["knowledge_research_chat_get"]({**notebook, "sessionId": local_session}))
    assert sibling["ok"] is False and sibling["status"] == 404
    # Research evidence is shared within a company read grant; unlike chat
    # sessions, it is not private to the creating logical principal.
    assert call("note_get", {"noteId": note_id})["note"]["content"] == fixture["noteBody"]
    os.environ["KNOWLEDGE_RESEARCH_SERVICE_TOKEN"] = os.environ["KNOWLEDGE_FIXTURE_OTHER_COMPANY_TOKEN"]
    other_discovery = json.loads(handlers["knowledge_research_notebooks_discover"]({}))
    assert other_discovery["ok"] is True
    assert all(item["id"] != notebook["notebookId"] for item in other_discovery["result"]["notebooks"])
    foreign = json.loads(handlers["knowledge_research_context_get"](notebook))
    assert foreign["ok"] is False and foreign["status"] == 403
    foreign_note = json.loads(handlers["knowledge_research_note_get"]({**notebook, "noteId": note_id}))
    assert foreign_note["ok"] is False and foreign_note["status"] == 403
    assert len(other_discovery["result"]["notebooks"]) == 1
    foreign_membership = json.loads(handlers["knowledge_research_note_get"]({
        "notebookId": other_discovery["result"]["notebooks"][0]["id"], "noteId": note_id,
    }))
    assert foreign_membership["ok"] is False and foreign_membership["status"] == 502
    assert fixture["noteBody"] not in json.dumps(foreign_membership)
    os.environ["KNOWLEDGE_RESEARCH_SERVICE_TOKEN"] = original
    forged = json.loads(handlers["knowledge_research_chat_send"]({**notebook, **message_args, "context": {}}))
    assert forged["ok"] is False
    forged_discovery = json.loads(handlers["knowledge_research_notebooks_discover"]({"companyId": "other"}))
    assert forged_discovery["ok"] is False and forged_discovery["error"] == "invalid_arguments"
    research_names = {name for name in handlers if name.startswith("knowledge_research_")} - {"knowledge_research_notebooks_list"}
    forged_note = json.loads(handlers["knowledge_research_note_get"]({**notebook, "noteId": note_id, "companyId": "other"}))
    assert forged_note["ok"] is False and forged_note["error"] == "invalid_arguments"
    assert len(research_names) == 13
    print(json.dumps({"ok": True, "registeredResearchTools": len(research_names), "allThirteenInvoked": True,
                      "listedNoteIdUsed": True, "savedNoteBodyMatches": True, "sameCompanySharedNoteRead": True,
                      "crossCompanyNoteStatus": foreign_note["status"], "foreignNoteMembershipStatus": foreign_membership["status"],
                      "noteScopeOverrideRejected": True,
                      "discoveredNotebookUsed": True, "discoveryScopeOverrideRejected": True,
                      "crossCompanyDiscoveryIsolated": True, "createdSourceReadBack": True,
                      "sourceId": new_source["receipt"]["sourceId"], "successfulReplay": True,
                      "historyMessages": 2, "sameCompanyOtherPrincipalStatus": sibling["status"],
                      "crossCompanyStatus": foreign["status"], "callerContextRejected": True}))


try:
    main()
except Exception as error:
    # Only our bounded assertions identify failures. Never print credentials,
    # arbitrary upstream response bodies, tool arguments or a traceback.
    message = str(error) if isinstance(error, RuntimeError) and str(error).startswith("handler_") else "hermes_fixture_failed"
    print(json.dumps({"ok": False, "error": message}))
    sys.exit(1)
