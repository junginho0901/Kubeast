"""The outcome of an alert investigation (features.alertInvestigation.verdict, off by default; nothing without
evidenceCheck or ledger, whose rca block it is part of).

With it on the rca block (investigation/rca.py) also says which of three answers the report gives — a cause found, no
fault found, or that the results cannot tell — and the calls that show the symptom the alert names. The server holds
the block to this run's calls (check()):

- a report that names a cause needs a call that answered and shows the symptom: the workload the alert's labels name, or
  without one the symptom's object or another the alert names, is in what the call returned, and the call is no read of
  what changed, of an alert or its rule or of names;
- cause_found also needs a cause the calls show (with evidenceCheck its checks, without it a call that answered);
- no_fault needs such a call that names the alert's object (any of them, when the alert names nothing);
- an answer that read or holds nothing shows none of these, whatever names it repeats (investigation/answers.py), and an
  alert about a workload is about that workload, not the pod its labels name beside it, which may be the one that
  collected the metric; an object that belongs to a workload (an Ingress, an HPA, a PVC, a PDB, a quota) is no workload,
  and an alert about one is answered by a read of its namespace too;
- the outcome, "no_fault" and "causes" say the same.

What does not hold is asked about once, in the one second ask with the other checks' problems (rca.ask_again). Of an
answer that still does not hold the server keeps cannot_tell and says why under the report (note()); the causes stay in
the result as the model gave them.

The lists beside the outcome are the server's, from the run's calls alone (lists()): the sources the calls read, what
was checked and normal (the checks anomaly_rank lists as normal, an issue check that lists nothing) and what was not
looked at (the sources no call read, the checks anomaly_rank lists as not run, the calls that gave no answer). Nothing
the model writes goes into them. The row keeps all of it in its result as `verdict` (investigation/result.py); a result
without it was written with the switch off, or before there was one.
"""

from __future__ import annotations

import json
import re
from dataclasses import dataclass, field
from typing import Any, Iterable, Optional

from app.services.ai import repeats
from app.services.investigation import answers, evidence, rca
from app.services.investigation import result as inv_result
from app.services.investigation import windows

CAUSE_FOUND, NO_FAULT, CANNOT_TELL = "cause_found", "no_fault", "cannot_tell"
OUTCOMES = (CAUSE_FOUND, NO_FAULT, CANNOT_TELL)

# What the row keeps of the lists at most; a longer one keeps its first items and is named in `cut`.
MAX_NORMAL = 20
MAX_NOT_LOOKED_AT = 20
MAX_DETAIL = 200

# An alert's labels that name an object; its namespace, scrape job and instance name none. The first of these it has is
# what the alert is about: a metric about a workload carries the pod, container and service that were scraped for it. An
# attached object belongs to a workload, whose own reads need not name it.
WORKLOAD_LABELS = ("deployment", "statefulset", "daemonset", "replicaset", "workload", "job_name", "cronjob")
ATTACHED_LABELS = ("persistentvolumeclaim", "horizontalpodautoscaler", "hpa", "poddisruptionbudget", "resourcequota", "ingress")
OBJECT_LABELS = (WORKLOAD_LABELS, ATTACHED_LABELS, ("exported_pod",), ("pod",), ("node",),
                 ("exported_service", "service", "service_name", "app", "exported_container", "container"))
# What collects metrics about other objects: its own name in a label a scrape adds is not what the alert is about, unless
# it is all there is.
COLLECTORS = ("kube-state-metrics", "node-exporter")
SCRAPE_LABELS = frozenset({"pod", "service", "service_name", "app", "container"})

# Reads that show no symptom: what an alert or its rule says and which names there are (and what changed, can_show).
NO_SYMPTOM = frozenset({
    "alerts_list", "alerts_inbox", "prometheus_rules", "prometheus_metrics", "prometheus_labels", "loki_labels",
    "traces_tags", "k8s_find_resource", "k8s_explain", "k8s_get_available_api_resources", "can_i", "clusters_list",
})

