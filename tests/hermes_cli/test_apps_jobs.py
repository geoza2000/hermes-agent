"""Hermes Apps sessions: the app → Hermes handoff contract.

A request stores its files and context, the worker routes clarify questions to the app and
back, the final reply becomes the job result (with an optional fenced JSON block), follow-ups
resume the same Hermes session, and app sessions are unattended for approvals.
"""

from __future__ import annotations

import json
import threading

import pytest

from hermes_cli import apps_job_runner, apps_jobs, apps_store
from tests.waiting import wait_until


@pytest.fixture
def home(tmp_path):
    root = tmp_path / ".hermes"
    root.mkdir()
    apps_store.create_app(root, "invoices", "Invoices", icon="🧾")
    apps_store.update_app(root, "invoices", {"agent": {"prompt": "Extract invoice fields.", "skills": ["invoice-processing"]}})
    return root


class FakeModel:
    """Stands in for the model turn only: asks one clarify question, then replies with JSON."""

    def __init__(self, ask=True):
        self.ask, self.calls = ask, []

    def __call__(self, prompt, **kwargs):
        self.calls.append({"prompt": prompt, **kwargs})
        agent = type("Agent", (), {"session_id": "sess-apps-1"})()
        kwargs["on_agent"](agent)
        agent.tool_start_callback("c1", "read_file", {})
        answer = None
        if self.ask:
            reply = kwargs["clarify_callback"]([{
                "qid": "q0", "question": "Which supplier?", "choices": ["Acme (Recommended)", "Northwind"],
                "choices_offered": ["Acme", "Northwind"], "multi_select": False}])
            answer = reply["answers"].get("q0")
        body = json.dumps({"supplier": answer or "unknown", "total": 1200})
        return f"Saved the invoice.\n\n```json\n{body}\n```", {"session_id": "sess-apps-1"}


def test_create_job_stores_files_and_rejects_bad_requests(home):
    job = apps_jobs.create_job(home, "invoices", "Process this", files=[("../../evil name.pdf", b"%PDF"), ("a.png", b"png")],
                               context={"currency": "EUR"})
    folder = apps_jobs.job_dir(home, "invoices", job["id"]) / "files"
    assert sorted(p.name for p in folder.iterdir()) == ["a.png", "evil name.pdf"]
    assert job["status"] == "queued" and job["context"] == {"currency": "EUR"}
    assert "/" not in json.dumps(apps_jobs.public_view(job)["files"])
    with pytest.raises(apps_store.AppError):
        apps_jobs.create_job(home, "invoices", "")
    with pytest.raises(apps_store.AppError):
        apps_jobs.create_job(home, "invoices", "x", files=[("f", b"1")] * (apps_jobs.MAX_FILES + 1))
    with pytest.raises(apps_store.AppError):
        apps_jobs.create_job(home, "invoices", "x", context=["not", "an", "object"])
    apps_jobs.create_job(home, "invoices", "second")
    with pytest.raises(apps_store.AppError, match="in progress"):
        apps_jobs.create_job(home, "invoices", "third, over the active cap")


def test_worker_routes_a_question_to_the_app_and_stores_the_result(home):
    job = apps_jobs.create_job(home, "invoices", "Process this invoice", files=[("inv.pdf", b"%PDF")])
    model = FakeModel()
    worker = threading.Thread(target=apps_job_runner.run_job, args=(home, "invoices", job["id"]),
                              kwargs={"run_turn": model, "answer_timeout": 30})
    worker.start()

    def waiting():
        return apps_jobs.load_job(home, "invoices", job["id"])["status"] == "needs_input"

    wait_until(waiting, timeout=10)
    pending = apps_jobs.load_job(home, "invoices", job["id"])
    question = pending["question"]["questions"][0]
    assert question == {"qid": "q0", "question": "Which supplier?", "choices": ["Acme", "Northwind"], "multi_select": False}
    assert pending["session_id"] == "sess-apps-1"
    with pytest.raises(apps_store.AppError):
        apps_jobs.submit_answer(home, "invoices", job["id"], {"q9": "x"})
    apps_jobs.submit_answer(home, "invoices", job["id"], {"q0": "Northwind"})
    worker.join(timeout=10)

    done = apps_jobs.load_job(home, "invoices", job["id"])
    assert done["status"] == "done" and done["question"] is None
    assert done["result"]["json"] == {"supplier": "Northwind", "total": 1200}
    assert [s["text"] for s in done["steps"]][:3] == ["Started", "Using read file", "Waiting for your answer"]
    call = model.calls[0]
    assert call["platform"] == "apps" and call["skills"] == ["invoice-processing"] and call["resume"] is None
    assert "Extract invoice fields." in call["instructions"]
    assert str(apps_jobs.job_dir(home, "invoices", job["id"]) / "files" / "inv.pdf") in call["prompt"]


