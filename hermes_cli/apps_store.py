"""Hermes Apps — personal mini apps Hermes builds and iterates on, stored per profile.

Every function takes the owning profile home explicitly: one dashboard process serves several
profiles, so an ambient ``get_hermes_home()`` read here would be a silent cross-profile leak.

Layout under ``<home>/apps/``::

    <slug>/app.json        manifest (name, icon, visibility, telemetry, version history)
    <slug>/draft/          working copy Hermes edits; previewed, never served as "current"
    <slug>/versions/<n>/   immutable published snapshots; ``current_version`` selects one
    <slug>/data/<key>.json app-owned records written through the in-app data API
    <slug>/events/         usage telemetry (see :mod:`hermes_cli.apps_telemetry`)

Publishing copies ``draft/`` into a new version, so the live app changes only on an explicit
publish and every earlier version stays available for rollback.
"""

from __future__ import annotations

import json
import os
import re
import shutil
import tempfile
import time
from pathlib import Path
from typing import Any, Optional

SCHEMA_VERSION = 1
SLUG_RE = re.compile(r"^[a-z0-9][a-z0-9-]{0,47}$")
VISIBILITIES = ("private", "public")
_NAME_MAX = 80
_DESCRIPTION_MAX = 400
_ICON_MAX = 16
_NOTE_MAX = 400
_DATA_KEY_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$")
DATA_VALUE_MAX_BYTES = 256 * 1024
DATA_MAX_KEYS = 200
AGENT_PROMPT_MAX = 8000
_AGENT_NAME_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9_.:/-]{0,79}$")

_STARTER_HTML = """<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
  <title>{name}</title>
  <style>
    :root {{ color-scheme: light dark; font-family: system-ui, sans-serif; }}
    body {{ margin: 0; min-height: 100vh; display: grid; place-items: center; }}
    main {{ text-align: center; padding: 24px; }}
    .icon {{ font-size: 48px; }}
  </style>
</head>
<body>
  <main>
    <div class="icon">{icon}</div>
    <h1>{name}</h1>
    <p>Ask Hermes in any chat to build this app.</p>
  </main>
</body>
</html>
"""


class AppError(ValueError):
    """Invalid input or a missing app. The message is safe to show the user."""


class AppNotFound(AppError):
    pass


def apps_root(home: Path) -> Path:
    return Path(home) / "apps"


def validate_slug(slug: str) -> str:
    if not isinstance(slug, str) or not SLUG_RE.match(slug):
        raise AppError("App id must be 1-48 lowercase letters, digits or hyphens, starting with a letter or digit.")
    return slug


def app_dir(home: Path, slug: str) -> Path:
    return apps_root(home) / validate_slug(slug)


def _now() -> float:
    return round(time.time(), 3)


def _write_json_atomic(path: Path, payload: Any) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    fd, tmp = tempfile.mkstemp(prefix=f".{path.name}.", dir=str(path.parent))
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as handle:
            json.dump(payload, handle, indent=2, sort_keys=True)
            handle.write("\n")
        os.replace(tmp, path)
    except BaseException:
        Path(tmp).unlink(missing_ok=True)
        raise


def _clean_text(value: Any, field: str, limit: int, *, required: bool = False) -> str:
    text = "" if value is None else str(value).strip()
    if required and not text:
        raise AppError(f"{field} is required.")
    if len(text) > limit:
        raise AppError(f"{field} must be at most {limit} characters.")
    return text


def load_manifest(home: Path, slug: str) -> dict[str, Any]:
    path = app_dir(home, slug) / "app.json"
    try:
        manifest = json.loads(path.read_text(encoding="utf-8-sig"))
    except FileNotFoundError:
        raise AppNotFound(f"App '{slug}' does not exist.") from None
    except (OSError, json.JSONDecodeError) as exc:
        raise AppError(f"App '{slug}' has an unreadable manifest: {exc}") from exc
    if not isinstance(manifest, dict) or manifest.get("slug") != slug:
        raise AppError(f"App '{slug}' has an invalid manifest.")
    return manifest


def _save_manifest(home: Path, manifest: dict[str, Any]) -> dict[str, Any]:
    manifest["updated_at"] = _now()
    _write_json_atomic(app_dir(home, manifest["slug"]) / "app.json", manifest)
    return manifest


