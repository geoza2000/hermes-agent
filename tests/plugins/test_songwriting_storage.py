"""Real SQLite lock and asset publication regressions for the song store."""
from contextlib import contextmanager
import json
import os
from pathlib import Path
import sqlite3
import subprocess
import sys

import pytest
from fastapi import FastAPI, HTTPException
from fastapi.testclient import TestClient

from hermes_cli.sqlite_safe_read import has_live_connection
from hermes_cli.web_routers.files import _fs_read_bytes
from hermes_state import SessionDB
from plugins.songwriting import storage
from plugins.songwriting.api import router
from plugins.songwriting.models import MidiTake
from plugins.songwriting.storage import SongStore


TAKE = {"schema": 1, "kind": "midi", "durationMs": 300,
        "device": {"id": "keys", "name": "Local keys", "manufacturer": ""},
        "events": [{"timeMs": 0, "data": [144, 60, 100]},
                   {"timeMs": 250, "data": [128, 60, 0]}]}


@pytest.fixture
def store():
    db = SessionDB()
    db.create_session("storage-test", source="desktop")
    db.close()
    return SongStore("storage-test")


_CAPTURE = """
import json, sqlite3, sys
from plugins.songwriting.models import MidiTake
from plugins.songwriting.storage import SongStore
connect = sqlite3.connect
def immediate_connect(*args, **kwargs):
    kwargs['timeout'] = 0
    return connect(*args, **kwargs)
sqlite3.connect = immediate_connect
try:
    result = SongStore('storage-test').capture_midi(MidiTake.model_validate(json.loads(sys.argv[1])))
    print(json.dumps(result))
except sqlite3.OperationalError as exc:
    if 'locked' not in str(exc):
        raise
    print('BLOCKED')
"""


def external_capture(store):
    return subprocess.run(
        [sys.executable, "-c", _CAPTURE, json.dumps(TAKE)],
        env={**os.environ, "HERMES_HOME": str(store.home)},
        capture_output=True, text=True, timeout=60, check=True,
    ).stdout.strip()


@pytest.mark.platforms("posix")
def test_dashboard_raw_read_cannot_unlock_capture_for_another_process(store, monkeypatch):
    with store.transaction():
        pass  # Reproduce the lost-update case on an already-initialized project.
    original_transaction = store.transaction
    observed = {}

    @contextmanager
    def inspect_before_commit():
        with original_transaction() as state:
            yield state
            observed["tracked"] = has_live_connection(store.db_path)
            try:
                _fs_read_bytes(store.db_path)
                observed["dashboard"] = 200
            except HTTPException as exc:
                observed["dashboard"] = exc.status_code
            observed["competitor"] = external_capture(store)

    monkeypatch.setattr(store, "transaction", inspect_before_commit)
    first = store.capture_midi(MidiTake.model_validate(TAKE))
    assert observed == {"tracked": True, "dashboard": 409, "competitor": "BLOCKED"}
    assert not has_live_connection(store.db_path)
    second = json.loads(external_capture(store))
    project = store.read()
    assert project == second["project"]
    assert project["revision"] == 2 and len(project["captures"]) == 2
    assert {item["path"] for item in project["captures"]} == {first["capturePath"], second["capturePath"]}


def test_read_only_song_connection_blocks_dashboard_byte_reads(store, monkeypatch):
    store.capture_midi(MidiTake.model_validate(TAKE))
    connect = sqlite3.connect
    observed = []

    class InspectRead(sqlite3.Connection):
        def execute(self, sql, *args):
            if sql == "SELECT project FROM song WHERE id=1":
                observed.append(has_live_connection(store.db_path))
                with pytest.raises(HTTPException) as exc:
                    _fs_read_bytes(store.db_path)
                assert exc.value.status_code == 409
            return super().execute(sql, *args)

    def inspected_connect(*args, **kwargs):
        # connect_tracked will retrofit this real connection's close lifecycle.
        kwargs["factory"] = InspectRead
        return connect(*args, **kwargs)

    monkeypatch.setattr(sqlite3, "connect", inspected_connect)
    assert store.read()["revision"] == 1
    assert observed == [True]
    assert not has_live_connection(store.db_path)
    assert _fs_read_bytes(store.db_path, 16) == b"SQLite format 3\x00"


