"""FastAPI surface mounted by Hermes' authenticated, profile-scoped plugin host."""
from json import JSONDecodeError
import sqlite3

from fastapi import APIRouter, HTTPException
from fastapi.exceptions import RequestValidationError
from fastapi.routing import APIRoute
from starlette.responses import JSONResponse

from .models import (AddLaneRequest, ApplyRequest, AudioTakeRequest, MidiTakeRequest, RejectRequest,
                     SongSettingsRequest, UpdateLaneRequest)
from . import lanes, soundfont
from .storage import SongError, SongStore

class BoundedRoute(APIRoute):
    def get_route_handler(self):
        original = super().get_route_handler()

        async def bounded(request):
            limit = 28 * 1024 * 1024 if request.url.path.endswith("/audio") else 4 * 1024 * 1024
            header = request.headers.get("content-length")
            if header is not None:
                try:
                    size = int(header)
                except ValueError:
                    raise HTTPException(400, "Invalid Content-Length") from None
                if size < 0 or size > limit:
                    raise HTTPException(400, "Songwriting request exceeds size limit")
            body = bytearray()
            async for chunk in request.stream():
                if len(body) + len(chunk) > limit:
                    raise HTTPException(400, "Songwriting request exceeds size limit")
                body.extend(chunk)
            request._body = bytes(body)
            try:
                return await original(request)
            except RequestValidationError as exc:
                # Never echo base64 uploads or raw recordings into error responses.
                details = [{"loc": error["loc"], "type": error["type"], "msg": error["msg"]}
                           for error in exc.errors()[:10]]
                return JSONResponse({"detail": details}, status_code=422)
        return bounded


router = APIRouter(route_class=BoundedRoute)


def run(action, *args):
    try:
        return action(*args)
    except SongError as exc:
        raise HTTPException(exc.status, exc.message) from exc
    except (OSError, sqlite3.Error, JSONDecodeError) as exc:
        raise HTTPException(503, "Songwriting storage is unavailable; recordings have not been replaced") from exc


def store_for(session_id):
    return run(SongStore, session_id)


@router.get("/soundfont")
def soundfont_status():
    return run(soundfont.status)


@router.post("/soundfont/install")
def soundfont_install():
    return run(soundfont.install)


@router.get("/soundfont/chunks/{index}")
def soundfont_chunk(index: int):
    return run(soundfont.chunk, index)


@router.get("/sessions/{session_id}/project")
def project(session_id: str):
    return run(store_for(session_id).read)


@router.post("/sessions/{session_id}/settings")
def song_settings(session_id: str, request: SongSettingsRequest):
    return run(lanes.settings, store_for(session_id), request)


@router.post("/sessions/{session_id}/lanes")
def add_lane(session_id: str, request: AddLaneRequest):
    return run(lanes.add_lane, store_for(session_id), request)


@router.post("/sessions/{session_id}/lanes/{lane_id}")
def update_lane(session_id: str, lane_id: str, request: UpdateLaneRequest):
    return run(lanes.update_lane, store_for(session_id), lane_id, request)


@router.post("/sessions/{session_id}/lanes/{lane_id}/delete")
def delete_lane(session_id: str, lane_id: str):
    return run(lanes.delete_lane, store_for(session_id), lane_id)


@router.post("/sessions/{session_id}/lanes/{lane_id}/midi")
def record_midi(session_id: str, lane_id: str, request: MidiTakeRequest):
    return run(lanes.record_midi, store_for(session_id), lane_id, request)


@router.post("/sessions/{session_id}/lanes/{lane_id}/audio")
def record_audio(session_id: str, lane_id: str, request: AudioTakeRequest):
    return run(lanes.record_audio, store_for(session_id), lane_id, request)


@router.get("/sessions/{session_id}/captures/{capture_id}/chunks/{index}")
def capture_chunk(session_id: str, capture_id: str, index: int):
    return run(lanes.capture_chunk, store_for(session_id), capture_id, index)


@router.post("/sessions/{session_id}/apply")
def apply(session_id: str, request: ApplyRequest):
    return run(lanes.apply, store_for(session_id), request)


@router.post("/sessions/{session_id}/reject")
def reject(session_id: str, request: RejectRequest):
    return run(lanes.reject, store_for(session_id), request)


@router.post("/sessions/{session_id}/undo")
def undo(session_id: str):
    return run(lanes.undo, store_for(session_id))