# What an investigation can look at, each with the tools that read it. A tool in none of them reads no source of its own
# (names, rules, what the investigator may do); a timeline reads events too unless it is the changes view.
SOURCES: tuple[tuple[str, frozenset[str]], ...] = (
    ("objects", frozenset({
        "get_cluster_overview", "issues", "k8s_get_resources", "k8s_get_resource_yaml", "k8s_describe_resource",
        "k8s_jq_query", "k8s_tabular_query", "k8s_count", "resource_graph", "storage_summary"})),
    ("events", frozenset({"k8s_get_events", "k8s_describe_resource", "timeline"})),
    ("changes", frozenset({"timeline", "helm_read", "gitops_status"})),
    ("logs", frozenset({"k8s_get_pod_logs", "logsearch", "loki_query", "loki_patterns", "logfiles"})),
    ("metrics", frozenset({"prometheus_query", "get_pod_metrics", "get_node_metrics"})),
    ("traces", frozenset({"traces_search", "traces_get", "traces_metrics", "traces_compare"})),
    ("network", frozenset({"network_flows", "network_drops", "network_top_flows", "network_policy_check",
                           "network_policy_effective", "k8s_check_service_connectivity"})),
    ("alerts", frozenset({"alerts_list", "alerts_inbox"})),
)

# The source an anomaly_rank check reads (a check in none of them counts for no source).
CHECK_SOURCES = {
    "issues": "objects", "crash_reasons": "objects", "node_pressure": "objects", "node_conditions_not_cpu": "objects",
    "restarts": "metrics", "memory_near_limit": "metrics", "cpu_throttling": "metrics",
    "error_log_patterns": "logs", "error_log_counts": "logs",
    "trace_errors": "traces", "trace_latency": "traces", "trace_requests": "traces",
}

NOT_A_READ = "not a read-only tool"  # the runner's refusal of a write the model asked for


def on(cfg) -> bool:
    """Whether the outcome is asked for: its switch, and a switch that asks for the block it is in."""
    return bool(cfg.verdict and rca.on(cfg))


# A lone surrogate, which a JSON escape can write and the database refuses.
_SURROGATE = re.compile(f"[{chr(0xD800)}-{chr(0xDFFF)}]")


def _text(value: Any) -> str:
    return _SURROGATE.sub("", inv_result.text(value))


def writable(value: Any) -> Any:
    """`value` with lone surrogates taken out of every string at any depth: neither text nor JSON of the database holds one."""
    if isinstance(value, str):
        return _SURROGATE.sub("", value)
    if isinstance(value, (list, tuple)):
        return [writable(v) for v in value]
    if isinstance(value, dict):
        return {writable(k): writable(v) for k, v in value.items()}
    return value


@dataclass(frozen=True)
class Alert:
    """What an alert gives its object by: the names in its labels, and its namespace. `workload`: they name a workload,
    so the report is about that and no other. `attached`: they name an object that belongs to one."""
    names: tuple[str, ...] = ()
    namespace: str = ""
    workload: bool = False
    attached: bool = False

    @property
    def by_namespace(self) -> bool:
        """Whether a read of its namespace is about it."""
        return bool(self.namespace) and (self.attached or not self.names)

    @property
    def wanted(self) -> list[str]:
        """Its object's names, its namespace too where a read of that is about it."""
        return [*self.names, *([self.namespace] if self.by_namespace else [])]


# The end of a generated pod name: the ReplicaSet's hash and the API server's five letters (k8s.io/apimachinery util/rand).
_POD_END = re.compile(r"-[bcdfghjklmnpqrstvwxz2456789]{5}$")
_HASH_END = re.compile(r"-[bcdfghjklmnpqrstvwxz2456789]{6,10}$")
# The end of a CronJob's Job: the schedule's minute, or Kubeast's manual run's second.
_RUN_END = re.compile(r"-(manual-)?\d{6,}$")