@pytest.fixture
def client(store):
    app = FastAPI()
    app.include_router(router)
    return TestClient(app)


def asset_files(store):
    return {path.name: path.read_bytes() for path in store.directory.iterdir()
            if path.is_file() and not path.name.startswith("project.sqlite")}


def request_asset(client, operation):
    import base64
    from array import array
    from plugins.songwriting.audio import pcm_wav
    body = TAKE
    if operation == "audio":
        body = {"name": "Local recording", "mime": "audio/wav",
                "data": base64.b64encode(pcm_wav(array("h", [1000] * 240))).decode()}
    elif operation == "render":
        body = {}
    return client.post(f"/sessions/storage-test/{operation}", json=body)


def fail_writes(monkeypatch, stage):
    if stage == "serialize":
        transaction = SongStore.transaction

        @contextmanager
        def unserializable_project(self):
            with transaction(self) as state:
                yield state
                state[1]["invalid"] = float("nan")

        monkeypatch.setattr(SongStore, "transaction", unserializable_project)
        return
    connect = storage.connect_tracked

    class FailingWrite(sqlite3.Connection):
        def execute(self, sql, *args):
            if stage == "insert" and sql.startswith("INSERT OR REPLACE INTO song"):
                raise sqlite3.OperationalError("PRIVATE injected INSERT failure")
            return super().execute(sql, *args)

        def commit(self):
            if stage == "late_commit":
                super().commit()
            if stage in ("commit", "late_commit"):
                raise sqlite3.OperationalError("PRIVATE injected commit failure")
            return super().commit()

    def failing_connect(*args, **kwargs):
        if not kwargs.get("uri"):
            kwargs["factory"] = FailingWrite
        return connect(*args, **kwargs)

    monkeypatch.setattr(storage, "connect_tracked", failing_connect)


@pytest.mark.parametrize("operation", ["captures", "audio", "render"])
@pytest.mark.parametrize("stage", ["serialize", "insert", "commit"])
def test_failed_transaction_removes_new_assets_but_preserves_existing_sources(store, client, monkeypatch, operation, stage):
    store.capture_midi(MidiTake.model_validate(TAKE))
    before, files = store.read(), asset_files(store)
    fail_writes(monkeypatch, stage)
    response = request_asset(client, operation)
    assert response.status_code == 503, response.text
    assert "PRIVATE" not in response.text and str(store.directory) not in response.text
    assert store.read() == before
    assert asset_files(store) == files


@pytest.mark.parametrize("operation", ["captures", "audio", "render"])
def test_confirmed_late_commit_returns_reachable_assets_without_deleting_sources(store, client, monkeypatch, operation):
    original = store.capture_midi(MidiTake.model_validate(TAKE))
    files = asset_files(store)
    fail_writes(monkeypatch, "late_commit")
    response = request_asset(client, operation)
    assert response.status_code == 200, response.text
    result = response.json()
    project = store.read()
    assert Path(original["capturePath"]).read_bytes() == files[Path(original["capturePath"]).name]
    if operation == "render":
        assert project == original["project"]
        assert Path(result["path"]).is_file()
    else:
        assert result["project"] == project
        assert project["revision"] == 2 and len(project["captures"]) == 2
        assert Path(result["capturePath"]).is_file()
        for track in project["tracks"]:
            if track.get("path"):
                assert Path(track["path"]).is_file()


_CRASH_CAPTURE = """
import json, os, sqlite3, sys
from plugins.songwriting import storage
from plugins.songwriting.models import MidiTake
connect = storage.connect_tracked
class CrashCommit(sqlite3.Connection):
    def commit(self):
        if sys.argv[2] == 'after':
            super().commit()
        os._exit(73)
def crash_connect(*args, **kwargs):
    if not kwargs.get('uri'):
        kwargs['factory'] = CrashCommit
    return connect(*args, **kwargs)
storage.connect_tracked = crash_connect
storage.SongStore('storage-test').capture_midi(MidiTake.model_validate(json.loads(sys.argv[1])))
"""


