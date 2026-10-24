"""Song document shape (schema 2: lanes) and forward migration of schema-1 songs."""
import hashlib
import json

from .models import MAX_LANES

# Schema 1 named its synth patches; keep earlier test songs playable on General MIDI.
LEGACY_PROGRAMS = {"piano": 0, "keys": 4, "guitar": 25, "bass": 33, "pad": 89, "lead": 81}


def empty_project(session_id):
    return {"schema": 2, "id": session_id, "title": "Untitled song", "revision": 0, "tempo": 100,
            "selectedLaneId": None, "lanes": [], "captures": []}


def new_lane(lane_id, name, instrument, source):
    return {"id": lane_id, "name": name, "instrument": instrument, "source": source, "notes": [],
            "audio": None, "play": "notes", "muted": False, "solo": False, "volume": 0.8}


def digest(lane):
    """Fingerprint of what a suggestion would overwrite; Keep refuses if it moved."""
    if lane is None:
        return None
    material = {key: lane[key] for key in ("name", "instrument", "notes")}
    return hashlib.sha256(json.dumps(material, sort_keys=True).encode()).hexdigest()


def instrument_of(track):
    name = track.get("instrument") or "piano"
    return {"program": LEGACY_PROGRAMS.get(name, 0), "drums": name == "drums"}


def migrate_proposal(proposal, lanes):
    """A pending 0.1 proposal (generated MIDI tracks) becomes a lanes suggestion, still unapplied."""
    by_id = {lane["id"]: lane for lane in lanes}
    changes = [{"laneId": track["id"], "name": track["name"][:80], "instrument": instrument_of(track),
                "notes": track.get("notes") or []}
               for track in proposal.get("tracks", [])[:MAX_LANES] if track.get("kind") == "midi"]
    if not changes or len(by_id.keys() | {change["laneId"] for change in changes}) > MAX_LANES:
        return None
    return {"id": proposal["id"], "brief": proposal.get("brief") or "Suggested parts", "changes": changes,
            "base": {change["laneId"]: digest(by_id.get(change["laneId"])) for change in changes}}


def migrate(project):
    """Bring a schema-1 song (tracks) forward to lanes without touching its source files."""
    if project.get("schema") == 2:
        return project
    lanes = []
    for track in project.get("tracks", [])[:MAX_LANES]:
        lane = new_lane(track["id"], track["name"][:80], instrument_of(track),
                        "audio" if track["kind"] == "audio" else "midi")
        lane["notes"] = track.get("notes") or []
        if track["kind"] == "audio":
            capture = next((c for c in project.get("captures", []) if c["id"] == track["id"]), None)
            lane["audio"] = {"captureId": track["id"], "startMs": 0, "offsetMs": 0, "durationMs": track.get("durationMs") or 0,
                             "mime": (capture or {}).get("mime", "audio/wav")}
            lane["play"] = "audio"
        lanes.append(lane)
    migrated = {**empty_project(project["id"]), "title": project.get("title", "Untitled song"),
                "revision": project.get("revision", 0), "lanes": lanes, "captures": project.get("captures", [])}
    suggestion = migrate_proposal(project["proposal"], lanes) if project.get("proposal") else None
    if suggestion:
        migrated["proposal"] = suggestion
    return migrated
