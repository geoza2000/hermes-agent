"""Session-scoped songwriting lanes over REST; every recording stays inside the test home."""
import base64
import importlib.util
import json
import sys
from pathlib import Path

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from hermes_constants import get_hermes_home
from hermes_state import SessionDB

PREFIX = "/api/plugins/songwriting/sessions/song-session"
TAKE = {
    "schema": 1, "kind": "midi",
    "device": {"id": "keys-1", "name": "Test keys", "manufacturer": "Local"},
    "durationMs": 600,
    "events": [
        {"timeMs": 0, "data": [144, 60, 100]},
        {"timeMs": 100, "data": [176, 64, 127]},
        {"timeMs": 300, "data": [128, 60, 32]},
        {"timeMs": 500, "data": [176, 64, 0]},
    ],
}
BASS = {"program": 33, "drums": False}
TRUMPET = {"program": 56, "drums": False}
NOTE = {"startMs": 0, "durationMs": 400, "note": 40, "velocity": 80}


def load_router():
    path = Path(__file__).resolve().parents[2] / "plugins/songwriting/dashboard/plugin_api.py"
    spec = importlib.util.spec_from_file_location("songwriting_dashboard_test", path)
    assert spec is not None and spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    sys.modules[spec.name] = module
    spec.loader.exec_module(module)
    return module.router


@pytest.fixture
def client():
    db = SessionDB()
    db.create_session("song-session", source="desktop")
    db.close()
    app = FastAPI()
    app.include_router(load_router(), prefix="/api/plugins/songwriting")
    return TestClient(app)


def add_lane(client, name="Bass", instrument=BASS, source="midi", prefix=PREFIX):
    response = client.post(prefix + "/lanes", json={"name": name, "instrument": instrument, "source": source})
    assert response.status_code == 200, response.text
    return response.json()["lane"]


def record(client, lane, take=TAKE, start=0):
    return client.post(f"{PREFIX}/lanes/{lane['id']}/midi", json={"take": take, "startMs": start})


def hum(client, lane, notes=None, data=b"RIFF fake webm bytes", mime="audio/webm;codecs=opus"):
    return client.post(f"{PREFIX}/lanes/{lane['id']}/audio", json={
        "name": "Voice", "mime": mime, "data": base64.b64encode(data).decode(), "durationMs": 1200,
        "startMs": 500, "notes": notes if notes is not None else [{**NOTE, "note": 64}]})


def propose(changes, brief="Busier bass"):
    from plugins.songwriting.tool import handle
    return json.loads(handle({"action": "propose", "brief": brief, "changes": changes}, session_id="song-session"))


def test_empty_song_is_read_only_and_a_take_lands_on_its_lane_immutably(client):
    root = get_hermes_home() / "plugin-data/songwriting/sessions"
    project = client.get(PREFIX + "/project").json()
    assert project["schema"] == 2 and project["lanes"] == [] and project["revision"] == 0
    assert not root.exists()
    lane = add_lane(client)
    assert lane["instrument"] == BASS and lane["notes"] == []
    result = record(client, lane, start=2000).json()
    assert json.loads(Path(result["capturePath"]).read_text()) == TAKE
    [saved] = result["project"]["lanes"]
    assert saved["notes"] == [{"startMs": 2000, "durationMs": 500, "note": 60, "velocity": 100}]
    assert result["project"]["selectedLaneId"] == lane["id"]
    before = Path(result["capturePath"]).read_bytes()
    second = record(client, lane).json()
    assert second["capturePath"] != result["capturePath"]
    assert Path(result["capturePath"]).read_bytes() == before
    assert len(second["project"]["captures"]) == 2


def test_drum_pads_play_whatever_instrument_the_lane_has(client):
    # An electronic kit's real pattern: note-on then velocity-0 note-on in the same instant,
    # on channel 10, between MIDI clock ticks.
    events = []
    for time, pad in ((83, 38), (504, 38), (1562, 48), (2137, 45)):
        events += [{"timeMs": time - 1, "data": [0xF8]}, {"timeMs": time, "data": [0x99, pad, 30]},
                   {"timeMs": time, "data": [0x99, pad, 0]}]
    kit = {**TAKE, "device": {"id": "kit", "name": "Alesis Nitro Max", "manufacturer": "Alesis"},
           "durationMs": 3000, "events": events}
    lane = add_lane(client)
    [saved] = record(client, lane, take=kit).json()["project"]["lanes"]
    assert [(note["startMs"], note["note"], note["durationMs"]) for note in saved["notes"]] == [
        (83, 38, 100), (504, 38, 100), (1562, 48, 100), (2137, 45, 100)]
    # Any device plays any instrument: drum pads recorded onto a bass lane stay a bass part.
    assert saved["instrument"] == BASS


