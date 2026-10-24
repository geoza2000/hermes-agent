"""The CLI worker consumes a request exactly once and persists failures."""
import argparse

from hermes_cli import apps_cmd, apps_improvements, apps_store


def test_cli_review_consumes_request_and_duplicate_does_not_repeat(tmp_path, monkeypatch):
    home = tmp_path / '.hermes'
    monkeypatch.setenv('HERMES_HOME', str(home))
    apps_store.create_app(home, 'notes', 'Notes')
    state = apps_improvements.load_state(home, 'notes')
    state['request'] = {'id': 'one', 'at': __import__('time').time(), 'status': 'queued'}
    apps_improvements.save_state(home, 'notes', state)
    parser = argparse.ArgumentParser()
    apps_cmd.add_parser(parser.add_subparsers())
    args = parser.parse_args(['apps', 'review', 'notes', '--request-id', 'one'])
    assert args.func(args) == 0
    result = apps_improvements.load_state(home, 'notes')
    assert result['request']['status'] == 'done'
    assert result['request']['run_id'] == result['runs'][-1]['id']
    assert args.func(args) == 0
    assert len(apps_improvements.load_state(home, 'notes')['runs']) == 1


def test_worker_failure_releases_request(tmp_path, monkeypatch):
    home = tmp_path / '.hermes'
    apps_store.create_app(home, 'notes', 'Notes')
    state = apps_improvements.load_state(home, 'notes')
    state['request'] = {'id': 'one', 'at': __import__('time').time(), 'status': 'queued'}
    apps_improvements.save_state(home, 'notes', state)

    def fail(*args, **kwargs):
        raise OSError('disk unavailable')

    monkeypatch.setattr(apps_improvements, 'run_review', fail)
    assert apps_improvements.run_request(home, 'notes', 'one') == 1
    request = apps_improvements.load_state(home, 'notes')['request']
    assert request['status'] == 'failed'
    assert 'disk unavailable' in request['error']
