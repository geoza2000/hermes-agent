"""Lane operations. Takes are immutable files; lanes point at them and carry editable notes.

Every content change snapshots the previous lanes so Undo can restore them. Mixer state (mute,
solo, volume, which lane is selected) changes freely and is not part of the undo history.
"""
import base64
import binascii
import json
from uuid import uuid4

from .models import MAX_AUDIO_BYTES, MAX_LANES, symbolic_notes
from .schema import digest, new_lane
from .storage import SongError

AUDIO_TYPES = {"audio/wav": ".wav", "audio/x-wav": ".wav", "audio/webm": ".webm", "audio/ogg": ".ogg",
               "audio/mp4": ".m4a", "audio/mpeg": ".mp3", "audio/flac": ".flac"}
HISTORY_LIMIT = 64


def lane_of(project, lane_id):
    lane = next((item for item in project["lanes"] if item["id"] == lane_id), None)
    if lane is None:
        raise SongError(404, "That lane no longer exists; refresh the song")
    return lane


def snapshot(conn, project):
    """Remember the song before an undoable change."""
    state = {"lanes": project["lanes"], "tempo": project["tempo"], "title": project["title"]}
    conn.execute("INSERT INTO history(project) VALUES (?)", (json.dumps(state),))
    conn.execute(f"DELETE FROM history WHERE id NOT IN (SELECT id FROM history ORDER BY id DESC LIMIT {HISTORY_LIMIT})")


def changed(project):
    """Bump the revision Desktop polls on. A pending suggestion survives: Keep re-checks its lanes."""
    project["revision"] += 1


def add_lane(store, request):
    with store.transaction() as (conn, project):
        if len(project["lanes"]) >= MAX_LANES:
            raise SongError(400, f"A song can have at most {MAX_LANES} lanes")
        snapshot(conn, project)
        lane = new_lane("lane_" + uuid4().hex[:12], request.name, request.instrument.model_dump(), request.source)
        if request.source == "audio":
            lane["play"] = "audio"
        project["lanes"].append(lane)
        project["selectedLaneId"] = lane["id"]
        changed(project)
    return {"project": project, "lane": lane}


def update_lane(store, lane_id, request):
    with store.transaction() as (conn, project):
        lane = lane_of(project, lane_id)
        fields = request.model_dump(exclude_none=True)
        if "play" in fields and fields["play"] == "audio" and not lane["audio"]:
            raise SongError(400, "This lane has no recording to play")
        if {"name", "instrument"} & fields.keys():
            snapshot(conn, project)
        if "instrument" in fields:
            fields["instrument"] = request.instrument.model_dump()
        lane.update(fields)
        changed(project)
    return project


def delete_lane(store, lane_id):
    with store.transaction() as (conn, project):
        lane_of(project, lane_id)
        snapshot(conn, project)
        project["lanes"] = [lane for lane in project["lanes"] if lane["id"] != lane_id]
        if project["selectedLaneId"] == lane_id:
            project["selectedLaneId"] = project["lanes"][-1]["id"] if project["lanes"] else None
        changed(project)
    return project


def record_midi(store, lane_id, request):
    """A new MIDI take replaces the lane's notes; the raw events stay as an immutable file."""
    with store.transaction() as (conn, project):
        lane = lane_of(project, lane_id)
        snapshot(conn, project)
        path = store.write_asset(request.take.model_dump_json(by_alias=True).encode(), ".midi.json", conn=conn)
        capture_id = "capture_" + path.name.split(".")[0]
        offset = request.startMs
        lane["notes"] = [{**note, "startMs": round(note["startMs"] + offset, 3)} for note in symbolic_notes(request.take)]
        lane["source"] = "midi"
        lane["take"] = {"captureId": capture_id, "startMs": offset}
        project["captures"].append({"id": capture_id, "kind": "midi", "name": request.take.device.name,
                                    "laneId": lane_id, "path": str(path), "durationMs": request.take.durationMs})
        changed(project)
    return {"project": project, "capturePath": str(path)}


def record_audio(store, lane_id, request):
    """Keep the exact recording; its pitch-tracked notes (if any) make it playable as an instrument."""
    mime = request.mime.partition(";")[0].strip().lower()
    if mime not in AUDIO_TYPES:
        raise SongError(400, "Unsupported audio type")
    try:
        data = base64.b64decode(request.data, validate=True)
    except (ValueError, binascii.Error) as exc:
        raise SongError(400, "Audio data must be valid base64") from exc
    if not data or len(data) > MAX_AUDIO_BYTES:
        raise SongError(400, "Audio must be non-empty and at most 20 MiB")
    with store.transaction() as (conn, project):
        lane = lane_of(project, lane_id)
        snapshot(conn, project)
        path = store.write_asset(data, AUDIO_TYPES[mime], conn=conn)
        capture_id = "capture_" + path.stem
        lane["audio"] = {"captureId": capture_id, "startMs": request.startMs, "offsetMs": request.offsetMs,
                         "durationMs": request.durationMs, "mime": request.mime}
        notes = [note.model_dump() for note in request.notes or []]
        lane["notes"] = [{**note, "startMs": round(note["startMs"] + request.startMs, 3)} for note in notes]
        # A hummed line plays as the lane's instrument; a plain recording plays as itself.
        lane["play"] = "notes" if notes and lane["source"] == "voice" else "audio"
        project["captures"].append({"id": capture_id, "kind": "audio", "name": request.name, "laneId": lane_id,
                                    "path": str(path), "durationMs": request.durationMs, "mime": request.mime})
        changed(project)
    return {"project": project, "capturePath": str(path)}


