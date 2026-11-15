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


def for_model(tool: str, text: str, limit: Optional[int] = None) -> str:
    """The text, or with the switch its object, cut so the object stays within limit (the model's tool_result_chars):
    escaping adds characters, so the answer inside is cut again by what the object went over."""
    if not enabled():
        return text
    out = as_json(tool, text)
    budget = len(text)
    while limit is not None and len(out) > limit and budget > 0:
        budget -= len(out) - limit
        out = as_json(tool, formatters._truncate_tool_result_for_llm(text, max(budget, 0), tool=tool))
    return out
