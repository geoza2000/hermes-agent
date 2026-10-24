"""Dashboard creation uses the existing profile-bound app store, always private and draft."""
from fastapi.testclient import TestClient
from hermes_cli import web_server


def test_dashboard_creates_private_draft_and_rejects_duplicate():
    client = TestClient(web_server.app)
    headers = {web_server._SESSION_HEADER_NAME: web_server._SESSION_TOKEN}
    assert client.post("/api/apps", json={"slug": "notes", "name": "Notes"}).status_code == 401
    created = client.post("/api/apps", headers=headers, json={"slug": "notes", "name": "Notes"})
    assert created.status_code == 200, created.text
    app = created.json()["app"]
    assert app["visibility"] == "private" and app["current_version"] is None
    assert client.get("/api/apps/notes", headers=headers).json()["app"]["name"] == "Notes"
    assert client.post("/api/apps", headers=headers, json={"slug": "notes", "name": "Again"}).status_code == 400
    assert client.post("/api/apps", headers=headers, json={"slug": "../bad", "name": "Bad"}).status_code == 400
