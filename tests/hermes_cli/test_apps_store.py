"""Hermes Apps storage + telemetry contracts: versions are immutable, rollback is exact,
asset resolution cannot escape the app, and telemetry never stores typed values by default."""

from __future__ import annotations

import json
import os

import pytest

from hermes_cli import apps_links, apps_store, apps_telemetry


@pytest.fixture
def home(tmp_path):
    root = tmp_path / ".hermes"
    root.mkdir()
    return root


def _write_draft(home, slug, html):
    (apps_store.app_dir(home, slug) / "draft" / "index.html").write_text(html, encoding="utf-8")


def test_publish_snapshots_the_draft_and_later_edits_do_not_change_live(home):
    apps_store.create_app(home, "invoices", "Invoices", icon="🧾")
    _write_draft(home, "invoices", "<h1>one</h1>")
    assert apps_store.publish(home, "invoices", note="first")["current_version"] == 1

    _write_draft(home, "invoices", "<h1>two</h1>")
    live = apps_store.content_dir(home, "invoices")
    assert (live / "index.html").read_text() == "<h1>one</h1>", "editing the draft must not touch the live app"
    preview = apps_store.content_dir(home, "invoices", preview=True)
    assert (preview / "index.html").read_text() == "<h1>two</h1>"

    manifest = apps_store.publish(home, "invoices", note="second")
    assert manifest["current_version"] == 2
    assert [v["note"] for v in manifest["versions"]] == ["first", "second"]
    assert (apps_store.rollback(home, "invoices", 1))["current_version"] == 1
    assert (apps_store.content_dir(home, "invoices") / "index.html").read_text() == "<h1>one</h1>"


def test_unpublished_app_has_no_live_content_and_new_apps_are_private(home):
    manifest = apps_store.create_app(home, "beats", "Beat Lab")
    assert manifest["visibility"] == "private"
    assert manifest["telemetry"] == {"enabled": True, "capture_values": False}
    assert apps_store.content_dir(home, "beats") is None


@pytest.mark.parametrize("slug", ["", "Invoices", "../x", "a" * 49, "-lead", "has space"])
def test_invalid_slugs_are_rejected(home, slug):
    with pytest.raises(apps_store.AppError):
        apps_store.create_app(home, slug, "X")


def test_update_rejects_unknown_settings_and_bad_values(home):
    apps_store.create_app(home, "a", "A")
    with pytest.raises(apps_store.AppError):
        apps_store.update_app(home, "a", {"owner": "someone"})
    with pytest.raises(apps_store.AppError):
        apps_store.update_app(home, "a", {"visibility": "everyone"})
    with pytest.raises(apps_store.AppError):
        apps_store.update_app(home, "a", {"telemetry": {"enabled": "yes"}})
    updated = apps_store.update_app(home, "a", {"visibility": "public", "telemetry": {"enabled": False}})
    assert updated["visibility"] == "public"
    assert updated["telemetry"] == {"enabled": False, "capture_values": False}


@pytest.mark.skipif(not hasattr(os, "symlink"), reason="needs symlinks")
def test_resolve_asset_stays_inside_the_app(home, tmp_path):
    apps_store.create_app(home, "a", "A")
    draft = apps_store.app_dir(home, "a") / "draft"
    (draft / "css").mkdir()
    (draft / "css" / "app.css").write_text("body{}")
    (draft / ".secret").write_text("x")
    outside = tmp_path / "outside.txt"
    outside.write_text("secret")
    try:
        (draft / "leak.txt").symlink_to(outside)
    except OSError:
        pytest.skip("symlink creation not permitted")

    assert apps_store.resolve_asset(draft, "") == (draft / "index.html").resolve()
    assert apps_store.resolve_asset(draft, "css/app.css") == (draft / "css" / "app.css").resolve()
    for rel in ("../app.json", "css/../../app.json", ".secret", "leak.txt", "missing.js"):
        assert apps_store.resolve_asset(draft, rel) is None, rel


