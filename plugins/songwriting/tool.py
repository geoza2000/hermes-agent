"""Hermes's hands on the song: read lanes, add or retune lanes, and suggest note changes.

Uses the conversation's configured model; this tool never calls another model. Note changes
are suggestions the listener previews and keeps or discards in the Songwriting pane.
"""
import json
import sqlite3
from typing import Literal

from pydantic import Field, ValidationError

from . import lanes
from .models import (LANE_ID, AddLaneRequest, Instrument, LaneChange, ProposalRequest, SongSettingsRequest,
                     UpdateLaneRequest, Wire)
from .storage import SongError, SongStore


class ToolRequest(Wire):
    action: Literal["read", "read_capture", "add_lane", "set_lane", "set_tempo", "propose"]
    captureId: str | None = Field(default=None, max_length=100)
    laneId: str | None = Field(default=None, pattern=LANE_ID)
    name: str | None = Field(default=None, min_length=1, max_length=80)
    instrument: Instrument | None = None
    source: Literal["midi", "voice", "audio"] | None = None
    tempo: int | None = Field(default=None, ge=40, le=240)
    brief: str | None = Field(default=None, max_length=8000)
    changes: list[LaneChange] | None = Field(default=None, max_length=16)


SCHEMA = {
    "name": "songwriting",
    "description": ("Work on the song in this chat's Songwriting pane. read: lanes, notes, tempo and the "
                    "selected lane. read_capture: a take's raw MIDI events. add_lane: a new empty lane the "
                    "user records into (source midi = keyboard, voice = hum/sing and convert to the "
                    "instrument, audio = plain recording). set_lane: rename or change a lane's General MIDI "
                    "instrument. set_tempo: song BPM. propose: suggested note/instrument changes, new lanes "
                    "or removals that the user previews and keeps or discards; never applied by you."),
    "parameters": ToolRequest.model_json_schema(),
}


def read_capture(store, capture_id):
    capture, path = lanes.capture_file(store, capture_id)
    if capture["kind"] != "midi":
        return {"capture": capture, "note": "Audio recording; its pitch-tracked notes are on the lane."}
    if path.stat().st_size > 4 * 1024 * 1024:
        raise SongError(400, "Take exceeds the read budget")
    return {"capture": capture, "take": json.loads(path.read_text())}


def run(store, request):
    action = request.action
    if action == "read":
        return {"project": store.read(),
                "hint": "selectedLaneId is the lane the user means by 'this lane'."}
    if action == "read_capture":
        return read_capture(store, request.captureId)
    if action == "add_lane":
        if not (request.name and request.instrument and request.source):
            raise SongError(422, "add_lane needs name, instrument and source")
        return lanes.add_lane(store, AddLaneRequest(name=request.name, instrument=request.instrument,
                                                    source=request.source))
    if action == "set_lane":
        if not request.laneId:
            raise SongError(422, "set_lane needs laneId")
        return lanes.update_lane(store, request.laneId, UpdateLaneRequest(name=request.name,
                                                                          instrument=request.instrument))
    if action == "set_tempo":
        return lanes.settings(store, SongSettingsRequest(tempo=request.tempo))
    if not (request.brief and request.changes):
        raise SongError(422, "propose needs brief and changes")
    return lanes.propose(store, ProposalRequest(brief=request.brief, changes=request.changes))


def handle(args, **context):
    session_id = context.get("session_id")
    if not session_id:
        return json.dumps({"error": "Songwriting requires the calling session context", "status": 403})
    try:
        result = run(SongStore(session_id), ToolRequest.model_validate(args))
        return json.dumps(result, allow_nan=False)
    except ValidationError:
        return json.dumps({"error": "Invalid songwriting arguments; use the tool schema", "status": 422})
    except SongError as exc:
        return json.dumps({"error": exc.message, "status": exc.status})
    except (OSError, sqlite3.Error, json.JSONDecodeError):
        return json.dumps({"error": "Songwriting storage is unavailable", "status": 503})