def _pod_names(pod: str) -> list[str]:
    """A pod's name and its workload's, where the name is a generated one: a pod that was replaced has another name."""
    owner = _POD_END.sub("", pod)
    return [pod] if owner == pod else list(dict.fromkeys((pod, _HASH_END.sub("", owner))))


def _names_by(key: str, name: str) -> list[str]:
    """The names an alert's label gives its object by: its own, and its workload's where the name is made from it."""
    if key in ("pod", "exported_pod"):
        return _pod_names(name)
    end = {"replicaset": _HASH_END, "job_name": _RUN_END}.get(key)
    return list(dict.fromkeys((name, end.sub("", name)))) if end else [name]


def alert_of(labels: Any, namespace: str = "") -> Alert:
    given = labels if isinstance(labels, dict) else {}
    for collectors in (False, True):  # a collector's own name only where the labels name nothing else
        for keys in OBJECT_LABELS:
            found = [(key, given[key].strip()) for key in keys if isinstance(given.get(key), str)]
            names = [name for key, n in found if n and len(n) <= 253 and
                     (collectors or key not in SCRAPE_LABELS or not any(evidence._names(n, c) for c in COLLECTORS))
                     for name in _names_by(key, n)]
            if names:
                return Alert(tuple(dict.fromkeys(names)), namespace or "", keys is WORKLOAD_LABELS, keys is ATTACHED_LABELS)
    return Alert((), namespace or "")


# --- the model's part, held to the calls ----------------------------------------------------------------------------


@dataclass
class Problem:
    reason: str                  # the failure kind is outcome_<reason>
    values: dict[str, Any] = field(default_factory=dict)
    lowers: bool = True          # the outcome the block says does not stand while it is there


@dataclass
class Checked:
    """The block's outcome as check() read it."""
    said: Optional[str]          # the block's outcome, None when it is not one of the three
    outcome: str                 # what the server keeps of it
    problems: list[Problem] = field(default_factory=list)

    @property
    def why(self) -> list[str]:
        """Why the server keeps cannot_tell."""
        return [p.reason for p in self.problems if p.lowers]


def said(block: dict) -> Optional[str]:
    value = block.get("outcome")
    word = value.strip().lower().replace(" ", "_").replace("-", "_") if isinstance(value, str) else ""
    return word if word in OUTCOMES else None


def symptom(block: dict) -> tuple[str, list[Any]]:
    """The symptom's object and the call numbers given for it: {"resource", "evidence"}, or the numbers alone."""
    given = block.get("symptom")
    if isinstance(given, list):
        return "", given
    if not isinstance(given, dict):
        return "", []
    return _text(given.get("resource")), given["evidence"] if isinstance(given.get("evidence"), list) else []


def can_show(read: evidence.Read) -> bool:
    """Whether a read can show a symptom: not what changed, what an alert or its rule says, or which names there are."""
    changes = read.tool == windows.CHANGES_TOOL and read.args.get("view") == windows.CHANGES_VIEW
    return not changes and read.tool not in NO_SYMPTOM


def _is_about(read: evidence.Read, names: Iterable[str], namespace: str) -> bool:
    """Whether a call returned one of the names or, where one is given, read that namespace."""
    if any(evidence._names(read.text, name) for name in names):
        return True
    return bool(namespace) and (read.args.get("namespace") == namespace or evidence._names(read.text, namespace))


def _wanted(resource: str, alert: Alert) -> tuple[list[str], str]:
    """What a symptom's call must be about: one of the names, or the namespace where one is given. The workload the alert
    is about; without one the symptom's object or one the alert names, and the alert's namespace only where no object is
    given or the alert's is attached to another. A cluster is not named by what is read in it."""
    if alert.workload:
        return list(alert.names), ""
    whole = resource.lower().startswith("cluster/")
    own = "" if whole else evidence.resource_name(resource)
    return [n for n in dict.fromkeys((own, *alert.names)) if n], "" if own or whole or not alert.by_namespace else alert.namespace


