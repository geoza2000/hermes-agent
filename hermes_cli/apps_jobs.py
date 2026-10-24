"""Hermes Apps sessions: an app hands a request (prompt, files, context) to a Hermes session.

Each request is a *job* stored under ``<home>/apps/<slug>/jobs/<job_id>/``::

    job.json      status, steps, pending question, result, session id
    answer.json   the app's reply to a pending question (written by the server)
    message.json  a follow-up message queued for the next turn (written by the server)
    files/        uploads the app attached to the request
    run.log       the worker process's output

The server creates a job and launches ``hermes apps run-job``; the worker owns ``job.json``
while it runs. The server only writes the separate answer/message files, so the two processes
never write the same file.

Statuses: ``queued`` → ``running`` → (``needs_input`` ↔ ``running``) → ``done`` | ``failed`` | ``waiting``.
``waiting``: a question went unanswered while the app was open, so the turn ended; the question and
session id stay on the job and a later answer resumes the same Hermes session. A finished job also
accepts a follow-up message. Waiting jobs do not count toward the active-request cap.
"""

from __future__ import annotations

import json
import os
import re
import secrets
import tempfile
import time
from pathlib import Path
from typing import Any, Optional, Sequence

from hermes_cli.apps_store import AppError, AppNotFound, app_dir, load_manifest

PROMPT_MAX = 8000
MESSAGE_MAX = 4000
CONTEXT_MAX_BYTES = 32 * 1024
MAX_FILES = 5
FILE_MAX_BYTES = 20 * 1024 * 1024
TOTAL_FILES_MAX_BYTES = 40 * 1024 * 1024
MAX_ACTIVE_JOBS = 2
STEPS_KEPT = 40
ACTIVE = frozenset({"queued", "running", "needs_input"})
FINISHED = frozenset({"done", "failed", "waiting"})
_JOB_ID_RE = re.compile(r"^[a-z0-9]{12}$")
_UNSAFE_NAME = re.compile(r"[^A-Za-z0-9._ -]+")
_FENCED_JSON = re.compile(r"```json\s*\n(.*?)\n```", re.DOTALL)


def _now() -> float:
    return round(time.time(), 3)


def jobs_root(home: Path, slug: str) -> Path:
    return app_dir(home, slug) / "jobs"


def job_dir(home: Path, slug: str, job_id: str) -> Path:
    if not isinstance(job_id, str) or not _JOB_ID_RE.match(job_id):
        raise AppNotFound("Unknown session request.")
    return jobs_root(home, slug) / job_id


def _write_json(path: Path, payload: Any) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    fd, tmp = tempfile.mkstemp(prefix=f".{path.name}.", dir=str(path.parent))
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as handle:
            json.dump(payload, handle, indent=2, ensure_ascii=False)
        os.replace(tmp, path)
    except BaseException:
        Path(tmp).unlink(missing_ok=True)
        raise


def _read_json(path: Path) -> Any:
    try:
        return json.loads(path.read_text(encoding="utf-8-sig"))
    except FileNotFoundError:
        return None


def safe_filename(name: str, index: int) -> str:
    base = Path(str(name or "")).name.strip()
    base = _UNSAFE_NAME.sub("_", base).strip(" .")[:120]
    return base or f"file-{index + 1}"


def _clean_context(context: Any) -> Optional[dict]:
    if context in (None, "", {}):
        return None
    if not isinstance(context, dict):
        raise AppError("Session context must be a JSON object.")
    if len(json.dumps(context, ensure_ascii=False).encode("utf-8")) > CONTEXT_MAX_BYTES:
        raise AppError(f"Session context is limited to {CONTEXT_MAX_BYTES // 1024} KB.")
    return context


def active_jobs(home: Path, slug: str) -> int:
    return sum(1 for job in _all_jobs(home, slug) if job.get("status") in ACTIVE)


def create_job(home: Path, slug: str, prompt: str, *, files: Sequence[tuple[str, bytes]] = (),
               context: Any = None) -> dict[str, Any]:
    """Validate and store a new request. Launching the worker is the caller's job."""
    load_manifest(home, slug)
    prompt = str(prompt or "").strip()
    if not prompt and not files:
        raise AppError("A session request needs a prompt or at least one file.")
    if len(prompt) > PROMPT_MAX:
        raise AppError(f"The prompt is limited to {PROMPT_MAX} characters.")
    if len(files) > MAX_FILES:
        raise AppError(f"A request can attach at most {MAX_FILES} files.")
    if any(len(data) > FILE_MAX_BYTES for _, data in files):
        raise AppError(f"Each file is limited to {FILE_MAX_BYTES // (1024 * 1024)} MB.")
    if sum(len(data) for _, data in files) > TOTAL_FILES_MAX_BYTES:
        raise AppError(f"Attached files are limited to {TOTAL_FILES_MAX_BYTES // (1024 * 1024)} MB in total.")
    context = _clean_context(context)
    if active_jobs(home, slug) >= MAX_ACTIVE_JOBS:
        raise AppError(f"This app already has {MAX_ACTIVE_JOBS} requests in progress. Try again when one finishes.")

    job_id = secrets.token_hex(6)
    folder = job_dir(home, slug, job_id)
    stored = []
    used: set[str] = set()
    for index, (name, data) in enumerate(files):
        filename = safe_filename(name, index)
        while filename in used:
            filename = f"{index + 1}-{filename}"
        used.add(filename)
        target = folder / "files" / filename
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_bytes(data)
        stored.append({"name": filename, "size": len(data)})
    now = _now()
    job = {
        "id": job_id, "slug": slug, "status": "queued", "created_at": now, "updated_at": now,
        "prompt": prompt, "context": context, "files": stored, "session_id": None,
        "steps": [], "question": None, "result": None, "error": None, "turns": 1,
    }
    _write_json(folder / "job.json", job)
    return job