@pytest.mark.parametrize("crash", ["before", "after"])
def test_next_write_reconciles_interrupted_publication_without_deleting_committed_sources(store, crash):
    store.capture_midi(MidiTake.model_validate(TAKE))
    result = subprocess.run(
        [sys.executable, "-c", _CRASH_CAPTURE, json.dumps(TAKE), crash],
        env={**os.environ, "HERMES_HOME": str(store.home)},
        capture_output=True, text=True, timeout=60, check=False,
    )
    assert result.returncode == 73, result.stderr
    assert len(asset_files(store)) == 2
    project = store.capture_midi(MidiTake.model_validate(TAKE))["project"]
    assert len(project["captures"]) == (2 if crash == "before" else 3)
    assert set(asset_files(store)) == {Path(item["path"]).name for item in project["captures"]}


def test_staged_original_and_pcm_share_the_existing_session_budget(store, monkeypatch):
    with store.transaction():
        pass
    before = store.read()
    with pytest.raises(storage.SongError, match="storage limit"):
        with store.transaction() as (conn, _):
            store.write_asset(b"1234", ".wav", conn=conn)
            used = sum(path.stat().st_size for path in store.directory.iterdir() if path.is_file())
            monkeypatch.setattr(storage, "MAX_SESSION_BYTES", used + 4)
            store.write_asset(b"5678", ".pcm.wav", conn=conn)
    assert store.read() == before
    assert asset_files(store) == {}
    assert list(store.pending_directory.iterdir()) == []


def test_orphan_reconciliation_is_bounded_and_makes_progress(store, client, monkeypatch, caplog):
    original = store.capture_midi(MidiTake.model_validate(TAKE))
    files = asset_files(store)
    unlink = Path.unlink

    def unavailable_cleanup(path, *args, **kwargs):
        if path.parent == store.directory and path.name.endswith(".wav"):
            raise PermissionError("PRIVATE cleanup failure")
        return unlink(path, *args, **kwargs)

    with monkeypatch.context() as fault:
        fail_writes(fault, "commit")
        fault.setattr(Path, "unlink", unavailable_cleanup)
        response = request_asset(client, "audio")
    assert response.status_code == 503
    assert "cleanup deferred" in caplog.text and "PRIVATE" not in caplog.text
    assert len(list(store.pending_directory.iterdir())) == 2
    assert len(asset_files(store)) == 3
    monkeypatch.setattr(storage, "MAX_RECONCILE_ASSETS", 1)
    with store.transaction():
        pass
    assert len(list(store.pending_directory.iterdir())) == 1
    assert len(asset_files(store)) == 2
    with store.transaction():
        pass
    assert list(store.pending_directory.iterdir()) == []
    assert asset_files(store) == files
    assert store.read() == original["project"]


def test_committed_render_returns_its_path_even_when_receipt_cleanup_is_deferred(store, client, monkeypatch, caplog):
    store.capture_midi(MidiTake.model_validate(TAKE))
    unlink = Path.unlink

    def unavailable_receipt_cleanup(path, *args, **kwargs):
        if path.parent == store.pending_directory:
            raise PermissionError("PRIVATE receipt cleanup failure")
        return unlink(path, *args, **kwargs)

    with monkeypatch.context() as fault:
        fault.setattr(Path, "unlink", unavailable_receipt_cleanup)
        response = request_asset(client, "render")
    assert response.status_code == 200, response.text
    path = Path(response.json()["path"])
    rendered = path.read_bytes()
    assert "cleanup deferred" in caplog.text and "PRIVATE" not in caplog.text
    assert len(list(store.pending_directory.iterdir())) == 1
    with store.transaction():
        pass
    assert path.read_bytes() == rendered
    assert list(store.pending_directory.iterdir()) == []


