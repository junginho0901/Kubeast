"""The structured result of an investigation (features.alertInvestigation.evidenceCheck or ledger, both off by
default).

With either on, the report ends with one fenced rca block (investigation/rca.py) — the causes (resource, kind, start,
the calls that show it), the path from the cause to the symptom, what was ruled out, whether there is a fault at all,
and with the ledger its hypotheses (investigation/ledger.py). The causes, path, ruled-out and no-fault keys are the
shape the AI evaluation reads. The server takes the block out of the report and keeps what it read in the row's
`result` (dbmigrate 00030), each call number given with its tool, so the report window, the floating chat, the MCP
`investigations` read and the AI evaluation stay with the calls they came from; without the ledger `hypotheses` is
empty. With both switches off nothing here runs and `result` stays null.
"""

from __future__ import annotations

from typing import Any, Optional

from app.services.investigation.rca import split  # noqa: F401 - the shared block, read here by older callers

VERSION = 1
TAG = "rca"
# What a stored result holds at most: a model that writes more is cut, not refused.
MAX_CAUSES = 10
MAX_PATH = 12
MAX_RULED_OUT = 20
MAX_CALLS = 20
MAX_TEXT = 300


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
          *, asked_again: bool = False, ask_failed: bool = False,
          failures: Optional[list[dict[str, Any]]] = None) -> dict[str, Any]:
    """The row's `result`: what the server read of the block, with each call number given as its call. `failures`:
    what the checks still found wrong (rca.check), kept when given."""
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
    if failures is not None:
        out["failures"] = failures
    return out
