"""The evidence check of an investigation's report (features.alertInvestigation.evidenceCheck, on by default).

With it on, the report ends with an rca block (investigation/rca.py, the one mechanism this check shares with the
hypothesis ledger): one fenced JSON object of causes (resource, kind, start, the numbers of the calls that show it),
the path from the cause to the symptom, what was ruled out and whether there is a fault at all — the same shape the AI
evaluation asks for. Before the report is kept, the server holds each cause to this run's calls:

- each number names a call of this run that answered without an error (a refused repeat stands for the call it
  repeated);
- the cause's name appears in what one of those calls returned to the model (the results are not stored, so the run
  keeps that text in memory only while it lasts);
- the cause does not start after the alert did.

When a cause fails, or the block is missing, the model is asked once more without tools to mark such a cause as a
hypothesis or give the call that shows it (with the ledger's problems in the same message when that is on). What still
fails is listed under the report by the server, as not verified. The block itself is taken out of the report that is
kept.
"""

from __future__ import annotations

import re
from dataclasses import dataclass, field
from datetime import datetime, timedelta, timezone
from typing import Any, Optional

from app.services.investigation import rca
from app.services.investigation.numbers import tag  # noqa: F401 - the numbers the causes name
from app.services.investigation.rca import KINDS, FINAL_NOTE, split  # noqa: F401 - the shared block

# The instruction with this check alone; the runner asks rca.instruction for the switches that are on.
INSTRUCTION = rca.instruction(evidence=True, hypotheses=False)

# A cause may be given a little after the alert's start: the alert's time and the model's are both rounded.
START_TOLERANCE = timedelta(seconds=120)

@dataclass
class Read:
    """One call of the run as the check sees it: what the model read, whether it failed, and for a refused repeat the
    number of the call it repeated."""
    tool: str
    args: dict
    text: str = ""
    failed: bool = False
    same_as: Optional[int] = None
    # with the verdict on (investigation/answers.py): "unread" an answer that read nothing, "empty" one that holds nothing
    nothing: str = ""

    @property
    def shows(self) -> bool:
        """Whether its answer holds more than what was asked."""
        return not self.nothing


@dataclass
class Problem:
    resource: str
    reason: str                  # no_evidence | bad_calls | empty_answer (the verdict on) | name_missing | after_alert
    values: dict[str, Any] = field(default_factory=dict)
    index: int = -1              # the cause's place in the block's causes, from 0


def resource_name(resource: str) -> str:
    """"Kind/namespace/name" or "Kind/name" or "name" → the name."""
    parts = [p.strip() for p in str(resource).split("/") if p.strip()]
    if len(parts) >= 3:
        return "/".join(parts[2:])
    return parts[-1] if parts else ""


def _names(text: str, name: str) -> bool:
    """The name as a whole name in the text: "cart" in "cart-7d9f4-x2k" (a pod of it) and "pod/cart", not in "mycart"
    or "cartservice"."""
    if not name:
        return False
    return re.search(rf"(?<![a-z0-9]){re.escape(name.lower())}(?![a-z0-9])", text.lower()) is not None


def _time(value: Any) -> Optional[datetime]:
    if not isinstance(value, str) or not value.strip():
        return None
    text = re.sub(r"\.\d+", "", value.strip()).replace("Z", "+00:00").replace("z", "+00:00")
    try:
        t = datetime.fromisoformat(text)
    except ValueError:
        return None
    return t.astimezone(timezone.utc).replace(tzinfo=None) if t.tzinfo else t


def _number(n: Any) -> Optional[int]:
    if isinstance(n, bool):
        return None
    if isinstance(n, int):
        return n
    if isinstance(n, str) and n.strip().isdecimal():
        try:
            return int(n.strip())
        except ValueError:  # more digits than int() takes
            return None
    return None


def answered(numbers: list, reads: list[Read]) -> tuple[list[tuple[Any, Read]], list[tuple[Any, Optional[Read]]]]:
    """The call numbers given, as (those of calls of this run that answered, the rest), each with its call; a refused
    repeat stands for the call it repeated."""
    good, bad = [], []
    for n in numbers:
        k = _number(n)
        read = reads[k - 1] if k is not None and 1 <= k <= len(reads) else None
        if read is not None and read.same_as is not None and 1 <= read.same_as <= len(reads):
            read = reads[read.same_as - 1]
        (good if read is not None and not read.failed else bad).append((n, read))
    return good, bad


