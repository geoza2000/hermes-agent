"""Hermes Apps routes: the owner API under ``/api/apps`` and the three ways a browser opens an app.

* ``/apps/<profile>/<slug>/``   signed-in entry (dashboard session or native Desktop principal).
                                 Mints a fresh link and redirects; this is the PWA start URL.
* ``/apps-cap/<token>/...``      capability link; the token names one app and expires.
* ``/apps-public/<profile>/<slug>/...``  only while the owner has made the app public.

The last two are listed as public prefixes for the OAuth gate because the gate's cookie cannot
reach a sandboxed document; the token or the app's public flag is the boundary, checked here.
Public viewers never get the app-data API, so publishing an app never exposes the owner's records.
"""

from __future__ import annotations

import asyncio
import json
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Optional
from urllib.parse import quote

from fastapi import APIRouter, HTTPException, Request
from fastapi.responses import RedirectResponse, Response

from hermes_cli import apps_jobs, apps_links, apps_store, apps_telemetry, apps_web
from hermes_cli.web_deps import late
from hermes_cli.web_routers._common import config_scoped_to_thread, destructive_profile

router = APIRouter()
_require_token = late("_require_token")

CAP_PREFIX = "/apps-cap/"
PUBLIC_PREFIX = "/apps-public/"
ENTRY_PREFIX = "/apps/"


# ── profile ↔ home ────────────────────────────────────────────────────────────────────────────

def _profile_name_for_home(home: Path) -> str:
    from hermes_cli import profiles

    resolved = home.resolve()
    if resolved == profiles._get_default_hermes_home().resolve():
        return "default"
    try:
        parts = resolved.relative_to(profiles._get_profiles_root().resolve()).parts
    except ValueError:
        return "custom"
    return parts[0] if len(parts) == 1 else "custom"


def _home_for_profile(name: str) -> Optional[Path]:
    """The home a URL's profile segment names, or None. ``custom`` is only the process's own home."""
    from hermes_cli import profiles
    from hermes_cli.config import get_process_hermes_home

    if name == "custom":
        process_home = get_process_hermes_home()
        return process_home if _profile_name_for_home(process_home) == "custom" else None
    try:
        profiles.validate_profile_name(name)
    except ValueError:
        return None
    if not profiles.profile_exists(name):
        return None
    return profiles.get_profile_dir(name)


def _current_home_and_name() -> tuple[Path, str]:
    from hermes_constants import get_hermes_home

    home = get_hermes_home()
    return home, _profile_name_for_home(home)


# ── owner API ─────────────────────────────────────────────────────────────────────────────────

def _app_error(exc: apps_store.AppError) -> HTTPException:
    status = 404 if isinstance(exc, apps_store.AppNotFound) else 400
    return HTTPException(status_code=status, detail=str(exc))


async def _scoped(profile: Optional[str], fn) -> Any:
    try:
        return await config_scoped_to_thread(profile, fn)
    except apps_store.AppError as exc:
        raise _app_error(exc) from exc


def _paths(name: str, manifest: dict[str, Any]) -> dict[str, Optional[str]]:
    slug = manifest["slug"]
    entry = f"{ENTRY_PREFIX}{quote(name)}/{slug}/"
    public = f"{PUBLIC_PREFIX}{quote(name)}/{slug}/" if manifest.get("visibility") == "public" else None
    return {"entry_path": entry, "public_path": public}


def _summary(name: str, manifest: dict[str, Any]) -> dict[str, Any]:
    return {**manifest, **_paths(name, manifest), "profile": name}


@router.get("/api/apps")
async def list_apps(request: Request, profile: Optional[str] = None):
    _require_token(request)

    def run():
        home, name = _current_home_and_name()
        return {"profile": name, "apps": [_summary(name, m) for m in apps_store.list_apps(home)]}

    return await _scoped(profile, run)


@router.get("/api/apps/{slug}")
async def get_app(slug: str, request: Request, profile: Optional[str] = None, days: int = 7):
    _require_token(request)

    def run():
        home, name = _current_home_and_name()
        manifest = apps_store.load_manifest(home, slug)
        return {
            "app": _summary(name, manifest),
            "insights": apps_telemetry.summarize(home, slug, days=max(1, min(days, 90))),
            "data_keys": len(apps_store.data_keys(home, slug)),
        }

    return await _scoped(profile, run)


