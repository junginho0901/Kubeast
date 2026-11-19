"""Gemini's thought signatures on function calls (provider google or gemini).

Gemini 3 and later sign the first function call of each step, and refuse with a 400 a request whose current turn (from
the last user message; a tool result is not one) holds a step whose first call comes back without its signature. Through
the OpenAI-compatible endpoint the signature is the call's `extra_content.google.thought_signature`. The two tool loops
(tool_turn.run_tool_turn, streaming.session_chat_stream) keep a call's `extra_content` in the history as received, and
provider_adapter sends a google request through `sent`, which gives the calls the server made itself (ids starting with
SERVER_CALL_ID, the investigator's step 0) the placeholder Google documents for calls the model did not make. A call of
the model's that came without a signature goes back as it came: Google calls the placeholder a last resort that costs the
model's reasoning. Other providers keep their calls as before: id, type and function.
"""

from __future__ import annotations

from typing import Any

PROVIDERS = frozenset({"google", "gemini"})
# ai.google.dev and Vertex AI "Thought signatures": a function call the model did not make skips the check with this.
PLACEHOLDER = "skip_thought_signature_validator"
# The id of a call the server made before the first model call is this and its number.
SERVER_CALL_ID = "kubeast_step0_"


def is_google(provider: Any) -> bool:
    return str(provider or "").strip().lower() in PROVIDERS


def _extra_content(call: Any) -> Any:
    return call.get("extra_content") if isinstance(call, dict) else getattr(call, "extra_content", None)


def kept(provider: Any, call: Any) -> dict[str, Any]:
    """What the history keeps with a call besides its id, type and function: on google its `extra_content` as the
    answer gave it (a response's tool call, or a streamed call's collected dict), else nothing."""
    extra = _extra_content(call) if is_google(provider) else None
    return {"extra_content": extra} if isinstance(extra, dict) and extra else {}


def _merged(held: dict[str, Any], more: dict[str, Any]) -> dict[str, Any]:
    out = dict(held)
    for key, value in more.items():
        out[key] = _merged(out[key], value) if isinstance(value, dict) and isinstance(out.get(key), dict) else value
    return out


def add_delta(provider: Any, held: dict[str, Any], delta: Any) -> None:
    """Streaming: a call's `extra_content` may come with any of its chunks; `held` is the call collected so far."""
    extra = _extra_content(delta) if is_google(provider) else None
    if isinstance(extra, dict) and extra:
        held["extra_content"] = _merged(held.get("extra_content") or {}, extra)


def _signed(call: dict[str, Any]) -> bool:
    extra = call.get("extra_content")
    google = extra.get("google") if isinstance(extra, dict) else None
    return isinstance(google, dict) and bool(google.get("thought_signature"))


def _server_made(call: dict[str, Any]) -> bool:
    return str(call.get("id") or "").startswith(SERVER_CALL_ID)


def sent(messages: Any) -> Any:
    """The messages of a google request: a step of the current turn the server made, whose first call has no signature,
    carries the placeholder on that call. The caller's list and messages stay as they are."""
    if not isinstance(messages, list):
        return messages
    start = next((i + 1 for i in range(len(messages) - 1, -1, -1)
                  if isinstance(messages[i], dict) and messages[i].get("role") == "user"), 0)
    out = None
    for i in range(start, len(messages)):
        message = messages[i]
        if not isinstance(message, dict) or message.get("role") != "assistant":
            continue
        calls = message.get("tool_calls") or []
        if not calls or not isinstance(calls[0], dict) or _signed(calls[0]) or not _server_made(calls[0]):
            continue
        first = dict(calls[0])
        extra = first.get("extra_content") if isinstance(first.get("extra_content"), dict) else {}
        google = extra.get("google") if isinstance(extra.get("google"), dict) else {}
        first["extra_content"] = {**extra, "google": {**google, "thought_signature": PLACEHOLDER}}
        out = out if out is not None else list(messages)
        out[i] = {**message, "tool_calls": [first, *calls[1:]]}
    return out if out is not None else messages