def _symptom_problem(block: dict, reads: list[evidence.Read], alert: Alert) -> Optional[Problem]:
    resource, given = symptom(block)
    if not given:
        return Problem("no_symptom")
    good, bad = evidence.answered(given, reads)
    if not good:
        return Problem("symptom_bad_calls", {"calls": [n for n, _ in bad]})
    shows = [(n, read) for n, read in good if can_show(read) and read.shows]
    if not shows:
        return Problem("symptom_not_shown", {"calls": [n for n, _ in good]})
    names, namespace = _wanted(resource, alert)
    if (names or namespace) and not any(_is_about(read, names, namespace) for _, read in shows):
        # the block's own name for it: an alert's label is another system's text and goes in no message outside its fence
        return Problem("symptom_name_missing", {"name": "" if alert.workload else evidence.resource_name(resource),
                                                "workload": alert.workload, "calls": [n for n, _ in shows]})
    if bad:  # a call that shows it does not make the other numbers right, and they do not make it wrong
        return Problem("symptom_bad_calls", {"calls": [n for n, _ in bad]}, lowers=False)
    return None


def _read_problem(reads: list[evidence.Read], alert: Alert) -> Optional[Problem]:
    """no_fault needs a call that answered and names the alert's object. An issue check of every severity that lists
    nothing is such an answer, about the namespace it was asked for."""
    given = [read for read in reads if not read.failed and read.text and can_show(read) and
             (read.shows or (read.tool == "issues" and read.nothing == "empty" and not read.args.get("severity")))]
    if not given:
        return Problem("nothing_read")
    namespace = alert.namespace if alert.by_namespace else ""
    if alert.wanted and not any(_is_about(read, alert.names, namespace) for read in given):
        return Problem("not_read")
    return None


def _answered_for(cause: dict, reads: list[evidence.Read], tool_log: list[dict[str, Any]]) -> bool:
    """Whether a call given for a cause answered with something."""
    found, _bad = inv_result.calls(cause.get("evidence"), tool_log)
    return any(read.shows for _, read in evidence.answered([ref["call"] for ref in found], reads)[0])


def _fits(outcome: str, causes: bool, no_fault: Any) -> bool:
    if outcome == CAUSE_FOUND:
        return causes and no_fault is not True
    return not causes and no_fault is not (False if outcome == NO_FAULT else True)


def check(block: dict, *, reads: Optional[list[evidence.Read]], alert: Alert, tool_log: list[dict[str, Any]],
          unverified: Optional[set[int]]) -> Checked:
    """The block's outcome held to the run's calls. `unverified`: the places in the block's causes the evidence check
    found a problem with, None when that check is off (a cause is then shown by a call that answered)."""
    reads = reads or []
    given = block.get("causes")
    causes = [(i, c) for i, c in enumerate(given if isinstance(given, list) else [])
              if isinstance(c, dict) and rca.is_cause(c)]
    no_fault = block.get("no_fault")
    word = said(block)
    told = CAUSE_FOUND if causes else NO_FAULT if no_fault is True else CANNOT_TELL
    problems: list[Problem] = []
    if word is None:  # what the rest of the block says stands for it
        problems.append(Problem("missing", lowers=False))
    elif not _fits(word, bool(causes), no_fault):
        problems.append(Problem("contradicts", {"said": word, "causes": len(causes),
                                                "no_fault": json.dumps(no_fault if isinstance(no_fault, bool) else None)}))
    outcome = word or told
    if causes:
        if (found := _symptom_problem(block, reads, alert)) is not None:
            problems.append(found)
        shown = [i for i, c in causes if (i not in unverified if unverified is not None else _answered_for(c, reads, tool_log))]
        if outcome == CAUSE_FOUND and not shown:
            problems.append(Problem("cause_not_shown"))
    elif outcome == NO_FAULT and (found := _read_problem(reads, alert)) is not None:
        problems.append(found)
    return Checked(word, CANNOT_TELL if any(p.lowers for p in problems) else outcome, problems)