def test_hummed_voice_plays_as_its_instrument_and_keeps_the_recording(client):
    lane = add_lane(client, "Trumpet", TRUMPET, "voice")
    result = hum(client, lane).json()
    [saved] = result["project"]["lanes"]
    assert saved["play"] == "notes" and saved["notes"][0]["startMs"] == 500
    assert saved["audio"]["startMs"] == 500 and saved["audio"]["durationMs"] == 1200
    assert Path(result["capturePath"]).read_bytes() == b"RIFF fake webm bytes"
    chunk = client.get(f"{PREFIX}/captures/{saved['audio']['captureId']}/chunks/0").json()
    assert base64.b64decode(chunk["data"]) == b"RIFF fake webm bytes" and chunk["chunks"] == 1
    back = client.post(f"{PREFIX}/lanes/{lane['id']}", json={"play": "audio"})
    assert back.json()["lanes"][0]["play"] == "audio"
    plain = add_lane(client, "Room", TRUMPET, "audio")
    assert hum(client, plain, notes=[]).json()["project"]["lanes"][1]["play"] == "audio"


def test_mixer_changes_are_not_undo_history_but_content_changes_are(client):
    lane = add_lane(client)
    record(client, lane)
    client.post(f"{PREFIX}/lanes/{lane['id']}", json={"muted": True, "volume": 0.3})
    client.post(f"{PREFIX}/lanes/{lane['id']}", json={"instrument": TRUMPET})
    undone = client.post(PREFIX + "/undo").json()
    assert undone["lanes"][0]["instrument"] == BASS
    assert undone["lanes"][0]["muted"] is True and undone["lanes"][0]["volume"] == 0.3
    assert client.post(PREFIX + "/undo").json()["lanes"][0]["notes"] == []
    assert client.post(PREFIX + "/undo").json()["lanes"] == []
    assert client.post(PREFIX + "/undo").status_code == 409


def test_suggestions_preview_then_keep_with_undo_and_stale_lanes_refuse(client):
    lane = add_lane(client)
    record(client, lane)
    original = client.get(PREFIX + "/project").json()
    pending = propose([{"laneId": lane["id"], "notes": [NOTE, {**NOTE, "startMs": 400}]},
                       {"laneId": "hermes_pad", "name": "Pad", "instrument": {"program": 89}, "notes": [NOTE]}])
    assert client.get(PREFIX + "/project").json()["lanes"] == original["lanes"]
    kept = client.post(PREFIX + "/apply", json={"proposalId": pending["proposal"]["id"]}).json()
    assert [len(item["notes"]) for item in kept["lanes"]] == [2, 1] and "proposal" not in kept
    assert kept["lanes"][1]["source"] == "hermes"
    assert client.post(PREFIX + "/undo").json()["lanes"] == original["lanes"]
    stale = propose([{"laneId": lane["id"], "notes": [NOTE]}])
    record(client, lane, start=1000)
    response = client.post(PREFIX + "/apply", json={"proposalId": stale["proposal"]["id"]})
    assert response.status_code == 409


def test_unrelated_lane_edits_do_not_invalidate_a_suggestion(client):
    bass, other = add_lane(client), add_lane(client, "Keys", {"program": 0})
    pending = propose([{"laneId": bass["id"], "notes": [NOTE]}])
    record(client, other)
    client.post(f"{PREFIX}/lanes/{bass['id']}", json={"solo": True})
    assert client.post(PREFIX + "/apply", json={"proposalId": pending["proposal"]["id"]}).status_code == 200


