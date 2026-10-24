"""Token budget enforcement for improvement reviews, including providers that ignore output caps."""
from types import SimpleNamespace

import pytest

from hermes_cli import apps_improvement_model as model
from hermes_cli import apps_improvements, apps_store, apps_telemetry


def _reply(text, total, completion=10):
    message = SimpleNamespace(content=text)
    return SimpleNamespace(choices=[SimpleNamespace(message=message)],
                           usage=SimpleNamespace(total_tokens=total, completion_tokens=completion))


@pytest.fixture
def home(tmp_path):
    root = tmp_path / ".hermes"
    root.mkdir()
    apps_store.create_app(root, "notes", "Notes")
    apps_telemetry.record_events(root, "notes", [{"type": "click", "target": "button: Save"}] * 3, viewer="owner")
    return root


def test_measured_overspend_discards_suggestions_and_records_usage(home):
    """Codex ignores max_tokens: a reply that overspends is measured and thrown away."""
    calls = []

    def overspend(messages, max_tokens):
        calls.append(max_tokens)
        return _reply('{"suggestions": []}', total=50_000, completion=40_000)

    state = apps_improvements.run_review(home, "notes", model_call=overspend)
    run = state["runs"][-1]
    assert len(calls) == 1, "exactly one request, no retry"
    assert run["status"] == "budget_exhausted" and run["total_tokens"] == 50_000
    assert "over the 12000 token cap" in run["error"] or "over the" in run["error"]
    assert state["suggestions"] == []


def test_input_estimate_refuses_before_any_request(home):
    apps_store.update_app(home, "notes", {})
    draft = apps_store.app_dir(home, "notes") / "draft" / "index.html"
    draft.write_text("<html>" + "x" * 60_000 + "</html>", encoding="utf-8")

    def never(*_a, **_k):
        raise AssertionError("no request may be sent over budget")

    state = apps_improvements.run_review(home, "notes", model_call=never)
    assert state["runs"][-1]["status"] == "budget_exhausted"
    assert "Raise the cap" in state["runs"][-1]["error"]


def test_default_request_uses_the_profiles_configured_provider(monkeypatch):
    seen = {}

    def fake_call_llm(**kwargs):
        seen.update(kwargs)
        return _reply("{}", total=100)

    import agent.auxiliary_client as aux

    monkeypatch.setattr(aux, "call_llm", fake_call_llm)
    model.request([{"role": "user", "content": "hi"}], max_tokens=600)
    assert seen["task"] == "apps_review" and seen["max_tokens"] == 600 and "provider" not in seen


def test_finished_app_request_queues_an_after_session_review(home, monkeypatch):
    from hermes_cli import apps_improvement_schedule, apps_job_runner, apps_jobs

    queued = []
    monkeypatch.setattr(apps_improvement_schedule, "queue_after_session", lambda h, s: queued.append(s))
    job = apps_jobs.create_job(home, "notes", "x")
    apps_job_runner.run_job(home, "notes", job["id"],
                            run_turn=lambda prompt, **kw: ("done", {"session_id": "s1"}))
    assert queued == ["notes"]
