"""The rca block at the end of an investigation's report: one mechanism behind two switches,
features.alertInvestigation.evidenceCheck (the causes held to the run's calls, investigation/evidence.py) and
features.alertInvestigation.ledger (the hypotheses, investigation/ledger.py), both off by default.

With either on, the system prompt ends with one instruction for the block (instruction(): the hypotheses' part only
with the ledger), the last step's message with FINAL_NOTE, and the answer is split once (split()). check() runs the
checks of the switches that are on over that one block and gives each problem as one of FAILURES; while there is one,
the model is asked once more without tools, every problem of both checks in one message (ask_again()), and the second
answer is checked the same way when its block can be read. The row keeps what the server read as `result`
(investigation/result.py), so the AI evaluation scores a block the kept report no longer shows. The tool results carry
their call numbers (investigation/numbers.py).

Only the block at the very end of the answer counts. The model's answers in a run with the block may be ANSWER_TOKENS
long; one that still stops inside the block (or at its length before it) is `cut` and asked for once more, shorter.
"""

from __future__ import annotations

import json
import re
from dataclasses import dataclass, field
from typing import Any, Iterable, Optional

from app.services.investigation import numbers

KINDS = ("crash", "oom", "image", "config_change", "rollout", "network_policy", "dns", "resource_limit", "quota", "node",
         "dependency_down", "dependency_slow", "storage", "none")

# What check() can find wrong, both checks together.
FAILURES = (
    # no block at the very end, one that is not the shape below, one the answer stopped inside
    "block_missing", "block_invalid", "block_cut",
    # evidenceCheck: a cause no call of the run shows (evidence.check's reasons)
    "cause_no_evidence", "cause_bad_calls", "cause_name_missing", "cause_after_alert",
    # both on: a cause no hypothesis of state cause is about
    "cause_not_in_ledger",
    # ledger: a hypothesis not closed (ledger.check's reasons), or none while the block finds a fault
    "hypothesis_open", "hypothesis_no_evidence", "hypothesis_no_reason", "hypothesis_bad_calls", "no_hypotheses",
)

FINAL_NOTE = " End it with the rca block."

# The longest answer of a run with the block, in tokens, when the model's options set none: the chat's own default.
# The 2 048 an investigation's answer has otherwise do not hold the six headings and a block with twelve hypotheses.
ANSWER_TOKENS = 4096
MAX_HYPOTHESES = 12

_OPEN = re.compile(r"```[ \t]*rca[ \t]*\r?\n")
_FENCE = "```"
_ARGS_CHARS = 200


def on(cfg) -> bool:
    return bool(cfg.evidence_check or cfg.ledger)


def is_cause(c: dict) -> bool:
    """Whether an entry of the block's causes is a cause: only kind "none" (a string, any case) says it is not."""
    kind = c.get("kind")
    return not (isinstance(kind, str) and kind.strip().lower() == "none")


def instruction(*, evidence: bool, hypotheses: bool) -> str:
    """The system prompt's last part, with the call numbers' sentence first."""
    shape = (
        '{"no_fault": false,\n'
        f' "causes": [{{"resource": "Kind/namespace/name", "kind": "{"|".join(KINDS)}", '
        '"started_at": "RFC3339 time or null", "evidence": [1, 3]}],\n'
        ' "path": ["Kind/namespace/name of the cause", "...", "Kind/namespace/name where the symptom shows"],\n'
        ' "ruled_out": ["Kind/namespace/name"]'
        + (',\n "hypotheses": [{"id": "h1", "statement": "one sentence", "resource": "Kind/namespace/name", '
           '"state": "cause|symptom|ruled_out|blocked", "for": [2], "against": [4], "blocked": "why it could not be checked"}]'
           if hypotheses else "")
        + "}\n"
    )
    says = ['"evidence" lists the numbers of the calls whose results show the cause.']
    if evidence:
        says.append('A cause no result shows is a hypothesis: say so in the report and leave it out of "causes".')
    if hypotheses:
        says.append(
            f"List every hypothesis you weighed, the ones you set aside too, at most {MAX_HYPOTHESES}. Close each one: "
            "cause or symptom with the calls whose results show it under \"for\", ruled_out with the calls that show it "
            "is not the cause under \"against\", "
            "blocked with the reason it could not be checked (a refused or missing tool) under \"blocked\". \"evidence\", "
            "\"for\" and \"against\" hold call numbers only.")
        if evidence:
            says.append('Each cause in "causes" is also a hypothesis of state cause about the same object.')
    says.append('If you find no fault, answer "no_fault": true and "causes": [].')
    says.append("Keep the report brief so that the whole block fits after it; nothing comes after the block.")
    says.append("The server checks the block against this investigation's calls and takes it out of the report"
                + (", and shows the hypotheses as a table under it: do not write that table yourself." if hypotheses
                   else " that is kept."))
    return (numbers.NOTE + " At the very end of the report, after the headings, add one fenced code block tagged rca "
            "holding one JSON object:\n```rca\n" + shape + "```\n" + " ".join(says))


