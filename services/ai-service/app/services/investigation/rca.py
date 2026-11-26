"""The rca block at the end of an investigation's report: one mechanism behind two switches,
features.alertInvestigation.evidenceCheck (the causes held to the run's calls, investigation/evidence.py) and
features.alertInvestigation.ledger (the hypotheses, investigation/ledger.py), both on by default.

With either on, the system prompt ends with one instruction for the block (instruction(): the hypotheses' part only
with the ledger), the last step's message with FINAL_NOTE, and the answer is split once (split()). check() runs the
checks of the switches that are on over that one block and gives each problem as one of FAILURES; while there is one,
the model is asked once more without tools, every problem of both checks in one message (ask_again()), and the second
answer is checked the same way when its block can be read. The row keeps what the server read as `result`
(investigation/result.py), so the AI evaluation scores a block the kept report no longer shows. The tool results carry
their call numbers (investigation/numbers.py).

The block is the last rca block of the answer (split()); a second answer replaces the first only with a report before
its block (has_report()). The model's answers in a run with the block may be ANSWER_TOKENS long; one that still stops
inside the block (or at its length before it) is `cut` and asked for once more, shorter.

With features.alertInvestigation.verdict on too, the block also says the report's outcome and the calls that show the
alert's symptom, and the same check and second ask hold it to the calls (investigation/verdict.py); off, nothing of it
is asked for or read.

With ai.causeNaming on too, the instruction also says how "causes" is filled (app/services/cause_naming.py); the shape and
what reads it stay the same.
"""

from __future__ import annotations

import json
import re
from dataclasses import dataclass, field
from typing import Any, Iterable, Optional

from app.services import cause_naming
from app.services.investigation import numbers

KINDS = ("crash", "oom", "image", "config_change", "rollout", "network_policy", "dns", "resource_limit", "quota", "node",
         "dependency_down", "dependency_slow", "storage", "none")

# What check() can find wrong, every check together.
FAILURES = (
    # no block at the very end, one that is not the shape below, one the answer stopped inside
    "block_missing", "block_invalid", "block_cut",
    # evidenceCheck: a cause no call of the run shows (evidence.check's reasons)
    "cause_no_evidence", "cause_bad_calls", "cause_name_missing", "cause_after_alert",
    # both on: a cause no hypothesis of state cause is about
    "cause_not_in_ledger",
    # ledger: a hypothesis not closed (ledger.check's reasons, not_verified with both on), or none while the block finds a fault
    "hypothesis_open", "hypothesis_no_evidence", "hypothesis_no_reason", "hypothesis_bad_calls", "hypothesis_not_verified",
    "no_hypotheses",
    # evidenceCheck: a cause whose calls read only alerts, rules or names, and with the verdict one whose calls hold nothing;
    # verdict: an outcome the block or the calls do not hold (verdict.check's reasons)
    "cause_empty_answer",
    "outcome_missing", "outcome_contradicts", "outcome_no_symptom", "outcome_symptom_bad_calls",
    "outcome_symptom_name_missing", "outcome_symptom_not_shown", "outcome_cause_not_shown", "outcome_nothing_read",
    "outcome_not_read",
)

FINAL_NOTE = " End it with the rca block."

ANSWER_TOKENS = 4096  # a run with the block, when the model's options set none: the chat's default, not 2 048
MAX_HYPOTHESES = 12

_OPEN = re.compile(r"```[ \t]*rca[ \t]*\r?\n")
_CLOSE = re.compile(r"^[ \t]*```", re.M)
_FENCE_REST = re.compile(r"[`\w-]*[ \t]*(?=\r?\n|\r|$)")  # backticks or a language name left on the closing line
_HEADING = re.compile(r"^#{1,6}[ \t]+\S", re.M)
_FENCE = "```"
_ARGS_CHARS = 200


def on(cfg) -> bool:
    return bool(cfg.evidence_check or cfg.ledger)


