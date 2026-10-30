"""A model's own limits, saved in its options (AI Models → Limits): the longest answer in tokens (max_tokens) and the
longest tool result the model is given, in characters (tool_result_chars). Empty means the call's own default."""

from typing import Any, Mapping, Optional

TOOL_RESULT_CHARS = 6000
ANSWER_TOKENS_RANGE = (1, 1_000_000)
TOOL_RESULT_CHARS_RANGE = (1_000, 200_000)
RANGES = {"max_tokens": ANSWER_TOKENS_RANGE, "tool_result_chars": TOOL_RESULT_CHARS_RANGE}
# Read by Kubeast only, never sent to a provider: OpenAI refuses a parameter it does not know.
KUBEAST_KEYS = frozenset({"tool_result_chars"})


def _value(options: Optional[Mapping[str, Any]], key: str) -> Optional[int]:
    v = (options or {}).get(key)
    lo, hi = RANGES[key]
    if isinstance(v, bool) or not isinstance(v, int) or not lo <= v <= hi:
        return None
    return v


def answer_tokens(service: Any, default: int) -> int:
    return _value(getattr(service, "options", None), "max_tokens") or default


def tool_result_chars(service: Any) -> int:
    return _value(getattr(service, "options", None), "tool_result_chars") or TOOL_RESULT_CHARS


def check(options: Optional[Mapping[str, Any]]) -> None:
    """Refuses a limit that is not a whole number in its range (on save; a row written before is read as empty)."""
    for key, (lo, hi) in RANGES.items():
        if options is None or options.get(key) is None:
            continue
        if _value(options, key) is None:
            raise ValueError(f"options.{key} must be a whole number from {lo} to {hi}")
