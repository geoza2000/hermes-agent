"""Launch the detached ``hermes apps run-job`` worker for a Hermes Apps session request.

Uses the same installation-bound command and scrubbed per-profile environment as dashboard
actions, so a worker for profile B never inherits the dashboard profile's credentials.
"""

from __future__ import annotations

import subprocess
import sys
from pathlib import Path
from typing import Any

from hermes_cli import apps_jobs


def _subcommand(profile: str, slug: str, job_id: str) -> list[str]:
    selector = [] if profile == "custom" else ["-p", profile]
    return [*selector, "apps", "run-job", slug, job_id]


def launch_job_worker(home: Path, profile: str, slug: str, job_id: str) -> int:
    """Start the worker detached and return its pid. Output goes to the job's ``run.log``."""
    from hermes_cli._launchers import runtime_command
    from hermes_cli._subprocess_compat import windows_detach_flags
    from hermes_cli.web_server import PROJECT_ROOT
    from hermes_cli.web_server_gateway import _profile_action_environment

    subcommand = _subcommand(profile, slug, job_id)
    env = _profile_action_environment(subcommand, {"HERMES_SESSION_PLATFORM": "apps"})
    if profile == "custom":
        env["HERMES_HOME"] = str(home)
    log_path = apps_jobs.job_dir(home, slug, job_id) / "run.log"
    with open(log_path, "ab", buffering=0) as log_file:
        detach: dict[str, Any] = (
            {"creationflags": windows_detach_flags()} if sys.platform == "win32" else {"start_new_session": True})
        proc = subprocess.Popen(
            runtime_command(PROJECT_ROOT, subcommand), cwd=str(home), stdin=subprocess.DEVNULL,
            stdout=log_file, stderr=subprocess.STDOUT, env=env, **detach,
        )
    return proc.pid