def create_app(home: Path, slug: str, name: str, *, icon: str = "", description: str = "") -> dict[str, Any]:
    """Create an app with a starter draft. Nothing is published until :func:`publish`."""
    root = app_dir(home, slug)
    name = _clean_text(name, "Name", _NAME_MAX, required=True)
    icon = _clean_text(icon, "Icon", _ICON_MAX) or "🧩"
    description = _clean_text(description, "Description", _DESCRIPTION_MAX)
    if (root / "app.json").exists():
        raise AppError(f"App '{slug}' already exists.")
    draft = root / "draft"
    draft.mkdir(parents=True, exist_ok=True)
    index = draft / "index.html"
    if not index.exists():
        index.write_text(_STARTER_HTML.format(name=_html_escape(name), icon=_html_escape(icon)), encoding="utf-8")
    created = _now()
    manifest = {
        "schema_version": SCHEMA_VERSION,
        "slug": slug,
        "name": name,
        "icon": icon,
        "description": description,
        "visibility": "private",
        "telemetry": {"enabled": True, "capture_values": False},
        "current_version": None,
        "versions": [],
        "created_at": created,
    }
    return _save_manifest(home, manifest)


def _html_escape(text: str) -> str:
    return text.replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;").replace('"', "&quot;")


def list_apps(home: Path) -> list[dict[str, Any]]:
    root = apps_root(home)
    if not root.is_dir():
        return []
    apps = []
    for child in sorted(root.iterdir()):
        if not child.is_dir() or not SLUG_RE.match(child.name):
            continue
        try:
            apps.append(load_manifest(home, child.name))
        except AppError:
            continue  # a half-written or foreign folder is not an app; never fail the whole list
    return sorted(apps, key=lambda m: m.get("updated_at") or 0, reverse=True)


def update_app(home: Path, slug: str, changes: dict[str, Any]) -> dict[str, Any]:
    """Apply user-editable manifest changes. Unknown keys are rejected rather than stored."""
    manifest = load_manifest(home, slug)
    allowed = {"name", "icon", "description", "visibility", "telemetry", "agent"}
    unknown = set(changes) - allowed
    if unknown:
        raise AppError(f"Unsupported app settings: {', '.join(sorted(unknown))}.")
    if "name" in changes:
        manifest["name"] = _clean_text(changes["name"], "Name", _NAME_MAX, required=True)
    if "icon" in changes:
        manifest["icon"] = _clean_text(changes["icon"], "Icon", _ICON_MAX) or "🧩"
    if "description" in changes:
        manifest["description"] = _clean_text(changes["description"], "Description", _DESCRIPTION_MAX)
    if "visibility" in changes:
        if changes["visibility"] not in VISIBILITIES:
            raise AppError("Visibility must be 'private' or 'public'.")
        manifest["visibility"] = changes["visibility"]
    if "telemetry" in changes:
        manifest["telemetry"] = _merge_telemetry(manifest.get("telemetry") or {}, changes["telemetry"])
    if "agent" in changes:
        manifest["agent"] = _clean_agent(changes["agent"])
    return _save_manifest(home, manifest)


def _clean_names(value: Any, field: str, limit: int) -> list[str]:
    if value in (None, ""):
        return []
    if not isinstance(value, list) or len(value) > limit:
        raise AppError(f"Agent {field} must be a list of at most {limit} names.")
    names = [str(v).strip() for v in value if str(v).strip()]
    if any(not _AGENT_NAME_RE.match(n) for n in names):
        raise AppError(f"Agent {field} contain an invalid name.")
    return list(dict.fromkeys(names))


def _clean_agent(agent: Any) -> Optional[dict[str, Any]]:
    """The session setup an app's requests run with: instructions, preloaded skills, toolsets."""
    if agent is None:
        return None
    if not isinstance(agent, dict) or set(agent) - {"prompt", "skills", "toolsets"}:
        raise AppError("Agent settings accept only 'prompt', 'skills' and 'toolsets'.")
    return {
        "prompt": _clean_text(agent.get("prompt"), "Agent prompt", AGENT_PROMPT_MAX),
        "skills": _clean_names(agent.get("skills"), "skills", 10),
        "toolsets": _clean_names(agent.get("toolsets"), "toolsets", 20) or None,
    }


def _merge_telemetry(current: dict[str, Any], incoming: Any) -> dict[str, Any]:
    if not isinstance(incoming, dict) or set(incoming) - {"enabled", "capture_values"}:
        raise AppError("Telemetry settings accept only 'enabled' and 'capture_values'.")
    merged = {"enabled": bool(current.get("enabled", True)), "capture_values": bool(current.get("capture_values", False))}
    for key, value in incoming.items():
        if not isinstance(value, bool):
            raise AppError(f"Telemetry '{key}' must be true or false.")
        merged[key] = value
    return merged


def _draft_has_entry(draft: Path) -> bool:
    return (draft / "index.html").is_file()


def publish(home: Path, slug: str, *, note: str = "") -> dict[str, Any]:
    """Explicit CLI publication snapshots and checks the current draft."""
    from hermes_cli import apps_revisions

    revision = apps_revisions.review(home, slug)
    return apps_revisions.publish_review(home, slug, revision, note=note)


