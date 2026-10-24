"""Session-scoped songwriting REST behavior; all sources stay inside the test home."""
import importlib.util
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


def load_router():
    path = Path(__file__).resolve().parents[2] / "plugins/songwriting/dashboard/plugin_api.py"
    assert path.exists(), "songwriting API plugin must exist"
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


def test_empty_read_does_not_create_project_and_capture_is_immutable(client):
    root = get_hermes_home() / "plugin-data/songwriting"
    response = client.get(PREFIX + "/project")
    assert response.status_code == 200, response.text
    assert response.json() == {
        "schema": 1, "id": "song-session", "title": "Untitled song", "revision": 0,
        "brief": "", "tracks": [], "captures": [],
    }
    assert not root.exists()
    response = client.post(PREFIX + "/captures", json=TAKE)
    assert response.status_code == 200, response.text
    result = response.json()
    import json
    assert json.loads(Path(result["capturePath"]).read_text()) == TAKE
    track = result["project"]["tracks"][0]
    assert track["protected"] and track["origin"] == "recorded"
    assert track["notes"] == [{"startMs": 0, "durationMs": 500, "note": 60, "velocity": 100}]
    assert result["project"]["revision"] == 1
    assert client.get(PREFIX + "/project").json() == result["project"]
    before = Path(result["capturePath"]).read_bytes()
    second = client.post(PREFIX + "/captures", json=TAKE).json()
    assert second["capturePath"] != result["capturePath"]
    assert Path(result["capturePath"]).read_bytes() == before
    assert len(second["project"]["captures"]) == 2


def generated(track_id="bass", note=40):
    return {"id": track_id, "name": "Bass", "kind": "midi", "origin": "generated",
            "protected": False, "instrument": "bass",
            "notes": [{"startMs": 0, "durationMs": 400, "note": note, "velocity": 80}]}


def propose(client, tracks, revision, brief="Add a quiet bass part"):
    return client.post(PREFIX + "/proposal", json={"baseRevision": revision,
                       "brief": brief, "tracks": tracks})


def test_proposals_are_reviewed_revision_fenced_and_undoable(client):
    original = client.post(PREFIX + "/captures", json=TAKE).json()["project"]
    proposal = propose(client, [generated()], 1)
    assert proposal.status_code == 200, proposal.text
    pending = proposal.json()
    assert pending["project"]["tracks"] == original["tracks"]
    assert pending["proposal"]["baseRevision"] == 1
    assert client.get(PREFIX + "/project").json()["proposal"] == pending["proposal"]
    assert propose(client, [generated()], 0).status_code == 409
    applied = client.post(PREFIX + "/apply", json={"proposalId": pending["proposal"]["id"], "baseRevision": 1})
    assert applied.status_code == 200, applied.text
    project = applied.json()
    assert project["revision"] == 2 and len(project["tracks"]) == 2
    assert project["tracks"][0] == original["tracks"][0]
    assert "proposal" not in project
    assert client.post(PREFIX + "/apply", json={"proposalId": pending["proposal"]["id"], "baseRevision": 1}).status_code == 409
    pending2 = propose(client, [generated("lead", 72)], 2).json()["proposal"]
    assert client.post(PREFIX + "/reject", json={"proposalId": pending["proposal"]["id"]}).status_code == 409
    rejected = client.post(PREFIX + "/reject", json={"proposalId": pending2["id"]})
    assert rejected.status_code == 200 and "proposal" not in rejected.json()
    assert client.post(PREFIX + "/undo", json={"baseRevision": 1}).status_code == 409
    undone = client.post(PREFIX + "/undo", json={"baseRevision": 2})
    assert undone.status_code == 200, undone.text
    assert undone.json()["revision"] == 3
    assert undone.json()["tracks"] == original["tracks"]
    assert undone.json()["captures"] == original["captures"]