_REASONS = {
    "en": {
        "missing": '"outcome" is not cause_found, no_fault or cannot_tell',
        "contradicts": '"outcome" is {said} beside {causes} causes and "no_fault" {no_fault}',
        "no_symptom": "no call is given that shows the alert's symptom",
        "symptom_bad_calls": "calls {calls}, given for the symptom, are not calls of this investigation that answered",
        "symptom_name_missing": "{name} does not appear in what calls {calls}, given for the symptom, returned",
        "symptom_not_shown": "calls {calls}, given for the symptom, hold nothing or read only what changed, an alert or its rule, or names",
        "cause_not_shown": "no call shows any of its causes",
        "nothing_read": "no call of this investigation that read a state answered with something",
        "not_read": "no call that read a state names the alert's object",
    },
    "ko": {
        "missing": '"outcome"이 cause_found, no_fault, cannot_tell 중 하나가 아님',
        "contradicts": '"outcome"은 {said}인데 원인이 {causes}개이고 "no_fault"는 {no_fault}임',
        "no_symptom": "알림의 증상을 보여 주는 호출을 대지 않음",
        "symptom_bad_calls": "증상의 근거로 댄 {calls}번 호출은 이 조사에서 답을 받은 호출이 아님",
        "symptom_name_missing": "증상의 근거로 댄 {calls}번 호출이 돌려준 결과에 {name}{subject} 나오지 않음",
        "symptom_not_shown": "증상의 근거로 댄 {calls}번 호출은 담긴 것이 없거나 바뀐 것, 알림이나 그 규칙, 이름만 읽음",
        "cause_not_shown": "원인을 보여 주는 호출이 하나도 없음",
        "nothing_read": "이 조사에서 상태를 읽어 무엇이든 답을 받은 호출이 없음",
        "not_read": "상태를 읽은 호출 가운데 알림의 대상 이름이 나오는 것이 없음",
    },
}
REASONS = tuple(_REASONS["en"])
# In place of a name: the block gives none, or it is the alert's label's, which goes in no message outside its fence.
_ITS_OBJECT = {"en": "the symptom's object", "ko": "증상의 대상"}
_ITS_WORKLOAD = {"en": "the workload the alert's labels name", "ko": "알림의 레이블이 가리키는 워크로드"}
_CALL_CHARS = 20


def reason_text(p: Problem, language: str = "en") -> str:
    language = language if language in _REASONS else "en"
    calls = ", ".join(_text(str(n))[:_CALL_CHARS] for n in (p.values.get("calls") or [])[:inv_result.MAX_CALLS])
    stand_in = (_ITS_WORKLOAD if p.values.get("workload") else _ITS_OBJECT)[language]
    return _REASONS[language][p.reason].format(**{**p.values, "calls": calls, "name": p.values.get("name") or stand_in,
                                                  "subject": "이(가)" if p.values.get("name") else "가" if p.values.get("workload") else "이"})


def kinds(failures: Iterable[dict[str, Any]]) -> list[str]:
    """The failure kinds of the outcome among an answer's failures."""
    return [k for k in rca.kinds(failures) if k.startswith("outcome_")]


# --- the server's lists ----------------------------------------------------------------------------------------------


def _items(value: Any) -> list:
    return value if isinstance(value, list) else []


def _detail(value: Any) -> str:
    """A reason as the lists keep it: its first MAX_DETAIL characters, an ellipsis the last where it was cut."""
    text = _SURROGATE.sub("", str(value).replace("\x00", "")).strip() if value is not None else ""
    return text if len(text) <= MAX_DETAIL else text[:MAX_DETAIL - 1] + "…"


