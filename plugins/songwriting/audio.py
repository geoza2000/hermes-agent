"""Small deterministic offline sequencer, PCM mixer and bounded local audio decoding.

This is sequenced synthesis, not a trained waveform model or a live instrument.
"""
from array import array
import base64
import binascii
import io
import math
from pathlib import Path
import subprocess
import sys
from time import monotonic
import wave

from hermes_platform.resolver import locate_command

from .models import MAX_AUDIO_BYTES, MAX_DURATION_MS
from .storage import SongError, checked_path

RATE = 24_000
MAX_FRAMES = RATE * MAX_DURATION_MS // 1000
FORMATS = {"audio/wav": ("wav", ".wav"), "audio/x-wav": ("wav", ".wav"),
           "audio/webm": ("matroska", ".webm"), "audio/ogg": ("ogg", ".ogg"),
           "audio/mp4": ("mov", ".m4a"), "audio/mpeg": ("mp3", ".mp3"),
           "audio/flac": ("flac", ".flac")}


def pcm_wav(samples: array) -> bytes:
    output = io.BytesIO()
    little = array("h", samples)
    if sys.byteorder != "little":
        little.byteswap()
    with wave.open(output, "wb") as wav:
        wav.setnchannels(1)
        wav.setsampwidth(2)
        wav.setframerate(RATE)
        wav.writeframes(little.tobytes())
    return output.getvalue()


def read_pcm(path: Path) -> array:
    with wave.open(str(path), "rb") as wav:
        channels, width, rate, frames = wav.getnchannels(), wav.getsampwidth(), wav.getframerate(), wav.getnframes()
        if rate < 1 or frames < 1 or frames * 1000 / rate > MAX_DURATION_MS:
            raise SongError(400, "Audio must be non-empty and at most five minutes")
        if width != 2 or channels not in (1, 2) or not 8000 <= rate <= 192000:
            raise wave.Error("Local decoder needed for this WAV encoding")
        if frames * channels * width > 120 * 1024 * 1024:
            raise SongError(400, "Decoded audio exceeds size limit")
        raw = wav.readframes(frames)
        if len(raw) != frames * channels * width:
            raise SongError(400, "Truncated audio")
    source = array("h", raw)
    if sys.byteorder != "little":
        source.byteswap()
    if channels == 2:
        source = array("h", (int((source[i] + source[i + 1]) / 2) for i in range(0, len(source), 2)))
    if rate == RATE:
        return source
    count = round(frames * RATE / rate)
    if count < 1:
        raise SongError(400, "Audio is too short to contain a sample after resampling to 24 kHz")
    # Linear resampling is deliberately local and dependency-free, not studio mastering.
    result = array("h")
    for index in range(count):
        position = index * rate / RATE
        left = min(int(position), len(source) - 1)
        right = min(left + 1, len(source) - 1)
        result.append(round(source[left] + (source[right] - source[left]) * (position - left)))
    return result


def decode_audio(store, source: Path, mime: str) -> array:
    try:
        return read_pcm(source)
    except (wave.Error, EOFError):
        pass
    command = locate_command("ffmpeg").command
    if not command:
        raise SongError(400, "Local ffmpeg decoder is unavailable; import a PCM16 WAV or install ffmpeg")
    target = store.directory / (source.stem + ".decode.wav")
    checked_path(store.home, target)
    try:
        # Force the demuxer: uploaded playlists cannot fetch URLs or arbitrary local files.
        args = [*command, "-nostdin", "-hide_banner", "-loglevel", "error", "-threads", "1",
                "-protocol_whitelist", "file,pipe", "-f", FORMATS[mime][0], "-i", str(source),
                "-vn", "-sn", "-dn", "-ac", "1", "-ar", str(RATE), "-t", "300.001",
                "-c:a", "pcm_s16le", "-f", "wav", "-fs", str((MAX_FRAMES + RATE) * 2 + 4096),
                "-n", str(target)]
        from tools.environments.local import served_profile_child_env
        subprocess.run(args, stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL,
                       stderr=subprocess.DEVNULL, timeout=30, check=True,
                       env=served_profile_child_env(target_home=store.home, inherit_credentials=False))
        return read_pcm(target)
    except (subprocess.SubprocessError, OSError, wave.Error, EOFError) as exc:
        raise SongError(400, "Audio could not be decoded locally within the safety limits") from exc
    finally:
        target.unlink(missing_ok=True)


def upload(store, request):
    mime = request.mime.partition(";")[0].strip().lower()
    if mime not in FORMATS:
        raise SongError(400, "Unsupported audio MIME type")
    try:
        data = base64.b64decode(request.data, validate=True)
    except (ValueError, binascii.Error) as exc:
        raise SongError(400, "Audio data must be valid base64") from exc
    if not data or len(data) > MAX_AUDIO_BYTES:
        raise SongError(400, "Audio upload exceeds the 20 MiB limit or is empty")
    with store.transaction() as (conn, project):
        if len(project["tracks"]) >= 32:
            raise SongError(400, "A song may contain at most 32 tracks")
        source = store.write_asset(data, FORMATS[mime][1], conn=conn)
        samples = decode_audio(store, checked_path(store.home, store.pending_directory / source.name), mime)
        decoded = store.write_asset(pcm_wav(samples), ".pcm.wav", conn=conn)
        duration = len(samples) * 1000 / RATE
        track_id = "audio_" + source.stem
        project["tracks"].append({"id": track_id, "name": request.name, "kind": "audio",
                                  "origin": "imported", "protected": True,
                                  "path": str(decoded), "durationMs": duration})
        project["captures"].append({"id": track_id, "kind": "audio", "name": request.name,
                                    "path": str(source), "durationMs": duration,
                                    "mime": request.mime, "playbackPath": str(decoded)})
        project["revision"] += 1
        project.pop("proposal", None)
    return {"project": project, "capturePath": str(source)}