def test_named_generated_changes_keep_other_tracks_and_protect_sources(client):
    original = client.post(PREFIX + "/captures", json=TAKE).json()["project"]
    source = original["tracks"][0]
    attempted = dict(generated(), id=source["id"])
    assert propose(client, [attempted], 1).status_code == 400
    pending = propose(client, [generated(), generated("lead", 72)], 1).json()["proposal"]
    project = client.post(PREFIX + "/apply", json={"proposalId": pending["id"], "baseRevision": 1}).json()
    lead = project["tracks"][2]
    pending = propose(client, [generated(note=43)], 2).json()["proposal"]
    project = client.post(PREFIX + "/apply", json={"proposalId": pending["id"], "baseRevision": 2}).json()
    assert project["tracks"][0] == source and project["tracks"][2] == lead
    assert project["tracks"][1]["notes"][0]["note"] == 43
    assert propose(client, [generated(), generated()], 3).status_code == 400
    bad = dict(generated("unsafe"), kind="audio", path="/etc/passwd", notes=None)
    assert propose(client, [bad], 3).status_code == 400


def test_undo_never_loses_capture_added_after_apply(client):
    pending = propose(client, [generated()], 0).json()["proposal"]
    client.post(PREFIX + "/apply", json={"proposalId": pending["id"], "baseRevision": 0})
    recorded = client.post(PREFIX + "/captures", json=TAKE).json()["project"]
    undone = client.post(PREFIX + "/undo", json={"baseRevision": 2})
    assert undone.status_code == 200, undone.text
    assert undone.json()["captures"] == recorded["captures"]
    assert undone.json()["tracks"] == [recorded["tracks"][1]]


def wav_bytes(value=5000, frames=24000, rate=24000):
    from array import array
    import io
    import wave
    output = io.BytesIO()
    with wave.open(output, "wb") as wav:
        wav.setnchannels(1)
        wav.setsampwidth(2)
        wav.setframerate(rate)
        wav.writeframes(array("h", [value] * frames).tobytes())
    return output.getvalue()


def read_samples(path):
    from array import array
    import wave
    with wave.open(str(path), "rb") as wav:
        assert wav.getnchannels() == 1 and wav.getsampwidth() == 2
        return wav.getframerate(), array("h", wav.readframes(wav.getnframes()))


def test_real_audio_upload_and_single_mixed_wav_with_stems(client):
    import base64
    payload = wav_bytes()
    upload = client.post(PREFIX + "/audio", json={"name": "Microphone.wav", "mime": "audio/wav",
                                                  "data": base64.b64encode(payload).decode()})
    assert upload.status_code == 200, upload.text
    captured = upload.json()
    assert Path(captured["capturePath"]).read_bytes() == payload
    audio = captured["project"]["tracks"][0]
    assert audio["kind"] == "audio" and audio["protected"]
    assert audio["durationMs"] == 1000
    proposal = propose(client, [generated()], 1).json()["proposal"]
    client.post(PREFIX + "/apply", json={"proposalId": proposal["id"], "baseRevision": 1})
    stem = client.post(PREFIX + "/render", json={"trackIds": ["bass"]})
    assert stem.status_code == 200, stem.text
    assert stem.json()["mime"] == "audio/wav" and stem.json()["durationMs"] == 400
    rate, samples = read_samples(stem.json()["path"])
    assert rate == 24000 and max(samples) > 100 and min(samples) < -100
    original = client.post(PREFIX + "/render", json={"trackIds": [audio["id"]]}).json()
    _, audio_samples = read_samples(original["path"])
    assert list(audio_samples) == [5000] * 24000
    export = client.post(PREFIX + "/export", json={})
    assert export.status_code == 200, export.text
    mix = export.json()
    _, mixed = read_samples(mix["path"])
    assert mix["durationMs"] == 1000 and len(mixed) == 24000
    assert list(mixed[:len(samples)]) != list(samples)
    assert list(mixed[15000:]) == [5000] * 9000
    assert 5000 < max(mixed) < 32767
    assert client.post(PREFIX + "/render", json={"trackIds": ["absent"]}).status_code == 400
    assert client.post(PREFIX + "/render", json={"trackIds": []}).status_code == 400


def test_audio_rejects_invalid_and_overlong_uploads_without_mutating(client):
    import base64
    for data in ("not base64", base64.b64encode(b"not audio").decode()):
        response = client.post(PREFIX + "/audio", json={"name": "bad.wav", "mime": "audio/wav", "data": data})
        assert response.status_code == 400, response.text
    # A WAV header advertises a duration beyond the bounded decode budget.
    payload = wav_bytes(frames=301, rate=1)
    response = client.post(PREFIX + "/audio", json={"name": "long.wav", "mime": "audio/wav",
                                                   "data": base64.b64encode(payload).decode()})
    assert response.status_code == 400, response.text
    assert client.get(PREFIX + "/project").json()["revision"] == 0