class Facts:
    """What the run's calls answered that the checks and the lists are made of, noted as each call ends and kept only
    while the run lasts. `raw` is a call's whole answer (masked as the model's is), `status` the tool's own
    (tool_outcome, or answers.raw_outcome of a raw-text tool); a call that was refused or failed is not noted."""

    def __init__(self) -> None:
        self.normal: list[dict[str, Any]] = []
        self.not_run: list[dict[str, Any]] = []
        self.found: set[tuple[str, str]] = set()    # (namespace, check) that found something
        self.ran: set[tuple[str, str]] = set()      # (namespace, check) that ran, whatever it found
        self.unread: dict[int, tuple[str, str]] = {}  # a call that read nothing → (why, in the lists' words, its detail)
        self.empty: set[int] = set()                # calls whose answer holds nothing
        self.missed: set[int] = set()               # issue checks that could not read some of their lists
        self.no_issue: set[int] = set()             # issue checks that list no object
        self.checked: dict[str, dict[int, str]] = {}   # source → {call: tool} of the checks that read it

    def note(self, number: int, tool: str, args: Any, raw: Any, status: Optional[str]) -> None:
        if (why := answers.unread(tool, raw, status)) is not None:
            told = why in ("unavailable", "not_found")  # the others go by the general reason, their status as its detail
            self.unread[number] = (why, _detail(answers.unread_detail(tool, raw))) if told else ("no_answer", why)
            return
        if answers.empty(tool, raw):
            self.empty.add(number)
        if tool == windows.NARROW_TOOL and windows.is_narrowing_answer(raw):
            self._narrowing(number, tool, answers.parsed(raw) or {})
        elif tool == "issues":
            self._issues(number, tool, args if isinstance(args, dict) else {}, answers.parsed(raw) or {})

    def held_none(self, number: int) -> str:
        """evidence.Read.nothing of a call. An issue check that lists nothing and missed lists did not read what they hold."""
        if number in self.unread or (number in self.no_issue and number in self.missed):
            return "unread"
        return "empty" if number in self.empty or number in self.no_issue else ""

    @property
    def none_held(self) -> set[int]:
        return self.empty | self.no_issue | set(self.unread)

    def _narrowing(self, number: int, tool: str, data: dict) -> None:
        namespace = _text(data.get("namespace"))
        place: dict[str, Any] = {"namespace": namespace} if namespace else {}
        workload = data.get("workload")
        if isinstance(workload, dict) and workload.get("name"):
            place["workload"] = _text(f"{workload.get('kind') or ''}/{workload['name']}")
        window = data.get("window") if isinstance(data.get("window"), dict) else {}
        times = {key: at for key, at in (("since", _text(window.get("start"))), ("until", _text(window.get("end")))) if at}
        partial = {p["check"]: _detail(p.get("reason")) for p in _items(data.get("partial"))
                   if isinstance(p, dict) and isinstance(p.get("check"), str)}
        for f in _items(data.get("findings")):
            if isinstance(f, dict) and isinstance(f.get("check"), str):
                self._ran(namespace, f["check"], number, tool, found=True)
        for name in _items(data.get("normal")):
            if isinstance(name, str) and (check := _text(name)):
                self._ran(namespace, check, number, tool)
                self.normal.append({"check": check, "call": number, "tool": tool, **place, **times,
                                    **({"partial": partial[name]} if partial.get(name) else {})})
        for n in _items(data.get("not_run")):
            if isinstance(n, dict) and isinstance(n.get("check"), str) and (check := _text(n["check"])):
                self.not_run.append({"check": check, "reason": "not_run", "detail": _detail(n.get("reason")),
                                     "call": number, "tool": tool, **place})

    def _issues(self, number: int, tool: str, args: dict, data: dict) -> None:
        """The issue check: normal when it lists no object in its scope, whatever the severity, and read every list of it.
        The lists it could not read — not_read, and the Collector rows of an answer that is not narrowed — are not looked
        at, whatever else it lists. A grant limited to namespaces, whose answer names them, reads no nodes."""
        listed = data.get("issues")
        if not isinstance(listed, list) or not isinstance(data.get("total"), int):
            return
        limited = [_text(n) for n in _items(data.get("namespace")) if isinstance(n, str)]
        namespace = _text(args.get("namespace")) or ", ".join(limited)
        place = {"namespace": namespace} if namespace else {}
        collectors = [row for row in listed if isinstance(row, dict) and row.get("kind") == "Collector"]
        missed = _not_read(data.get("not_read"))
        for row in collectors:
            if not (limited and row.get("name") == "nodes"):
                missed.setdefault(_text(row.get("name")), _detail(row.get("message")))
        for name, why in missed.items():
            self.missed.add(number)
            self.not_run.append({"check": f"issues/{name}" if name else "issues", "reason": "not_run", "detail": why, "call": number,
                                 "tool": tool, **place})
        if len(listed) > len(collectors) or data["total"] > len(listed):
            self._ran(namespace, "issues", number, tool, found=True, whole=not missed)
            return
        self.no_issue.add(number)
        if not missed and not args.get("severity") and not data.get("truncated"):
            self._ran(namespace, "issues", number, tool)
            self.normal.append({"check": "issues", "call": number, "tool": tool, **place})

    def _ran(self, namespace: str, check: str, number: int, tool: str, found: bool = False, whole: bool = True) -> None:
        if whole:  # a check that missed lists did not read what they hold
            self.ran.add((namespace, check))
        if found:
            self.found.add((namespace, check))
        if (source := CHECK_SOURCES.get(check)) is not None:
            self.checked.setdefault(source, {})[number] = tool