def test_data_store_round_trips_json_and_enforces_limits(home):
    apps_store.create_app(home, "a", "A")
    apps_store.data_put(home, "a", "invoices", json.dumps([{"n": 1}]).encode())
    assert apps_store.data_get(home, "a", "invoices") == [{"n": 1}]
    assert apps_store.data_keys(home, "a") == ["invoices"]
    with pytest.raises(apps_store.AppError):
        apps_store.data_put(home, "a", "bad", b"not json")
    with pytest.raises(apps_store.AppError):
        apps_store.data_put(home, "a", "../escape", b"1")
    with pytest.raises(apps_store.AppError):
        apps_store.data_put(home, "a", "big", b'"' + b"x" * apps_store.DATA_VALUE_MAX_BYTES + b'"')
    assert apps_store.data_delete(home, "a", "invoices") is True
    assert apps_store.data_get(home, "a", "invoices") is None


def test_telemetry_drops_typed_values_unless_the_owner_opts_in(home):
    apps_store.create_app(home, "a", "A")
    event = {"type": "change", "target": "client", "props": {"field": "text", "value": "ACME Ltd"}}
    assert apps_telemetry.record_events(home, "a", [event, {"type": "bogus"}], viewer="owner") == 1
    stored = list(apps_telemetry.iter_events(home, "a"))
    assert stored[0]["props"] == {"field": "text"}, "typed values must never be stored by default"

    apps_store.update_app(home, "a", {"telemetry": {"capture_values": True}})
    apps_telemetry.record_events(home, "a", [event], viewer="owner")
    apps_telemetry.record_events(home, "a", [event], viewer="public")
    values = [e.get("props", {}).get("value") for e in apps_telemetry.iter_events(home, "a")]
    assert values.count("ACME Ltd") == 1, "public viewers never contribute captured values"


def test_telemetry_off_stores_nothing_and_summary_counts_interactions(home):
    apps_store.create_app(home, "a", "A")
    clicks = [{"type": "click", "target": "button: New invoice", "session": "s1"}] * 3
    apps_telemetry.record_events(home, "a", clicks + [{"type": "error", "target": "TypeError: x"}], viewer="owner")
    summary = apps_telemetry.summarize(home, "a")
    assert summary["total_events"] == 4
    assert summary["sessions"] == 1
    assert summary["top_interactions"][0] == {"label": "click: button: New invoice", "count": 3}
    assert summary["errors"] == [{"target": "TypeError: x", "count": 1}]

    apps_store.update_app(home, "a", {"telemetry": {"enabled": False}})
    assert apps_telemetry.record_events(home, "a", clicks, viewer="owner") == 0
    assert apps_telemetry.clear_events(home, "a") == 1
    assert apps_telemetry.summarize(home, "a")["total_events"] == 0


def test_links_bind_one_app_expire_and_revoke(home, monkeypatch):
    apps_store.create_app(home, "a", "A")
    homes = {"me": home}
    token, _ = apps_links.mint(home, "me", "a")
    link, resolved = apps_links.verify(token, homes.get)
    assert (link.profile, link.slug, link.preview, resolved) == ("me", "a", False, home)

    _, signature = token.split(".")
    forged = apps_links._b64(json.dumps({"p": "me", "s": "b", "e": link.expires_at, "m": "live"}, separators=(",", ":")).encode())
    assert apps_links.verify(f"{forged}.{signature}", homes.get) is None, "a link must not open another app"
    assert apps_links.verify(token, {}.get) is None, "unknown profile"
    assert apps_links.verify("garbage", homes.get) is None

    real_time = apps_links.time.time
    monkeypatch.setattr(apps_links.time, "time", lambda: real_time() + apps_links.DEFAULT_TTL_SECONDS + 5)
    assert apps_links.verify(token, homes.get) is None, "expired"
    monkeypatch.setattr(apps_links.time, "time", real_time)

    apps_links.rotate_key(home)
    assert apps_links.verify(token, homes.get) is None, "rotating the key revokes outstanding links"


@pytest.mark.skipif(os.name == "nt", reason="POSIX mode bits not enforced on Windows")
def test_link_key_is_owner_only(home):
    apps_store.create_app(home, "a", "A")
    apps_links.mint(home, "me", "a")
    assert (apps_store.apps_root(home) / ".link-key").stat().st_mode & 0o077 == 0