def test_high_rate_single_frame_audio_is_rejected_before_publication(client, monkeypatch):
    import base64
    import os
    before = client.post(PREFIX + "/captures", json=TAKE).json()["project"]
    directory = Path(before["captures"][0]["path"]).parent
    files = {path.name for path in directory.iterdir() if path.is_file()}
    published = []
    link = os.link

    def record_publication(*args, **kwargs):
        published.append(args)
        return link(*args, **kwargs)

    monkeypatch.setattr(os, "link", record_publication)
    response = client.post(PREFIX + "/audio", json={"name": "tiny.wav", "mime": "audio/wav",
                           "data": base64.b64encode(wav_bytes(frames=1, rate=192000)).decode()})
    assert response.status_code == 400, response.text
    assert "too short" in response.json()["detail"].lower()
    assert client.get(PREFIX + "/project").json() == before
    assert {path.name for path in directory.iterdir() if path.is_file()} == files
    assert list((directory / ".pending-assets").iterdir()) == []
    assert published == []


def test_session_lookup_is_exact_and_profile_local(client, tmp_path):
    from hermes_constants import set_hermes_home_override, reset_hermes_home_override
    assert client.get(PREFIX.replace("song-session", "song") + "/project").status_code == 404
    assert client.post(PREFIX.replace("song-session", "unknown") + "/captures", json=TAKE).status_code == 404
    captured = client.post(PREFIX + "/captures", json=TAKE).json()
    other_home = tmp_path / "other-profile"
    other_home.mkdir()
    token = set_hermes_home_override(other_home)
    try:
        db = SessionDB(db_path=other_home / "state.db")
        db.create_session("song-session", source="desktop")
        db.close()
        fresh = client.get(PREFIX + "/project")
        assert fresh.status_code == 200 and fresh.json()["tracks"] == []
        assert not (other_home / "plugin-data/songwriting").exists()
    finally:
        reset_hermes_home_override(token)
    assert client.get(PREFIX + "/project").json() == captured["project"]


@pytest.mark.platforms("posix")
def test_symlinked_storage_and_source_files_fail_closed(client, tmp_path):
    root = get_hermes_home() / "plugin-data"
    root.mkdir(exist_ok=True)
    outside = tmp_path / "outside"
    outside.mkdir()
    (root / "songwriting").symlink_to(outside, target_is_directory=True)
    response = client.post(PREFIX + "/captures", json=TAKE)
    assert response.status_code == 400, response.text
    assert list(outside.iterdir()) == []
    (root / "songwriting").unlink()
    import base64
    uploaded = client.post(PREFIX + "/audio", json={"name": "source", "mime": "audio/wav",
                                                   "data": base64.b64encode(wav_bytes()).decode()}).json()
    path = Path(uploaded["project"]["tracks"][0]["path"])
    path.unlink()
    secret = outside / "secret.wav"
    secret.write_bytes(wav_bytes(value=12345))
    path.symlink_to(secret)
    response = client.post(PREFIX + "/render", json={})
    assert response.status_code == 400, response.text
    assert str(secret) not in response.text and "12345" not in response.text


def test_request_bodies_are_bounded_before_validation(client):
    response = client.post(PREFIX + "/captures", content=b"{}", headers={"Content-Length": "999999999", "Content-Type": "application/json"})
    assert response.status_code == 400, response.text
    # Chunked requests cannot bypass the bound by omitting Content-Length.
    response = client.post(PREFIX + "/proposal", content=iter([b" " * (1024 * 1024)] * 5), headers={"Content-Type": "application/json"})
    assert response.status_code == 400, response.text


def test_concurrent_apply_has_exactly_one_winner(client):
    from concurrent.futures import ThreadPoolExecutor
    pending = propose(client, [generated()], 0).json()["proposal"]
    with ThreadPoolExecutor(max_workers=2) as executor:
        results = list(executor.map(lambda _: client.post(PREFIX + "/apply", json={"proposalId": pending["id"], "baseRevision": 0}).status_code, range(2)))
    assert sorted(results) == [200, 409]
    project = client.get(PREFIX + "/project").json()
    assert project["revision"] == 1 and len(project["tracks"]) == 1