def test_unanswered_question_times_out_and_the_session_still_finishes(home):
    job = apps_jobs.create_job(home, "invoices", "Process")
    assert apps_job_runner.run_job(home, "invoices", job["id"], run_turn=FakeModel(), answer_timeout=0.2) == 0
    done = apps_jobs.load_job(home, "invoices", job["id"])
    assert done["status"] == "done" and done["result"]["json"]["supplier"] == "unknown"
    assert "No answer in time" in [s["text"] for s in done["steps"]]


def test_follow_up_resumes_the_same_session_and_failures_reach_the_app(home):
    job = apps_jobs.create_job(home, "invoices", "Process")
    model = FakeModel(ask=False)
    apps_job_runner.run_job(home, "invoices", job["id"], run_turn=model)
    with pytest.raises(apps_store.AppError):
        apps_jobs.submit_answer(home, "invoices", job["id"], {"q0": "x"})

    apps_jobs.queue_message(home, "invoices", job["id"], "Also mark it paid")
    assert apps_jobs.load_job(home, "invoices", job["id"])["status"] == "queued"
    apps_job_runner.run_job(home, "invoices", job["id"], run_turn=model)
    assert model.calls[1]["prompt"] == "Also mark it paid" and model.calls[1]["resume"] == "sess-apps-1"
    assert apps_jobs.load_job(home, "invoices", job["id"])["turns"] == 2

    def broken(prompt, **kwargs):
        raise RuntimeError("provider unavailable")

    failed = apps_jobs.create_job(home, "invoices", "Process")
    assert apps_job_runner.run_job(home, "invoices", failed["id"], run_turn=broken) == 1
    assert apps_jobs.load_job(home, "invoices", failed["id"])["error"] == "provider unavailable"


def test_parse_result_takes_the_last_json_block():
    text = 'Draft\n```json\n{"a": 1}\n```\nFinal\n```json\n{"b": 2}\n```'
    assert apps_jobs.parse_result(text)["json"] == {"b": 2}
    assert apps_jobs.parse_result("no json here")["json"] is None


def test_agent_settings_are_validated(home):
    with pytest.raises(apps_store.AppError):
        apps_store.update_app(home, "invoices", {"agent": {"model": "x"}})
    with pytest.raises(apps_store.AppError):
        apps_store.update_app(home, "invoices", {"agent": {"skills": ["bad name; rm"]}})
    assert apps_store.update_app(home, "invoices", {"agent": None})["agent"] is None


def test_app_sessions_deny_flagged_commands_by_default(monkeypatch):
    import tools.approval as approval_mod
    from tools import approval_context

    monkeypatch.setattr(approval_mod, "_YOLO_MODE_FROZEN", False)
    monkeypatch.setattr(approval_context, "_get_approval_mode", lambda: "manual")
    for var in ("HERMES_CRON_SESSION", "HERMES_GATEWAY_SESSION", "HERMES_INTERACTIVE", "HERMES_EXEC_ASK", "HERMES_YOLO_MODE"):
        monkeypatch.delenv(var, raising=False)
    monkeypatch.setenv("HERMES_SESSION_KEY", "apps-approval-test")
    monkeypatch.setenv("HERMES_SESSION_PLATFORM", "apps")
    result = approval_mod.check_all_command_guards("sudo systemctl restart nginx", "local")
    assert result["approved"] is False and "approvals.unattended_mode" in result["message"]
