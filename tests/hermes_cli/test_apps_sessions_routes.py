"""Hermes Apps session routes through the real dashboard app: only the owner's signed link can
hand work to Hermes, uploads land in the job, questions are answered over HTTP, and public
viewers are refused. The worker launch is replaced at the process boundary."""

from __future__ import annotations

import json

import pytest
from fastapi.testclient import TestClient

from hermes_cli import apps_job_launcher, apps_jobs, apps_store, web_server

AUTH = {web_server._SESSION_HEADER_NAME: web_server._SESSION_TOKEN}


@pytest.fixture
def home():
    from hermes_constants import get_hermes_home

    h = get_hermes_home()
    apps_store.create_app(h, "invoices", "Invoices")
    apps_store.publish(h, "invoices")
    return h


@pytest.fixture
def launches(monkeypatch):
    calls = []
    monkeypatch.setattr(apps_job_launcher, "launch_job_worker", lambda *args: calls.append(args) or 4242)
    return calls


@pytest.fixture
def client():
    return TestClient(web_server.app)


def _base(client):
    return client.post("/api/apps/invoices/link", headers=AUTH, json={}).json()["path"]


def test_owner_link_starts_a_session_with_files_and_launches_the_worker(client, home, launches):
    base = _base(client)
    r = client.post(f"{base}_hermes/sessions", data={"prompt": "Process", "context": json.dumps({"currency": "EUR"})},
                    files=[("files", ("inv.pdf", b"%PDF-1.4", "application/pdf"))])
    assert r.status_code == 200, r.text
    session = r.json()["session"]
    assert session["status"] == "queued" and session["files"] == [{"name": "inv.pdf", "size": 8}]
    assert launches and launches[0][2:] == ("invoices", session["id"])
    stored = apps_jobs.job_dir(home, "invoices", session["id"]) / "files" / "inv.pdf"
    assert stored.read_bytes() == b"%PDF-1.4"

    listed = client.get(f"{base}_hermes/sessions").json()["sessions"]
    assert [s["id"] for s in listed] == [session["id"]]
    assert client.get(f"{base}_hermes/sessions/{session['id']}").json()["session"]["id"] == session["id"]
    jobs = client.get("/api/apps/invoices/jobs", headers=AUTH).json()["jobs"]
    assert [j["id"] for j in jobs] == [session["id"]]


def test_json_requests_answers_and_follow_ups(client, home, launches):
    base = _base(client)
    session = client.post(f"{base}_hermes/sessions", content=json.dumps({"prompt": "Summarize unpaid"}),
                          headers={"Content-Type": "text/plain"}).json()["session"]
    job = apps_jobs.load_job(home, "invoices", session["id"])
    job.update(status="needs_input", question={"ask_id": "a1", "questions": [{"qid": "q0", "question": "?"}]})
    apps_jobs.save_job(home, "invoices", job)

    answered = client.post(f"{base}_hermes/sessions/{session['id']}/answer", content=json.dumps({"answers": {"q0": "Yes"}}))
    assert answered.status_code == 200
    reply = json.loads((apps_jobs.job_dir(home, "invoices", session["id"]) / "answer.json").read_text())
    assert reply == {"ask_id": "a1", "answers": {"q0": "Yes"}}

    early = client.post(f"{base}_hermes/sessions/{session['id']}/message", content=json.dumps({"message": "more"}))
    assert early.status_code == 400, "a follow-up waits for the current turn"
    job = apps_jobs.load_job(home, "invoices", session["id"])
    job.update(status="done")
    apps_jobs.save_job(home, "invoices", job)
    followed = client.post(f"{base}_hermes/sessions/{session['id']}/message", content=json.dumps({"message": "more"}))
    assert followed.json()["session"]["status"] == "queued" and len(launches) == 2


def test_answering_a_parked_question_relaunches_the_session_and_pending_filters(client, home, launches):
    base = _base(client)
    session = client.post(f"{base}_hermes/sessions", content=json.dumps({"prompt": "x"})).json()["session"]
    other = client.post(f"{base}_hermes/sessions", content=json.dumps({"prompt": "y"})).json()["session"]
    job = apps_jobs.load_job(home, "invoices", session["id"])
    job.update(status="waiting", session_id="s1",
               question={"ask_id": "a1", "questions": [{"qid": "q0", "question": "Supplier?"}]})
    apps_jobs.save_job(home, "invoices", job)

    pending = client.get(f"{base}_hermes/sessions?pending=1").json()["sessions"]
    assert [s["id"] for s in pending] == [session["id"]] and other["id"] != session["id"]
    launched = len(launches)
    r = client.post(f"{base}_hermes/sessions/{session['id']}/answer", content=json.dumps({"answers": {"q0": "Acme"}}))
    assert r.status_code == 200 and r.json()["session"]["status"] == "queued"
    assert len(launches) == launched + 1 and "resume" not in r.json()["session"]


def test_bad_requests_and_unknown_jobs(client, home, launches):
    base = _base(client)
    assert client.post(f"{base}_hermes/sessions", content="{}").status_code == 400
    assert client.get(f"{base}_hermes/sessions/zzzzzzzzzzzz").status_code == 404
    assert client.get(f"{base}_hermes/sessions/../../x").status_code == 404
    for _ in range(apps_jobs.MAX_ACTIVE_JOBS):
        client.post(f"{base}_hermes/sessions", content=json.dumps({"prompt": "x"}))
    assert client.post(f"{base}_hermes/sessions", content=json.dumps({"prompt": "x"})).status_code == 429
    assert not launches[apps_jobs.MAX_ACTIVE_JOBS:]


def test_public_viewers_cannot_start_or_read_sessions(client, home, launches):
    profile = client.get("/api/apps", headers=AUTH).json()["profile"]
    client.patch("/api/apps/invoices", headers=AUTH, json={"visibility": "public"})
    public = f"/apps-public/{profile}/invoices/_hermes/sessions"
    assert client.post(public, content=json.dumps({"prompt": "x"})).status_code == 403
    assert client.get(public).status_code == 403
    assert client.get(f"{public}/abcdefabcdef").status_code == 403
    assert not launches
    page = client.get(f"/apps-public/{profile}/invoices/").text
    assert 'data-hermes-data="0"' in page


def test_spawn_failure_is_reported_on_the_job(client, home, monkeypatch):
    def refuse(*_args):
        raise OSError("no such interpreter")

    monkeypatch.setattr(apps_job_launcher, "launch_job_worker", refuse)
    r = client.post(f"{_base(client)}_hermes/sessions", content=json.dumps({"prompt": "x"}))
    assert r.json()["session"]["status"] == "failed" and "no such interpreter" in r.json()["session"]["error"]


def test_session_index_maps_each_app_session_to_its_app(client, home, launches):
    apps_store.create_app(home, "beat", "Beat Lab", icon="🎛️")
    for slug, sid in (("invoices", "s-inv"), ("beat", "s-beat")):
        job = apps_jobs.create_job(home, slug, "x")
        job["session_id"] = sid
        apps_jobs.save_job(home, slug, job)
    apps_jobs.create_job(home, "invoices", "not started yet")

    index = client.get("/api/apps-sessions", headers=AUTH).json()
    assert index["sessions"] == {"s-inv": "invoices", "s-beat": "beat"}
    assert index["apps"]["beat"] == {"name": "Beat Lab", "icon": "🎛️"}
    assert client.get("/api/apps-sessions").status_code == 401