@pytest.mark.parametrize("landed", [False, True])
def test_unconfirmable_commit_defers_cleanup_until_a_locked_read_can_prove_the_outcome(store, client, monkeypatch, caplog, landed):
    original = store.capture_midi(MidiTake.model_validate(TAKE))
    files = asset_files(store)
    connect = storage.connect_tracked

    class UnknownOutcome(sqlite3.Connection):
        def commit(self):
            if landed:
                super().commit()
            raise sqlite3.OperationalError("PRIVATE commit outcome unknown")

        def rollback(self):
            raise sqlite3.OperationalError("PRIVATE rollback unavailable")

    def unconfirmable_connect(*args, **kwargs):
        if not kwargs.get("uri"):
            kwargs["factory"] = UnknownOutcome
        return connect(*args, **kwargs)

    with monkeypatch.context() as fault:
        fault.setattr(storage, "connect_tracked", unconfirmable_connect)
        response = request_asset(client, "audio")
    assert response.status_code == 503, response.text
    assert "PRIVATE" not in response.text and str(store.directory) not in response.text
    assert "publication outcome is unconfirmed" in caplog.text and "PRIVATE" not in caplog.text
    assert len(list(store.pending_directory.iterdir())) == 2
    assert len(asset_files(store)) == 3
    assert not has_live_connection(store.db_path)
    with store.transaction():
        pass
    project = store.read()
    assert list(store.pending_directory.iterdir()) == []
    assert Path(original["capturePath"]).read_bytes() == files[Path(original["capturePath"]).name]
    if landed:
        assert project["revision"] == 2 and len(project["captures"]) == 2
        assert len(asset_files(store)) == 3
        assert all(Path(item["path"]).is_file() for item in project["captures"])
        assert Path(project["tracks"][1]["path"]).is_file()
    else:
        assert project == original["project"]
        assert asset_files(store) == files


@pytest.mark.parametrize("operation", ["captures", "audio"])
@pytest.mark.parametrize("stage", ["serialize", "insert", "commit"])
def test_first_write_failure_cleans_assets_even_when_asset_table_is_rolled_back(store, client, monkeypatch, operation, stage):
    before = store.read()
    fail_writes(monkeypatch, stage)
    response = request_asset(client, operation)
    assert response.status_code == 503, response.text
    assert store.read() == before
    assert asset_files(store) == {}
    assert list(store.pending_directory.iterdir()) == []
    assert not has_live_connection(store.db_path)


def test_partial_audio_publication_is_cleaned_if_publishing_pcm_fails(store, client, monkeypatch):
    original = store.capture_midi(MidiTake.model_validate(TAKE))
    files = asset_files(store)
    link = os.link

    def fail_pcm_publication(source, target, **kwargs):
        if target.name.endswith(".pcm.wav"):
            raise OSError("PRIVATE PCM publication failure")
        return link(source, target, **kwargs)

    monkeypatch.setattr(os, "link", fail_pcm_publication)
    response = request_asset(client, "audio")
    assert response.status_code == 503, response.text
    assert "PRIVATE" not in response.text and str(store.directory) not in response.text
    assert store.read() == original["project"]
    assert asset_files(store) == files
    assert list(store.pending_directory.iterdir()) == []


def test_publication_collision_does_not_delete_an_existing_legacy_source(store, client, monkeypatch):
    from uuid import UUID
    original = store.capture_midi(MidiTake.model_validate(TAKE))
    path = Path(original["capturePath"])
    raw = path.read_bytes()
    # Projects written before the asset mapping existed still own their sources.
    with store.transaction() as (conn, _):
        conn.execute("DELETE FROM assets")
    monkeypatch.setattr(storage, "uuid4", lambda: UUID(path.name.split(".")[0]))
    response = request_asset(client, "captures")
    assert response.status_code == 503, response.text
    assert store.read() == original["project"]
    assert path.read_bytes() == raw
    assert list(store.pending_directory.iterdir()) == []