def _publish_snapshot(home: Path, slug: str, draft: Path, *, note: str = "") -> dict[str, Any]:
    """Called under the app changes lock with an immutable reviewed source."""
    manifest = load_manifest(home, slug)
    root = app_dir(home, slug)
    if not _draft_has_entry(draft):
        raise AppError(f"App '{slug}' has no draft/index.html to publish.")
    note = _clean_text(note, "Note", _NOTE_MAX)
    number = max((int(v["number"]) for v in manifest.get("versions") or []), default=0) + 1
    target = root / "versions" / str(number)
    staging = root / "versions" / f".staging-{number}"
    shutil.rmtree(staging, ignore_errors=True)
    shutil.copytree(draft, staging, symlinks=False, ignore=shutil.ignore_patterns(".*"))
    os.replace(staging, target)
    manifest.setdefault("versions", []).append({"number": number, "published_at": _now(), "note": note})
    manifest["current_version"] = number
    return _save_manifest(home, manifest)


def rollback(home: Path, slug: str, version: int) -> dict[str, Any]:
    manifest = load_manifest(home, slug)
    known = {int(v["number"]) for v in manifest.get("versions") or []}
    if version not in known or not (app_dir(home, slug) / "versions" / str(version)).is_dir():
        raise AppError(f"App '{slug}' has no version {version}.")
    manifest["current_version"] = version
    return _save_manifest(home, manifest)


def content_dir(home: Path, slug: str, *, preview: bool = False) -> Optional[Path]:
    """The directory a viewer sees: the draft for previews, else the current version."""
    root = app_dir(home, slug)
    if preview:
        return root / "draft"
    manifest = load_manifest(home, slug)
    current = manifest.get("current_version")
    return None if current is None else root / "versions" / str(int(current))


def resolve_asset(base: Path, rel_path: str) -> Optional[Path]:
    """Resolve ``rel_path`` inside ``base`` or return None.

    Rejects traversal, hidden segments (``.git``, dotfiles) and symlinks that escape ``base``.
    A directory resolves to its ``index.html``.
    """
    parts = [p for p in (rel_path or "").split("/") if p not in ("", ".")]
    if any(p == ".." or p.startswith(".") or "\\" in p or "\x00" in p for p in parts):
        return None
    try:
        root = base.resolve(strict=True)
    except (FileNotFoundError, OSError):
        return None
    candidate = root.joinpath(*parts) if parts else root
    if candidate.is_dir():
        candidate = candidate / "index.html"
    try:
        resolved = candidate.resolve(strict=True)
    except (FileNotFoundError, OSError):
        return None
    if resolved != root and root not in resolved.parents:
        return None
    return resolved if resolved.is_file() else None


# ── App data: small JSON records an app stores through the in-app SDK ────────────────────────

def _data_path(home: Path, slug: str, key: str) -> Path:
    if not isinstance(key, str) or not _DATA_KEY_RE.match(key):
        raise AppError("Data keys must be 1-64 letters, digits, dots, hyphens or underscores.")
    load_manifest(home, slug)
    return app_dir(home, slug) / "data" / f"{key}.json"


def data_get(home: Path, slug: str, key: str) -> Any:
    path = _data_path(home, slug, key)
    try:
        return json.loads(path.read_text(encoding="utf-8-sig"))
    except FileNotFoundError:
        return None


def data_put(home: Path, slug: str, key: str, raw: bytes) -> Any:
    """Store ``raw`` (JSON text) under ``key``. Size and key-count are capped per app."""
    path = _data_path(home, slug, key)
    if len(raw) > DATA_VALUE_MAX_BYTES:
        raise AppError(f"Data values are limited to {DATA_VALUE_MAX_BYTES // 1024} KB.")
    try:
        value = json.loads(raw.decode("utf-8"))
    except (UnicodeDecodeError, json.JSONDecodeError) as exc:
        raise AppError("Data values must be JSON.") from exc
    if not path.exists() and len(data_keys(home, slug)) >= DATA_MAX_KEYS:
        raise AppError(f"An app can store at most {DATA_MAX_KEYS} data keys.")
    _write_json_atomic(path, value)
    return value


def data_delete(home: Path, slug: str, key: str) -> bool:
    path = _data_path(home, slug, key)
    existed = path.exists()
    path.unlink(missing_ok=True)
    return existed


def data_keys(home: Path, slug: str) -> list[str]:
    folder = app_dir(home, slug) / "data"
    if not folder.is_dir():
        return []
    return sorted(p.stem for p in folder.glob("*.json") if _DATA_KEY_RE.match(p.stem))