@router.patch("/api/apps/{slug}")
async def update_app(slug: str, request: Request, profile: Optional[str] = None):
    _require_token(request)
    changes = await request.json()
    if not isinstance(changes, dict):
        raise HTTPException(status_code=400, detail="Expected a JSON object of app settings.")
    if "visibility" in changes:
        # Making an app public is privileged: never let an omitted profile pick the target.
        profile = destructive_profile(profile, "PATCH /api/apps/{slug}")

    def run():
        home, name = _current_home_and_name()
        return {"app": _summary(name, apps_store.update_app(home, slug, changes))}

    return await _scoped(profile, run)


@router.post("/api/apps/{slug}/publish")
async def publish_app(slug: str, request: Request, profile: Optional[str] = None):
    _require_token(request)
    body = await _optional_json(request)

    def run():
        home, name = _current_home_and_name()
        return {"app": _summary(name, apps_store.publish(home, slug, note=str(body.get("note") or "")))}

    return await _scoped(profile, run)


@router.post("/api/apps/{slug}/rollback")
async def rollback_app(slug: str, request: Request, profile: Optional[str] = None):
    _require_token(request)
    body = await _optional_json(request)
    version = body.get("version")
    if not isinstance(version, int) or isinstance(version, bool):
        raise HTTPException(status_code=400, detail="'version' must be a version number.")

    def run():
        home, name = _current_home_and_name()
        return {"app": _summary(name, apps_store.rollback(home, slug, version))}

    return await _scoped(profile, run)


@router.post("/api/apps/{slug}/link")
async def mint_app_link(slug: str, request: Request, profile: Optional[str] = None):
    """A signed link for this owner's viewer: the Desktop frame, "Open in browser", a phone."""
    _require_token(request)
    body = await _optional_json(request)
    mode = "preview" if body.get("preview") else "live"
    raw_ttl = body.get("ttl")
    ttl = raw_ttl if isinstance(raw_ttl, int) and not isinstance(raw_ttl, bool) else apps_links.DEFAULT_TTL_SECONDS

    def run():
        home, name = _current_home_and_name()
        apps_store.load_manifest(home, slug)
        token, expires = apps_links.mint(home, name, slug, ttl=ttl, mode=mode)
        return {"path": f"{CAP_PREFIX}{token}/", "expires_at": expires, "mode": mode}

    return await _scoped(profile, run)


@router.post("/api/apps/{slug}/telemetry/clear")
async def clear_app_telemetry(slug: str, request: Request, profile: Optional[str] = None):
    _require_token(request)
    profile = destructive_profile(profile, "POST /api/apps/{slug}/telemetry/clear")

    def run():
        home, _ = _current_home_and_name()
        return {"removed_files": apps_telemetry.clear_events(home, slug)}

    return await _scoped(profile, run)


@router.get("/api/apps/{slug}/jobs")
async def list_app_jobs(slug: str, request: Request, profile: Optional[str] = None, limit: int = 20):
    """Recent session requests an app made, for the owner's Desktop view."""
    _require_token(request)

    def run():
        home, _ = _current_home_and_name()
        apps_store.load_manifest(home, slug)
        jobs = apps_jobs.list_jobs(home, slug, limit=max(1, min(limit, 50)))
        return {"jobs": [apps_jobs.public_view(j) for j in jobs]}

    return await _scoped(profile, run)


@router.post("/api/apps-links/revoke")
async def revoke_app_links(request: Request, profile: Optional[str] = None):
    _require_token(request)
    profile = destructive_profile(profile, "POST /api/apps-links/revoke")

    def run():
        home, _ = _current_home_and_name()
        apps_links.rotate_key(home)
        return {"ok": True}

    return await _scoped(profile, run)


async def _optional_json(request: Request) -> dict[str, Any]:
    raw = await request.body()
    if not raw:
        return {}
    try:
        body = await request.json()
    except ValueError as exc:
        raise HTTPException(status_code=400, detail="Expected a JSON body.") from exc
    if not isinstance(body, dict):
        raise HTTPException(status_code=400, detail="Expected a JSON object.")
    return body


# ── viewers ───────────────────────────────────────────────────────────────────────────────────

@dataclass(frozen=True)
class _View:
    home: Path
    profile: str
    slug: str
    base: str
    viewer: str  # "owner" | "public"
    preview: bool

    @property
    def data_enabled(self) -> bool:
        return self.viewer == "owner"

    @property
    def start_url(self) -> str:
        if self.viewer == "public":
            return self.base
        return f"{ENTRY_PREFIX}{quote(self.profile)}/{self.slug}/"


