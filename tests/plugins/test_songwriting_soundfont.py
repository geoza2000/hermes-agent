"""The instrument download publishes only bytes that match the pinned size and hash."""
import base64
import hashlib
import io

import pytest

from plugins.songwriting import soundfont
from plugins.songwriting.storage import SongError

PAYLOAD = b"RIFF" + bytes(range(256)) * 40


@pytest.fixture
def pinned(monkeypatch):
    monkeypatch.setattr(soundfont, "SHA256", hashlib.sha256(PAYLOAD).hexdigest())
    monkeypatch.setattr(soundfont, "SIZE", len(PAYLOAD))
    monkeypatch.setattr(soundfont, "CHUNK", 4000)


def serving(data):
    def fetch(url, timeout):
        assert url == soundfont.URL and timeout == soundfont.TIMEOUT_S
        return io.BytesIO(data)
    return fetch


def test_verified_download_installs_once_and_reassembles_from_chunks(pinned):
    assert not soundfont.status()["installed"]
    status = soundfont.install(serving(PAYLOAD))
    assert status["installed"] and status["chunks"] == 3
    joined = b"".join(base64.b64decode(soundfont.chunk(index)["data"]) for index in range(status["chunks"]))
    assert joined == PAYLOAD
    # Installed means no second download.
    assert soundfont.install(lambda *_args, **_kwargs: pytest.fail("downloaded twice"))["installed"]
    with pytest.raises(SongError):
        soundfont.chunk(3)


@pytest.mark.parametrize("served", [PAYLOAD[:-1] + b"X", PAYLOAD[:-10], PAYLOAD + b"extra"])
def test_tampered_short_or_oversized_downloads_never_land(pinned, served):
    with pytest.raises(SongError):
        soundfont.install(serving(served))
    assert not soundfont.status()["installed"]
    assert not soundfont.path().exists()
    assert not soundfont.path().with_suffix(".partial").exists()
    with pytest.raises(SongError, match="not installed"):
        soundfont.chunk(0)


def test_network_failure_is_a_visible_error_without_partial_files(pinned):
    def offline(url, timeout):
        raise OSError("no route to host")
    with pytest.raises(SongError, match="Could not download"):
        soundfont.install(offline)
    assert not soundfont.path().with_suffix(".partial").exists()
