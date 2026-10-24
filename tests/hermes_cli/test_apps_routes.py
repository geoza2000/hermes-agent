"""Hermes Apps HTTP boundary through the real dashboard app.

Contracts: private apps open only through a signed link minted by an authenticated owner (or a
signed-in session's entry redirect); every app document is CSP-sandboxed so its code cannot reach
the dashboard origin; public apps never expose the owner's app data; the owner API stays gated.
"""

from __future__ import annotations

import json

import pytest
from fastapi.testclient import TestClient

from hermes_cli import apps_store, web_server
from hermes_cli.dashboard_auth import clear_providers, register_provider
from tests.hermes_cli.conftest_dashboard_auth import StubAuthProvider

AUTH = {web_server._SESSION_HEADER_NAME: web_server._SESSION_TOKEN}


@pytest.fixture
def home():
    from hermes_constants import get_hermes_home

    h = get_hermes_home()
    apps_store.create_app(h, "invoices", "Invoices", icon="🧾")
    (apps_store.app_dir(h, "invoices") / "draft" / "index.html").write_text(
        "<!doctype html><html><head><title>Inv</title></head><body><button>New</button></body></html>"
    )
    apps_store.publish(h, "invoices", note="v1")
    return h


@pytest.fixture
def client():
    return TestClient(web_server.app)


def _link(client, *, preview=False):
    r = client.post("/api/apps/invoices/link", headers=AUTH, json={"preview": preview})
    assert r.status_code == 200, r.text
    return r.json()["path"]


def test_owner_api_requires_auth(client, home):
    assert client.get("/api/apps").status_code == 401
    assert client.post("/api/apps/invoices/link").status_code == 401
    listed = client.get("/api/apps", headers=AUTH).json()
    assert [a["slug"] for a in listed["apps"]] == ["invoices"]
    assert listed["apps"][0]["entry_path"].endswith("/invoices/")
    assert listed["apps"][0]["public_path"] is None


def test_signed_link_serves_a_sandboxed_document_with_the_runtime(client, home):
    base = _link(client)
    r = client.get(base)
    assert r.status_code == 200
    csp = r.headers["content-security-policy"]
    assert csp.startswith("sandbox ") and "allow-same-origin" not in csp, "app code must run in an opaque origin"
    assert r.headers["referrer-policy"] == "no-referrer"
    assert f'src="{base}_hermes/sdk.js"' in r.text
    assert 'data-hermes-data="1"' in r.text and 'data-hermes-values="0"' in r.text
    assert client.get(f"{base}_hermes/sdk.js").headers["content-type"].startswith("text/javascript")
    manifest = client.get(f"{base}_hermes/manifest.webmanifest").json()
    assert manifest["display"] == "standalone" and manifest["start_url"].startswith("/apps/")


def test_tampered_or_unknown_links_and_unpublished_paths_404(client, home):
    base = _link(client)
    token = base.split("/")[2]
    assert client.get(f"/apps-cap/{token[:-2]}xx/").status_code == 404
    assert client.get(f"{base}../../api/apps").status_code in (401, 404)
    assert client.get(f"{base}nope.js").status_code == 404


def test_preview_link_serves_the_draft_live_link_serves_the_published_version(client, home):
    (apps_store.app_dir(home, "invoices") / "draft" / "index.html").write_text("<p>draft v2</p>")
    assert "draft v2" not in client.get(_link(client)).text
    assert "draft v2" in client.get(_link(client, preview=True)).text


def test_owner_link_reaches_app_data_and_telemetry(client, home):
    base = _link(client)
    put = client.post(f"{base}_hermes/data/records", content=json.dumps({"rows": [1, 2]}), headers={"Content-Type": "text/plain"})
    assert put.status_code == 200 and put.headers["access-control-allow-origin"] == "*"
    assert client.get(f"{base}_hermes/data/records").json() == {"value": {"rows": [1, 2]}}
    assert client.get(f"{base}_hermes/data").json() == {"keys": ["records"]}
    sent = client.post(f"{base}_hermes/events", content=json.dumps({"events": [{"type": "click", "target": "New"}]}))
    assert sent.json() == {"stored": 1}
    detail = client.get("/api/apps/invoices", headers=AUTH).json()
    assert detail["insights"]["total_events"] == 1 and detail["data_keys"] == 1


def test_public_apps_serve_without_auth_but_never_expose_owner_data(client, home):
    apps_store.data_put(home, "invoices", "records", b'{"secret": true}')
    profile = client.get("/api/apps", headers=AUTH).json()["profile"]
    public_base = f"/apps-public/{profile}/invoices/"
    assert client.get(public_base).status_code == 404, "private apps are not reachable on the public path"

    r = client.patch("/api/apps/invoices", headers=AUTH, json={"visibility": "public"})
    assert r.status_code == 200 and r.json()["app"]["public_path"] == public_base
    page = client.get(public_base)
    assert page.status_code == 200 and 'data-hermes-data="0"' in page.text
    assert page.headers["content-security-policy"].startswith("sandbox ")
    for path in ("_hermes/data", "_hermes/data/records"):
        assert client.get(public_base + path).status_code == 403
    assert client.post(public_base + "_hermes/data/records", content=b"1").status_code == 403
    assert client.post(public_base + "_hermes/data-delete/records").status_code == 403
    assert apps_store.data_get(home, "invoices", "records") == {"secret": True}


def test_signed_in_entry_requires_a_session_on_loopback(client, home):
    profile = client.get("/api/apps", headers=AUTH).json()["profile"]
    r = client.get(f"/apps/{profile}/invoices/", follow_redirects=False)
    # A bare loopback request is not a signed-in owner: no link is minted, it goes to the dashboard.
    assert r.status_code == 302 and "/apps-cap/" not in r.headers["location"]
    assert r.headers["location"].startswith("/apps?open=invoices")


@pytest.fixture
def gated_client():
    clear_providers()
    register_provider(StubAuthProvider())
    saved = {k: getattr(web_server.app.state, k, None) for k in ("bound_host", "bound_port", "auth_required")}
    web_server.app.state.bound_host = "fly-app.fly.dev"
    web_server.app.state.bound_port = 443
    web_server.app.state.auth_required = True
    yield TestClient(web_server.app, base_url="https://fly-app.fly.dev")
    clear_providers()
    for key, value in saved.items():
        setattr(web_server.app.state, key, value)


def test_gated_entry_redirects_a_signed_in_owner_to_a_working_link(gated_client, home):
    from hermes_cli.web_routers.apps import _profile_name_for_home

    entry = f"/apps/{_profile_name_for_home(home)}/invoices/"
    anonymous = gated_client.get(entry, follow_redirects=False)
    assert anonymous.status_code in (302, 303, 307) and "/login" in anonymous.headers["location"]

    r1 = gated_client.get("/auth/login?provider=stub", follow_redirects=False)
    state = r1.headers["location"].split("state=")[1]
    gated_client.get(f"/auth/callback?code=stub_code&state={state}", follow_redirects=False)
    r = gated_client.get(entry, follow_redirects=False)
    assert r.status_code == 302 and r.headers["location"].startswith("/apps-cap/")

    gated_client.cookies.clear()
    page = gated_client.get(r.headers["location"])
    assert page.status_code == 200 and "<button>New</button>" in page.text, "the link itself is the capability"