def _cap_view(token: str) -> Optional[_View]:
    verified = apps_links.verify(token, _home_for_profile)
    if verified is None:
        return None
    link, home = verified
    return _View(home, link.profile, link.slug, f"{CAP_PREFIX}{token}/", "owner", link.preview)


def _public_view(profile: str, slug: str) -> Optional[_View]:
    home = _home_for_profile(profile)
    if home is None or not apps_store.SLUG_RE.match(slug):
        return None
    try:
        manifest = apps_store.load_manifest(home, slug)
    except apps_store.AppError:
        return None
    if manifest.get("visibility") != "public":
        return None
    return _View(home, profile, slug, f"{PUBLIC_PREFIX}{quote(profile)}/{slug}/", "public", False)


def _not_found() -> Response:
    return apps_web.message_page("App not found", "This app link is invalid, expired, or the app is private.", status=404)


def _serve(view: Optional[_View], rel_path: str) -> Response:
    if view is None:
        return _not_found()
    try:
        manifest = apps_store.load_manifest(view.home, view.slug)
        folder = apps_store.content_dir(view.home, view.slug, preview=view.preview)
    except apps_store.AppError:
        return _not_found()
    if folder is None:
        return apps_web.message_page(manifest.get("name") or view.slug, "This app has not been published yet.", status=404)
    asset = apps_store.resolve_asset(folder, rel_path)
    if asset is None:
        return apps_web.message_page("Not found", "This page is not part of the app.", status=404)
    return apps_web.file_response(asset, manifest, base=view.base, viewer=view.viewer, data_enabled=view.data_enabled)


def _runtime_asset(view: Optional[_View], name: str) -> Response:
    if view is None:
        return _not_found()
    if name == "sdk.js":
        return apps_web.sdk_response()
    try:
        manifest = apps_store.load_manifest(view.home, view.slug)
    except apps_store.AppError:
        return _not_found()
    if name == "icon.svg":
        return apps_web.icon_response(manifest)
    return apps_web.manifest_response(manifest, base=view.base, start_url=view.start_url)


async def _events(view: Optional[_View], request: Request) -> Response:
    if view is None:
        return _not_found()
    body = await request.body()
    try:
        events = apps_telemetry.parse_batch(body)
        stored = await asyncio.to_thread(apps_telemetry.record_events, view.home, view.slug, events, viewer=view.viewer)
    except apps_store.AppError as exc:
        return apps_web.json_response({"error": str(exc)}, status=400)
    return apps_web.json_response({"stored": stored})


def _data_denied(view: Optional[_View]) -> Optional[Response]:
    if view is None:
        return _not_found()
    if not view.data_enabled:
        return apps_web.json_response({"error": "App data is only available to the app's owner."}, status=403)
    return None


async def _data(view: Optional[_View], key: Optional[str], request: Request, op: str) -> Response:
    denied = _data_denied(view)
    if denied is not None or view is None:
        return denied or _not_found()
    key = key or ""
    try:
        if op == "keys":
            result: dict[str, Any] = {"keys": await asyncio.to_thread(apps_store.data_keys, view.home, view.slug)}
        elif op == "get":
            result = {"value": await asyncio.to_thread(apps_store.data_get, view.home, view.slug, key)}
        elif op == "put":
            raw = await request.body()
            result = {"value": await asyncio.to_thread(apps_store.data_put, view.home, view.slug, key, raw)}
        else:
            result = {"deleted": await asyncio.to_thread(apps_store.data_delete, view.home, view.slug, key)}
    except apps_store.AppError as exc:
        return apps_web.json_response({"error": str(exc)}, status=400)
    return apps_web.json_response(result)


# Signed-in entry. Literal ``_hermes`` routes precede the catch-all on every base.

@router.get("/apps/{profile}/{slug}")
@router.get("/apps/{profile}/{slug}/{rel_path:path}")
async def app_entry(profile: str, slug: str, request: Request, rel_path: str = ""):
    signed_in = getattr(request.state, "session", None) is not None or getattr(request.state, "native_http_principal", None)
    if not signed_in:
        return apps_web.message_page(
            "Sign in to open this app",
            "Private Hermes apps open from Hermes Desktop or a signed-in Hermes dashboard.",
            status=401,
        )
    home = _home_for_profile(profile)
    if home is None or not apps_store.SLUG_RE.match(slug):
        return _not_found()
    try:
        apps_store.load_manifest(home, slug)
    except apps_store.AppError:
        return _not_found()
    token, _ = await asyncio.to_thread(apps_links.mint, home, profile, slug)
    target = f"{CAP_PREFIX}{token}/{rel_path}"
    if request.url.query:
        target += f"?{request.url.query}"
    return RedirectResponse(target, status_code=302, headers={"Cache-Control": "no-store", "Referrer-Policy": "no-referrer"})


