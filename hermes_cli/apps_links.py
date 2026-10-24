"""Signed, expiring app links: how an authenticated owner's viewer reaches a private app.

Apps run with an opaque origin (CSP ``sandbox`` without ``allow-same-origin``) so their code can
never ride the dashboard's cookies or call ``/api/*``. That also means a sandboxed page cannot
carry a cookie of its own, so access to a private app is a capability in the URL path:
``/apps-cap/<token>/...``. The token is minted only by an authenticated ``/api/apps`` call (or a
signed-in browser hitting ``/apps/<profile>/<slug>/``), names exactly one app, and expires.

The HMAC key is per profile (``<home>/apps/.link-key``, mode 0600); rotating it revokes every
outstanding link for that profile at once.
"""

from __future__ import annotations

import base64
import hashlib
import hmac
import json
import os
import secrets
import time
from dataclasses import dataclass
from pathlib import Path
from typing import Callable, Optional

from hermes_cli.apps_store import SLUG_RE, apps_root

DEFAULT_TTL_SECONDS = 12 * 60 * 60
MAX_TTL_SECONDS = 7 * 24 * 60 * 60
_MODES = ("live", "preview")


@dataclass(frozen=True)
class AppLink:
    profile: str
    slug: str
    expires_at: int
    mode: str

    @property
    def preview(self) -> bool:
        return self.mode == "preview"


def _b64(data: bytes) -> str:
    return base64.urlsafe_b64encode(data).rstrip(b"=").decode("ascii")


def _unb64(text: str) -> bytes:
    return base64.urlsafe_b64decode(text + "=" * (-len(text) % 4))


def _key_path(home: Path) -> Path:
    return apps_root(home) / ".link-key"


def _read_key(home: Path) -> Optional[bytes]:
    try:
        key = _key_path(home).read_bytes()
    except FileNotFoundError:
        return None
    return key if len(key) >= 32 else None


def _signing_key(home: Path) -> bytes:
    return _read_key(home) or _write_key(home)


def _write_key(home: Path) -> bytes:
    path = _key_path(home)
    path.parent.mkdir(parents=True, exist_ok=True)
    key = secrets.token_bytes(32)
    tmp = path.with_name(f".link-key.{secrets.token_hex(4)}")
    fd = os.open(tmp, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    with os.fdopen(fd, "wb") as handle:
        handle.write(key)
    os.replace(tmp, path)
    return key


def rotate_key(home: Path) -> None:
    """Invalidate every outstanding link for this profile."""
    _write_key(home)


def mint(home: Path, profile: str, slug: str, *, ttl: int = DEFAULT_TTL_SECONDS, mode: str = "live") -> tuple[str, int]:
    if not SLUG_RE.match(slug):
        raise ValueError("invalid app id")
    if mode not in _MODES:
        raise ValueError("invalid link mode")
    ttl = max(60, min(int(ttl), MAX_TTL_SECONDS))
    expires = int(time.time()) + ttl
    payload = _b64(json.dumps({"p": profile, "s": slug, "e": expires, "m": mode}, separators=(",", ":")).encode())
    key = _signing_key(home)
    signature = _b64(hmac.new(key, payload.encode("ascii"), hashlib.sha256).digest())
    return f"{payload}.{signature}", expires


def verify(token: str, home_for_profile: Callable[[str], Optional[Path]]) -> Optional[tuple[AppLink, Path]]:
    """Return the link and its profile home, or None for anything malformed, forged or expired."""
    if not isinstance(token, str) or token.count(".") != 1 or len(token) > 1024:
        return None
    payload, signature = token.split(".")
    try:
        claims = json.loads(_unb64(payload))
    except (ValueError, json.JSONDecodeError):
        return None
    if not isinstance(claims, dict):
        return None
    profile, slug, expires, mode = claims.get("p"), claims.get("s"), claims.get("e"), claims.get("m")
    if not (isinstance(profile, str) and isinstance(slug, str) and SLUG_RE.match(slug)):
        return None
    if not isinstance(expires, int) or expires < time.time() or mode not in _MODES:
        return None
    home = home_for_profile(profile)
    if home is None:
        return None
    key = _read_key(home)
    if key is None:
        return None
    expected = _b64(hmac.new(key, payload.encode("ascii"), hashlib.sha256).digest())
    if not hmac.compare_digest(expected, signature):
        return None
    return AppLink(profile=profile, slug=slug, expires_at=expires, mode=mode), home
