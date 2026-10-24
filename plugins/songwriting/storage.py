"""Atomic session-owned persistence; every request resolves the current profile afresh."""
from contextlib import contextmanager
from itertools import islice
import json
import logging
import os
from pathlib import Path
import re
import sqlite3
from typing import cast
from uuid import uuid4

from hermes_cli.sqlite_safe_read import TrackedConnection, connect_tracked
from hermes_constants import get_hermes_home
from hermes_state import SessionDB
from plugins.plugin_storage import plugin_data_dir

from .schema import empty_project, migrate

MAX_SESSION_BYTES = 256 * 1024 * 1024
MAX_RECONCILE_ASSETS = 64
logger = logging.getLogger(__name__)


class SongError(Exception):
    def __init__(self, status: int, message: str):
        self.status, self.message = status, message
        super().__init__(message)


def session_owner(session_id: str) -> str:
    if not isinstance(session_id, str) or not re.fullmatch(r"[a-zA-Z0-9_-]{1,160}", session_id):
        raise SongError(400, "Invalid session ID")
    path = get_hermes_home() / "state.db"
    if not path.is_file():
        raise SongError(404, "Session not found in this profile")
    db = SessionDB(db_path=path, read_only=True)
    try:
        row = db.get_session(session_id)
        if row is None:
            raise SongError(404, "Session not found in this profile")
        # Use the store's own lineage policy: compressed parents alone do not
        # establish ownership (explicit branch/reset/delegate markers win).
        lineage = db.get_compression_lineage(session_id)
        return lineage[0] if lineage else row["id"]
    finally:
        db.close()


def checked_path(root: Path, path: Path) -> Path:
    """Reject symlinks, including ones that point back inside the owned tree."""
    try:
        relative = path.relative_to(root)
    except ValueError as exc:
        raise SongError(400, "Path is not owned by this song") from exc
    current = root
    if root.is_symlink():
        raise SongError(400, "Symlinked song storage is not allowed")
    for part in relative.parts:
        if part in (".", ".."):
            raise SongError(400, "Invalid song path")
        current = current / part
        if current.is_symlink():
            raise SongError(400, "Symlinked song storage is not allowed")
    if not path.resolve().is_relative_to(root.resolve()):
        raise SongError(400, "Path is not owned by this song")
    return path


class SongConnection(TrackedConnection):
    _song_assets: list[str]


