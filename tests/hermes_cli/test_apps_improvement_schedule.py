"""The existing cron store is the only timer; Apps never starts another scheduler."""
from pathlib import Path

from hermes_cli import apps_store


def test_settings_reconcile_profile_owned_weekly_daily_manual_jobs(tmp_path, monkeypatch):
    from cron import jobs
    from hermes_cli.apps_improvement_settings import save_settings
    from hermes_cli.apps_improvements import load_state

    home = tmp_path / '.hermes'
    monkeypatch.setenv('HERMES_HOME', str(home))
    monkeypatch.setattr(Path, 'home', lambda: tmp_path)
    apps_store.create_app(home, 'notes', 'Notes')
    save_settings(home, {'schedule': 'weekly'})
    job_id = load_state(home, 'notes')['schedule_job']
    job = jobs.get_job(job_id)
    assert job['schedule']['expr'] == '0 20 * * 0'
    assert job['no_agent'] is True and job['deliver'] == 'local'
    save_settings(home, {'schedule': 'daily'}, slug='notes')
    assert jobs.get_job(job_id)['schedule']['expr'] == '0 20 * * *'
    save_settings(home, {'schedule': 'manual'}, slug='notes')
    assert jobs.get_job(job_id) is None


def test_after_session_queues_one_deduplicated_cron_occurrence(tmp_path, monkeypatch):
    from cron import jobs
    from hermes_cli.apps_improvement_schedule import queue_after_session
    from hermes_cli.apps_improvement_settings import save_settings

    home = tmp_path / '.hermes'
    monkeypatch.setenv('HERMES_HOME', str(home))
    monkeypatch.setattr(Path, 'home', lambda: tmp_path)
    apps_store.create_app(home, 'notes', 'Notes')
    save_settings(home, {'schedule': 'after-session'}, slug='notes')
    first = queue_after_session(home, 'notes')
    second = queue_after_session(home, 'notes')
    assert first == second
    job = jobs.get_job(first)
    assert job['schedule']['kind'] == 'once'
    assert job['no_agent'] is True
