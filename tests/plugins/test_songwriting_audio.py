"""Offline audio renderer checks independent of browser/device fixtures."""
from array import array
import importlib
import math
from pathlib import Path
import subprocess
import wave

import pytest

from hermes_constants import get_hermes_home
from hermes_platform.resolver import locate_command
from hermes_state import SessionDB
from plugins.songwriting import audio
from plugins.songwriting.models import AudioRequest, MidiTake, RenderRequest
from plugins.songwriting.storage import SongError, SongStore


@pytest.fixture
def store():
    db = SessionDB()
    db.create_session("audio-test", source="desktop")
    db.close()
    return SongStore("audio-test")


def score(instrument="piano"):
    return {"id": instrument, "name": instrument, "kind": "midi", "origin": "generated", "protected": False,
            "instrument": instrument, "notes": [{"startMs": 0, "durationMs": 200, "note": 42 if instrument == "drums" else 69, "velocity": 100}]}


@pytest.mark.parametrize("instrument", ["piano", "bass", "drums", "pad", "lead"])
def test_every_local_instrument_writes_finite_non_silent_wav(store, instrument):
    with store.transaction() as (_, project):
        project["tracks"] = [score(instrument)]
    result = audio.render(store, RenderRequest())
    with wave.open(result["path"], "rb") as wav:
        assert wav.getnframes() == 4800 and wav.getframerate() == 24000
        samples = array("h", wav.readframes(wav.getnframes()))
    assert max(samples) > 100 and min(samples) < -100
    assert max(abs(sample) for sample in samples) < 32767
    assert all(math.isfinite(sample) for sample in samples)


def test_renderer_stops_at_a_bounded_checkpoint(store, monkeypatch):
    with store.transaction() as (_, project):
        project["tracks"] = [score()]
    assert hasattr(audio, "monotonic"), "renderer needs a real time budget, not only a note-count bound"
    ticks = iter([0, 31, 31, 31])
    monkeypatch.setattr(audio, "monotonic", lambda: next(ticks, 31))
    with pytest.raises(SongError, match="time budget"):
        audio.render(store, RenderRequest())
    assert not list(store.directory.glob("*.mix.wav"))


def test_session_storage_quota_prevents_unbounded_render_accumulation(store, monkeypatch):
    module = importlib.import_module(SongStore.__module__)
    monkeypatch.setattr(module, "MAX_SESSION_BYTES", 1024, raising=False)
    with store.transaction() as (_, project):
        project["tracks"] = [score()]
    with pytest.raises(SongError, match="storage limit"):
        audio.render(store, RenderRequest())
    assert store.read()["tracks"][0]["id"] == "piano"


def test_real_compressed_audio_decodes_locally_or_reports_missing_decoder(store):
    import base64
    command = locate_command("ffmpeg").command
    if not command:
        # A real request must fail visibly, never return a fabricated WAV.
        with pytest.raises(SongError, match="decoder is unavailable"):
            audio.upload(store, AudioRequest(name="take", mime="audio/webm;codecs=opus", data=base64.b64encode(b"not-webm").decode()))
        return
    # Exercise a real codec round-trip using local audio, not a mocked subprocess.
    with store.transaction() as (conn, _):
        source = store.write_asset(audio.pcm_wav(array("h", [int(4000 * math.sin(i / 20)) for i in range(6000)])), ".wav", conn=conn)
    encoded = store.directory / "test-opus.webm"
    subprocess.run([*command, "-nostdin", "-loglevel", "error", "-i", str(source), "-c:a", "libopus", "-y", str(encoded)], check=True, timeout=15)
    result = audio.upload(store, AudioRequest(name="Microphone", mime="audio/webm;codecs=opus", data=base64.b64encode(encoded.read_bytes()).decode()))
    assert Path(result["capturePath"]).read_bytes() == encoded.read_bytes()
    track = result["project"]["tracks"][0]
    assert 240 <= track["durationMs"] <= 280
    rendered = audio.render(store, RenderRequest())
    with wave.open(rendered["path"], "rb") as wav:
        assert max(abs(sample) for sample in array("h", wav.readframes(wav.getnframes()))) > 1000


def test_raw_midi_channels_retriggers_and_sustain_remain_preserved(store):
    take = MidiTake.model_validate({"schema": 1, "kind": "midi", "device": {"id": "d", "name": "Pads", "manufacturer": ""}, "durationMs": 600,
        "events": [{"timeMs": 0, "data": [144, 60, 100]}, {"timeMs": 0, "data": [145, 60, 70]},
                   {"timeMs": 100, "data": [144, 60, 90]}, {"timeMs": 200, "data": [145, 60, 0]},
                   {"timeMs": 300, "data": [176, 64, 127]}, {"timeMs": 400, "data": [128, 60, 0]},
                   {"timeMs": 500, "data": [176, 64, 0]}]})
    result = store.capture_midi(take)
    import json
    assert json.loads(Path(result["capturePath"]).read_text()) == take.model_dump(by_alias=True)
    notes = result["project"]["tracks"][0]["notes"]
    assert sorted(n["durationMs"] for n in notes) == [100, 200, 400]
