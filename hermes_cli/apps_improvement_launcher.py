"""Start a review in a scrubbed, explicit-profile worker, never the web server's runtime."""
from __future__ import annotations

import secrets
import subprocess
import sys
import time
from pathlib import Path

from hermes_cli import apps_revisions, apps_store


def queue_review(home: Path, profile: str, slug: str) -> dict:
    from hermes_cli._launchers import runtime_command
    from hermes_cli._subprocess_compat import windows_detach_flags
    from hermes_cli.apps_improvements import load_state, save_state
    from hermes_cli.web_server import PROJECT_ROOT
    from hermes_cli.web_server_gateway import _profile_action_environment

    with apps_revisions.app_lock(home, slug):
        state = load_state(home, slug)
        pending = state.get('request')
        if pending and pending['status'] == 'queued' and time.time() - pending['at'] < 180:
            return pending
        request = {'id': secrets.token_hex(12), 'status': 'queued', 'at': time.time()}
        state['request'] = request
        save_state(home, slug, state)
        selector = [] if profile == 'custom' else ['-p', profile]
        command = [*selector, 'apps', 'review', slug, '--request-id', request['id']]
        env = _profile_action_environment(command, {'HERMES_SESSION_PLATFORM': 'apps'})
        env['HERMES_HOME'] = str(home)
        detach = {'creationflags': windows_detach_flags()} if sys.platform == 'win32' else {'start_new_session': True}
        try:
            with (apps_store.app_dir(home, slug) / 'review.log').open('ab', buffering=0) as log:
                subprocess.Popen(runtime_command(PROJECT_ROOT, command), cwd=str(home), stdin=subprocess.DEVNULL,
                                 stdout=log, stderr=subprocess.STDOUT, env=env, **detach)
        except OSError as exc:
            request.update(status='failed', error='Could not start review worker.')
            save_state(home, slug, state)
            raise apps_store.AppError('Could not start the Hermes review worker.') from exc
        return request
