"""Browser-safe return targets for the existing dashboard sign-in flow."""
from __future__ import annotations

import time

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from hermes_cli.dashboard_auth import clear_providers, register_provider
from hermes_cli.dashboard_auth.base import Session
from hermes_cli.dashboard_auth.middleware import gated_auth_middleware
from hermes_cli.dashboard_auth.request_utils import is_safe_next_path
from hermes_cli.dashboard_auth.routes import (
    _reset_password_rate_limit,
    _validate_post_login_target,
    router,
)
from tests.hermes_cli.conftest_dashboard_auth import StubAuthProvider


class PasswordStub(StubAuthProvider):
    name = "password-stub"
    supports_password = True

    def complete_password_login(self, *, username: str, password: str) -> Session:
        return Session(
            user_id="test-user", email="", display_name="Test", org_id="",
            provider=self.name, expires_at=int(time.time()) + 3600,
            access_token="test-access", refresh_token="test-refresh",
        )


@pytest.fixture
def auth_client(monkeypatch):
    from hermes_cli.dashboard_auth import prefix

    monkeypatch.setattr(prefix, "_load_dashboard_section", dict)
    clear_providers()
    register_provider(StubAuthProvider())
    register_provider(PasswordStub())
    _reset_password_rate_limit()
    app = FastAPI()
    app.state.auth_required = True
    app.middleware("http")(gated_auth_middleware)
    app.include_router(router)
    with TestClient(app, base_url="https://dashboard.example") as client:
        yield client
    clear_providers()
    _reset_password_rate_limit()


@pytest.mark.parametrize("path", [r"/\evil.example/", r"/\\evil.example/"])
def test_next_path_rejects_browser_authority_backslashes(path):
    # WHATWG special URLs treat backslashes as slashes, unlike urllib.parse.
    assert not is_safe_next_path(path)


@pytest.mark.parametrize("target", [r"/\evil.example/", "/%5cevil.example/", "%2F%5Cevil.example/"])
def test_post_login_validation_rejects_decoded_backslashes(target):
    assert _validate_post_login_target(target) == ""


@pytest.mark.parametrize("target", [r"/\evil.example/", "/%5cevil.example/"])
def test_password_login_never_returns_cross_origin_browser_target(auth_client, target):
    response = auth_client.post(
        "/auth/password-login",
        json={"provider": "password-stub", "username": "test", "password": "test", "next": target},
    )
    assert response.status_code == 200
    # login_page.js calls window.location.assign on this unquoted JSON value.
    assert response.json() == {"ok": True, "next": "/"}