def _not_read(missed: Any) -> dict[str, str]:
    """An issue check's lists that could not be read, each with why ("" where the answer does not say)."""
    if isinstance(missed, dict):
        return {_text(name): _detail(why) if isinstance(why, str) else "" for name, why in missed.items()}
    if isinstance(missed, list):
        return {_text(name) if isinstance(name, str) else "": "" for name in missed}
    return {"": _detail(missed) if isinstance(missed, str) else ""} if missed else {}


def sources_of(tool: str, args: Any) -> list[str]:
    changes = tool == windows.CHANGES_TOOL and isinstance(args, dict) and args.get("view") == windows.CHANGES_VIEW
    return [source for source, tools in SOURCES if tool in tools and not (changes and source == "events")]


def _kept(items: list, limit: int) -> tuple[list, Optional[dict[str, int]]]:
    return items[:limit], inv_result.counted(items, limit, limit)


def lists(tool_log: list[dict[str, Any]], facts: Facts, offered: Iterable[str]) -> dict[str, Any]:
    """looked_at, checked_normal and not_looked_at of a run, from its calls (`tool_log`), what they answered (`facts`)
    and the tools it was offered. A check is normal when no call of the run found something with it in that namespace,
    and not looked at when none ran it there; a call that gave no answer is listed unless the same read answered in
    another call. A list past its cap keeps its first items and is named in `cut`."""
    answered: dict[str, dict[int, str]] = {source: dict(facts.checked.get(source) or {}) for source, _ in SOURCES}
    gave_none: dict[str, dict[int, str]] = {}
    failed: list[tuple[int, dict[str, Any], str, str]] = []
    reads: set[str] = set()
    for number, entry in enumerate(tool_log, 1):
        tool, args = str(entry.get("tool") or ""), entry.get("args")
        if entry.get("error") == NOT_A_READ or "repeat_of" in entry:
            continue
        if entry.get("error"):
            failed.append((number, entry, "failed", _detail(entry["error"])))
        elif number in facts.unread:
            failed.append((number, entry, *facts.unread[number]))
        else:
            reads.add(repeats.key(tool, args))
            for source in sources_of(tool, args):
                answered[source][number] = tool
            continue
        for source in sources_of(tool, args):
            gave_none.setdefault(source, {})[number] = tool

    looked_at: list[dict[str, Any]] = []
    not_looked_at: list[dict[str, Any]] = []
    names = set(offered)
    for source, tools in SOURCES:
        if answered[source]:
            refs = [{"call": n, "tool": tool} for n, tool in sorted(answered[source].items())]
            kept, cut = _kept(refs, inv_result.MAX_CALLS)
            looked_at.append({"source": source, "calls": kept, **({"cut": {"calls": cut}} if cut else {})})
        else:
            not_looked_at.append({"source": source, "reason": "no_answer" if source in gave_none else
                                  "not_called" if tools & names else "not_offered"})

    seen: set[tuple[str, str, str]] = set()
    normal: list[dict[str, Any]] = []
    for item in facts.normal:
        place = (item.get("namespace", ""), item["check"])
        if place in facts.found or (*place, item.get("workload", "")) in seen:
            continue
        seen.add((*place, item.get("workload", "")))
        normal.append(item)
    for item in facts.not_run:
        place = (item.get("namespace", ""), item["check"])
        if (place[0], item["check"].partition("/")[0]) in facts.ran or (*place, "not_run") in seen:  # a list of a check: check/list
            continue
        seen.add((*place, "not_run"))
        not_looked_at.append(item)
    for number, entry, reason, detail in failed:
        if repeats.key(str(entry.get("tool") or ""), entry.get("args")) not in reads:
            not_looked_at.append({"call": number, "tool": str(entry.get("tool") or ""), "reason": reason,
                                  **({"detail": detail} if detail else {})})

    out: dict[str, Any] = {"looked_at": looked_at}
    cuts: dict[str, dict[str, int]] = {}
    for name, items, limit in (("checked_normal", normal, MAX_NORMAL), ("not_looked_at", not_looked_at, MAX_NOT_LOOKED_AT)):
        out[name], cut = _kept(items, limit)
        if cut:
            cuts[name] = cut
    if cuts:
        out["cut"] = cuts
    return out