@router.post("/apps-cap/{token}/_hermes/events")
async def cap_events(token: str, request: Request):
    return await _events(_cap_view(token), request)


@router.get("/apps-cap/{token}/_hermes/data")
async def cap_data_keys(token: str, request: Request):
    return await _data(_cap_view(token), None, request, "keys")


@router.get("/apps-cap/{token}/_hermes/data/{key}")
async def cap_data_get(token: str, key: str, request: Request):
    return await _data(_cap_view(token), key, request, "get")


@router.post("/apps-cap/{token}/_hermes/data/{key}")
async def cap_data_put(token: str, key: str, request: Request):
    return await _data(_cap_view(token), key, request, "put")


@router.post("/apps-cap/{token}/_hermes/data-delete/{key}")
async def cap_data_delete(token: str, key: str, request: Request):
    return await _data(_cap_view(token), key, request, "delete")


# ── app → Hermes session handoff (owner viewers only) ─────────────────────────────────────────

_UPLOAD_MAX_BYTES = apps_jobs.TOTAL_FILES_MAX_BYTES + 1024 * 1024


def _json_or_error(text: str):
    try:
        return json.loads(text)
    except json.JSONDecodeError as exc:
        raise apps_store.AppError("Expected JSON.") from exc


async def _json_body(request: Request) -> dict:
    body = _json_or_error((await request.body()).decode("utf-8", "replace") or "{}")
    if not isinstance(body, dict):
        raise apps_store.AppError("Expected a JSON object.")
    return body


async def _session_request(request: Request) -> tuple[str, list[tuple[str, bytes]], object]:
    """``prompt``/``context``/``files`` from multipart (files attached) or a JSON text body."""
    length = request.headers.get("content-length", "")
    if length.isdigit() and int(length) > _UPLOAD_MAX_BYTES:
        raise apps_store.AppError("The request is too large.")
    if not request.headers.get("content-type", "").startswith("multipart/form-data"):
        body = await _json_body(request)
        return str(body.get("prompt") or ""), [], body.get("context")
    form = await request.form(max_files=apps_jobs.MAX_FILES, max_fields=8)
    files = [(upload.filename or "", await upload.read())
             for upload in form.getlist("files") if not isinstance(upload, str)]
    raw_context, prompt = form.get("context"), form.get("prompt")
    context = _json_or_error(raw_context) if isinstance(raw_context, str) and raw_context else None
    return (prompt if isinstance(prompt, str) else ""), files, context


def _launch(view: _View, job_id: str) -> dict:
    """Start the worker; a spawn failure is recorded on the job so the app sees why."""
    from hermes_cli.apps_job_launcher import launch_job_worker

    try:
        launch_job_worker(view.home, view.profile, view.slug, job_id)
    except OSError as exc:
        job = apps_jobs.load_job(view.home, view.slug, job_id)
        job.update(status="failed", error=f"Could not start Hermes: {exc}")
        apps_jobs.save_job(view.home, view.slug, job)
    return apps_jobs.load_job(view.home, view.slug, job_id)


def _session_denied(view: Optional[_View]) -> Optional[Response]:
    if view is None:
        return _not_found()
    if view.viewer != "owner":
        return apps_web.json_response({"error": "Hermes sessions are only available to the app's owner."}, status=403)
    return None


async def _session_op(view: _View, request: Request, op: str, job_id: str) -> dict:
    home, slug = view.home, view.slug
    if op == "get":
        return await asyncio.to_thread(apps_jobs.load_job, home, slug, job_id)
    if op == "answer":
        answers = (await _json_body(request)).get("answers")
        return await asyncio.to_thread(apps_jobs.submit_answer, home, slug, job_id, answers)
    if op == "create":
        prompt, files, context = await _session_request(request)
        job = await asyncio.to_thread(apps_jobs.create_job, home, slug, prompt, files=files, context=context)
    else:
        message = (await _json_body(request)).get("message")
        job = await asyncio.to_thread(apps_jobs.queue_message, home, slug, job_id, message)
    return await asyncio.to_thread(_launch, view, job["id"])


