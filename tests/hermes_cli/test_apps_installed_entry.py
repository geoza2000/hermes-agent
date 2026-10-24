"""Private installed app entry must survive the dashboard's existing OAuth round trip."""
from urllib.parse import parse_qs, urlsplit

pytest_plugins = ["tests.hermes_cli.test_apps_routes"]


def test_private_app_login_returns_to_exact_entry(gated_client, home):
    from hermes_cli.web_routers.apps import _profile_name_for_home

    entry = f"/apps/{_profile_name_for_home(home)}/invoices/"
    first = gated_client.get(entry, follow_redirects=False)
    login = first.headers["location"]
    assert parse_qs(urlsplit(login).query)["next"] == [entry]
    # The single-provider gate may go straight to auth/login; /login otherwise renders choices.
    if urlsplit(login).path == "/login":
        login = "/auth/login?provider=stub&" + urlsplit(login).query
    start = gated_client.get(login, follow_redirects=False)
    state = parse_qs(urlsplit(start.headers["location"]).query)["state"][0]
    callback = gated_client.get(f"/auth/callback?code=stub_code&state={state}", follow_redirects=False)
    assert callback.headers["location"] == entry
    app = gated_client.get(entry, follow_redirects=False)
    assert app.headers["location"].startswith("/apps-cap/")
    assert gated_client.get(app.headers["location"]).status_code == 200


def test_installed_app_cannot_extend_revoked_capability(gated_client, home):
    from hermes_cli import apps_links
    from hermes_cli.web_routers.apps import _profile_name_for_home

    profile = _profile_name_for_home(home)
    token, _ = apps_links.mint(home, profile, "invoices")
    base = f"/apps-cap/{token}/"
    manifest = gated_client.get(base + "_hermes/manifest.webmanifest").json()
    assert manifest["start_url"] == f"/apps/{profile}/invoices/"
    apps_links.rotate_key(home)
    assert gated_client.get(base).status_code == 404
    assert gated_client.get(manifest["start_url"], follow_redirects=False).status_code == 302


def test_installed_app_without_session_hands_off_to_dashboard(client, home):
    """Token-mode dashboards (no Portal gate): the installed app must not dead-end."""
    from hermes_cli.web_routers.apps import _profile_name_for_home

    profile = _profile_name_for_home(home)
    response = client.get(f"/apps/{profile}/invoices/", follow_redirects=False)
    assert response.status_code == 302
    assert response.headers["location"] == f"/apps?open=invoices&profile={profile}"
    assert client.get("/apps/nobody/invoices/", follow_redirects=False).status_code == 404