# --- what the row, the report and the audit row keep -------------------------------------------------------------------


def shape(block: Optional[dict], checked: Optional[Checked], tool_log: list[dict[str, Any]], facts: Facts,
          offered: Iterable[str]) -> dict[str, Any]:
    """The result's `verdict`: the outcome the server keeps (None when the block could not be read), what the block said,
    why they differ, the symptom with its calls, and the lists."""
    out: dict[str, Any] = {"outcome": checked.outcome if checked else None, "said": checked.said if checked else None,
                           "why": checked.why if checked else []}
    resource, given = symptom(block) if isinstance(block, dict) else ("", [])
    if checked and (resource or given):
        found, _bad = inv_result.calls(given, tool_log)
        out["symptom"] = {"resource": resource, "evidence": found}
        if (cut := inv_result.counted(given, inv_result.MAX_CALLS, inv_result.MAX_CALLS)) is not None:
            out["symptom"]["cut"] = {"evidence": cut}
    out.update(lists(tool_log, facts, offered))
    return out


_NOTE = {
    "en": ("Outcome kept by the server: cannot tell. What the report concludes does not hold against this investigation's calls, "
           "so read its cause, or its finding of no fault, as a hypothesis:"),
    "ko": "서버가 남긴 결론: 알 수 없음. 보고서의 결론이 이 조사의 호출과 맞지 않아, 적힌 원인이나 이상 없음은 가설로 읽어 주세요:",
}


def note(checked: Optional[Checked], language: str) -> str:
    """Added under the report by the server when it keeps cannot_tell of an outcome that does not hold; "" otherwise."""
    if checked is None or not checked.why:
        return ""
    lines = "\n".join(f"- {reason_text(p, language)}" for p in checked.problems if p.lowers)
    return f"\n\n---\n\n{_NOTE.get(language, _NOTE['en'])}\n{lines}"


def counts(shaped: dict[str, Any], *, asked_because: list[dict[str, Any]], failures: list[dict[str, Any]]) -> dict[str, Any]:
    """The ai.investigation.run row's `verdict`: the outcome kept and the one said, the outcome's failure kinds of the
    first answer and of the kept one, and how long the lists are — kind names and numbers, no text of the model's."""
    cut = shaped.get("cut") or {}
    return {"outcome": shaped["outcome"], "said": shaped["said"], "asked_because": kinds(asked_because), "failures": kinds(failures),
            "looked_at": len(shaped["looked_at"]),
            **{name: (cut.get(name) or {}).get("given", len(shaped[name])) for name in ("checked_normal", "not_looked_at")}}