def is_cause(c: dict) -> bool:
    """Whether an entry of the block's causes is a cause: only kind "none" (a string, any case) says it is not."""
    kind = c.get("kind")
    return not (isinstance(kind, str) and kind.strip().lower() == "none")


# features.alertInvestigation.verdict: what the block has more, and what it is (investigation/verdict.py).
_OUTCOME_SHAPE = ('"outcome": "cause_found|no_fault|cannot_tell",\n'
                  ' "symptom": {"resource": "Kind/namespace/name", "evidence": [2]},\n ')
_OUTCOME_SAYS = (
    '"outcome" is cause_found when calls show the alert\'s symptom and a cause in "causes", no_fault when they show nothing '
    'wrong, and cannot_tell otherwise, with "no_fault": false and "causes": []. "symptom" is the object where the symptom the '
    "alert names shows and the numbers of the calls whose results show it there; a call that reads what changed, an alert, its "
    'rule or a list of names does not show it. While no call does, its "evidence" is [] and so is "causes". The server writes '
    "down what was checked and normal and what was not looked at from the calls themselves: the block has no list of them.")


def instruction(*, evidence: bool, hypotheses: bool, verdict: bool = False, naming: bool = False) -> str:
    """The system prompt's last part, with the call numbers' sentence first. `naming`: with how "causes" is filled."""
    shape = (
        "{" + (_OUTCOME_SHAPE if verdict else "") + '"no_fault": false,\n'
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
    if verdict:
        says.append(_OUTCOME_SAYS)
    says.append("Keep the report brief so that the whole block fits after it; nothing comes after the block.")
    says.append("The server checks the block against this investigation's calls and takes it out of the report"
                + (", and shows the hypotheses as a table under it: do not write that table yourself." if hypotheses
                   else " that is kept."))
    return (numbers.NOTE + " At the very end of the report, after the headings, add one fenced code block tagged rca "
            "holding one JSON object:\n```rca\n" + shape + "```\n" + (cause_naming.INVESTIGATION if naming else "") + " ".join(says))


def _close(body: str) -> Optional[tuple[int, int]]:
    """In the text after an rca fence: (where its JSON ends, where its closing fence's line ends), None when it never
    closes. The closing fence is the first that starts a line, else the first after the JSON on its line."""
    line = _CLOSE.search(body)
    if line:
        at, fence_end = line.start(), line.end()
    else:
        at = body.find(_FENCE)
        if at < 0:
            return None
        fence_end = at + len(_FENCE)
    rest = _FENCE_REST.match(body, fence_end)
    return at, rest.end() if rest else fence_end


def _jsonish(raw: str) -> bool:
    """Whether the text after an rca fence is JSON the model meant as its block, whole or broken: it starts with { or
    [, or parses at least in part. Words that are not JSON at all are a fence quoted from a tool result."""
    text = raw.strip()
    if text[:1] in ("{", "["):
        return True
    try:
        json.loads(text)
    except json.JSONDecodeError as e:
        return e.pos > 0
    except (ValueError, RecursionError):
        return False
    return True


def _without_blocks(text: str) -> str:
    """The text without its closed rca blocks; a fence whose text is not JSON (a quoted one) stays."""
    kept, pos = [], 0
    for m in _OPEN.finditer(text):
        if m.start() < pos:
            continue
        span = _close(text[m.end():])
        if span is None or not _jsonish(text[m.end():m.end() + span[0]]):
            continue
        kept.append(text[pos:m.start()])
        pos = m.end() + span[1]
    return ("".join(kept) + text[pos:]).rstrip()


def _block(raw: str) -> Optional[dict]:
    """The block's object, or None when it is not an object whose causes are a list of objects, or when it says
    "no_fault": true beside a cause (the instruction's rule; kind "none" is no cause, is_cause)."""
    try:
        block = json.loads(raw)
    except (ValueError, RecursionError):
        return None
    causes = block.get("causes") if isinstance(block, dict) else None
    if not (isinstance(causes, list) and all(isinstance(c, dict) for c in causes)):
        return None
    return None if block.get("no_fault") is True and any(is_cause(c) for c in causes) else block


def split(answer: str, finish_reason: str = "") -> tuple[str, Optional[dict], str]:
    """(the report, the block's object, "ok" | "missing" | "invalid" | "cut").

    The block is the last rca fence holding JSON, whole or broken (_jsonish), closed by a fence that starts a line (or ends its JSON; the
    rest of the closing line goes with it when it is only backticks or a language name). Space after it, or closing
    words with no fence when it is the answer's only rca fence, leave it the block; those words stay in the report, and
    an earlier rca fence stays too (one quoted from a tool result). A fence after it, or closing words after a second
    rca fence, is no block (missing): only that block leaves the report. A last rca fence whose text is not JSON at all is
    a quoted one (missing, its text kept). One that never closes is cut when the provider stopped at the length
    (`finish_reason` "length"); with a whole JSON object after it, it is the block; with other JSON it is cut, or
    missing when the provider said it stopped by itself ("stop"). An answer stopped at the length with no block is
    cut. Outside ok no closed rca block holding JSON stays in the report. A block that is not an object, whose causes
    are not a list or hold an item that is not an object, or that says "no_fault": true beside a cause, is invalid."""
    text = answer or ""
    stopped = finish_reason == "length"
    opens = list(_OPEN.finditer(text))
    if not opens:
        return text.rstrip(), None, "cut" if stopped else "missing"
    last = opens[-1]
    before, body = text[:last.start()], text[last.end():]
    span = _close(body)
    if span is None:
        if stopped:
            return _without_blocks(before), None, "cut"
        if not _jsonish(body):
            return _without_blocks(text), None, "missing"
        if (block := _block(body)) is not None:
            return before.rstrip(), block, "ok"
        return _without_blocks(before), None, "missing" if finish_reason == "stop" else "cut"
    raw, after = body[:span[0]], body[span[1]:]
    if not _jsonish(raw):
        return _without_blocks(text), None, "cut" if stopped else "missing"
    words = after.strip()
    if _FENCE in after or (words and len(opens) > 1):
        return _joined(_without_blocks(before), words), None, "cut" if stopped else "missing"
    block = _block(raw)
    if block is None:
        return _joined(_without_blocks(before), words), None, "invalid"
    return _joined(before.rstrip(), words), block, "ok"


def _joined(report: str, words: str) -> str:
    return f"{report}\n\n{words}" if words else report


def body_before(answer: str) -> str:
    """The answer's text before its last rca fence, stripped: the report without the block and the words after it."""
    opens = list(_OPEN.finditer(answer or ""))
    return (answer[:opens[-1].start()] if opens else answer or "").strip()


def has_report(answer: str) -> bool:
    """Whether the answer has a report before its block: text with a heading line (not only words around a block)."""
    return _HEADING.search(body_before(answer)) is not None


def unclosed(answer: str) -> bool:
    """Whether the answer's last rca fence holds JSON and never closes."""
    opens = list(_OPEN.finditer(answer or ""))
    body = answer[opens[-1].end():] if opens else ""
    return bool(opens) and _close(body) is None and _jsonish(body)


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
    unclosed: bool = False          # missing: its last rca fence holds JSON and never closes
    outcome: Optional[Any] = None   # verdict.Checked, verdict on and status ok
    failures: list[dict[str, Any]] = field(default_factory=list)    # each {"kind": one of FAILURES, ...}


def check(answer: str, *, tool_log: list[dict[str, Any]], reads: Optional[list], alert_start, evidence: bool,
          ledger: bool, finish_reason: str = "", alert: Optional[Any] = None) -> Checked:
    """`finish_reason`: the provider's for the answer; "length" (it stopped at its answer length) makes a missing block
    a cut one and is kept with the failure. `alert`: the alert's object (verdict.alert_of), given with the verdict on."""
    from app.services.investigation import evidence as inv_evidence
    from app.services.investigation import ledger as inv_ledger

    report, block, status = split(answer, finish_reason)
    out = Checked(report, block, status, unclosed=status == "missing" and unclosed(answer))
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
        unverified = {_name(p.resource) for p in out.cause_problems} - {""}
        for h in out.hypotheses:  # a cause hypothesis does not close on a cause the calls do not show
            if h["state"] == "cause" and _name(h.get("resource")) in unverified:
                h["problems"] = [*h.get("problems", []), {"reason": "not_verified"}]
                h["closed"] = False
    if ledger:
        out.failures += hypothesis_failures(block, out.hypotheses)
    if alert is not None:
        from app.services.investigation import verdict as inv_verdict

        out.outcome = inv_verdict.check(block, reads=reads, alert=alert, tool_log=tool_log,
                                        unverified={p.index for p in out.cause_problems} if evidence else None)
        out.failures += [{"kind": f"outcome_{p.reason}"} for p in out.outcome.problems]
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


def rows(tool_log: list[dict[str, Any]], same_as: Optional[dict[int, int]] = None,
         nothing: Iterable[int] = ()) -> list[tuple[str, Any, str]]:
    """The run's calls for the second ask: (tool, arguments, what came of it). `nothing`: with the verdict on, the calls
    whose answer holds nothing; a read of a log the node had none of (the entry's no_log) is one with it off too, as the
    ledger reads it."""
    same_as, none_held = same_as or {}, set(nothing)
    return [(e.get("tool", ""), e.get("args") or {},
             f"the same read as call {same_as[i]}" if i in same_as else "failed" if e.get("error") else
             "answered, holding nothing" if i in none_held or e.get("no_log") else "answered")
            for i, e in enumerate(tool_log, 1)]


def calls_text(calls: Iterable[tuple[str, Any, str]]) -> str:
    return "\n".join(
        f"[call {i}] {tool} {json.dumps(args, ensure_ascii=False, sort_keys=True, default=str)[:_ARGS_CHARS]} — {outcome}"
        for i, (tool, args, outcome) in enumerate(calls, 1))


def ask_again(checked: Checked, calls: Iterable[tuple[str, Any, str]], *, evidence: bool, ledger: bool,
              verdict: bool = False) -> str:
    """The one second ask, without tools: what the checks found, the run's calls, the report again."""
    from app.services.investigation import evidence as inv_evidence
    from app.services.investigation import ledger as inv_ledger

    if checked.status == "cut":
        head = ("Your report was cut off before its rca block ended, so the server could not check it against this "
                "investigation's calls. Keep the report brief so that the whole block fits after it.")
    elif checked.unclosed:
        head = ("Your rca block has no closing fence, so the server could not read it. Close the block with ``` on a "
                "line of its own.")
    elif checked.status == "invalid":
        head = ("Your rca block is not the JSON asked for (one object whose \"causes\" is a list of objects), so the "
                "server could not read it. Fix the block's JSON.")
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
        if checked.outcome is not None and checked.outcome.problems:
            from app.services.investigation import verdict as inv_verdict

            parts.append("The server checked the outcome against this investigation's calls. It does not hold:\n"
                         + "\n".join(f"- {inv_verdict.reason_text(p)}" for p in checked.outcome.problems))
        head = "\n\n".join(parts)
    says = ["Write the whole report again, under the same headings, ending with the rca block; nothing comes after the block."]
    if evidence:
        says.append('A cause that no call shows is a hypothesis: say so in the report and leave it out of "causes"; when '
                    "another call does show it, give that call's number.")
    if ledger:
        says.append("Close every hypothesis: give the calls that show it, mark it ruled_out with the calls that show it is "
                    "not the cause, or mark it blocked with the reason.")
    if verdict:
        says.append('"outcome" is cause_found only with a call that shows the alert\'s symptom and a cause a call shows. When '
                    'none does, leave "causes" empty and answer cannot_tell, or no_fault when the calls show nothing wrong, '
                    "and say so in the report.")
    says.append("No tools now.")
    return f"{head}\n\nThe calls of this investigation:\n{calls_text(calls) or '(none)'}\n\n" + " ".join(says)