def split(answer: str) -> tuple[str, Optional[dict], str]:
    """(the answer without its rca block, the block's object, "ok" | "missing" | "invalid" | "cut").

    Only a block at the very end of the answer, with nothing but space after its closing fence, is the block: an rca
    fence earlier on (one quoted from a tool result) stays in the report, and a last one with text after it is no block
    (missing). A last rca fence that never closes is an answer that stopped inside its block (cut), taken out of the
    report. A block that is not an object, whose causes are not a list or hold an item that is not an object, is
    invalid."""
    text = answer or ""
    opens = list(_OPEN.finditer(text))
    if not opens:
        return text.rstrip(), None, "missing"
    last = opens[-1]
    body = text[last.end():]
    end = body.find(_FENCE)
    if end < 0:
        return text[:last.start()].rstrip(), None, "cut"
    if body[end + len(_FENCE):].strip():
        return text.rstrip(), None, "missing"
    report = text[:last.start()].rstrip()
    try:
        block = json.loads(body[:end])
    except (ValueError, RecursionError):
        return report, None, "invalid"
    causes = block.get("causes") if isinstance(block, dict) else None
    if not isinstance(causes, list) or not all(isinstance(c, dict) for c in causes):
        return report, None, "invalid"
    return report, block, "ok"


@dataclass
class Checked:
    """One answer as the checks read it."""
    report: str                     # the answer without its block
    block: Optional[dict]
    status: str                     # ok | missing | invalid | cut
    causes: int = 0                 # the causes the evidence check held (kind none is not a cause)
    cause_problems: list = field(default_factory=list)       # evidence.Problem, evidenceCheck on
    hypotheses: list[dict[str, Any]] = field(default_factory=list)  # ledger.check, ledger on
    not_in_ledger: list[str] = field(default_factory=list)   # both on
    failures: list[dict[str, Any]] = field(default_factory=list)    # each {"kind": one of FAILURES, ...}


def check(answer: str, *, tool_log: list[dict[str, Any]], reads: Optional[list], alert_start, evidence: bool,
          ledger: bool, finish_reason: str = "") -> Checked:
    """`finish_reason`: the provider's for the answer; "length" (it stopped at its answer length) makes a missing block
    a cut one and is kept with the failure."""
    from app.services.investigation import evidence as inv_evidence
    from app.services.investigation import ledger as inv_ledger

    report, block, status = split(answer)
    if status == "missing" and finish_reason == "length":
        status = "cut"
    out = Checked(report, block, status)
    if status != "ok":
        failure: dict[str, Any] = {"kind": f"block_{status}"}
        if finish_reason == "length":
            failure["finish_reason"] = "length"
        out.failures = [failure]
        return out
    if evidence:
        out.causes, out.cause_problems = inv_evidence.check(block, reads or [], alert_start)
        out.failures += [{"kind": f"cause_{p.reason}", "resource": p.resource} for p in out.cause_problems]
    if ledger:
        out.hypotheses = inv_ledger.check(block, tool_log)
    if evidence and ledger:
        out.not_in_ledger = not_in_ledger(block, out.hypotheses)
        out.failures += [{"kind": "cause_not_in_ledger", "resource": r} for r in out.not_in_ledger]
    if ledger:
        out.failures += hypothesis_failures(block, out.hypotheses)
    return out


