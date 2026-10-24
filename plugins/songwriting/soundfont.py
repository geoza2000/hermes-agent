"""The sampled instruments: GeneralUser GS, fetched once on the user's request and verified.

Desktop plays it through an in-app SoundFont synthesizer. The file lives in the plugin's
profile-scoped data directory, shared by every song in that profile.
"""
import base64
import hashlib
import os
from pathlib import Path
import urllib.request

from plugins.plugin_storage import plugin_data_dir

from .storage import SongError

NAME = "GeneralUser GS v2.0.3"
FILENAME = "GeneralUser-GS-2.0.3.sf2"
# Pinned to the author's v2.0.3 commit; the hash, not the host, is what we trust.
URL = ("https://raw.githubusercontent.com/mrbumpy409/GeneralUser-GS/"
       "97049183643d5fc5a9322a69c5b09efb667c6c3a/GeneralUser-GS.sf2")
SHA256 = "9575028c7a1f589f5770fccc8cff2734566af40cd26ed836944e9a5152688cfe"
SIZE = 32_319_396
LICENSE = ("Free to use for your own music, private or commercial, by S. Christian Collins "
           "(https://schristiancollins.com/generaluser).")
CHUNK = 4 * 1024 * 1024
TIMEOUT_S = 60


def path() -> Path:
    return plugin_data_dir("songwriting") / "soundfonts" / FILENAME


def status():
    target = path()
    return {"name": NAME, "installed": target.is_file() and target.stat().st_size == SIZE, "size": SIZE,
            "sha256": SHA256, "license": LICENSE, "chunkSize": CHUNK, "chunks": -(-SIZE // CHUNK)}


def install(fetch=urllib.request.urlopen):
    """Download into a private temp file, verify size and hash, then publish atomically."""
    target = path()
    if status()["installed"]:
        return status()
    target.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    partial = target.with_suffix(".partial")
    digest, received = hashlib.sha256(), 0
    try:
        with fetch(URL, timeout=TIMEOUT_S) as response, open(partial, "wb") as output:
            while chunk := response.read(1024 * 1024):
                received += len(chunk)
                if received > SIZE:
                    raise SongError(502, "The instrument download was larger than expected")
                digest.update(chunk)
                output.write(chunk)
            output.flush()
            os.fsync(output.fileno())
        if received != SIZE or digest.hexdigest() != SHA256:
            raise SongError(502, "The instrument download failed verification; nothing was installed")
        os.replace(partial, target)
    except OSError as exc:
        raise SongError(502, "Could not download the instruments; check the connection and try again") from exc
    finally:
        partial.unlink(missing_ok=True)
    return status()


def chunk(index: int):
    if not status()["installed"]:
        raise SongError(404, "Instruments are not installed yet")
    if not 0 <= index < status()["chunks"]:
        raise SongError(400, "No such chunk")
    with open(path(), "rb") as source:
        source.seek(index * CHUNK)
        data = source.read(CHUNK)
    return {"index": index, "data": base64.b64encode(data).decode()}
