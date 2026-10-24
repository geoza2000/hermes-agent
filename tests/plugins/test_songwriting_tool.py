"""The real plugin loader registers one optional tool, restricted to caller context."""
import json
from pathlib import Path
import shutil

from hermes_constants import get_hermes_home
from hermes_state import SessionDB


ROOT = Path(__file__).resolve().parents[2]


def test_discovery_registers_usable_session_bound_tool_and_skill():
    from hermes_cli.plugins import PluginManager
    from tools.registry import registry

    home = get_hermes_home()
    shutil.copytree(ROOT / "plugins/songwriting", home / "plugins/songwriting", ignore=shutil.ignore_patterns("__pycache__"))
    (home / "config.yaml").write_text("plugins:\n  enabled: [songwriting]\n")
    db = SessionDB()
    db.create_session("tool-song", source="desktop")
    db.create_session("other-song", source="desktop")
    db.close()
    manager = PluginManager()
    manager.discover_and_load()
    assert "songwriting" in manager._plugins, "native manifest must be discoverable"
    loaded = manager._plugins["songwriting"]
    assert loaded.enabled and not loaded.error, loaded.error
    entry = registry.get_entry("songwriting", scope=manager.scope_key)
    assert entry is not None
    skill = manager._plugin_skills["songwriting:in-chat-songwriting"]
    assert skill["path"].is_file()
    assert "::songwriting" in skill["path"].read_text()
    handler = entry.handler
    missing = json.loads(handler({"action": "read"}))
    assert missing["status"] == 403
    forged = json.loads(handler({"action": "read", "session_id": "other-song"}, session_id="tool-song"))
    assert forged["status"] == 422
    read = json.loads(handler({"action": "read"}, session_id="tool-song", task_id="task-a"))
    assert read["project"]["id"] == "tool-song"
    track = {"id": "melody", "name": "Melody", "kind": "midi", "origin": "generated", "protected": False,
             "instrument": "lead", "notes": [{"startMs": 0, "durationMs": 250, "note": 69, "velocity": 90}]}
    proposed = json.loads(handler({"action": "propose", "baseRevision": 0, "brief": "A short instrumental", "tracks": [track]}, session_id="tool-song"))
    assert proposed["project"]["tracks"] == []
    assert proposed["proposal"]["tracks"][0]["id"] == "melody"
    # Applying is a human UI action, never an agent tool action.
    assert json.loads(handler({"action": "apply", "proposalId": proposed["proposal"]["id"]}, session_id="tool-song"))["status"] == 422
    other = json.loads(handler({"action": "read"}, session_id="other-song"))
    assert other["project"]["revision"] == 0 and "proposal" not in other["project"]


def test_tool_reads_actual_midi_capture_and_exports_only_its_own_project():
    from plugins.songwriting.models import MidiTake, ProposalRequest, ApplyRequest
    from plugins.songwriting.storage import SongStore
    from plugins.songwriting import revisions
    from plugins.songwriting.tool import handle

    db = SessionDB()
    db.create_session("tool-source", source="desktop")
    db.close()
    store = SongStore("tool-source")
    take = {"schema": 1, "kind": "midi", "durationMs": 300,
            "device": {"id": "hardware", "name": "Actual pads", "manufacturer": "Local"},
            "events": [{"timeMs": 5, "data": [153, 36, 117]}, {"timeMs": 250, "data": [137, 36, 0]}]}
    result = store.capture_midi(MidiTake.model_validate(take))
    assert result["project"]["tracks"][0]["instrument"] == "drums"
    capture_id = result["project"]["captures"][0]["id"]
    read = json.loads(handle({"action": "read_capture", "captureId": capture_id}, session_id="tool-source"))
    assert read["take"] == take and read["capture"]["path"] == result["capturePath"]
    bad = json.loads(handle({"action": "read_capture", "captureId": "../../secret"}, session_id="tool-source"))
    assert bad["status"] == 400
    proposal = revisions.propose(store, ProposalRequest(baseRevision=1, brief="Add piano", tracks=[
        {"id": "piano", "name": "piano", "kind": "midi", "origin": "generated", "protected": False,
         "notes": [{"startMs": 0, "durationMs": 300, "note": 60, "velocity": 80}]}]))["proposal"]
    revisions.apply(store, ApplyRequest(baseRevision=1, proposalId=proposal["id"]))
    rendered = json.loads(handle({"action": "export"}, session_id="tool-source"))
    assert Path(rendered["path"]).is_file() and rendered["mime"] == "audio/wav"
    store.db_path.write_bytes(b"bad database")
    failed = json.loads(handle({"action": "read"}, session_id="tool-source"))
    assert failed["status"] == 503 and str(store.db_path) not in failed["error"]


def test_tool_write_storage_failure_is_static_json_and_does_not_save_proposal(monkeypatch):
    import sqlite3
    from plugins.songwriting import storage
    from plugins.songwriting.tool import handle

    db = SessionDB()
    db.create_session("tool-write-failure", source="desktop")
    db.close()
    store = storage.SongStore("tool-write-failure")
    before = store.read()
    connect = storage.connect_tracked

    class FailedCommit(sqlite3.Connection):
        def commit(self):
            raise sqlite3.OperationalError(f"PRIVATE failure at {store.db_path}")

    def failing_connect(*args, **kwargs):
        if not kwargs.get("uri"):
            kwargs["factory"] = FailedCommit
        return connect(*args, **kwargs)

    monkeypatch.setattr(storage, "connect_tracked", failing_connect)
    track = {"id": "lead", "name": "Lead", "kind": "midi", "origin": "generated", "protected": False,
             "instrument": "lead", "notes": [{"startMs": 0, "durationMs": 250, "note": 69, "velocity": 90}]}
    result = json.loads(handle({"action": "propose", "baseRevision": 0, "brief": "A local part", "tracks": [track]},
                               session_id="tool-write-failure"))
    assert result == {"error": "Songwriting storage is unavailable", "status": 503}
    assert store.read() == before