def test_audio_mime_codec_parameter_from_real_mediarecorder(client):
    import base64
    response = client.post(PREFIX + "/audio", json={"name": "Microphone", "mime": "audio/wav;codecs=pcm",
                                                   "data": base64.b64encode(wav_bytes()).decode()})
    assert response.status_code == 200, response.text


def test_immutable_source_capture_limit_is_enforced(client):
    for index in range(32):
        response = client.post(PREFIX + "/captures", json=TAKE)
        assert response.status_code == 200, (index, response.text)
    response = client.post(PREFIX + "/captures", json=TAKE)
    assert response.status_code == 400, response.text
    project = client.get(PREFIX + "/project").json()
    assert project["revision"] == 32 and len(project["tracks"]) == 32


def test_imported_audio_is_preserved_when_proposal_is_applied_and_undone(client):
    import base64
    result = client.post(PREFIX + "/audio", json={"name": "voice.wav", "mime": "audio/wav", "data": base64.b64encode(wav_bytes()).decode()}).json()
    raw = Path(result["capturePath"]).read_bytes()
    proposal = propose(client, [generated()], 1).json()["proposal"]
    client.post(PREFIX + "/apply", json={"proposalId": proposal["id"], "baseRevision": 1})
    undo = client.post(PREFIX + "/undo", json={"baseRevision": 2}).json()
    assert undo["tracks"] == result["project"]["tracks"]
    assert Path(result["capturePath"]).read_bytes() == raw


def test_compression_continuation_keeps_durable_song_but_fork_does_not(client):
    original = client.post(PREFIX + "/captures", json=TAKE).json()["project"]
    db = SessionDB()
    db.end_session("song-session", end_reason="compression")
    db.create_session("continuation", source="desktop", parent_session_id="song-session")
    db.create_session("fork", source="desktop", parent_session_id="continuation")
    db.create_session("marked-fork", source="desktop", parent_session_id="song-session",
                      model_config={"_branched_from": "song-session"})
    db.close()
    continuation = client.get(PREFIX.replace("song-session", "continuation") + "/project")
    assert continuation.status_code == 200, continuation.text
    assert continuation.json() == original
    fork = client.get(PREFIX.replace("song-session", "fork") + "/project")
    assert fork.json()["tracks"] == [] and fork.json()["id"] == "fork"
    marked_fork = client.get(PREFIX.replace("song-session", "marked-fork") + "/project")
    assert marked_fork.json()["tracks"] == [] and marked_fork.json()["id"] == "marked-fork"


def test_corrupt_song_store_is_reported_without_internal_paths(client):
    result = client.post(PREFIX + "/captures", json=TAKE).json()
    db_path = Path(result["capturePath"]).parent / "project.sqlite"
    db_path.write_bytes(b"not a sqlite database")
    response = client.get(PREFIX + "/project")
    assert response.status_code == 503, response.text
    assert str(db_path) not in response.text and "sqlite" not in response.text.lower()


def test_validation_rejects_nonfinite_or_malformed_notes_without_echoing_uploads(client):
    malformed = generated()
    malformed["notes"][0]["note"] = 128
    response = propose(client, [malformed], 0)
    assert response.status_code == 422
    import json
    nonfinite = generated()
    nonfinite["notes"][0]["startMs"] = float("nan")
    response = client.post(PREFIX + "/proposal", content=json.dumps({"baseRevision": 0, "brief": "Invalid timing", "tracks": [nonfinite]}), headers={"Content-Type": "application/json"})
    assert response.status_code == 422
    invalid = dict(TAKE, events=[{"timeMs": 0, "data": [144, 60]}])
    assert client.post(PREFIX + "/captures", json=invalid).status_code == 422
    response = client.post(PREFIX + "/audio", json={"name": "invalid", "mime": "audio/wav", "data": "PRIVATE_AUDIO_PAYLOAD", "extra": "not allowed"})
    assert response.status_code == 422 and "PRIVATE_AUDIO_PAYLOAD" not in response.text


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
    mounted_client = TestClient(app)
    response = mounted_client.get(PREFIX + "/project")
    assert response.status_code == 200, response.text
    assert response.json()["tracks"] == []
