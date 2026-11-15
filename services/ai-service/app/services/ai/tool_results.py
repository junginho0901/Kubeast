"""What the model reads of a tool's answer. With AI_TOOL_RESULTS_JSON (chart ai.toolResultsJSON) each answer is one JSON
object naming its tool, so text a cluster wrote (a log line, an event, an annotation) reaches the model as a JSON string
it cannot close or read as more than data; off, the model reads the answer as before."""
from __future__ import annotations

import json
from typing import Any, Optional

from app.services import switch
from app.services.ai import formatters

# Tools whose answer is text a container or the cluster wrote as it is: a log line that is one JSON object stays a string.
RAW_TEXT_TOOLS = frozenset({"k8s_get_pod_logs", "k8s_describe_resource", "k8s_get_resource_yaml", "k8s_execute_command"})


def enabled() -> bool:
    return switch.env_on("AI_TOOL_RESULTS_JSON")


def as_json(tool: str, text: str, args: Optional[dict] = None) -> str:
    """The answer as {"tool", ["args",] "result"}: a JSON object or list Kubeast built as itself, anything else (a log,
    YAML, a cut answer, a raw-text tool's answer) as a string."""
    value: Any = text
    if tool not in RAW_TEXT_TOOLS:
        try:
            parsed = json.loads(text)
        except (TypeError, ValueError):
            parsed = None
        if isinstance(parsed, (dict, list)):
            value = parsed
    entry: dict[str, Any] = {"tool": tool}
    if args is not None:
        entry["args"] = args
    entry["result"] = value
    return json.dumps(entry, ensure_ascii=False)


def _wrapped(tool: str, text: str, budget: int) -> str:
    return as_json(tool, formatters._truncate_tool_result_for_llm(text, budget, tool=tool))


def for_model(tool: str, text: str, limit: Optional[int] = None) -> str:
    """The text, or with the switch its object, cut so the object stays within limit (the model's tool_result_chars):
    escaping adds characters, so the answer inside keeps the most of it whose object fits."""
    if not enabled():
        return text
    out = as_json(tool, text)
    if limit is None or len(out) <= limit:
        return out
    low, high = 0, len(text)
    while low < high:
        mid = (low + high + 1) // 2
        if len(_wrapped(tool, text, mid)) <= limit:
            low = mid
        else:
            high = mid - 1
    return _wrapped(tool, text, low)