def kinds(failures: Iterable[dict[str, Any]]) -> list[str]:
    """The failure kinds found, each once, in the order of FAILURES."""
    found = {f.get("kind") for f in failures}
    return [k for k in FAILURES if k in found]


def hypothesis_failures(block: Optional[dict], hypotheses: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """The ledger's failures: each problem of a hypothesis not closed, or no hypothesis while the block finds a fault."""
    out = [{"kind": f"hypothesis_{p['reason']}", "id": h["id"]} for h in hypotheses for p in h.get("problems") or []]
    if not hypotheses and (block or {}).get("no_fault") is not True:
        out.append({"kind": "no_hypotheses"})
    return out


def _name(resource: Any) -> str:
    from app.services.investigation.evidence import resource_name

    return resource_name(str(resource or "")).strip().lower()


def not_in_ledger(block: dict, hypotheses: list[dict[str, Any]]) -> list[str]:
    """The causes no hypothesis of state cause is about, by the object's name."""
    named = {_name(h.get("resource")) for h in hypotheses if h.get("state") == "cause"}
    causes = block.get("causes")
    return [str(c.get("resource") or "").strip() for c in (causes if isinstance(causes, list) else [])
            if isinstance(c, dict) and is_cause(c) and _name(c.get("resource")) not in named]


def rows(tool_log: list[dict[str, Any]], same_as: Optional[dict[int, int]] = None) -> list[tuple[str, Any, str]]:
    """The run's calls for the second ask: (tool, arguments, what came of it)."""
    same_as = same_as or {}
    return [(e.get("tool", ""), e.get("args") or {},
             f"the same read as call {same_as[i]}" if i in same_as else "failed" if e.get("error") else "answered")
            for i, e in enumerate(tool_log, 1)]


def calls_text(calls: Iterable[tuple[str, Any, str]]) -> str:
    return "\n".join(
        f"[call {i}] {tool} {json.dumps(args, ensure_ascii=False, sort_keys=True, default=str)[:_ARGS_CHARS]} — {outcome}"
        for i, (tool, args, outcome) in enumerate(calls, 1))


def ask_again(checked: Checked, calls: Iterable[tuple[str, Any, str]], *, evidence: bool, ledger: bool) -> str:
    """The one second ask, without tools: what both checks found, the run's calls, the report again."""
    from app.services.investigation import evidence as inv_evidence
    from app.services.investigation import ledger as inv_ledger

    if checked.status == "cut":
        head = ("Your report was cut off before its rca block ended, so the server could not check it against this "
                "investigation's calls. Keep the report brief so that the whole block fits after it.")
    elif checked.status != "ok":
        head = "Your report did not end with a valid rca block, so the server could not check it against this investigation's calls."
    else:
        parts = []
        if checked.cause_problems:
            parts.append("The server checked the causes against this investigation's calls. These causes are not shown by them:\n"
                         + "\n".join(f"- {p.resource or '(no resource)'}: {inv_evidence.reason_text(p)}" for p in checked.cause_problems))
        if checked.not_in_ledger:
            parts.append("These causes are not a hypothesis of state cause:\n"
                         + "\n".join(f"- {r or '(no resource)'}" for r in checked.not_in_ledger))
        still = [h for h in checked.hypotheses if not h["closed"]]
        if still:
            parts.append("The server checked the hypotheses against this investigation's calls. These are not closed:\n" + "\n".join(
                f"- {h['id']} ({h['statement'] or '-'}): " + "; ".join(inv_ledger.reason_text(p) for p in h.get("problems") or [])
                for h in still))
        if any(f["kind"] == "no_hypotheses" for f in checked.failures):
            parts.append('Your rca block lists no hypotheses while "no_fault" is not true.')
        head = "\n\n".join(parts)
    says = ["Write the whole report again, under the same headings, ending with the rca block."]
    if evidence:
        says.append('A cause that no call shows is a hypothesis: say so in the report and leave it out of "causes"; when '
                    "another call does show it, give that call's number.")
    if ledger:
        says.append("Close every hypothesis: give the calls that show it, mark it ruled_out with the calls that show it is "
                    "not the cause, or mark it blocked with the reason.")
    says.append("No tools now.")
    return f"{head}\n\nThe calls of this investigation:\n{calls_text(calls) or '(none)'}\n\n" + " ".join(says)