async def _sessions(view: Optional[_View], request: Request, op: str, job_id: str = "") -> Response:
    denied = _session_denied(view)
    if denied is not None or view is None:
        return denied or _not_found()
    try:
        if op == "list":
            jobs = await asyncio.to_thread(apps_jobs.list_jobs, view.home, view.slug)
            return apps_web.json_response({"sessions": [apps_jobs.public_view(j) for j in jobs]})
        job = await _session_op(view, request, op, job_id)
    except apps_store.AppNotFound as exc:
        return apps_web.json_response({"error": str(exc)}, status=404)
    except apps_store.AppError as exc:
        return apps_web.json_response({"error": str(exc)}, status=429 if "in progress" in str(exc) else 400)
    return apps_web.json_response({"session": apps_jobs.public_view(job)})


@router.get("/apps-cap/{token}/_hermes/sessions")
async def cap_sessions_list(token: str, request: Request):
    return await _sessions(_cap_view(token), request, "list")


@router.post("/apps-cap/{token}/_hermes/sessions")
async def cap_sessions_create(token: str, request: Request):
    return await _sessions(_cap_view(token), request, "create")


@router.get("/apps-cap/{token}/_hermes/sessions/{job_id}")
async def cap_session_get(token: str, job_id: str, request: Request):
    return await _sessions(_cap_view(token), request, "get", job_id)


@router.post("/apps-cap/{token}/_hermes/sessions/{job_id}/answer")
async def cap_session_answer(token: str, job_id: str, request: Request):
    return await _sessions(_cap_view(token), request, "answer", job_id)


@router.post("/apps-cap/{token}/_hermes/sessions/{job_id}/message")
async def cap_session_message(token: str, job_id: str, request: Request):
    return await _sessions(_cap_view(token), request, "message", job_id)


# After the literal data routes: ``_hermes/{name}`` would otherwise swallow ``_hermes/data``.
@router.get("/apps-cap/{token}/_hermes/{name}")
async def cap_runtime(token: str, name: str):
    return _runtime_asset(_cap_view(token), name) if name in _RUNTIME_ASSETS else _not_found()


@router.get("/apps-cap/{token}")
async def cap_root_redirect(token: str):
    return RedirectResponse(f"{CAP_PREFIX}{token}/", status_code=308)


@router.get("/apps-cap/{token}/{rel_path:path}")
async def cap_file(token: str, rel_path: str = ""):
    return await asyncio.to_thread(_serve, _cap_view(token), rel_path)


@router.post("/apps-public/{profile}/{slug}/_hermes/events")
async def public_events(profile: str, slug: str, request: Request):
    return await _events(_public_view(profile, slug), request)


@router.api_route("/apps-public/{profile}/{slug}/_hermes/data{rest:path}", methods=["GET", "POST"])
async def public_data(profile: str, slug: str, rest: str):
    return _data_denied(_public_view(profile, slug)) or _not_found()


@router.api_route("/apps-public/{profile}/{slug}/_hermes/data-delete/{key}", methods=["POST"])
async def public_data_delete(profile: str, slug: str, key: str):
    return _data_denied(_public_view(profile, slug)) or _not_found()


@router.api_route("/apps-public/{profile}/{slug}/_hermes/sessions{rest:path}", methods=["GET", "POST"])
async def public_sessions(profile: str, slug: str, rest: str):
    return _session_denied(_public_view(profile, slug)) or _not_found()


@router.get("/apps-public/{profile}/{slug}/_hermes/{name}")
async def public_runtime(profile: str, slug: str, name: str):
    return _runtime_asset(_public_view(profile, slug), name) if name in _RUNTIME_ASSETS else _not_found()


@router.get("/apps-public/{profile}/{slug}")
async def public_root_redirect(profile: str, slug: str):
    return RedirectResponse(f"{PUBLIC_PREFIX}{quote(profile)}/{slug}/", status_code=308)


@router.get("/apps-public/{profile}/{slug}/{rel_path:path}")
async def public_file(profile: str, slug: str, rel_path: str = ""):
    return await asyncio.to_thread(_serve, _public_view(profile, slug), rel_path)


_RUNTIME_ASSETS = frozenset({"sdk.js", "icon.svg", "manifest.webmanifest"})
