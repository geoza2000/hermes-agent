"""Use the conversation's configured Hermes model; this tool never calls another LLM."""
import json
import sqlite3
from pathlib import Path
from typing import Literal

from pydantic import Field, ValidationError

from . import audio, revisions
from .models import ProposalRequest, RenderRequest, SongTrack, Wire
from .storage import SongError, SongStore, checked_path


class ToolRequest(Wire):
    action: Literal["read", "read_capture", "propose", "render", "export"]
    captureId: str | None = Field(default=None, max_length=100)
    baseRevision: int | None = Field(default=None, ge=0)
    brief: str | None = Field(default=None, max_length=8000)
    tracks: list[SongTrack] | None = Field(default=None, max_length=32)
    trackIds: list[str] | None = Field(default=None, max_length=32)


SCHEMA = {
    "name": "songwriting",
    "description": "Read this chat's song and immutable capture events, propose editable symbolic instrumental parts for human review, or render/export local sequenced synthesis. Cannot apply edits. No external music service.",
    "parameters": ToolRequest.model_json_schema(),
}


def read_capture(store, capture_id):
    project = store.read()
    capture = next((item for item in project["captures"] if item["id"] == capture_id), None)
    if capture is None:
        raise SongError(400, "Choose an existing capture ID from the project")
    path = checked_path(store.home, Path(capture["path"]))
    if path.parent != store.directory:
        raise SongError(400, "Capture is not owned by this session")
    if capture["kind"] == "midi":
        if path.stat().st_size > 4 * 1024 * 1024:
            raise SongError(400, "Capture exceeds the read budget")
        return {"capture": capture, "take": json.loads(path.read_text()),
                "sourceFidelity": "Raw MIDI channels, controllers and device metadata are retained; symbolic playback is approximate."}
    return {"capture": capture, "sourceFidelity": "Immutable original audio and a local PCM playback copy; no transcription or stem separation is claimed."}


def handle(args, **context):
    session_id = context.get("session_id")
    if not session_id:
        return json.dumps({"error": "Songwriting requires the calling session context", "status": 403})
    try:
        request = ToolRequest.model_validate(args)
        store = SongStore(session_id)
        if request.action == "read":
            result = {"project": store.read(), "method": "Configured Hermes LLM + local sequenced synthesis",
                      "next": "Use read_capture with each relevant capture ID to inspect actual source events before proposing parts."}
        elif request.action == "read_capture":
            result = read_capture(store, request.captureId)
        elif request.action == "propose":
            proposal = ProposalRequest.model_validate({"baseRevision": request.baseRevision,
                                                       "brief": request.brief,
                                                       "tracks": [t.model_dump(exclude_none=True) for t in request.tracks] if request.tracks else None})
            result = revisions.propose(store, proposal)
        else:
            result = audio.render(store, RenderRequest(trackIds=request.trackIds))
        return json.dumps(result, allow_nan=False)
    except ValidationError:
        return json.dumps({"error": "Invalid songwriting arguments; use the tool schema", "status": 422})
    except SongError as exc:
        return json.dumps({"error": exc.message, "status": exc.status})
    except (OSError, sqlite3.Error, json.JSONDecodeError):
        return json.dumps({"error": "Songwriting storage is unavailable", "status": 503})