def test_suggestions_are_bounded_and_cannot_invent_or_remove_missing_lanes(client):
    assert propose([{"laneId": "ghost", "remove": True}])["status"] == 400
    assert propose([{"laneId": "ghost", "notes": [NOTE]}])["status"] == 400
    assert propose([{"laneId": "x", "remove": True, "notes": [NOTE]}])["status"] == 422
    for index in range(16):
        add_lane(client, f"Lane {index}")
    assert client.post(PREFIX + "/lanes", json={"name": "17", "instrument": BASS, "source": "midi"}).status_code == 400
    assert propose([{"laneId": "extra", "instrument": BASS, "notes": [NOTE]}])["status"] == 400


def test_concurrent_keep_has_exactly_one_winner(client):
    from concurrent.futures import ThreadPoolExecutor
    lane = add_lane(client)
    pending = propose([{"laneId": lane["id"], "notes": [NOTE]}])["proposal"]
    with ThreadPoolExecutor(max_workers=2) as executor:
        codes = list(executor.map(lambda _: client.post(PREFIX + "/apply", json={"proposalId": pending["id"]}).status_code, range(2)))
    assert sorted(codes) == [200, 409]


def test_audio_takes_reject_bad_payloads_without_mutating(client):
    lane = add_lane(client, "Voice", TRUMPET, "voice")
    before = client.get(PREFIX + "/project").json()
    for body in ({"mime": "audio/webm", "data": "not base64"}, {"mime": "text/html", "data": "AAAA"}):
        payload = {"name": "x", "durationMs": 10, **body}
        assert client.post(f"{PREFIX}/lanes/{lane['id']}/audio", json=payload).status_code == 400
    response = client.post(f"{PREFIX}/lanes/{lane['id']}/audio", json={
        "name": "x", "mime": "audio/webm", "data": "PRIVATE_AUDIO_PAYLOAD", "durationMs": 10, "extra": 1})
    assert response.status_code == 422 and "PRIVATE_AUDIO_PAYLOAD" not in response.text
    assert client.get(PREFIX + "/project").json() == before


def test_session_lookup_is_exact_and_profile_local(client, tmp_path):
    from hermes_constants import reset_hermes_home_override, set_hermes_home_override
    assert client.get(PREFIX.replace("song-session", "song") + "/project").status_code == 404
    unknown = PREFIX.replace("song-session", "unknown")
    assert client.post(unknown + "/lanes", json={"name": "B", "instrument": BASS, "source": "midi"}).status_code == 404
    lane = add_lane(client)
    record(client, lane)
    saved = client.get(PREFIX + "/project").json()
    other_home = tmp_path / "other-profile"
    other_home.mkdir()
    token = set_hermes_home_override(other_home)
    try:
        db = SessionDB(db_path=other_home / "state.db")
        db.create_session("song-session", source="desktop")
        db.close()
        assert client.get(PREFIX + "/project").json()["lanes"] == []
        assert not (other_home / "plugin-data/songwriting/sessions").exists()
    finally:
        reset_hermes_home_override(token)
    assert client.get(PREFIX + "/project").json() == saved


@pytest.mark.platforms("posix")
def test_symlinked_storage_and_recordings_fail_closed(client, tmp_path):
    lane = add_lane(client)
    root = get_hermes_home() / "plugin-data/songwriting/sessions"
    outside = tmp_path / "outside"
    outside.mkdir()
    real = root / "song-session"
    real.rename(tmp_path / "moved")
    real.symlink_to(outside, target_is_directory=True)
    assert record(client, lane).status_code in (400, 404)
    assert list(outside.iterdir()) == []
    real.unlink()
    (tmp_path / "moved").rename(real)
    result = hum(client, lane).json()
    capture = result["project"]["captures"][0]
    path = Path(capture["path"])
    path.unlink()
    secret = outside / "secret.webm"
    secret.write_bytes(b"SECRET_BYTES")
    path.symlink_to(secret)
    response = client.get(f"{PREFIX}/captures/{capture['id']}/chunks/0")
    assert response.status_code == 400 and "SECRET" not in response.text and str(secret) not in response.text


def test_request_bodies_are_bounded_before_validation(client):
    response = client.post(PREFIX + "/lanes", content=b"{}",
                           headers={"Content-Length": "999999999", "Content-Type": "application/json"})
    assert response.status_code == 400, response.text
    # Chunked requests cannot bypass the bound by omitting Content-Length.
    response = client.post(PREFIX + "/settings", content=iter([b" " * (1024 * 1024)] * 5),
                           headers={"Content-Type": "application/json"})
    assert response.status_code == 400, response.text