class SongStore:
    def __init__(self, session_id: str):
        self.session_id = session_owner(session_id)
        self.home = get_hermes_home().resolve()
        self.root = self.home / "plugin-data/songwriting"
        self.directory = checked_path(self.home, self.root / "sessions" / self.session_id)
        self.db_path = self.directory / "project.sqlite"
        self.pending_directory = self.directory / ".pending-assets"

    def read(self) -> dict:
        checked_path(self.home, self.db_path)
        if not self.db_path.exists():
            return empty_project(self.session_id)
        conn = connect_tracked(f"{self.db_path.as_uri()}?mode=ro", uri=True, timeout=10)
        try:
            if conn.execute("SELECT 1 FROM sqlite_master WHERE type='table' AND name='song'").fetchone() is None:
                return empty_project(self.session_id)
            row = conn.execute("SELECT project FROM song WHERE id=1").fetchone()
            return migrate(json.loads(row[0])) if row else empty_project(self.session_id)
        finally:
            conn.close()

    @contextmanager
    def transaction(self):
        checked_path(self.home, self.db_path)
        plugin_data_dir("songwriting")
        self.directory.mkdir(parents=True, exist_ok=True, mode=0o700)
        checked_path(self.home, self.db_path)
        conn = cast(SongConnection, connect_tracked(self.db_path, timeout=10, isolation_level=None, factory=SongConnection))
        assets = []
        conn._song_assets = assets
        committing = False
        try:
            conn.execute("BEGIN IMMEDIATE")
            conn.execute("CREATE TABLE IF NOT EXISTS song (id INTEGER PRIMARY KEY, project TEXT NOT NULL)")
            conn.execute("CREATE TABLE IF NOT EXISTS history (id INTEGER PRIMARY KEY, project TEXT NOT NULL)")
            conn.execute("CREATE TABLE IF NOT EXISTS assets (name TEXT PRIMARY KEY)")
            self.reconcile_pending(conn)
            row = conn.execute("SELECT project FROM song WHERE id=1").fetchone()
            project = migrate(json.loads(row[0])) if row else empty_project(self.session_id)
            yield conn, project
            try:
                serialized = json.dumps(project, allow_nan=False)
            except (TypeError, ValueError) as exc:
                raise SongError(503, "Songwriting project could not be saved; sources have not been replaced") from exc
            conn.execute("INSERT OR REPLACE INTO song VALUES (1, ?)", (serialized,))
            self.publish_assets(assets)
            committing = True
            conn.commit()
        except BaseException as exc:
            # A commit may have landed before its caller raised. Only rows that
            # survive rollback are evidence; deleting first can destroy sources.
            try:
                conn.rollback()
                committed = self.committed_assets(conn, assets)
            except (sqlite3.Error, OSError):
                if assets:
                    logger.warning("Songwriting publication outcome is unconfirmed; receipts retained for the next write")
                raise
            self.finish_assets(assets, committed)
            if not (committing and assets and committed == set(assets)
                    and isinstance(exc, (sqlite3.Error, OSError))):
                raise
        else:
            self.finish_assets(assets, set(assets))
        finally:
            conn.close()

    def committed_assets(self, conn, names):
        if conn.execute("SELECT 1 FROM sqlite_master WHERE type='table' AND name='assets'").fetchone() is None:
            return set()
        return {name for name in names if conn.execute("SELECT 1 FROM assets WHERE name=?", (name,)).fetchone()}

    def reconcile_pending(self, conn):
        pending = checked_path(self.home, self.pending_directory)
        if not pending.exists():
            return
        # Only interrupted publications live here; a bounded batch makes progress
        # without walking the potentially much larger collection of completed mixes.
        with os.scandir(pending) as entries:
            names = [entry.name for entry in islice(entries, MAX_RECONCILE_ASSETS)]
        self.remove_pending(names, self.committed_assets(conn, names))

    def remove_pending(self, names, committed):
        for name in names:
            if not re.fullmatch(r"[0-9a-f]{32}\.(?:midi\.json|pcm\.wav|mix\.wav|wav|webm|ogg|m4a|mp3|flac)", name):
                raise SongError(503, "Songwriting publication recovery is unavailable")
            staging = checked_path(self.home, self.pending_directory / name)
            path = checked_path(self.home, self.directory / name)
            # A failed no-overwrite publication may have collided with an older
            # source. Only our staging inode proves the final link is ours.
            if name not in committed and staging.exists() and path.exists() and path.samefile(staging):
                path.unlink()
            staging.unlink(missing_ok=True)

    def finish_assets(self, names, committed):
        try:
            self.remove_pending(names, committed)
        except OSError:
            # Keep the staging receipt for the next locked reconciliation. A
            # completed commit must still return its paths, not strand an export.
            logger.warning("Songwriting asset cleanup deferred until the next write")

    def publish_assets(self, names):
        for name in names:
            staging = checked_path(self.home, self.pending_directory / name)
            path = checked_path(self.home, self.directory / name)
            # Keep the staging link as a receipt until the DB outcome is known.
            os.link(staging, path)

    def write_asset(self, data: bytes, suffix: str, *, conn) -> Path:
        used = sum(checked_path(self.home, path).stat().st_size for path in self.directory.iterdir() if path.is_file())
        used += sum(checked_path(self.home, self.pending_directory / name).stat().st_size for name in conn._song_assets)
        if used + len(data) > MAX_SESSION_BYTES:
            raise SongError(400, "Song storage limit reached (256 MiB); preserve sources and start a new song")
        path = checked_path(self.home, self.directory / (uuid4().hex + suffix))
        checked_path(self.home, self.pending_directory).mkdir(exist_ok=True, mode=0o700)
        staging = checked_path(self.home, self.pending_directory / path.name)
        conn._song_assets.append(path.name)
        conn.execute("INSERT INTO assets(name) VALUES (?)", (path.name,))
        flags = os.O_WRONLY | os.O_CREAT | os.O_EXCL | getattr(os, "O_NOFOLLOW", 0)
        fd = os.open(staging, flags, 0o600)
        with os.fdopen(fd, "wb") as output:
            output.write(data)
            output.flush()
            os.fsync(output.fileno())
        # Validation/decoding uses staging; no final path is published until the
        # transaction body and project serialization have both succeeded.
        return path