def load_job(home: Path, slug: str, job_id: str) -> dict[str, Any]:
    job = _read_json(job_dir(home, slug, job_id) / "job.json")
    if not isinstance(job, dict):
        raise AppNotFound("Unknown session request.")
    return job


def save_job(home: Path, slug: str, job: dict[str, Any]) -> dict[str, Any]:
    job["updated_at"] = _now()
    job["steps"] = (job.get("steps") or [])[-STEPS_KEPT:]
    _write_json(job_dir(home, slug, job["id"]) / "job.json", job)
    return job


def add_step(job: dict[str, Any], text: str) -> None:
    job.setdefault("steps", []).append({"at": _now(), "text": str(text)[:200]})


def list_jobs(home: Path, slug: str, *, limit: int = 20, pending: bool = False) -> list[dict[str, Any]]:
    """Newest first. *pending* keeps only requests waiting on an answer."""
    jobs = _all_jobs(home, slug)
    if pending:
        jobs = [j for j in jobs if j.get("status") in ("needs_input", "waiting")]
    return jobs[: max(1, limit)]


def _all_jobs(home: Path, slug: str) -> list[dict[str, Any]]:
    root = jobs_root(home, slug)
    if not root.is_dir():
        return []
    jobs = []
    for child in root.iterdir():
        if child.is_dir() and _JOB_ID_RE.match(child.name):
            job = _read_json(child / "job.json")
            if isinstance(job, dict):
                jobs.append(job)
    jobs.sort(key=lambda j: j.get("created_at") or 0, reverse=True)
    return jobs


def public_view(job: dict[str, Any]) -> dict[str, Any]:
    """What the app sees: no filesystem paths, the prompt echoed back for its own history."""
    keys = ("id", "status", "created_at", "updated_at", "prompt", "files", "session_id", "steps",
            "question", "result", "error", "turns")
    return {key: job.get(key) for key in keys}


def submit_answer(home: Path, slug: str, job_id: str, answers: Any) -> dict[str, Any]:
    """Answer a live question (the turn is still open) or a ``waiting`` one (queues a resume).

    Returns the job; ``job["resume"]`` is True when the caller must relaunch the worker."""
    job = load_job(home, slug, job_id)
    question = job.get("question")
    if job.get("status") not in ("needs_input", "waiting") or not question:
        raise AppError("This request is not waiting for an answer.")
    if not isinstance(answers, dict):
        raise AppError("Answers must be an object keyed by question id.")
    known = {q["qid"] for q in question.get("questions") or []}
    unknown = set(answers) - known
    if unknown:
        raise AppError(f"Unknown question ids: {', '.join(sorted(unknown))}.")
    cleaned: dict[str, Any] = {}
    for qid, value in answers.items():
        if isinstance(value, list):
            cleaned[qid] = [str(v)[:MESSAGE_MAX] for v in value][:8]
        elif value is None:
            cleaned[qid] = None
        else:
            cleaned[qid] = str(value)[:MESSAGE_MAX]
    if job["status"] == "waiting":
        return dict(queue_message(home, slug, job_id, _answers_message(question, cleaned)), resume=True)
    _write_json(job_dir(home, slug, job_id) / "answer.json", {"ask_id": question["ask_id"], "answers": cleaned})
    return job


def _answers_message(question: dict, answers: dict) -> str:
    lines = ["Answers to the questions you asked earlier:"]
    for q in question.get("questions") or []:
        value = answers.get(q["qid"])
        shown = ", ".join(value) if isinstance(value, list) else (value or "(no answer)")
        lines.append(f"- {q['question']} {shown}")
    return "\n".join(lines)[:MESSAGE_MAX]


def queue_message(home: Path, slug: str, job_id: str, message: str) -> dict[str, Any]:
    """Queue a follow-up turn on a finished request; the caller relaunches the worker."""
    job = load_job(home, slug, job_id)
    message = str(message or "").strip()
    if not message:
        raise AppError("The message is empty.")
    if len(message) > MESSAGE_MAX:
        raise AppError(f"Messages are limited to {MESSAGE_MAX} characters.")
    if job.get("status") not in FINISHED:
        raise AppError("Wait for the current turn to finish before sending another message.")
    if active_jobs(home, slug) >= MAX_ACTIVE_JOBS:
        raise AppError(f"This app already has {MAX_ACTIVE_JOBS} requests in progress.")
    _write_json(job_dir(home, slug, job_id) / "message.json", {"message": message})
    job["status"] = "queued"
    job["error"] = None
    job["question"] = None
    job["turns"] = int(job.get("turns") or 1) + 1
    add_step(job, "Follow-up queued")
    return save_job(home, slug, job)


def take_file(home: Path, slug: str, job_id: str, name: str) -> Optional[dict]:
    """Read and remove a one-shot handoff file (answer.json / message.json)."""
    path = job_dir(home, slug, job_id) / name
    payload = _read_json(path)
    path.unlink(missing_ok=True)
    return payload if isinstance(payload, dict) else None


def parse_result(text: str) -> dict[str, Any]:
    """The final reply plus the last fenced ```json block, when the session produced one."""
    text = str(text or "").strip()
    result: dict[str, Any] = {"text": text, "json": None}
    blocks = _FENCED_JSON.findall(text)
    if blocks:
        try:
            result["json"] = json.loads(blocks[-1])
        except json.JSONDecodeError:
            result["json"] = None
    return result
