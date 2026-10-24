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
    lane = json.loads(handler({"action": "add_lane", "name": "Bass", "instrument": {"program": 33},
                                "source": "midi"}, session_id="tool-song"))["lane"]
    assert lane["instrument"] == {"program": 33, "drums": False}
    cello = json.loads(handler({"action": "set_lane", "laneId": lane["id"], "instrument": {"program": 42}},
                               session_id="tool-song"))
    assert cello["lanes"][0]["instrument"]["program"] == 42
    notes = [{"startMs": 0, "durationMs": 250, "note": 40, "velocity": 90}]
    proposed = json.loads(handler({"action": "propose", "brief": "A bass line",
                                   "changes": [{"laneId": lane["id"], "notes": notes}]}, session_id="tool-song"))
    assert proposed["project"]["lanes"][0]["notes"] == []
    assert proposed["proposal"]["changes"][0]["notes"] == notes
    # Keeping a suggestion is the listener's action in the pane, never an agent tool action.
    kept = json.loads(handler({"action": "apply", "proposalId": proposed["proposal"]["id"]}, session_id="tool-song"))
    assert kept["status"] == 422
    other = json.loads(handler({"action": "read"}, session_id="other-song"))
    assert other["project"]["lanes"] == [] and "proposal" not in other["project"]


def test_tool_reads_the_actual_take_and_fails_closed():
    from plugins.songwriting import lanes
    from plugins.songwriting.models import AddLaneRequest, Instrument, MidiTake, MidiTakeRequest
    from plugins.songwriting.storage import SongStore
    from plugins.songwriting.tool import handle

    db = SessionDB()
    db.create_session("tool-source", source="desktop")
    db.close()
    store = SongStore("tool-source")
    lane = lanes.add_lane(store, AddLaneRequest(name="Drums", instrument=Instrument(program=0, drums=True),
                                                source="midi"))["lane"]
    take = {"schema": 1, "kind": "midi", "durationMs": 300,
            "device": {"id": "hardware", "name": "Actual pads", "manufacturer": "Local"},
            "events": [{"timeMs": 5, "data": [153, 36, 117]}, {"timeMs": 250, "data": [137, 36, 0]}]}
    result = lanes.record_midi(store, lane["id"], MidiTakeRequest(take=MidiTake.model_validate(take)))
    capture_id = result["project"]["captures"][0]["id"]
    read = json.loads(handle({"action": "read_capture", "captureId": capture_id}, session_id="tool-source"))
    assert read["take"] == take and read["capture"]["path"] == result["capturePath"]
    bad = json.loads(handle({"action": "read_capture", "captureId": "../../secret"}, session_id="tool-source"))
    assert bad["status"] == 404
    incomplete = json.loads(handle({"action": "add_lane", "name": "No instrument"}, session_id="tool-source"))
    assert incomplete["status"] == 422
    store.db_path.write_bytes(b"bad database")
    failed = json.loads(handle({"action": "read"}, session_id="tool-source"))
    assert failed["status"] == 503 and str(store.db_path) not in failed["error"]


def test_tool_write_storage_failure_is_static_json_and_does_not_save_proposal(monkeypatch):
    import sqlite3
    from plugins.songwriting import lanes, storage
    from plugins.songwriting.models import AddLaneRequest, Instrument
    from plugins.songwriting.tool import handle

    db = SessionDB()
    db.create_session("tool-write-failure", source="desktop")
    db.close()
    store = storage.SongStore("tool-write-failure")
    lane = lanes.add_lane(store, AddLaneRequest(name="Lead", instrument=Instrument(program=81), source="midi"))["lane"]
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
    notes = [{"startMs": 0, "durationMs": 250, "note": 69, "velocity": 90}]
    result = json.loads(handle({"action": "propose", "brief": "A local part",
                                "changes": [{"laneId": lane["id"], "notes": notes}]}, session_id="tool-write-failure"))
    assert result == {"error": "Songwriting storage is unavailable", "status": 503}
    assert store.read() == before