def check(block: dict, reads: list[Read], alert_start: Optional[datetime]) -> tuple[int, list[Problem]]:
    """(the causes checked, what is wrong with them), one problem per cause, the first found. A cause whose other
    checks pass but that also gives a number naming no call that answered is bad_calls too. An entry of kind "none"
    is not a cause (rca.is_cause); one whose kind is missing or null is. The rows keep UTC without a zone, as
    `alert_start` does."""
    given = block.get("causes")
    causes = [(i, c) for i, c in enumerate(given if isinstance(given, list) else [])
              if isinstance(c, dict) and rca.is_cause(c)]
    problems: list[Problem] = []
    for index, c in causes:
        resource = str(c.get("resource") or "").strip()
        numbers = c.get("evidence") if isinstance(c.get("evidence"), list) else []
        if not numbers:
            problems.append(Problem(resource, "no_evidence", index=index))
            continue
        good, bad = answered(numbers, reads)
        if not good:
            problems.append(Problem(resource, "bad_calls", {"calls": [n for n, _ in bad]}, index))
            continue
        held = [(n, read) for n, read in good if read.shows]
        if not held:
            problems.append(Problem(resource, "empty_answer", {"calls": [n for n, _ in good]}, index))
            continue
        if not any(_names(read.text, resource_name(resource)) for _, read in held):
            problems.append(Problem(resource, "name_missing", {"name": resource_name(resource), "calls": [n for n, _ in held]},
                                    index))
            continue
        started = _time(c.get("started_at"))
        if alert_start is not None and started is not None and started > alert_start + START_TOLERANCE:
            problems.append(Problem(resource, "after_alert", {"at": _stamp(started), "start": _stamp(alert_start)}, index))
            continue
        if bad:  # a call that shows the cause does not make the other numbers right: each must name a call that answered
            problems.append(Problem(resource, "bad_calls", {"calls": [n for n, _ in bad]}, index))
    return len(causes), problems


def _stamp(t: datetime) -> str:
    return t.strftime("%Y-%m-%dT%H:%M:%SZ")


def _calls(values: dict) -> str:
    return ", ".join(str(n) for n in values.get("calls") or [])


_REASONS = {
    "en": {
        "no_evidence": "no call is given for it",
        "bad_calls": "calls {calls} are not calls of this investigation that answered",
        "empty_answer": "calls {calls} read nothing or their answer holds nothing",
        "name_missing": "{name} does not appear in what calls {calls} returned",
        "after_alert": "it starts at {at}, after the alert's start at {start}",
    },
    "ko": {
        "no_evidence": "근거로 댄 호출이 없음",
        "bad_calls": "{calls}번 호출은 이 조사에서 답을 받은 호출이 아님",
        "empty_answer": "{calls}번 호출은 읽은 것이 없거나 답에 담긴 것이 없음",
        "name_missing": "{calls}번 호출이 돌려준 결과에 {name}이(가) 나오지 않음",
        "after_alert": "시작 시각 {at}이(가) 알림 시작 {start}보다 늦음",
    },
}


def reason_text(p: Problem, language: str = "en") -> str:
    texts = _REASONS.get(language, _REASONS["en"])
    return texts[p.reason].format(**{**p.values, "calls": _calls(p.values)})


def ask_again(status: str, problems: list[Problem], reads: list[Read]) -> str:
    """The second ask with this check alone (rca.ask_again): the report again, causes no call shows marked as
    hypotheses."""
    calls = [(r.tool, r.args, f"the same read as call {r.same_as}" if r.same_as else "failed" if r.failed else "answered")
             for r in reads]
    return rca.ask_again(rca.Checked("", None, status, cause_problems=problems), calls, evidence=True, ledger=False)


_NOTE = {
    "en": ("Not verified by the server: no tool result of this investigation shows the causes below, so read them as "
           "hypotheses.", "Not verified by the server: the report did not end with a valid rca block, so its causes were "
           "not checked against the tool results."),
    "ko": ("서버 확인 안 됨: 아래 원인은 이 조사의 도구 결과로 확인되지 않아 가설로 읽어 주세요.",
           "서버 확인 안 됨: 보고서 끝에 올바른 rca 묶음이 없어 원인을 도구 결과와 대조하지 못했습니다."),
}


def note(status: str, problems: list[Problem], language: str) -> str:
    """Added under the report by the server, whatever the model wrote."""
    unchecked, missing = _NOTE.get(language, _NOTE["en"])
    if status != "ok":
        return "\n\n---\n\n" + missing
    lines = "\n".join(f"- {p.resource or '-'}: {reason_text(p, language)}" for p in problems)
    return f"\n\n---\n\n{unchecked}\n{lines}"
