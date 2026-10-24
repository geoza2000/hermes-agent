"""FastAPI surface mounted by Hermes' authenticated, profile-scoped plugin host."""
from json import JSONDecodeError
import sqlite3

from fastapi import APIRouter, HTTPException
from fastapi.exceptions import RequestValidationError
from fastapi.routing import APIRoute
from starlette.responses import JSONResponse

from .models import ApplyRequest, AudioRequest, MidiTake, ProposalRequest, RejectRequest, RenderRequest, UndoRequest
from . import audio, revisions
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


def run(session_id, action, *args):
    try:
        store = SongStore(session_id)
        if action in ("propose", "apply", "reject", "undo"):
            return getattr(revisions, action)(store, *args)
        if action in ("upload", "render"):
            return getattr(audio, action)(store, *args)
        return getattr(store, action)(*args)
    except SongError as exc:
        raise HTTPException(exc.status, exc.message) from exc
    except (OSError, sqlite3.Error, JSONDecodeError) as exc:
        raise HTTPException(503, "Songwriting storage is unavailable; sources have not been replaced") from exc


@router.get("/sessions/{session_id}/project")
def project(session_id: str):
    return run(session_id, "read")


@router.post("/sessions/{session_id}/captures")
def capture(session_id: str, take: MidiTake):
    return run(session_id, "capture_midi", take)


@router.post("/sessions/{session_id}/proposal")
def proposal(session_id: str, request: ProposalRequest):
    return run(session_id, "propose", request)


@router.post("/sessions/{session_id}/apply")
def apply(session_id: str, request: ApplyRequest):
    return run(session_id, "apply", request)


@router.post("/sessions/{session_id}/reject")
def reject(session_id: str, request: RejectRequest):
    return run(session_id, "reject", request)


@router.post("/sessions/{session_id}/undo")
def undo(session_id: str, request: UndoRequest):
    return run(session_id, "undo", request)


@router.post("/sessions/{session_id}/audio")
def upload(session_id: str, request: AudioRequest):
    return run(session_id, "upload", request)


@router.post("/sessions/{session_id}/render")
@router.post("/sessions/{session_id}/export")
def render(session_id: str, request: RenderRequest):
    return run(session_id, "render", request)
