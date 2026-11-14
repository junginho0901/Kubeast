"""The hypothesis ledger of an investigation (features.alertInvestigation.ledger, off by default).

The rca block (investigation/rca.py, the one mechanism this ledger shares with the evidence check) carries the hypotheses the model weighed: each with what it says, the object
it is about, its state — cause, symptom, ruled_out or blocked — and the calls whose results speak for it and against
it. Tool calls are not tagged with a hypothesis as they run (that would change every tool's definition): the model
ties calls to hypotheses at the end, by their numbers. The server then holds each hypothesis to this run's calls:

- a cause or a symptom needs a call that answered, among those for it;
- ruled_out needs a call that answered, among those against it;
- blocked needs the reason it could not be checked (a refused or failed call may be given for it);
- every number names a call of this run; a state outside the four is open.

A report whose hypotheses are not all closed (or that has none while it finds a fault) is asked for once more,
without tools (with the evidence check's problems in the same message when that is on). What is still open after that
stays in the result (investigation/result.py) with its reasons, which the report window shows.
"""

from __future__ import annotations

from typing import Any, Optional

from app.services.investigation import rca
from app.services.investigation import result as inv_result
from app.services.investigation.rca import FINAL_NOTE  # noqa: F401 - the shared block

STATES = ("cause", "symptom", "ruled_out", "blocked")
OPEN = "open"
MAX_HYPOTHESES = 12

# The instruction with the ledger alone; the runner asks rca.instruction for the switches that are on.
INSTRUCTION = rca.instruction(evidence=False, hypotheses=True)


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
    """Whether the report is asked for once more with the ledger alone: no valid block, a hypothesis not closed, or
    none at all while the block finds a fault (rca.check's failures)."""
    return status != "ok" or bool(rca.hypothesis_failures(block, hypotheses))


def counts(hypotheses: list[dict[str, Any]], *, asked_because: list[dict[str, Any]], failures: list[dict[str, Any]],
           asked_again: bool, ask_failed: bool) -> dict[str, Any]:
    """The ai.investigation.run row's `ledger`: the kept block's hypotheses counted, whether the model was asked once
    more, and the failure kinds of the first answer and of the kept one (rca.FAILURES) — numbers and kind names, no
    text of the model's."""
    states = dict.fromkeys((*STATES, OPEN), 0)
    for h in hypotheses:
        states[h["state"]] += 1
    return {"hypotheses": len(hypotheses), "states": states, "not_closed": sum(1 for h in hypotheses if not h["closed"]),
            "asked_again": asked_again, "asked_because": rca.kinds(asked_because), "ask_failed": ask_failed,
            "failures": rca.kinds(failures)}


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
    """The second ask with the ledger alone (rca.ask_again): the whole report again, every hypothesis closed."""
    checked = rca.Checked("", block, status, hypotheses=hypotheses,
                          failures=rca.hypothesis_failures(block, hypotheses) if status == "ok" else [])
    return rca.ask_again(checked, rca.rows(tool_log), evidence=False, ledger=True)
