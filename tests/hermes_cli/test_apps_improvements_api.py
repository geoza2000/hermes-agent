"""Owner-only, explicitly scoped settings and suggestion mutation routes."""
from pathlib import Path

from fastapi.testclient import TestClient

from hermes_cli import apps_store, web_server

AUTH = {web_server._SESSION_HEADER_NAME: web_server._SESSION_TOKEN}


def test_settings_and_suggestions_are_owner_and_profile_scoped(tmp_path, monkeypatch):
    monkeypatch.setattr(Path, 'home', lambda: tmp_path)
    home = tmp_path / '.hermes'
    monkeypatch.setenv('HERMES_HOME', str(home))
    apps_store.create_app(home, 'notes', 'Notes')
    client = TestClient(web_server.app)
    assert client.get('/api/apps-improvements').status_code == 401
    get = client.get('/api/apps-improvements?profile=default', headers=AUTH)
    assert get.status_code == 200, get.text
    assert get.json()['settings']['schedule'] == 'weekly'
    saved = client.put('/api/apps-improvements?profile=default', headers=AUTH, json={'schedule': 'manual'})
    assert saved.status_code == 200, saved.text
    per_app = client.get('/api/apps/notes/improvements?profile=default', headers=AUTH)
    assert per_app.json()['settings']['schedule'] == 'manual'
    changed = client.put('/api/apps/notes/improvements?profile=default', headers=AUTH, json={'schedule': 'daily', 'token_budget': 4000})
    assert changed.status_code == 200, changed.text
    assert changed.json()['settings']['token_budget'] == 4000
    assert client.get('/api/apps-improvements?profile=default', headers=AUTH).json()['settings']['token_budget'] != 4000
    reset = client.put('/api/apps/notes/improvements?profile=default', headers=AUTH, json={'inherit': True})
    assert reset.status_code == 200 and reset.json()['settings']['schedule'] == 'manual'
    assert client.put('/api/apps-improvements?profile=default', headers=AUTH, json={'auto_apply': True}).status_code == 400
