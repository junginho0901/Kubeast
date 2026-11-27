"""A thinking model's reasoning on an assistant message, sent back in the next requests of the same tool loop.

DeepSeek's thinking mode, on by default, answers with the reasoning as the message's `reasoning_content` and refuses with a
400 a request with tools whose earlier assistant message comes back without it (api-docs.deepseek.com "Thinking mode");
Together's thinking models give `reasoning` or `reasoning_content` and take it back under the same key over the steps
of a tool loop (docs.together.ai "OpenAI API compatibility"). The two tool loops (tool_turn.run_tool_turn,
streaming.session_chat_stream) keep each of these fields the answer gave, when it is text that is not empty, on that
assistant message of the loop's own history, as they keep Gemini's `extra_content` (thought_signatures).

Only a client that `applies` to keeps them (ProviderAdapter.reasoning_back): a provider reached at its own API (openai
with no base URL, azure, anthropic, google, gemini, ollama, claude-code) keeps none, and an answer with no such field
keeps none, so those requests are as before. openai with a base URL is another OpenAI-compatible endpoint, as a
ModelConfig names one. The saved answer, the audit rows and the next turn's history are made from the answer's text and
tool calls, not from the loop's messages, and hold none of it. An endpoint whose 400 names a field it was sent gets the
request once more without the fields, and when that is taken provider_adapter leaves them out of that endpoint's
requests from then on (`refused`, `without`).
"""

from __future__ import annotations

import re
from typing import Any

from app.services.model_config_policy import AZURE_PROVIDERS, PROVIDER_BASE_URLS, SUBSCRIPTION_PROVIDER, provider_id

# As the answers name them; each goes back under its own key.
KEYS = ("reasoning_content", "reasoning")
# Reached at their own API, where nothing asks for the reasoning back: their requests stay as they were.
_OWN_API = (frozenset(PROVIDER_BASE_URLS) | AZURE_PROVIDERS | {SUBSCRIPTION_PROVIDER}) - {"openai"}
# A refusal naming a field: the key as a word, so `reasoning_effort` is not one.
_NAMED = re.compile(r"\b(?:reasoning_content|reasoning)\b")


def applies(provider: Any, base_url: Any = None) -> bool:
    """Whether a client of this provider and base URL keeps the fields: an OpenAI-compatible endpoint that is not a
    provider's own API."""
    p = provider_id(str(provider or ""))
    if p == "openai":
        return bool(str(base_url or "").strip())
    return p not in _OWN_API


def _sends_back(service: Any) -> bool:
    return getattr(getattr(service, "client", None), "reasoning_back", False) is True


def _field(source: Any, key: str) -> Any:
    return source.get(key) if isinstance(source, dict) else getattr(source, key, None)


def kept(service: Any, message: Any) -> dict[str, str]:
    """What the history keeps on an assistant message besides its role, content and tool calls: the fields the answer
    gave (a response's message, or what add_delta collected), text that is not empty, when the service's client sends
    them back; else nothing."""
    out: dict[str, str] = {}
    if not _sends_back(service):
        return out
    for key in KEYS:
        value = _field(message, key)
        if isinstance(value, str) and value:
            out[key] = value
    return out


def add_delta(service: Any, held: dict[str, str], delta: Any) -> None:
    """Streaming: the reasoning comes in pieces, before the text and the calls; `held` collects them by key."""
    if not _sends_back(service):
        return
    for key in KEYS:
        piece = _field(delta, key)
        if isinstance(piece, str) and piece:
            held[key] = held.get(key, "") + piece


def _carried(messages: Any) -> bool:
    return isinstance(messages, list) and any(isinstance(m, dict) and any(k in m for k in KEYS) for m in messages)


def refused(err: Exception, messages: Any) -> bool:
    """A 400 whose text names one of the fields, for a request that carried one."""
    return getattr(err, "status_code", None) == 400 and _carried(messages) and bool(_NAMED.search(str(err)))


def without(messages: Any) -> Any:
    """The messages with none of the fields; the caller's list and messages stay as they are."""
    if not _carried(messages):
        return messages
    return [{k: v for k, v in m.items() if k not in KEYS} if isinstance(m, dict) else m for m in messages]
