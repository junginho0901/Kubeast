"""What the model reads of a tool's answer. With AI_TOOL_RESULTS_JSON (chart ai.toolResultsJSON) each answer is one JSON
object naming its tool, so text a cluster wrote (a log line, an event, an annotation) reaches the model as a JSON string
it cannot close or read as more than data; off, the model reads the answer as before."""
from __future__ import annotations

import json
import os
from typing import Any, Optional


def enabled() -> bool:
    return os.getenv("AI_TOOL_RESULTS_JSON", "false").strip().lower() in ("true", "1", "on")


def as_json(tool: str, text: str, args: Optional[dict] = None) -> str:
    """The answer as {"tool", ["args",] "result"}: a JSON answer as its object, anything else (a log, YAML, a cut JSON) as a string."""
    try:
        value: Any = json.loads(text)
    except (TypeError, ValueError):
        value = text
    if not isinstance(value, (dict, list)):
        value = text
    entry: dict[str, Any] = {"tool": tool}
    if args is not None:
        entry["args"] = args
    entry["result"] = value
    return json.dumps(entry, ensure_ascii=False)


def for_model(tool: str, text: str) -> str:
    return as_json(tool, text) if enabled() else text
