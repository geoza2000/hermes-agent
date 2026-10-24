"""Authenticated Apps improvement settings, review requests and owner decisions."""
from typing import Optional

from fastapi import APIRouter, Request

from hermes_cli import apps_improvements
from hermes_cli.apps_improvement_settings import save_settings, settings
from hermes_cli.web_routers._common import destructive_profile
from hermes_cli.web_routers.apps import _current_home_and_name, _optional_json, _require_token, _scoped

router = APIRouter()


def _view(home, slug=None):
    value = {'settings': settings(home, slug)}
    if slug:
        value.update(apps_improvements.load_state(home, slug))
    return value


@router.get('/api/apps-improvements')
async def global_settings(request: Request, profile: Optional[str] = None):
    _require_token(request)
    return await _scoped(profile, lambda: _view(_current_home_and_name()[0]))


@router.put('/api/apps-improvements')
async def update_global_settings(request: Request, profile: Optional[str] = None):
    _require_token(request)
    profile = destructive_profile(profile, 'PUT /api/apps-improvements')
    body = await _optional_json(request)

    def run():
        home, _ = _current_home_and_name()
        save_settings(home, body)
        return _view(home)

    return await _scoped(profile, run)


@router.get('/api/apps/{slug}/improvements')
async def app_settings(slug: str, request: Request, profile: Optional[str] = None):
    _require_token(request)
    return await _scoped(profile, lambda: _view(_current_home_and_name()[0], slug))


@router.put('/api/apps/{slug}/improvements')
async def update_app_settings(slug: str, request: Request, profile: Optional[str] = None):
    _require_token(request)
    profile = destructive_profile(profile, 'PUT /api/apps/{slug}/improvements')
    body = await _optional_json(request)

    def run():
        home, _ = _current_home_and_name()
        save_settings(home, None if body == {'inherit': True} else body, slug=slug)
        return _view(home, slug)

    return await _scoped(profile, run)


@router.post('/api/apps/{slug}/improvements/run')
async def run_review(slug: str, request: Request, profile: Optional[str] = None):
    _require_token(request)
    profile = destructive_profile(profile, 'POST /api/apps/{slug}/improvements/run')

    def run():
        from hermes_cli.apps_improvement_launcher import queue_review

        home, name = _current_home_and_name()
        return {'request': queue_review(home, name, slug)}

    return await _scoped(profile, run)


@router.post('/api/apps/{slug}/improvements/{suggestion_id}/{decision}')
async def decide(slug: str, suggestion_id: str, decision: str, request: Request, profile: Optional[str] = None):
    _require_token(request)
    profile = destructive_profile(profile, 'POST /api/apps/{slug}/improvements/decision')
    return await _scoped(profile, lambda: apps_improvements.decide(_current_home_and_name()[0], slug, suggestion_id, decision))
