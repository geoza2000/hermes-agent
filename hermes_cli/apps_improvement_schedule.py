"""Reconcile Apps review timers using Hermes cron's profile-owned store and workers."""
from __future__ import annotations

import contextlib
import datetime
import json
import os
import sys
from pathlib import Path

from hermes_cli import apps_revisions, apps_store
from hermes_cli.apps_improvement_settings import settings
from hermes_constants import reset_hermes_home_override, set_hermes_home_override


@contextlib.contextmanager
def _scope(home: Path):
    token = set_hermes_home_override(home)
    try:
        yield
    finally:
        reset_hermes_home_override(token)


def _script(home: Path, slug: str) -> str:
    # A fixed file, never a shell command; cron owns execution, profile env and time zone.
    source = Path(__file__).resolve().parent.parent
    path = home / 'scripts' / f'apps-review-{slug}.py'
    path.parent.mkdir(parents=True, exist_ok=True)
    text = (f'import sys\nsys.path.insert(0, {str(source)!r})\n'
            'from hermes_cli.apps_improvement_schedule import script_main\n'
            f'script_main({slug!r})\n')
    temporary = path.with_suffix('.new')
    temporary.write_text(text, encoding='utf-8')
    os.replace(temporary, path)
    return path.name


def _sync_app(home: Path, slug: str) -> None:
    from cron import jobs
    from hermes_cli.apps_improvements import load_state, save_state

    with apps_revisions.app_lock(home, slug):
        state = load_state(home, slug)
        config = settings(home, slug)
        existing = jobs.get_job(state['schedule_job']) if state.get('schedule_job') else None
        expr = {'weekly': '0 20 * * 0', 'daily': '0 20 * * *'}.get(config['schedule']) if config['enabled'] else None
        if expr:
            script = _script(home, slug)
            if existing:
                jobs.update_job(existing['id'], {'schedule': expr, 'script': script, 'no_agent': True,
                                                   'deliver': 'local', 'interpreter': sys.executable})
            else:
                job = jobs.create_job('', expr, name=f'Apps review: {slug}', script=script,
                                      no_agent=True, deliver='local', interpreter=sys.executable)
                state['schedule_job'] = job['id']
        else:
            if existing:
                jobs.remove_job(existing['id'])
            state['schedule_job'] = None
        if config['schedule'] != 'after-session' or not config['enabled']:
            if state.get('after_session_job'):
                jobs.remove_job(state['after_session_job'])
            state['after_session_job'] = None
        save_state(home, slug, state)


def sync_schedule(home: Path) -> None:
    with _scope(home):
        for app in apps_store.list_apps(home):
            _sync_app(home, app['slug'])


def queue_after_session(home: Path, slug: str) -> str | None:
    from cron import jobs
    from hermes_cli.apps_improvements import load_state, save_state

    config = settings(home, slug)
    if not config['enabled'] or config['schedule'] != 'after-session':
        return None
    with _scope(home), apps_revisions.app_lock(home, slug):
        state = load_state(home, slug)
        previous = jobs.get_job(state['after_session_job']) if state.get('after_session_job') else None
        if previous and previous.get('enabled'):
            return previous['id']
        instant = (datetime.datetime.now(datetime.UTC) + datetime.timedelta(seconds=5)).isoformat()
        job = jobs.create_job('', instant, name=f'Apps after-session review: {slug}', script=_script(home, slug),
                              no_agent=True, deliver='local', interpreter=sys.executable)
        state['after_session_job'] = job['id']
        save_state(home, slug, state)
        return job['id']


def script_main(slug: str) -> None:
    from hermes_cli.apps_improvements import run_review
    from hermes_constants import get_hermes_home

    state = run_review(get_hermes_home(), slug)
    last = state['runs'][-1] if state['runs'] else {'status': 'skipped'}
    print(json.dumps({'app': slug, 'run': last}))
    if last['status'] in ('failed', 'budget_exhausted'):
        raise SystemExit(1)
