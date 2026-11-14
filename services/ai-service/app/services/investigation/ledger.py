"""The hypothesis ledger of an investigation (features.alertInvestigation.ledger, off by default).

The rca block (investigation/result.py) carries the hypotheses the model weighed: each with what it says, the object
it is about, its state — cause, symptom, ruled_out or blocked — and the calls whose results speak for it and against
it. Tool calls are not tagged with a hypothesis as they run (that would change every tool's definition): the model
ties calls to hypotheses at the end, by their numbers. The server then holds each hypothesis to this run's calls:

- a cause or a symptom needs a call that answered, among those for it;
- ruled_out needs a call that answered, among those against it;
- blocked needs the reason it could not be checked (a refused or failed call may be given for it);
- every number names a call of this run; a state outside the four is open.

A report whose hypotheses are not all closed (or that has none while it finds a fault) is asked for once more,
without tools. What is still open after that stays in the result with its reasons, which the report window shows.
"""

from __future__ import annotations

import json
from typing import Any, Optional

from app.services.investigation import result as inv_result

STATES = ("cause", "symptom", "ruled_out", "blocked")
OPEN = "open"
MAX_HYPOTHESES = 12
_ARGS_CHARS = 200

INSTRUCTION = (
    "\n\nEach tool result starts with its call number, as [call 3]. At the very end of the report, after the headings, add "
    "one fenced code block tagged rca holding one JSON object:\n"
    "```rca\n"
    '{"no_fault": false,\n'
    ' "causes": [{"resource": "Kind/namespace/name", "kind": "crash|oom|image|config_change|rollout|network_policy|dns|'
    'resource_limit|quota|node|dependency_down|dependency_slow|storage|none", "started_at": "RFC3339 time or null", '
    '"evidence": [1, 3]}],\n'
    ' "path": ["Kind/namespace/name of the cause", "...", "Kind/namespace/name where the symptom shows"],\n'
    ' "ruled_out": ["Kind/namespace/name"],\n'
    ' "hypotheses": [{"id": "h1", "statement": "one sentence", "resource": "Kind/namespace/name", '
    '"state": "cause|symptom|ruled_out|blocked", "for": [2], "against": [4], "blocked": "why it could not be checked"}]}\n'
    "```\n"
    "List every hypothesis you weighed, the ones you set aside too. Close each one: cause or symptom with the calls whose "
    "results show it under \"for\", ruled_out with the calls that show it is not the cause under \"against\", blocked with "
    "the reason it could not be checked (a refused or missing tool) under \"blocked\". \"evidence\", \"for\" and "
    "\"against\" hold call numbers only. If you find no fault, answer \"no_fault\": true and \"causes\": []. The server "
    "checks the block against this investigation's calls, takes it out of the report and shows the hypotheses as a table "
    "under it: do not write that table yourself."
)

FINAL_NOTE = " End it with the rca block."


def _state(value: Any) -> str:
    s = str(value or "").strip().lower().replace(" ", "_").replace("-", "_")
    return s if s in STATES else OPEN


def check(block: Optional[dict], tool_log: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """The block's hypotheses as the row keeps them, each with `closed` and the reasons it is not (`problems`)."""
    raw = (block or {}).get("hypotheses")
    out: list[dict[str, Any]] = []
    for i, h in enumerate((raw if isinstance(raw, list) else [])[:MAX_HYPOTHESES], 1):
        if not isinstance(h, dict):
            continue
        state = _state(h.get("state"))
        pro, bad_pro = inv_result.calls(h.get("for"), tool_log)
        con, bad_con = inv_result.calls(h.get("against"), tool_log)
        blocked = inv_result.text(h.get("blocked")) if state == "blocked" else ""
        problems: list[dict[str, Any]] = []
        if state == OPEN:
            problems.append({"reason": "open"})
        elif state in ("cause", "symptom") and not any(not c.get("failed") for c in pro):
            problems.append({"reason": "no_evidence", "side": "for"})
        elif state == "ruled_out" and not any(not c.get("failed") for c in con):
            problems.append({"reason": "no_evidence", "side": "against"})
        elif state == "blocked" and not blocked:
            problems.append({"reason": "no_reason"})
        if bad_pro or bad_con:
            problems.append({"reason": "bad_calls", "calls": [str(v) for v in bad_pro + bad_con]})
        entry: dict[str, Any] = {
            "id": inv_result.text(h.get("id")) or f"h{i}",
            "statement": inv_result.text(h.get("statement")),
            "resource": inv_result.text(h.get("resource")),
            "state": state,
            "for": pro,
            "against": con,
            "closed": not problems,
        }
        if blocked:
            entry["blocked"] = blocked
        if problems:
            entry["problems"] = problems
        out.append(entry)
    return out


def needs_asking(status: str, block: Optional[dict], hypotheses: list[dict[str, Any]]) -> bool:
    """Whether the report is asked for once more: no valid block, a hypothesis not closed, or none at all while the
    block finds a fault."""
    if status != "ok":
        return True
    if any(not h["closed"] for h in hypotheses):
        return True
    return not hypotheses and (block or {}).get("no_fault") is not True


_REASONS = {
    "open": "its state is not one of cause, symptom, ruled_out or blocked",
    "no_evidence": 'no call that answered is given under "{side}"',
    "no_reason": 'it is blocked with no reason under "blocked"',
    "bad_calls": "{calls} name no call of this investigation",
}


def reason_text(problem: dict[str, Any]) -> str:
    values = {**problem, "calls": ", ".join(problem.get("calls") or [])}
    return _REASONS[problem["reason"]].format(**values)


def ask_again(status: str, block: Optional[dict], hypotheses: list[dict[str, Any]], tool_log: list[dict[str, Any]]) -> str:
    """The second ask, without tools: the whole report again, every hypothesis closed."""
    if status != "ok":
        head = "Your report did not end with a valid rca block, so the server could not read its hypotheses."
    elif not hypotheses:
        head = 'Your rca block lists no hypotheses while "no_fault" is not true.'
    else:
        head = "The server checked the hypotheses against this investigation's calls. These are not closed:\n" + "\n".join(
            f"- {h['id']} ({h['statement'] or '-'}): " + "; ".join(reason_text(p) for p in h.get("problems") or [])
            for h in hypotheses if not h["closed"])
    calls = "\n".join(
        f"[call {i}] {e.get('tool', '')} "
        f"{json.dumps(e.get('args') or {}, ensure_ascii=False, sort_keys=True, default=str)[:_ARGS_CHARS]} — "
        + ("failed" if e.get("error") else "answered")
        for i, e in enumerate(tool_log, 1))
    return (
        f"{head}\n\nThe calls of this investigation:\n{calls or '(none)'}\n\n"
        "Write the whole report again, under the same headings, ending with the rca block. Close every hypothesis: give "
        "the calls that show it, mark it ruled_out with the calls that show it is not the cause, or mark it blocked with "
        "the reason. No tools now."
    )
