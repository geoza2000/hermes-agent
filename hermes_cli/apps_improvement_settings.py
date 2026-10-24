"""Profile-owned improvement preferences. Saving them reconciles ordinary cron jobs."""
from __future__ import annotations

from pathlib import Path

from hermes_cli import apps_store

DEFAULTS = {'enabled': True, 'schedule': 'weekly', 'token_budget': 12000, 'auto_apply': False}
SCHEDULES = ('weekly', 'daily', 'after-session', 'manual')


def validate(value: dict) -> dict:
    if not isinstance(value, dict) or set(value) - set(DEFAULTS):
        raise apps_store.AppError('Unknown improvement setting.')
    if 'enabled' in value and not isinstance(value['enabled'], bool):
        raise apps_store.AppError('Enabled must be true or false.')
    if 'schedule' in value and value['schedule'] not in SCHEDULES:
        raise apps_store.AppError('Schedule must be weekly, daily, after-session or manual.')
    if 'token_budget' in value:
        cap = value['token_budget']
        if isinstance(cap, bool) or not isinstance(cap, int) or not 512 <= cap <= 100000:
            raise apps_store.AppError('Token budget must be 512–100000.')
    if value.get('auto_apply') not in (None, False):
        raise apps_store.AppError('Automatic edits are not enabled. Approve suggestions explicitly.')
    return value


def _config(home: Path) -> dict:
    from hermes_cli.config_effective import load_user_config_effective

    return load_user_config_effective(home / 'config.yaml')


def settings(home: Path, slug: str | None = None) -> dict:
    global_settings = (_config(home).get('apps') or {}).get('improvements') or {}
    value = {**DEFAULTS, **validate(global_settings)}
    if slug:
        from hermes_cli.apps_improvements import load_state

        value.update(validate(load_state(home, slug).get('override') or {}))
    return value


def save_settings(home: Path, value: dict | None, *, slug: str | None = None, sync: bool = True) -> dict:
    from hermes_cli import apps_revisions
    from hermes_cli.config import atomic_config_write, read_user_config_raw

    if value is not None:
        validate(value)
    if slug:
        from hermes_cli.apps_improvements import load_state, save_state

        with apps_revisions.app_lock(home, slug):
            state = load_state(home, slug)
            state['override'] = value
            save_state(home, slug, state)
    else:
        if value is None:
            raise apps_store.AppError('Global preferences cannot be null.')
        config = read_user_config_raw(home / 'config.yaml')
        section = config.setdefault('apps', {})
        section['improvements'] = {**section.get('improvements', {}), **value}
        atomic_config_write(home / 'config.yaml', config)
    if sync:
        from hermes_cli.apps_improvement_schedule import sync_schedule

        sync_schedule(home)
    return settings(home, slug)
