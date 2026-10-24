"""Reviewed bytes, not a live folder, are the publication authority."""
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from hermes_cli import apps_store, web_server

AUTH = {web_server._SESSION_HEADER_NAME: web_server._SESSION_TOKEN}


def test_review_snapshot_is_immutable_and_stale_publish_is_rejected(tmp_path):
    from hermes_cli import apps_revisions

    home = tmp_path / '.hermes'
    apps_store.create_app(home, 'notes', 'Notes')
    draft = apps_store.app_dir(home, 'notes') / 'draft' / 'index.html'
    draft.write_text('<p>reviewed</p>')
    review = apps_revisions.review(home, 'notes')
    draft.write_text('<p>changed</p>')
    assert (apps_revisions.snapshot_dir(home, 'notes', review) / 'index.html').read_text() == '<p>reviewed</p>'
    with pytest.raises(apps_store.AppError, match='changed'):
        apps_revisions.publish_review(home, 'notes', review)
    assert apps_store.load_manifest(home, 'notes')['current_version'] is None


def test_api_requires_revision_and_serves_reviewed_snapshot(monkeypatch, tmp_path):
    monkeypatch.setattr(Path, 'home', lambda: tmp_path)
    home = tmp_path / '.hermes'
    monkeypatch.setenv('HERMES_HOME', str(home))
    apps_store.create_app(home, 'notes', 'Notes')
    client = TestClient(web_server.app)
    listed = client.get('/api/apps', headers=AUTH).json()
    query = '?profile=' + listed['profile']
    review = client.post('/api/apps/notes/review' + query, headers=AUTH)
    assert review.status_code == 200, review.text
    receipt = review.json()
    assert client.post('/api/apps/notes/publish' + query, headers=AUTH, json={}).status_code == 400
    draft = apps_store.app_dir(home, 'notes') / 'draft' / 'index.html'
    draft.write_text('<p>unreviewed change</p>')
    page = client.get(receipt['path'])
    assert page.status_code == 200
    assert 'unreviewed change' not in page.text
    assert 'allow-same-origin' not in page.headers['content-security-policy']
    stale = client.post('/api/apps/notes/publish' + query, headers=AUTH, json={'revision': receipt['revision']})
    assert stale.status_code == 400 and 'changed' in stale.text
    fresh = client.post('/api/apps/notes/review' + query, headers=AUTH).json()
    published = client.post('/api/apps/notes/publish' + query, headers=AUTH, json={'revision': fresh['revision']})
    assert published.status_code == 200, published.text
    assert apps_store.load_manifest(home, 'notes')['current_version'] == 1
