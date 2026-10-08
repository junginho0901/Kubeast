"""Per-turn usage accounting for chat streams.

A chat turn can call the model several times (tool-calling iterations and
length continuations). The totals collected here become the `after` payload of
the `ai.chat.complete` audit record, which the admin AI-usage view aggregates.
There is no hard limit on purpose: the operator looks at who used how much.
"""
from __future__ import annotations

from typing import Any, Optional


def new_turn_usage() -> dict[str, Any]:
    return {"prompt_tokens": 0, "completion_tokens": 0, "total_tokens": 0, "seen": False}


def _field(usage: Any, name: str) -> int:
    value = usage.get(name) if isinstance(usage, dict) else getattr(usage, name, None)
    try:
        return int(value or 0)
    except (TypeError, ValueError):
        return 0


def add_usage(totals: dict[str, Any], usage: Any) -> dict[str, Any]:
    """Add one model call's usage (OpenAI-style object or dict; None is ignored)."""
    if usage is None:
        return totals
    totals["prompt_tokens"] += _field(usage, "prompt_tokens")
    totals["completion_tokens"] += _field(usage, "completion_tokens")
    total = _field(usage, "total_tokens")
    if total == 0:
        total = _field(usage, "prompt_tokens") + _field(usage, "completion_tokens")
    totals["total_tokens"] += total
    totals["seen"] = True
    return totals


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
    stream_options.include_usage), so sums in the admin view skip them.
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
        "tool_calls": int(tool_calls),
        "iterations": int(iterations),
        "duration_ms": int(duration_ms),
        "finish_reason": finish_reason,
        "message_length": int(message_length),
    }
