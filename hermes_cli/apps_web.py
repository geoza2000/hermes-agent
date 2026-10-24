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

# Kept small and dependency-free: it runs inside every app. Values typed into fields are never
# read unless the owner turned on capture_values for this app.
SDK_JS = r"""(() => {
  const script = document.currentScript;
  const cfg = script ? script.dataset : {};
  const base = cfg.hermesBase || './';
  const telemetry = cfg.hermesTelemetry === '1';
  const captureValues = cfg.hermesValues === '1';
  const dataEnabled = cfg.hermesData === '1';
  const session = Math.random().toString(36).slice(2, 12);
  const queue = [];
  let timer = null;

  const send = (events, keepalive) => {
    if (!events.length) return;
    try {
      fetch(base + '_hermes/events', {
        method: 'POST', mode: 'cors', credentials: 'omit', keepalive: Boolean(keepalive),
        headers: { 'Content-Type': 'text/plain' }, body: JSON.stringify({ events })
      }).catch(() => {});
    } catch (_) {}
  };
  const flush = keepalive => { clearTimeout(timer); timer = null; send(queue.splice(0, 100), keepalive); };
  const push = event => {
    if (!telemetry) return;
    queue.push(Object.assign({ ts: Date.now(), session }, event));
    if (queue.length >= 20) flush(false);
    else if (!timer) timer = setTimeout(() => flush(false), 5000);
  };

  const label = el => {
    if (!el || el.nodeType !== 1) return '';
    const own = el.getAttribute('data-track') || el.getAttribute('aria-label') || el.id || el.getAttribute('name');
    if (own) return String(own).slice(0, 80);
    const tag = el.tagName.toLowerCase();
    if (tag === 'button' || tag === 'a' || el.getAttribute('role') === 'button') {
      const text = (el.textContent || '').trim().replace(/\s+/g, ' ').slice(0, 40);
      if (text) return tag + ': ' + text;
    }
    return tag;
  };
  const fieldLabel = el => label(el) !== el.tagName.toLowerCase() ? label(el) : (el.getAttribute('placeholder') || label(el));

  document.addEventListener('click', ev => {
    const el = ev.target && ev.target.closest ? ev.target.closest('[data-track],button,a,[role=button],input[type=checkbox],input[type=radio]') : null;
    if (el) push({ type: 'click', target: label(el) });
  }, true);
  document.addEventListener('change', ev => {
    const el = ev.target;
    if (!el || !el.tagName) return;
    const props = { field: (el.type || el.tagName).toString().toLowerCase() };
    if (captureValues && 'value' in el && el.type !== 'password') props.value = String(el.value).slice(0, 200);
    push({ type: 'change', target: fieldLabel(el), props });
  }, true);
  document.addEventListener('submit', ev => push({ type: 'submit', target: label(ev.target) }), true);
  window.addEventListener('hashchange', () => push({ type: 'navigate', target: location.hash.split('?')[0] || '#' }));
  window.addEventListener('error', ev => push({ type: 'error', target: String(ev.message || 'error').slice(0, 200) }));
  window.addEventListener('unhandledrejection', ev => push({ type: 'error', target: String((ev.reason && ev.reason.message) || ev.reason || 'rejection').slice(0, 200) }));
  try {
    new PerformanceObserver(list => {
      for (const entry of list.getEntries()) if (entry.duration > 300) push({ type: 'slow', target: 'longtask', props: { ms: Math.round(entry.duration) } });
    }).observe({ type: 'longtask', buffered: true });
  } catch (_) {}
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'hidden') flush(true); });
  window.addEventListener('pagehide', () => flush(true));
  push({ type: 'view', target: location.pathname.split('/').slice(-1)[0] || 'index' });

  const dataUrl = key => base + '_hermes/data/' + encodeURIComponent(key);
  const needData = () => { if (!dataEnabled) throw new Error('App data is not available to this viewer'); };
  const json = async res => {
    if (!res.ok) throw new Error('Hermes app data request failed: ' + res.status);
    return res.json();
  };
  const data = {
    async get(key) { needData(); return (await json(await fetch(dataUrl(key), { credentials: 'omit' }))).value; },
    async set(key, value) {
      needData();
      return (await json(await fetch(dataUrl(key), { method: 'POST', credentials: 'omit', headers: { 'Content-Type': 'text/plain' }, body: JSON.stringify(value) }))).value;
    },
    async delete(key) { needData(); return (await json(await fetch(base + '_hermes/data-delete/' + encodeURIComponent(key), { method: 'POST', credentials: 'omit' }))).deleted; },
    async keys() { needData(); return (await json(await fetch(base + '_hermes/data', { credentials: 'omit' }))).keys; }
  };

  window.hermes = Object.freeze({
    viewer: cfg.hermesViewer || 'owner',
    telemetry,
    track(name, props) { push({ type: 'custom', name: String(name || 'event').slice(0, 60), props: props || {} }); },
    data: Object.freeze(data),
    flush: () => flush(false)
  });
})();
"""


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

