"""Serving Hermes Apps to browsers: HTML injection, the in-app SDK, PWA manifest and headers.

Every app document is served with ``Content-Security-Policy: sandbox`` (no ``allow-same-origin``),
so agent-written app code runs in an opaque origin on the same host as the dashboard without
being able to read its cookies, storage or ``/api/*``. The only server surface an app reaches
is ``<base>_hermes/*`` under its own capability or public base path.
"""

from __future__ import annotations

import json
import mimetypes
import re
from html import escape as _attr
from pathlib import Path
from typing import Any

from fastapi.responses import FileResponse, HTMLResponse, Response

APP_SANDBOX = "sandbox allow-scripts allow-forms allow-popups allow-popups-to-escape-sandbox allow-downloads allow-modals"
THEME_COLOR = "#1540b1"

_HEAD_CLOSE_RE = re.compile(r"</head\s*>", re.IGNORECASE)
_HTML_TYPES = {".html", ".htm"}

# The in-app runtime lives in a real JS file so it is linted and exercised by tests-js.
SDK_JS = (Path(__file__).parent / "data" / "apps_sdk.js").read_text(encoding="utf-8-sig")


def app_headers(*, html: bool) -> dict[str, str]:
    headers = {
        "Content-Security-Policy": APP_SANDBOX,
        "Referrer-Policy": "no-referrer",
        "X-Content-Type-Options": "nosniff",
        # The document runs in an opaque origin, so its own module scripts and data calls are
        # cross-origin requests. The base path is the capability; nothing here uses credentials.
        "Access-Control-Allow-Origin": "*",
        "Cross-Origin-Resource-Policy": "cross-origin",
    }
    headers["Cache-Control"] = "no-store" if html else "private, max-age=60"
    return headers


def inject_runtime(html: str, *, base: str, viewer: str, telemetry: bool, capture_values: bool, data_enabled: bool) -> str:
    tags = (
        f'<link rel="manifest" href="{_attr(base)}_hermes/manifest.webmanifest">'
        f'<link rel="icon" href="{_attr(base)}_hermes/icon.svg">'
        f'<meta name="theme-color" content="{THEME_COLOR}">'
        f'<meta name="apple-mobile-web-app-capable" content="yes">'
        f'<script src="{_attr(base)}_hermes/sdk.js" data-hermes-base="{_attr(base)}"'
        f' data-hermes-viewer="{_attr(viewer)}" data-hermes-telemetry="{int(telemetry)}"'
        f' data-hermes-values="{int(capture_values)}" data-hermes-data="{int(data_enabled)}"></script>'
    )
    match = _HEAD_CLOSE_RE.search(html)
    if match:
        return html[: match.start()] + tags + html[match.start():]
    return tags + html


def icon_svg(icon: str) -> str:
    glyph = _attr(icon or "🧩")
    return (
        '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 128 128">'
        f'<rect width="128" height="128" rx="28" fill="{THEME_COLOR}"/>'
        f'<text x="64" y="86" font-size="68" text-anchor="middle">{glyph}</text></svg>'
    )


def web_manifest(manifest: dict[str, Any], *, base: str, start_url: str) -> dict[str, Any]:
    name = manifest.get("name") or manifest["slug"]
    return {
        "name": name,
        "short_name": name[:24],
        "description": manifest.get("description") or "",
        "start_url": start_url,
        "scope": "/",
        "display": "standalone",
        "background_color": "#ffffff",
        "theme_color": THEME_COLOR,
        "icons": [{"src": f"{base}_hermes/icon.svg", "sizes": "any", "type": "image/svg+xml", "purpose": "any"}],
    }


def file_response(path: Path, manifest: dict[str, Any], *, base: str, viewer: str, data_enabled: bool) -> Response:
    if path.suffix.lower() in _HTML_TYPES:
        settings = manifest.get("telemetry") or {}
        html = inject_runtime(
            path.read_text(encoding="utf-8-sig", errors="replace"),
            base=base,
            viewer=viewer,
            telemetry=bool(settings.get("enabled", True)),
            capture_values=bool(settings.get("capture_values", False)) and viewer == "owner",
            data_enabled=data_enabled,
        )
        return HTMLResponse(html, headers=app_headers(html=True))
    media_type = mimetypes.guess_type(path.name)[0] or "application/octet-stream"
    return FileResponse(path, media_type=media_type, headers=app_headers(html=False))


def message_page(title: str, body: str, *, status: int) -> HTMLResponse:
    html = (
        "<!doctype html><meta charset=utf-8><meta name=viewport content='width=device-width,initial-scale=1'>"
        f"<title>{_attr(title)}</title><body style='font-family:system-ui;display:grid;place-items:center;"
        f"min-height:90vh;margin:0;text-align:center'><main><h1>{_attr(title)}</h1><p>{_attr(body)}</p></main>"
    )
    return HTMLResponse(html, status_code=status, headers=app_headers(html=True))


def json_response(payload: Any, *, status: int = 200) -> Response:
    return Response(
        json.dumps(payload), status_code=status, media_type="application/json", headers=app_headers(html=False) | {"Cache-Control": "no-store"}
    )


def sdk_response() -> Response:
    return Response(SDK_JS, media_type="text/javascript", headers=app_headers(html=False))


def icon_response(manifest: dict[str, Any]) -> Response:
    return Response(icon_svg(manifest.get("icon") or ""), media_type="image/svg+xml", headers=app_headers(html=False))


def manifest_response(manifest: dict[str, Any], *, base: str, start_url: str) -> Response:
    return Response(
        json.dumps(web_manifest(manifest, base=base, start_url=start_url)),
        media_type="application/manifest+json",
        headers=app_headers(html=False),
    )

