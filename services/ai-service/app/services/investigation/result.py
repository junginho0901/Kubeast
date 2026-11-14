"""The structured result of an investigation (features.alertInvestigation.ledger, off by default).

With it on, each tool result the model reads starts with its call number ([call 3]: the call's place in the run's
tool_calls, step 0's read included), and the report ends with one fenced rca block — the causes (resource, kind,
start, the calls that show it), the path from the cause to the symptom, what was ruled out, whether there is a fault
at all, and the hypotheses of the ledger (investigation/ledger.py). The causes, path, ruled-out and no-fault keys are
the shape the AI evaluation reads. The server takes the block out of the report and keeps what it read in the row's
`result` (dbmigrate 00029), each call number given with its tool, so the report window, the floating chat and the
MCP `investigations` read stay with the calls they came from. Without the switch nothing here runs and `result`
stays null.
"""

from __future__ import annotations

import json
import re
from typing import Any, Optional

VERSION = 1
TAG = "rca"
# What a stored result holds at most: a model that writes more is cut, not refused.
MAX_CAUSES = 10
MAX_PATH = 12
MAX_RULED_OUT = 20
MAX_CALLS = 20
MAX_TEXT = 300

_BLOCK = re.compile(r"```[ \t]*rca[ \t]*\r?\n(.*?)```", re.S)


def split(answer: str) -> tuple[str, Optional[dict], str]:
    """(the answer without its rca blocks, the last block's object, "ok" | "missing" | "invalid")."""
    blocks = _BLOCK.findall(answer or "")
    report = _BLOCK.sub("", answer or "").rstrip()
    if not blocks:
        return report, None, "missing"
    try:
        block = json.loads(blocks[-1])
    except ValueError:
        return report, None, "invalid"
    if not isinstance(block, dict):
        return report, None, "invalid"
    return report, block, "ok"


def text(value: Any) -> str:
    return str(value).strip()[:MAX_TEXT] if value is not None else ""


def number(value: Any) -> Optional[int]:
    if isinstance(value, bool):
        return None
    if isinstance(value, int):
        return value
    if isinstance(value, str) and value.strip().lstrip("#").isdigit():
        return int(value.strip().lstrip("#"))
    return None


def calls(values: Any, tool_log: list[dict[str, Any]]) -> tuple[list[dict[str, Any]], list[Any]]:
    """The call numbers a list gives, as {call, tool[, failed]} of this run's calls, and the numbers that name none."""
    found: list[dict[str, Any]] = []
    bad: list[Any] = []
    seen: set[int] = set()
    for v in (values if isinstance(values, list) else [])[:MAX_CALLS]:
        n = number(v)
        if n is None or not 1 <= n <= len(tool_log):
            bad.append(v)
            continue
        if n in seen:
            continue
        seen.add(n)
        entry = tool_log[n - 1]
        ref: dict[str, Any] = {"call": n, "tool": entry.get("tool", "")}
        if entry.get("error"):
            ref["failed"] = True
        found.append(ref)
    return found, bad


def _names(values: Any, limit: int) -> list[str]:
    return [t for t in (text(v) for v in (values if isinstance(values, list) else [])[:limit]) if t]


def shape(block: Optional[dict], status: str, tool_log: list[dict[str, Any]], hypotheses: list[dict[str, Any]],
          *, asked_again: bool = False, ask_failed: bool = False) -> dict[str, Any]:
    """The row's `result`: what the server read of the block, with each call number given as its call."""
    block = block if isinstance(block, dict) else {}
    causes = []
    for c in (block.get("causes") if isinstance(block.get("causes"), list) else [])[:MAX_CAUSES]:
        if not isinstance(c, dict):
            continue
        found, _bad = calls(c.get("evidence"), tool_log)
        causes.append({"resource": text(c.get("resource")), "kind": text(c.get("kind")).lower(),
                       "started_at": text(c.get("started_at")) or None, "evidence": found})
    no_fault = block.get("no_fault")
    out: dict[str, Any] = {
        "version": VERSION,
        "status": status,
        "no_fault": no_fault if isinstance(no_fault, bool) else None,
        "causes": causes,
        "path": _names(block.get("path"), MAX_PATH),
        "ruled_out": _names(block.get("ruled_out"), MAX_RULED_OUT),
        "hypotheses": hypotheses,
        "asked_again": asked_again,
    }
    if ask_failed:
        out["ask_failed"] = True
    return out
