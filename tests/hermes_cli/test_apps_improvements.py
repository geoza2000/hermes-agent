"""Improvements are evidence-backed proposals; neither review nor approval publishes."""
import json
from types import SimpleNamespace

import pytest

from hermes_cli import apps_store, apps_telemetry


def test_review_persists_three_evidenced_suggestions_and_approval_only_edits_draft(tmp_path):
    from hermes_cli import apps_improvements as improve, apps_revisions

    home = tmp_path / '.hermes'
    apps_store.create_app(home, 'notes', 'Notes')
    draft = apps_store.app_dir(home, 'notes') / 'draft' / 'index.html'
    draft.write_text('<button>Save</button>')
    apps_store.publish(home, 'notes')
    apps_telemetry.record_events(home, 'notes', [{'type': 'error', 'target': 'Save'}], viewer='owner')
    calls = []

    def model(messages, max_tokens):
        calls.append(max_tokens)
        return SimpleNamespace(choices=[SimpleNamespace(message=SimpleNamespace(content=json.dumps({
            'suggestions': [{'title': f'Clarify save {n}', 'reason': 'Save errors', 'evidence': ['errors:Save'],
                             'edit': {'path': 'index.html', 'before': 'Save', 'after': 'Save note'}} for n in range(5)]
        })))], usage=SimpleNamespace(prompt_tokens=100, completion_tokens=200, total_tokens=300))

    result = improve.run_review(home, 'notes', model_call=model)
    assert len(result['suggestions']) == 3
    assert result['runs'][-1]['total_tokens'] == 300
    assert 0 < calls[0] < improve.settings(home, 'notes')['token_budget']
    sid = result['suggestions'][0]['id']
    approved = improve.decide(home, 'notes', sid, 'approve')
    assert approved['suggestions'][0]['status'] == 'applied'
    assert draft.read_text() == '<button>Save note</button>'
    assert (apps_store.content_dir(home, 'notes') / 'index.html').read_text() == '<button>Save</button>'
    review = apps_revisions.review(home, 'notes')
    apps_revisions.publish_review(home, 'notes', review)
    assert apps_store.load_manifest(home, 'notes')['current_version'] == 2
    improve.decide(home, 'notes', result['suggestions'][1]['id'], 'dismiss')
    assert improve.load_state(home, 'notes')['suggestions'][1]['status'] == 'dismissed'


def test_budget_blocks_before_model_and_unsupported_evidence_is_not_persisted(tmp_path):
    from hermes_cli import apps_improvements as improve

    home = tmp_path / '.hermes'
    apps_store.create_app(home, 'notes', 'Notes')
    improve.save_settings(home, {'token_budget': 512}, slug='notes', sync=False)
    calls = []
    result = improve.run_review(home, 'notes', model_call=lambda *a, **kw: calls.append(1))
    assert not calls
    assert result['runs'][-1]['status'] == 'budget_exhausted'


def test_stale_suggestion_never_overwrites_an_external_edit(tmp_path):
    from hermes_cli import apps_improvements as improve, apps_revisions

    home = tmp_path / '.hermes'
    apps_store.create_app(home, 'notes', 'Notes')
    revision = apps_revisions.draft_revision(home, 'notes')
    improve.save_state(home, 'notes', {'suggestions': [{'id': 'test', 'status': 'pending', 'base_revision': revision,
        'edit': {'path': 'index.html', 'before': 'Notes', 'after': 'Different'}}], 'runs': []})
    draft = apps_store.app_dir(home, 'notes') / 'draft' / 'index.html'
    draft.write_text('external edit')
    with pytest.raises(apps_store.AppError, match='changed'):
        improve.decide(home, 'notes', 'test', 'approve')
    assert draft.read_text() == 'external edit'
