"""Immutable draft review snapshots and compare-before-publish authority.

The bytes copied into a review are the bytes published, even if an external editor races
publication. A changed draft fails closed; no timestamp or UI checkbox stands in for identity.
"""
from __future__ import annotations

import hashlib
import re
import secrets
import shutil
import threading
from pathlib import Path

from hermes_cli import apps_store
from hermes_cli.auth import _file_lock

_LOCK = threading.Lock()
_HOLDERS: dict[str, threading.local] = {}
_REVISION = re.compile(r"^[a-f0-9]{64}$")
MAX_BYTES = 10 * 1024 * 1024


def app_lock(home: Path, slug: str):
    path = apps_store.app_dir(home, slug) / '.changes.lock'
    with _LOCK:
        holder = _HOLDERS.setdefault(str(path.resolve()), threading.local())
    return _file_lock(path, holder, 30.0, 'App is busy. Try again.')


def files(folder: Path) -> dict[str, bytes]:
    result = {}
    size = 0
    for path in sorted(folder.rglob('*')):
        rel = path.relative_to(folder)
        if path.is_symlink():
            raise apps_store.AppError('App drafts must not contain symlinks.')
        if any(part.startswith('.') for part in rel.parts) or not path.is_file():
            continue
        size += path.stat().st_size
        if size > MAX_BYTES or len(result) >= 500:
            raise apps_store.AppError('Draft exceeds the review limit (10 MB / 500 files).')
        raw = path.read_bytes()
        if len(raw) + sum(map(len, result.values())) > MAX_BYTES:
            raise apps_store.AppError('Draft exceeds the review size limit.')
        result[rel.as_posix()] = raw
    if 'index.html' not in result:
        raise apps_store.AppError('Draft needs index.html.')
    return result


def identity(content: dict[str, bytes]) -> str:
    digest = hashlib.sha256()
    for name, raw in sorted(content.items()):
        digest.update(name.encode('utf-8') + b'\x00' + str(len(raw)).encode('ascii') + b'\x00' + raw)
    return digest.hexdigest()


def draft_revision(home: Path, slug: str) -> str:
    apps_store.load_manifest(home, slug)
    return identity(files(apps_store.app_dir(home, slug) / 'draft'))


def snapshot_dir(home: Path, slug: str, revision: str) -> Path:
    if not isinstance(revision, str) or not _REVISION.fullmatch(revision):
        raise apps_store.AppError('A reviewed revision is required. Preview the draft again.')
    return apps_store.app_dir(home, slug) / 'reviews' / revision


def review(home: Path, slug: str) -> str:
    apps_store.load_manifest(home, slug)
    with app_lock(home, slug):
        content = files(apps_store.app_dir(home, slug) / 'draft')
        revision = identity(content)
        target = snapshot_dir(home, slug, revision)
        if not target.exists():
            staging = target.with_name('.staging-' + secrets.token_hex(8))
            try:
                for name, raw in content.items():
                    path = staging / name
                    path.parent.mkdir(parents=True, exist_ok=True)
                    path.write_bytes(raw)
                staging.rename(target)
            finally:
                shutil.rmtree(staging, ignore_errors=True)
        return revision


def publish_review(home: Path, slug: str, revision: str, *, note: str = '') -> dict:
    target = snapshot_dir(home, slug, revision)
    with app_lock(home, slug):
        if not target.is_dir() or identity(files(target)) != revision:
            raise apps_store.AppError('Reviewed snapshot unavailable. Preview the draft again.')
        if draft_revision(home, slug) != revision:
            raise apps_store.AppError('Draft changed since review. Preview and approve the new revision.')
        return apps_store._publish_snapshot(home, slug, target, note=note)