def settings(store, request):
    with store.transaction() as (conn, project):
        fields = request.model_dump(exclude_none=True)
        if "selectedLaneId" in fields:
            lane_of(project, fields["selectedLaneId"])
        if {"tempo", "title"} & fields.keys():
            snapshot(conn, project)
        project.update(fields)
        changed(project)
    return project


def propose(store, request):
    """Hermes's suggestion: staged for the listener to preview, never applied by the agent."""
    with store.transaction() as (_, project):
        lanes = {lane["id"]: lane for lane in project["lanes"]}
        ids = [change.laneId for change in request.changes]
        if len(set(ids)) != len(ids):
            raise SongError(400, "Each lane may be changed once per proposal")
        added = [change for change in request.changes if change.laneId not in lanes]
        if any(change.remove for change in added):
            raise SongError(400, "Cannot remove a lane that does not exist")
        if any(change.notes is None or change.instrument is None for change in added):
            raise SongError(400, "A new lane needs an instrument and notes")
        if len(lanes) + len(added) > MAX_LANES:
            raise SongError(400, f"A song can have at most {MAX_LANES} lanes")
        project["proposal"] = {
            "id": uuid4().hex, "brief": request.brief,
            "changes": [change.model_dump(exclude_none=True) for change in request.changes],
            "base": {lane_id: digest(lanes.get(lane_id)) for lane_id in ids},
        }
    return {"project": project, "proposal": project["proposal"]}


def proposed_lanes(project):
    """The song as it would sound if the pending proposal were kept."""
    proposal = project.get("proposal")
    if not proposal:
        raise SongError(409, "There is no pending suggestion")
    lanes = [dict(lane) for lane in project["lanes"]]
    for change in proposal["changes"]:
        current = next((lane for lane in lanes if lane["id"] == change["laneId"]), None)
        if change.get("remove"):
            lanes = [lane for lane in lanes if lane["id"] != change["laneId"]]
            continue
        if current is None:
            current = new_lane(change["laneId"], change.get("name") or "Hermes", change["instrument"], "hermes")
            lanes.append(current)
        for key in ("name", "instrument", "notes"):
            if key in change:
                current[key] = change[key]
    return lanes


def apply(store, request):
    with store.transaction() as (conn, project):
        proposal = project.get("proposal")
        if not proposal or proposal["id"] != request.proposalId:
            raise SongError(409, "That suggestion is no longer pending; refresh the song")
        lanes = {lane["id"]: lane for lane in project["lanes"]}
        if any(digest(lanes.get(lane_id)) != base for lane_id, base in proposal["base"].items()):
            raise SongError(409, "Those lanes changed since Hermes suggested this; ask again")
        snapshot(conn, project)
        project["lanes"] = proposed_lanes(project)
        project.pop("proposal")
        changed(project)
    return project


def reject(store, request):
    with store.transaction() as (_, project):
        proposal = project.get("proposal")
        if not proposal or proposal["id"] != request.proposalId:
            raise SongError(409, "That suggestion is no longer pending; refresh the song")
        project.pop("proposal")
        changed(project)
    return project


def undo(store):
    with store.transaction() as (conn, project):
        row = conn.execute("SELECT id, project FROM history ORDER BY id DESC LIMIT 1").fetchone()
        if row is None:
            raise SongError(409, "Nothing to undo")
        previous = json.loads(row[1])
        current = {lane["id"]: lane for lane in project["lanes"]}
        # Mixer state is not history: an undone lane keeps the mute/solo/volume it has now.
        for lane in previous["lanes"]:
            for key in ("muted", "solo", "volume"):
                if lane["id"] in current:
                    lane[key] = current[lane["id"]][key]
        project.update(previous)
        if project["selectedLaneId"] not in {lane["id"] for lane in project["lanes"]}:
            project["selectedLaneId"] = project["lanes"][-1]["id"] if project["lanes"] else None
        conn.execute("DELETE FROM history WHERE id=?", (row[0],))
        changed(project)
    return project


def capture_file(store, capture_id):
    """The immutable source file behind a capture, for Desktop playback and the agent's reads."""
    from pathlib import Path
    from .storage import checked_path
    project = store.read()
    capture = next((item for item in project["captures"] if item["id"] == capture_id), None)
    if capture is None:
        raise SongError(404, "No such recording in this song")
    path = checked_path(store.home, Path(capture["path"]))
    if path.parent != store.directory:
        raise SongError(400, "Recording is not owned by this song")
    return capture, path


CHUNK = 4 * 1024 * 1024


def capture_chunk(store, capture_id, index):
    """Recordings travel to Desktop as base64 chunks: the host JSON client has no binary path."""
    capture, path = capture_file(store, capture_id)
    size = path.stat().st_size
    chunks = max(1, -(-size // CHUNK))
    if not 0 <= index < chunks:
        raise SongError(400, "No such chunk")
    with open(path, "rb") as source:
        source.seek(index * CHUNK)
        data = source.read(CHUNK)
    return {"index": index, "chunks": chunks, "mime": capture.get("mime", "application/json"),
            "data": base64.b64encode(data).decode()}
