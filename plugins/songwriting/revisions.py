"""Reviewed edits replace only explicitly named, unprotected generated parts."""
from uuid import uuid4

from .storage import SongError


def fence(project, revision):
    if project["revision"] != revision:
        raise SongError(409, "Song changed; refresh before continuing")


def validate_changes(project, tracks):
    existing = {track["id"]: track for track in project["tracks"]}
    ids = [track["id"] for track in tracks]
    if len(set(ids)) != len(ids):
        raise SongError(400, "Duplicate track IDs")
    for track in tracks:
        old = existing.get(track["id"])
        if old and (old["protected"] or old["origin"] != "generated"):
            raise SongError(400, "Source tracks are protected and cannot be replaced")
        if track["origin"] != "generated" or track["protected"] or track["kind"] != "midi" or track.get("path"):
            raise SongError(400, "Proposals must contain unprotected generated symbolic parts")
    if len(set(existing) | set(ids)) > 32:
        raise SongError(400, "A song may contain at most 32 tracks")


def propose(store, request):
    with store.transaction() as (_, project):
        fence(project, request.baseRevision)
        tracks = [track.model_dump(exclude_none=True) for track in request.tracks]
        validate_changes(project, tracks)
        project["proposal"] = {"id": uuid4().hex, "baseRevision": project["revision"],
                               "tracks": tracks, "brief": request.brief}
    return {"project": project, "proposal": project["proposal"]}


def pending(project, proposal_id):
    proposal = project.get("proposal")
    if not proposal or proposal["id"] != proposal_id:
        raise SongError(409, "Proposal is no longer pending; refresh the song")
    fence(project, proposal["baseRevision"])
    return proposal


def apply(store, request):
    import json
    with store.transaction() as (conn, project):
        fence(project, request.baseRevision)
        proposal = pending(project, request.proposalId)
        validate_changes(project, proposal["tracks"])
        replacements = {track["id"]: track for track in proposal["tracks"]}
        before = {track["id"]: track for track in project["tracks"]}
        history = {"tracks": {key: before.get(key) for key in replacements}, "brief": project["brief"]}
        conn.execute("INSERT INTO history(project) VALUES (?)", (json.dumps(history),))
        conn.execute("DELETE FROM history WHERE id NOT IN (SELECT id FROM history ORDER BY id DESC LIMIT 32)")
        project["tracks"] = [replacements.pop(track["id"], track) for track in project["tracks"]]
        project["tracks"].extend(replacements.values())
        project["brief"] = proposal["brief"]
        project["revision"] += 1
        project.pop("proposal")
    return project


def reject(store, request):
    with store.transaction() as (_, project):
        pending(project, request.proposalId)
        project.pop("proposal")
    return project


def undo(store, request):
    import json
    with store.transaction() as (conn, project):
        fence(project, request.baseRevision)
        row = conn.execute("SELECT id, project FROM history ORDER BY id DESC LIMIT 1").fetchone()
        if row is None:
            raise SongError(409, "No applied proposal to undo")
        history = json.loads(row[1])
        previous = history["tracks"]
        tracks = []
        for track in project["tracks"]:
            if track["id"] not in previous:
                tracks.append(track)
            elif previous[track["id"]] is not None:
                tracks.append(previous[track["id"]])
        project["tracks"], project["brief"] = tracks, history["brief"]
        project["revision"] += 1
        project.pop("proposal", None)
        conn.execute("DELETE FROM history WHERE id=?", (row[0],))
    return project
