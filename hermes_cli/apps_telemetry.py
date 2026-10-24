"""Hermes Apps usage telemetry: local, per-app, opt-out, values off by default.

Events stay on this machine under ``<home>/apps/<slug>/events/`` as daily JSONL files. They
exist so Hermes can learn how an app is actually used (in a chat about the app, and in the
scheduled improvement review) — nothing here sends data anywhere.

Owner and public viewers write to separate daily files with separate caps, so anonymous traffic
on a public app can never crowd out the owner's own history.
"""

from __future__ import annotations

import json
import time
from collections import Counter
from datetime import UTC, datetime, timedelta
from pathlib import Path
from typing import Any, Iterable, Iterator

from hermes_cli.apps_store import AppError, app_dir, load_manifest

EVENT_TYPES = frozenset({"view", "navigate", "click", "input", "change", "submit", "error", "slow", "custom"})
VIEWERS = ("owner", "public")
MAX_BATCH = 100
MAX_BODY_BYTES = 64 * 1024
_DAILY_CAP_BYTES = {"owner": 2 * 1024 * 1024, "public": 512 * 1024}
_TARGET_MAX = 200
_NAME_MAX = 60
_PROPS_MAX_KEYS = 12
_PROP_TEXT_MAX = 200
_VALUE_KEYS = frozenset({"value", "text", "content"})


def _events_dir(home: Path, slug: str) -> Path:
    return app_dir(home, slug) / "events"


def _day(ts: float) -> str:
    return datetime.fromtimestamp(ts, tz=UTC).strftime("%Y-%m-%d")


def _day_file(home: Path, slug: str, viewer: str, day: str) -> Path:
    prefix = "" if viewer == "owner" else f"{viewer}-"
    return _events_dir(home, slug) / f"{prefix}{day}.jsonl"


def _clean_props(props: Any, capture_values: bool) -> dict[str, Any]:
    if not isinstance(props, dict):
        return {}
    cleaned: dict[str, Any] = {}
    for key, value in list(props.items())[:_PROPS_MAX_KEYS]:
        key = str(key)[:_NAME_MAX]
        if key in _VALUE_KEYS and not capture_values:
            continue
        if isinstance(value, bool) or value is None or isinstance(value, (int, float)):
            cleaned[key] = value
        elif isinstance(value, str):
            cleaned[key] = value[:_PROP_TEXT_MAX]
    return cleaned


def _clean_event(raw: Any, capture_values: bool, received: float) -> dict[str, Any] | None:
    if not isinstance(raw, dict):
        return None
    kind = raw.get("type")
    if kind not in EVENT_TYPES:
        return None
    event: dict[str, Any] = {"type": kind, "received_at": received}
    target = raw.get("target")
    if isinstance(target, str) and target:
        event["target"] = target[:_TARGET_MAX]
    name = raw.get("name")
    if kind == "custom" and isinstance(name, str) and name:
        event["name"] = name[:_NAME_MAX]
    ts = raw.get("ts")
    if isinstance(ts, (int, float)) and not isinstance(ts, bool):
        event["ts"] = float(ts)
    session = raw.get("session")
    if isinstance(session, str) and session:
        event["session"] = session[:40]
    props = _clean_props(raw.get("props"), capture_values)
    if props:
        event["props"] = props
    return event


def parse_batch(body: bytes) -> list[Any]:
    if len(body) > MAX_BODY_BYTES:
        raise AppError("Telemetry batch is too large.")
    try:
        payload = json.loads(body.decode("utf-8") or "{}")
    except (UnicodeDecodeError, json.JSONDecodeError) as exc:
        raise AppError("Telemetry batch must be JSON.") from exc
    events = payload.get("events") if isinstance(payload, dict) else None
    if not isinstance(events, list):
        raise AppError("Telemetry batch must be an object with an 'events' list.")
    return events[:MAX_BATCH]


def record_events(home: Path, slug: str, events: Iterable[Any], *, viewer: str) -> int:
    """Append validated events. Returns how many were stored (0 when telemetry is off)."""
    if viewer not in VIEWERS:
        raise AppError("Unknown telemetry viewer.")
    manifest = load_manifest(home, slug)
    settings = manifest.get("telemetry") or {}
    if not settings.get("enabled", True):
        return 0
    received = round(time.time(), 3)
    capture_values = bool(settings.get("capture_values", False)) and viewer == "owner"
    cleaned = [e for e in (_clean_event(raw, capture_values, received) for raw in events) if e]
    if viewer != "owner":
        for event in cleaned:
            event["viewer"] = viewer
    if not cleaned:
        return 0
    path = _day_file(home, slug, viewer, _day(received))
    path.parent.mkdir(parents=True, exist_ok=True)
    lines = "".join(json.dumps(e, separators=(",", ":"), sort_keys=True) + "\n" for e in cleaned)
    size = path.stat().st_size if path.exists() else 0
    if size + len(lines.encode("utf-8")) > _DAILY_CAP_BYTES[viewer]:
        return 0
    with path.open("a", encoding="utf-8") as handle:
        handle.write(lines)
    return len(cleaned)


def iter_events(home: Path, slug: str, *, days: int = 7, include_public: bool = True) -> Iterator[dict[str, Any]]:
    load_manifest(home, slug)
    folder = _events_dir(home, slug)
    if not folder.is_dir():
        return
    today = datetime.now(tz=UTC).date()
    wanted = {(today - timedelta(days=n)).strftime("%Y-%m-%d") for n in range(max(1, days))}
    viewers = VIEWERS if include_public else ("owner",)
    for day in sorted(wanted):
        for viewer in viewers:
            path = _day_file(home, slug, viewer, day)
            if not path.is_file():
                continue
            with path.open(encoding="utf-8") as handle:
                for line in handle:
                    try:
                        yield json.loads(line)
                    except json.JSONDecodeError:
                        continue


def summarize(home: Path, slug: str, *, days: int = 7) -> dict[str, Any]:
    """Aggregate counts the improvement review reads. Contains no captured values."""
    by_type: Counter[str] = Counter()
    targets: Counter[str] = Counter()
    errors: Counter[str] = Counter()
    per_day: Counter[str] = Counter()
    sessions: set[str] = set()
    public = 0
    total = 0
    for event in iter_events(home, slug, days=days):
        total += 1
        kind = event.get("type", "")
        by_type[kind] += 1
        if event.get("viewer") == "public":
            public += 1
        if event.get("session"):
            sessions.add(event["session"])
        label = event.get("name") or event.get("target")
        if label and kind in {"click", "submit", "change", "input", "navigate", "custom"}:
            targets[f"{kind}: {label}"] += 1
        if kind == "error":
            errors[str(event.get("target") or "unknown")] += 1
        if "received_at" in event:
            per_day[_day(float(event["received_at"]))] += 1
    return {
        "days": days,
        "total_events": total,
        "public_events": public,
        "sessions": len(sessions),
        "by_type": dict(by_type.most_common()),
        "top_interactions": [{"label": k, "count": v} for k, v in targets.most_common(20)],
        "errors": [{"target": k, "count": v} for k, v in errors.most_common(10)],
        "per_day": dict(sorted(per_day.items())),
    }


def clear_events(home: Path, slug: str) -> int:
    load_manifest(home, slug)
    folder = _events_dir(home, slug)
    removed = 0
    if folder.is_dir():
        for path in folder.glob("*.jsonl"):
            path.unlink(missing_ok=True)
            removed += 1
    return removed
