"""Per-turn usage accounting for chat streams.

A chat turn can call the model several times (tool-calling iterations and
length continuations). The totals collected here become the `after` payload of
the `ai.chat.complete` audit record, which the admin AI-usage view aggregates.
There is no hard limit on purpose: the operator looks at who used how much.

Two numbers describe the input side. `prompt_tokens` is what the provider
billed (Ollama reports only the tokens it evaluated this call, so a KV-cache
hit makes it small); `prompt_chars` is the size of what we sent — system
prompt, tool definitions, history and the message — counted here, so the
effect of history windows, summaries and tool-description changes is visible
regardless of the provider. `cached_tokens` is the part of the prompt the
provider served from its cache (Anthropic cache_read_input_tokens, OpenAI
prompt_tokens_details.cached_tokens).
"""
from __future__ import annotations

import json
from typing import Any, Optional


def new_turn_usage() -> dict[str, Any]:
    return {
        "prompt_tokens": 0,
        "completion_tokens": 0,
        "total_tokens": 0,
        "cached_tokens": 0,
        "cache_creation_tokens": 0,
        "prompt_chars": 0,
        "model_calls": 0,
        "seen": False,
    }


def _field(usage: Any, name: str) -> int:
    value = usage.get(name) if isinstance(usage, dict) else getattr(usage, name, None)
    try:
        return int(value or 0)
    except (TypeError, ValueError):
        return 0


def _cached_tokens(usage: Any) -> int:
    """prompt_tokens_details.cached_tokens as an OpenAI object or a dict."""
    details = usage.get("prompt_tokens_details") if isinstance(usage, dict) else getattr(usage, "prompt_tokens_details", None)
    if details is None:
        return 0
    return _field(details, "cached_tokens")


def prompt_chars(messages: Any, tools: Any = None) -> int:
    """The size of a model request as we send it: every message (role, content,
    tool calls) plus the tool definitions, as JSON characters."""
    total = 0
    for part in (messages, tools):
        if not part:
            continue
        try:
            total += len(json.dumps(part, ensure_ascii=False, default=str))
        except (TypeError, ValueError):
            total += len(str(part))
    return total


def add_usage(totals: dict[str, Any], usage: Any, *, prompt_chars: int = 0) -> dict[str, Any]:
    """Add one model call's usage (OpenAI-style object or dict; None is ignored)
    and the size of the prompt that call was sent."""
    totals["model_calls"] = totals.get("model_calls", 0) + 1
    totals["prompt_chars"] = totals.get("prompt_chars", 0) + max(0, int(prompt_chars or 0))
    if usage is None:
        return totals
    totals["prompt_tokens"] += _field(usage, "prompt_tokens")
    totals["completion_tokens"] += _field(usage, "completion_tokens")
    total = _field(usage, "total_tokens")
    if total == 0:
        total = _field(usage, "prompt_tokens") + _field(usage, "completion_tokens")
    totals["total_tokens"] += total
    totals["cached_tokens"] = totals.get("cached_tokens", 0) + _cached_tokens(usage)
    totals["cache_creation_tokens"] = totals.get("cache_creation_tokens", 0) + _field(usage, "cache_creation_input_tokens")
    totals["seen"] = True
    return totals


def usage_event(usage: Any, *, prompt_chars: int = 0) -> dict[str, Any]:
    """One model call's usage as the SSE `usage` event carries it."""
    return {
        "prompt_tokens": _field(usage, "prompt_tokens"),
        "completion_tokens": _field(usage, "completion_tokens"),
        "total_tokens": _field(usage, "total_tokens") or (_field(usage, "prompt_tokens") + _field(usage, "completion_tokens")),
        "cached_tokens": _cached_tokens(usage),
        "prompt_chars": int(prompt_chars or 0),
    }


def message_usage(usage: dict[str, Any], *, model: Optional[str]) -> Optional[dict[str, Any]]:
    """What the answer message keeps of its turn (messages.usage, shown under the
    answer): the same token sums as the turn's ai.chat.complete row, or None
    when the provider sent no usage."""
    if not usage.get("seen"):
        return None
    return {
        "prompt_tokens": int(usage["prompt_tokens"]),
        "completion_tokens": int(usage["completion_tokens"]),
        "cached_tokens": int(usage.get("cached_tokens", 0)),
        "model_calls": int(usage.get("model_calls", 0)),
        "model": model,
    }


def chat_complete_payload(
    *,
    session_id: Optional[str],
    provider: Optional[str],
    model: Optional[str],
    cluster: Optional[str],
    usage: dict[str, Any],
    tool_calls: int,
    iterations: int,
    duration_ms: int,
    finish_reason: Optional[str] = None,
    message_length: int = 0,
    phase: str = "chat",
) -> dict[str, Any]:
    """The `after` payload of ai.chat.complete. Token fields are null when the
    provider sent no usage (an OpenAI-compatible endpoint that ignores
    stream_options.include_usage), so sums in the admin view skip them;
    prompt_chars and model_calls are ours and always present.
    `phase` is `chat` for a chat turn and `optimization` for the Optimization
    page's AI explanation, which has no session."""
    seen = bool(usage.get("seen"))
    return {
        "phase": phase,
        "session_id": session_id,
        "provider": provider,
        "model": model,
        "cluster": cluster,
        "prompt_tokens": usage["prompt_tokens"] if seen else None,
        "completion_tokens": usage["completion_tokens"] if seen else None,
        "total_tokens": usage["total_tokens"] if seen else None,
        "cached_tokens": usage.get("cached_tokens", 0) if seen else None,
        "cache_creation_tokens": usage.get("cache_creation_tokens", 0) if seen else None,
        "prompt_chars": int(usage.get("prompt_chars", 0)),
        "model_calls": int(usage.get("model_calls", 0)),
        "tool_calls": int(tool_calls),
        "iterations": int(iterations),
        "duration_ms": int(duration_ms),
        "finish_reason": finish_reason,
        "message_length": int(message_length),
    }