def test_compression_continuation_keeps_durable_song_but_fork_does_not(client):
    add_lane(client)
    original = client.get(PREFIX + "/project").json()
    db = SessionDB()
    db.end_session("song-session", end_reason="compression")
    db.create_session("continuation", source="desktop", parent_session_id="song-session")
    db.create_session("fork", source="desktop", parent_session_id="continuation")
    db.create_session("marked-fork", source="desktop", parent_session_id="song-session",
                      model_config={"_branched_from": "song-session"})
    db.close()
    assert client.get(PREFIX.replace("song-session", "continuation") + "/project").json() == original
    for fork in ("fork", "marked-fork"):
        project = client.get(PREFIX.replace("song-session", fork) + "/project").json()
        assert project["lanes"] == [] and project["id"] == fork


def test_corrupt_song_store_is_reported_without_internal_paths(client):
    lane = add_lane(client)
    db_path = Path(record(client, lane).json()["capturePath"]).parent / "project.sqlite"
    db_path.write_bytes(b"not a sqlite database")
    response = client.get(PREFIX + "/project")
    assert response.status_code == 503, response.text
    assert str(db_path) not in response.text and "sqlite" not in response.text.lower()


def test_schema_one_songs_open_as_lanes_without_touching_sources(client):
    from plugins.songwriting.storage import SongStore
    store = SongStore("song-session")
    with store.transaction() as (_, project):
        project.clear()
        project.update({"schema": 1, "id": "song-session", "title": "Old", "revision": 3, "brief": "", "captures": [],
                        "tracks": [{"id": "capture_a", "name": "Keys", "kind": "midi", "origin": "recorded",
                                    "protected": True, "instrument": "drums", "notes": [NOTE]}]})
    project = client.get(PREFIX + "/project").json()
    assert project["schema"] == 2 and project["revision"] == 3
    assert project["lanes"][0]["instrument"] == {"program": 0, "drums": True}
    assert project["lanes"][0]["notes"] == [NOTE]


def test_a_pending_schema_one_arrangement_survives_as_a_suggestion_to_keep(client):
    from plugins.songwriting.storage import SongStore
    bass = {"id": "bass", "name": "Bass", "kind": "midi", "origin": "generated", "protected": False,
            "instrument": "bass", "notes": [NOTE]}
    with SongStore("song-session").transaction() as (_, project):
        project.clear()
        project.update({"schema": 1, "id": "song-session", "title": "Old", "revision": 0, "brief": "", "tracks": [],
                        "captures": [], "proposal": {"id": "a" * 32, "baseRevision": 0, "brief": "Indie rock",
                                                     "tracks": [bass]}})
    project = client.get(PREFIX + "/project").json()
    assert project["lanes"] == [] and project["proposal"]["brief"] == "Indie rock"
    assert project["proposal"]["changes"] == [{"laneId": "bass", "name": "Bass",
                                                "instrument": {"program": 33, "drums": False}, "notes": [NOTE]}]
    kept = client.post(PREFIX + "/apply", json={"proposalId": "a" * 32}).json()
    assert [lane["name"] for lane in kept["lanes"]] == ["Bass"] and "proposal" not in kept


def test_native_dashboard_discovery_mounts_api_without_a_new_page(tmp_path):
    import shutil
    from hermes_cli.web_server_dashboard import _discover_dashboard_plugins, _mount_one_plugin_api
    home = get_hermes_home()
    plugin_root = home / "plugins"
    source = Path(__file__).resolve().parents[2] / "plugins/songwriting"
    shutil.copytree(source, plugin_root / "songwriting", ignore=shutil.ignore_patterns("__pycache__"))
    (home / "config.yaml").write_text("plugins:\n  enabled: [songwriting]\n")
    db = SessionDB()
    db.create_session("song-session", source="desktop")
    db.close()
    discovered = _discover_dashboard_plugins([(plugin_root, "user")])
    manifest = next(plugin for plugin in discovered if plugin["name"] == "songwriting")
    assert manifest["tab"]["hidden"] and manifest["has_api"]
    app = FastAPI()
    assert _mount_one_plugin_api(app, manifest, {"songwriting"}, set())
    response = TestClient(app).get(PREFIX + "/project")
    assert response.status_code == 200, response.text
    assert response.json()["lanes"] == []