def oscillator(instrument, phase, elapsed, note):
    fundamental = math.sin(phase)
    if instrument == "bass":
        return (fundamental + 0.22 * math.sin(2 * phase)) * math.exp(-elapsed * 1.3)
    if instrument == "pad":
        return (fundamental + 0.2 * math.sin(2.003 * phase)) * min(1, elapsed / 0.15)
    if instrument == "lead":
        return fundamental + 0.25 * math.sin(2 * phase) + 0.12 * math.sin(3 * phase)
    if instrument == "drums":
        # Deterministic percussion: kick-like low notes, noise-like high notes.
        if note < 40:
            return math.sin(phase * (1 + 1.8 * math.exp(-elapsed * 35))) * math.exp(-elapsed * 16)
        noise = 2 * ((math.sin((int(elapsed * RATE) + note * 919) * 12.9898) * 43758.5453) % 1) - 1
        return noise * math.exp(-elapsed * (35 if note >= 42 else 15))
    return (fundamental + 0.3 * math.sin(2 * phase) + 0.1 * math.sin(3 * phase)) * math.exp(-elapsed * 2.5)


def checkpoint(deadline):
    if monotonic() > deadline:
        raise SongError(400, "Local rendering time budget exceeded; render fewer tracks")


def add_notes(mix, track, deadline):
    instrument = track.get("instrument") or "piano"
    for note in track["notes"]:
        start = round(note["startMs"] * RATE / 1000)
        count = max(1, round(note["durationMs"] * RATE / 1000))
        end = min(len(mix), start + count)
        frequency = 440 * 2 ** ((note["note"] - 69) / 12)
        amplitude = 0.22 * note["velocity"] / 127
        for index in range(start, end):
            if index % 2048 == 0:
                checkpoint(deadline)
            local = index - start
            elapsed = local / RATE
            envelope = min(1, local / 120, (end - index) / 240)
            phase = math.tau * frequency * elapsed
            mix[index] += amplitude * envelope * oscillator(instrument, phase, elapsed, note["note"])


def render(store, request):
    deadline = monotonic() + 30
    project = store.read()
    ids = request.trackIds
    available = {track["id"] for track in project["tracks"]}
    if ids is not None and (not ids or len(ids) != len(set(ids)) or not set(ids) <= available):
        raise SongError(400, "Select existing, unique track IDs")
    tracks = [track for track in project["tracks"] if not track.get("muted") and (ids is None or track["id"] in ids)]
    if not tracks:
        raise SongError(400, "There are no audible tracks to render")
    duration, work = 0, 0
    for track in tracks:
        duration = max(duration, track.get("durationMs") or 0)
        for note in track.get("notes") or []:
            duration = max(duration, note["startMs"] + note["durationMs"])
            work += math.ceil(note["durationMs"] * RATE / 1000)
    if duration <= 0 or duration > MAX_DURATION_MS or work > 80_000_000:
        raise SongError(400, "Arrangement exceeds the local rendering budget; render fewer tracks")
    mix = array("f", [0]) * math.ceil(duration * RATE / 1000)
    uploads = {capture.get("playbackPath") for capture in project["captures"] if capture["kind"] == "audio"}
    for track in tracks:
        checkpoint(deadline)
        if track["kind"] == "midi":
            add_notes(mix, track, deadline)
        else:
            if track["path"] not in uploads:
                raise SongError(400, "Audio source is not an upload owned by this song")
            path = checked_path(store.home, Path(track["path"]))
            if path.parent != store.directory:
                raise SongError(400, "Audio source is not owned by this session")
            try:
                samples = read_pcm(path)
            except (OSError, wave.Error, EOFError) as exc:
                raise SongError(400, "Stored audio source is unavailable") from exc
            for index, sample in enumerate(samples[:len(mix)]):
                if index % 2048 == 0:
                    checkpoint(deadline)
                mix[index] += sample / 32768
    checkpoint(deadline)
    peak = max(abs(sample) for sample in mix)
    gain = min(1, 0.9 / peak) if peak else 1
    pcm = array("h", (max(-32768, min(32767, round(sample * gain * 32768))) for sample in mix))
    checkpoint(deadline)
    with store.transaction() as (conn, current):
        if current["revision"] != project["revision"]:
            raise SongError(409, "Song changed during rendering; render again")
        path = store.write_asset(pcm_wav(pcm), ".mix.wav", conn=conn)
    return {"path": str(path), "mime": "audio/wav", "durationMs": len(pcm) * 1000 / RATE}
