"""The structured result of an investigation (features.alertInvestigation.evidenceCheck or ledger, both on by
default).

With either on, the report ends with one fenced rca block (investigation/rca.py) — the causes (resource, kind, start,
the calls that show it), the path from the cause to the symptom, what was ruled out, whether there is a fault at all,
and with the ledger its hypotheses (investigation/ledger.py). The causes, path, ruled-out and no-fault keys are the
shape the AI evaluation reads: each cause keeps the numbers the model gave as `raw_evidence`, the ones that name no
call of the run too, beside `evidence`, each call number given with its tool. The server takes the block out of the
report and keeps what it read in the row's `result` (dbmigrate 00031), so the report window, the floating chat, the
MCP `investigations` read and the AI evaluation stay with the calls they came from. `checks` says which switches read
it: with evidenceCheck each cause says whether the calls show it (`verified`, and why not as `reason`), without the
ledger `hypotheses` is empty and the window shows none. A list cut at what the row keeps of it (MAX_CAUSES, MAX_PATH,
MAX_RULED_OUT, MAX_CALLS, MAX_HYPOTHESES) is named in `cut` with how many the model gave, which the window shows. With
features.alertInvestigation.verdict on too, `verdict` holds the outcome the server keeps and its lists of what was and was
not looked at (investigation/verdict.py); a result without it was written with that switch off. With both switches
off nothing here runs and `result` stays null. NUL characters, which the database refuses in JSON, are taken out of every text.
"""

from __future__ import annotations

from typing import Any, Optional

from app.services.investigation.rca import MAX_HYPOTHESES, is_cause
from app.services.investigation.rca import split  # noqa: F401 - the shared block, read here by older callers

VERSION = 1
TAG = "rca"
# What a stored result holds at most: a model that writes more is cut, not refused, and `cut` says so (counted). The
# ledger keeps at most MAX_HYPOTHESES hypotheses and MAX_CALLS numbers on each side of one (ledger.check).
MAX_CAUSES = 10
MAX_PATH = 12
MAX_RULED_OUT = 20
MAX_CALLS = 20
MAX_TEXT = 300


def text(value: Any) -> str:
    return str(value).replace("\x00", "").strip()[:MAX_TEXT] if value is not None else ""


def _raw(value: Any) -> Any:
    """A number as the model gave it: a whole number stays one, anything else is kept as its text."""
    return value if isinstance(value, int) and not isinstance(value, bool) else text(value)


def number(value: Any) -> Optional[int]:
    if isinstance(value, bool):
        return None
    if isinstance(value, int):
        return value
    if isinstance(value, str) and value.strip().lstrip("#").isdecimal():
        try:
            return int(value.strip().lstrip("#"))
        except ValueError:  # more digits than int() takes
            return None
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


def counted(given: Any, limit: int, kept: int) -> Optional[dict[str, int]]:
    """{given, kept} of a list the model gave past what the result keeps of it, None for one that fits."""
    n = len(given) if isinstance(given, list) else 0
    return {"given": n, "kept": kept} if n > limit else None


def shape(block: Optional[dict], status: str, tool_log: list[dict[str, Any]], hypotheses: list[dict[str, Any]],
          *, asked_again: bool = False, ask_failed: bool = False,
          failures: Optional[list[dict[str, Any]]] = None, cause_problems: Optional[list] = None,
          checks: Optional[dict[str, bool]] = None, verdict: Optional[dict[str, Any]] = None) -> dict[str, Any]:
    """The row's `result`: what the server read of the block, with each call number given as its call. `failures`:
    what the checks still found wrong (rca.check), kept when given. `cause_problems` (evidence.Problem, given while
    evidenceCheck is on) marks each cause `verified` or not, by its place in the block. `checks`: the switches that
    read the block. A list past its cap keeps its first items and is named in `cut` with how many the model gave and
    how many are kept: the causes, the path, ruled_out and, where the ledger read them, the hypotheses in the result's,
    a cause's evidence in the cause's (a hypothesis's for and against in the hypothesis's, ledger.check). `verdict`:
    verdict.shape's, kept as it is when given."""
    block = block if isinstance(block, dict) else {}
    unverified = {p.index: p.reason for p in cause_problems or []}
    causes = []
    for index, c in enumerate((block.get("causes") if isinstance(block.get("causes"), list) else [])[:MAX_CAUSES]):
        if not isinstance(c, dict):
            continue
        given = c.get("evidence") if isinstance(c.get("evidence"), list) else []
        found, _bad = calls(given, tool_log)
        cause: dict[str, Any] = {"resource": text(c.get("resource")), "kind": text(c.get("kind")).lower(),
                                 "started_at": text(c.get("started_at")) or None, "evidence": found,
                                 "raw_evidence": [_raw(v) for v in given[:MAX_CALLS]]}
        if (evidence_cut := counted(given, MAX_CALLS, len(cause["raw_evidence"]))) is not None:
            cause["cut"] = {"evidence": evidence_cut}
        if cause_problems is not None and is_cause(c):
            cause["verified"] = index not in unverified
            if index in unverified:
                cause["reason"] = unverified[index]
        causes.append(cause)
    no_fault = block.get("no_fault")
    path, ruled_out = _names(block.get("path"), MAX_PATH), _names(block.get("ruled_out"), MAX_RULED_OUT)
    out: dict[str, Any] = {
        "version": VERSION,
        "status": status,
        "no_fault": no_fault if isinstance(no_fault, bool) else None,
        "causes": causes,
        "path": path,
        "ruled_out": ruled_out,
        "hypotheses": hypotheses,
        "asked_again": asked_again,
    }
    # the hypotheses only where the ledger read them (as the window's ledgerOn reads `checks`)
    ledger_read = checks is None or bool(checks.get("ledger"))
    cut = {key: n for key, n in (("causes", counted(block.get("causes"), MAX_CAUSES, len(causes))),
                                 ("path", counted(block.get("path"), MAX_PATH, len(path))),
                                 ("ruled_out", counted(block.get("ruled_out"), MAX_RULED_OUT, len(ruled_out))),
                                 ("hypotheses", counted(block.get("hypotheses"), MAX_HYPOTHESES, len(hypotheses))
                                  if ledger_read else None))
           if n is not None}
    if cut:
        out["cut"] = cut
    if ask_failed:
        out["ask_failed"] = True
    if failures is not None:
        out["failures"] = [{k: text(v) if isinstance(v, str) else v for k, v in f.items()} for f in failures]
    if checks is not None:
        out["checks"] = {"evidence": bool(checks.get("evidence")), "ledger": bool(checks.get("ledger"))}
    if verdict is not None:
        out["verdict"] = verdict
    return out
