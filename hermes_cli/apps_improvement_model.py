"""One bounded, tool-free model request for an Apps improvement review.

The request goes through Hermes' auxiliary client, so it uses the profile's configured provider
(including openai-codex); `auxiliary.apps_review` in config.yaml can point it at a cheaper model.
The token budget is enforced in three steps, on every provider:

1. an input estimate must leave room for a reply before anything is sent;
2. exactly one request is made, with no tools and no retries;
3. the provider's measured usage is checked, and a run over the budget is discarded.

An output cap is requested too, but the auxiliary client forwards it only on routes that need
or honour it (Anthropic, OpenRouter, Gemini, local servers); Codex rejects it. So step 3, not the
cap, is the guarantee: an overspending run can cost more than the budget once, but its
suggestions are never applied.
"""
from __future__ import annotations

import math

from hermes_cli.apps_store import AppError

MIN_OUTPUT_TOKENS = 512
MAX_OUTPUT_TOKENS = 4096
_FRAMING_TOKENS = 64
_RUN_FRAMING_TOKENS = 256


class BudgetExhausted(AppError):
    pass


def input_reservation(messages: list[dict]) -> int:
    """Conservative token estimate: ~3 UTF-8 bytes per token for code and prose, plus framing."""
    return sum(math.ceil(len(m['content'].encode('utf-8')) / 3) + _FRAMING_TOKENS for m in messages) + _RUN_FRAMING_TOKENS


def request(messages: list[dict], max_tokens: int):
    from agent.auxiliary_client import call_llm

    return call_llm(task='apps_review', messages=messages, max_tokens=max_tokens, timeout=120)


def bounded_call(messages: list[dict], budget: int, *, model_call=None) -> tuple[object, dict]:
    reserved = input_reservation(messages)
    output_cap = min(MAX_OUTPUT_TOKENS, budget - reserved)
    if output_cap < MIN_OUTPUT_TOKENS:
        raise BudgetExhausted(
            f'This app needs about {reserved + MIN_OUTPUT_TOKENS} tokens per review, over the {budget} token cap. '
            'Raise the cap for this app.')
    response = (model_call or request)(messages, max_tokens=output_cap)
    usage = getattr(response, 'usage', None)
    total = getattr(usage, 'total_tokens', None)
    if not isinstance(total, int) or isinstance(total, bool) or total <= 0:
        raise AppError('The provider did not report token usage, so the review was discarded.')
    measured = {'total_tokens': total, 'input_estimate': reserved, 'output_allowance': output_cap, 'api_calls': 1}
    if total > budget:
        raise BudgetExhausted(f'The review used {total} tokens, over the {budget} token cap, so its suggestions were discarded.',
                              ) from None
    return response, measured
