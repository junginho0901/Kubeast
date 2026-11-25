"""Hard cases for scripts/ai-eval.py: the answer block (rca_block_v0), its scoring, the free-text scoring of an alert
investigation's report, the per-run truth copy, the order of a case's steps and the case checks. Pure functions only —
nothing here reaches a cluster or the API, so scripts/test_ai_eval_rca.py checks it with made-up answers.
"""
from __future__ import annotations

import json
import re
from datetime import datetime, timezone

# Appended (after a blank line) to every question of a case whose answer_format is rca_block_v0.
RCA_BLOCK_V0 = """At the very end of your answer, add one fenced code block tagged rca holding one JSON object:
{"no_fault": false,
 "causes": [{"resource": "Kind/namespace/name", "kind": "crash|oom|image|config_change|rollout|network_policy|dns|resource_limit|quota|node|dependency_down|dependency_slow|storage|none", "started_at": "RFC3339 time or null", "evidence": [1, 3]}],
 "path": ["Kind/namespace/name of the cause", "...", "Kind/namespace/name where the symptom shows"],
 "ruled_out": ["Kind/namespace/name"]}
"evidence" lists your own tool calls in this answer that show the cause, numbered from 1 in the order you made them. If you find no fault, answer "no_fault": true and "causes": []."""

ANSWER_FORMATS = {"rca_block_v0": RCA_BLOCK_V0}

KINDS = ("crash", "oom", "image", "config_change", "rollout", "network_policy", "dns", "resource_limit", "quota", "node",
         "dependency_down", "dependency_slow", "storage", "none")

# What an extra cause (not a truth cause, not in also_ok, not a decoy) takes off a right answer's 1.0, and how many a
# passing answer may hold: more reads as a list of guesses and does not pass.
EXTRA_CAUSE_PENALTY = 0.25
EXTRAS_ALLOWED = 1
DEFAULT_TIME_TOLERANCE_SECONDS = 120
DEFAULT_INJECT_WAIT_SECONDS = 240

# Fields that make a case run in stages (setup → baseline → inject → asks → undo); a case without any of them runs
# exactly as the twelve easy cases always have.
STAGED_FIELDS = ("question_vague", "answer_format", "baseline_seconds", "fault_start_at", "inject_cmds", "inject_wait",
                 "fault_duration_seconds", "undo_cmds", "ask_after_seconds", "cooldown_seconds", "alert")

# A case's alert for the alert path (ai-eval.py --alerts, README "The alert path").
ALERT_FIELDS = ("labels", "annotations", "rule", "match", "after_seconds", "fire_wait_seconds", "investigation_wait_seconds")
DEFAULT_FIRE_WAIT_SECONDS = 600
DEFAULT_INVESTIGATION_WAIT_SECONDS = 900

# The free-text check of a report (score_text): words that say a cause of each kind, words that say there is no fault,
# words that rule a named object out and words that blame one. Broad on purpose — the check only has to read the same
# way with and without the rca block.
KIND_WORDS = {
    "crash": r"crash|exit(ed)? (code|with)|restart|panic|재시작|비정상 종료",
    "oom": r"\boom|out of memory|memory limit|메모리 (부족|한도|제한)",
    "image": r"imagepull|errimage|image pull|(image|tag) (is )?(missing|not found|wrong)|이미지",
    "config_change": r"config|setting|environment variable|\benv\b|설정|환경 ?변수",
    "rollout": r"rollout|rolled out|roll-out|new (revision|replicaset|release)|롤아웃|배포",
    "network_policy": r"network ?polic|netpol|ingress rule|egress rule|네트워크 ?정책",
    "dns": r"\bdns|ndots|resolv|name resolution|search domain|이름 (풀이|해석)|검색 ?도메인",
    "resource_limit": r"(cpu|memory) limit|throttl|\bcfs\b|limits?\b|스로틀|리소스 (한도|제한)",
    "quota": r"quota|쿼터|할당량",
    "node": r"\bnode\b|notready|not ready|cordon|taint|saturat|\bbusy\b|\bpegged\b|\bmaxed\b|cpu pressure|\bcontention\b|노드|포화|경합",
    "dependency_down": r"no (ready )?endpoints|scaled (down|to (0|zero))|replicas:? 0|connection refused|unavailable|\bdown\b|엔드포인트|중단",
    "dependency_slow": r"slow(s|ed|ing)? down|slow|latency|timeout|timed out|느려|지연",
    "storage": r"\bpvc|persistentvolume|volume|disk|storage|볼륨|디스크|스토리지",
}
_FAULT_NOUNS = r"(fault|problem|issue|outage|failure|incident|error|cause|evidence|sign|trace)s?"
# There is no fault: in a clause that names no object of the truth, the report's answer; next to a name, that name ruled out.
NO_FAULT_WORDS = re.compile(
    r"\bno (current |ongoing |active |real |actual )?(fault|problem|issue|outage|failure|incident)s?\b"
    rf"|\b(found|find|see|saw|shows?) no {_FAULT_NOUNS}\b|\bno (evidence|sign|trace)s? (of|for)\b"
    rf"|\b(could not|couldn'?t|did not|didn'?t|cannot|can'?t) (find|see) (a |an |any )?{_FAULT_NOUNS}\b"
    r"|\bnothing (is |was |seems |looks )?(wrong|broken|failing|abnormal)|\bnothing points (at|to)\b"
    r"|\bno (action|fix) (is )?(needed|required)|\bfalse (positive|alarm)"
    r"|찾지 못했|찾을 수 없|발견(하지 못|되지 않)|장애(가|는)? 없|고장(이|은)? 없|문제(가|는)? 없|이상(이|은)? 없|흔적(이|은)? 없", re.I)
# A named object ruled out: unchanged, normal, unrelated, not the cause.
CLEAR_WORDS = re.compile(
    r"\bnot (the |a |an )?(cause|culprit|problem|issue|fault|reason|involved|related|changed|at fault)\b|\bisn'?t (the |a )?(cause|problem)"
    r"|\b(did|does|do|has|have) not (cause|break|affect|make|touch)|\b(didn|doesn|don|hasn|haven)'t (cause|break|affect|make|touch)"
    r"|\bunchanged\b|\bno( \w+)? change|\bunrelated\b|\bruled? (it |this |them )?out\b|\bharmless\b"
    r"|\blooks? (normal|fine|healthy|ok|okay|good|correct|as expected)|\b(is|are|was|were|stays?|stayed) (normal|fine|healthy|correct|ok|okay)\b"
    r"|\b(working|running|behaving|answering|serving|finished|completed?) (normally|as expected|fine|cleanly)|\bas expected\b"
    r"|\bexpected behaviou?r|\bas (it|they) should\b"
    r"|정상|무관|(관계|관련)(가|이)? 없|원인(이|은|과는)? 아니|원인 아님|바뀌지 않|변경(이|은|되지)? ?(없|않)|영향(이|은)? 없", re.I)
# A no-fault clause about the others ("No problems elsewhere", "no issues in the other workloads") rules them out; it
# does not say the report found no fault.
OTHERS_WORDS = re.compile(r"\b(elsewhere|others?|rest|remaining)\b|나머지|다른|그 ?외", re.I)
# A named object blamed: what it is said to have caused, not what happened to it ("restarted once" blames nothing).
# CAUSE_WORDS blame the object named nearest before them ("X caused it", "X 때문에"), else after ("the culprit is X");
# CAUSED_BY_WORDS the object nearest after them ("because of X"), else before; FAIL_WORDS what went wrong with the
# object named nearest before them, which blames nothing in an object of the truth's path (its symptom: "so cart fails").
CAUSE_WORDS = re.compile(r"\bcaus(e|es|ed|ing)\b(?!\s+by)|culprit|\bled to|\bleads? to|result(s|ed)? in"
                         r"|\bmade\b[^.;]{0,40}\b(slow|fail|break)|원인|때문|탓", re.I)
CAUSED_BY_WORDS = re.compile(r"\bcaused by\b|\bbecause( of)?\b|\bdue to\b|\bresult of\b|\bthanks to\b", re.I)
FAIL_WORDS = re.compile(r"\bbr(o|ea)k|fail|\b(is|went|goes) down\b|실패|장애|느려지|망가", re.I)
# A change said of a ConfigMap or Secret cause is its config_change ("raised WEB_WORKERS from 3 to 6").
CHANGE_WORDS = re.compile(r"\b(changed?|changes|changing|edited|raised|lowered|increased|decreased|bumped|added|removed|replaced"
                          r"|updated|modified|rewritten|rewrote|overwritten|overwrote|switched|set to)\b"
                          r"|바뀌|바꾸|바꿨|수정|변경|올렸|올린|늘렸|늘린|줄였|줄인|추가", re.I)
CONFIG_KINDS = frozenset({"configmap", "secret"})
_HEADING = re.compile(r"^[ \t]{0,3}#{1,6}[ \t]+(.+?)[ \t#]*$", re.M)  # an ATX heading: a space after the #s
_TOKEN = re.compile(r"[A-Za-z0-9][A-Za-z0-9._/-]*")
_SENTENCE_BREAK = re.compile(r"(?<=[.!?。])\s+|\n+")
# Where a sentence's clauses part: ';', ',', while, but, and, though, and Korean -고, -지만, -며.
_CLAUSE_BREAK = re.compile(r"[;,]|\s(?:while|whereas|but|and|although|though)\s|(?<=[가-힣])(?:고|지만|으며|며)\s", re.I)
_BULLET = re.compile(r"^\s*(?:[-*+•]|\d+[.)])\s+")

_KIND_ALIASES = {
    "deploy": "deployment", "deployments": "deployment", "rs": "replicaset", "replicasets": "replicaset",
    "po": "pod", "pods": "pod", "svc": "service", "services": "service", "cm": "configmap", "configmaps": "configmap",
    "netpol": "networkpolicy", "networkpolicies": "networkpolicy", "quota": "resourcequota",
    "resourcequotas": "resourcequota", "hpa": "horizontalpodautoscaler", "horizontalpodautoscalers": "horizontalpodautoscaler",
    "ds": "daemonset", "daemonsets": "daemonset", "sts": "statefulset", "statefulsets": "statefulset",
    "cj": "cronjob", "cronjobs": "cronjob", "jobs": "job", "no": "node", "nodes": "node", "ns": "namespace",
    "namespaces": "namespace", "pvc": "persistentvolumeclaim", "persistentvolumeclaims": "persistentvolumeclaim",
    "ep": "endpoints", "secrets": "secret", "ing": "ingress", "ingresses": "ingress",
}
# Kinds the first part of "a/b" may name; a first part that is none of them, with no dot and no capital, is a namespace.
_KNOWN_KINDS = frozenset({
    "pod", "deployment", "replicaset", "statefulset", "daemonset", "job", "cronjob", "service", "endpoints", "endpointslice",
    "ingress", "ingressclass", "networkpolicy", "configmap", "secret", "serviceaccount", "role", "rolebinding",
    "clusterrole", "clusterrolebinding", "namespace", "node", "persistentvolume", "persistentvolumeclaim", "storageclass",
    "resourcequota", "limitrange", "horizontalpodautoscaler", "poddisruptionbudget", "priorityclass", "event", "lease",
    "gateway", "httproute", "networkchaos", "podchaos", "stresschaos", *_KIND_ALIASES, *_KIND_ALIASES.values(),
})
_PLACEHOLDER = re.compile(r"\{\{(\w+)\}\}")
# A fenced block: its info words (```rca, ```RCA, ```json rca) and its body.
_FENCE = re.compile(r"```[ \t]*([^\n`]*)\r?\n(.*?)```", re.S)


def is_staged(case: dict) -> bool:
    return any(k in case for k in STAGED_FIELDS)


def question_forms(case: dict) -> list[tuple[str, str]]:
    """(form, text): the specific question, then the vague one when the case has it."""
    forms = [("question", case["question"])]
    if case.get("question_vague"):
        forms.append(("question_vague", case["question_vague"]))
    return forms


def ask_order(case: dict, repeat: int) -> list[tuple[str, str, int]]:
    """(form, question, run) for one ask time: the forms take turns and swap their order every other run (specific,
    vague, vague, specific, ...), so neither form is always the one asked later."""
    forms = question_forms(case)
    order = []
    for n in range(repeat):
        order += [(form, text, n + 1) for form, text in (forms if n % 2 == 0 else forms[::-1])]
    return order


def question_with_format(question: str, answer_format: str | None) -> str:
    if not answer_format:
        return question
    return question + "\n\n" + ANSWER_FORMATS[answer_format]


def ask_times(case: dict) -> list:
    """Seconds after the fault start to ask at; [None] = ask as soon as the case is ready."""
    value = case.get("ask_after_seconds")
    if value is None:
        return [None]
    return list(value) if isinstance(value, list) else [value]


def schedule(case: dict) -> list[tuple]:
    """The case's timed steps after injection, in order: ("undo", seconds) when fault_duration_seconds is set and
    ("ask", seconds or None) per ask time. An undo at the same second as an ask goes first."""
    events = [("ask", t) for t in ask_times(case)]
    if case.get("fault_duration_seconds") is not None:
        events.append(("undo", case["fault_duration_seconds"]))
    order = {"undo": 0, "ask": 1}
    return sorted(events, key=lambda e: (-1 if e[1] is None else e[1], order[e[0]]))


def check_case(case: dict, has_truth: bool) -> list[str]:
    """What is wrong with a case's fields (empty = runnable)."""
    problems = []
    for key in ("id", "cluster", "namespace", "question"):
        if not case.get(key):
            problems.append(f"no {key}")
    fmt = case.get("answer_format")
    if fmt and fmt not in ANSWER_FORMATS:
        problems.append(f"unknown answer_format {fmt!r}")
    if fmt and not has_truth:
        problems.append(f"answer_format {fmt} without truth.json")
    for t in ask_times(case):
        if t is not None and (isinstance(t, bool) or not isinstance(t, (int, float)) or t < 0):
            problems.append(f"ask_after_seconds holds {t!r}")
    if case.get("fault_start_at") not in (None, "inject", "setup"):
        problems.append(f"fault_start_at {case['fault_start_at']!r} is not inject or setup")
    if case.get("fault_start_at", "inject") == "inject" and case.get("ask_after_seconds") is not None and not case.get("inject_cmds"):
        problems.append("ask_after_seconds counts from the injection but there is no inject_cmds (fault_start_at: setup?)")
    if case.get("inject_wait") and not case.get("inject_cmds"):
        problems.append("inject_wait without inject_cmds")
    if case.get("fault_duration_seconds") is not None and not case.get("undo_cmds"):
        problems.append("fault_duration_seconds without undo_cmds")
    for key in ("setup_cmds", "inject_cmds", "undo_cmds", "cleanup_cmds"):
        if not isinstance(case.get(key, []), list):
            problems.append(f"{key} is not a list")
    before = case.get("not_right_after", [])
    if not isinstance(before, list) or not all(isinstance(x, str) and x for x in before):
        problems.append(f"not_right_after {before!r} is not a list of case ids")
    return problems + check_alert(case, has_truth)


def run_order(cases: list[tuple]) -> list[tuple]:
    """(case dir, case) in the order they run: as given, but a case goes before a case its not_right_after names where it
    would come right after it (the traces, logs and metrics one leaves behind are still in the other's window)."""
    out: list[tuple] = []
    for entry in cases:
        at = len(out)
        while at and out[at - 1][1].get("id") in (entry[1].get("not_right_after") or []):
            at -= 1
        out.insert(at, entry)
    return out


def check_alert(case: dict, has_truth: bool) -> list[str]:
    """What is wrong with a case's alert (empty when it has none)."""
    alert = case.get("alert")
    if alert is None:
        return []
    if not isinstance(alert, dict):
        return ["alert is not an object"]
    problems = [f"alert has unknown field {k!r}" for k in alert if k not in ALERT_FIELDS]
    for key in ("labels", "annotations", "match"):
        value = alert.get(key, {})
        if not isinstance(value, dict) or not all(isinstance(k, str) and isinstance(v, str) for k, v in value.items()):
            problems.append(f"alert {key} is not an object of strings")
    labels = alert.get("labels") if isinstance(alert.get("labels"), dict) else {}
    rule = alert.get("rule")
    if rule is not None and (not isinstance(rule, str) or not rule):
        problems.append("alert rule is not a name")
    if not labels.get("alertname") and not rule:
        problems.append("alert has neither labels.alertname nor rule")
    if rule and labels.get("alertname") and labels["alertname"] != rule:
        problems.append("alert labels.alertname is not its rule's name")
    for key in ("after_seconds", "fire_wait_seconds", "investigation_wait_seconds"):
        v = alert.get(key)
        if v is not None and (isinstance(v, bool) or not isinstance(v, (int, float)) or v < 0):
            problems.append(f"alert {key} holds {v!r}")
    if not has_truth:
        problems.append("alert without truth.json")
    return problems


# Kinds with no namespace: a cause of one of these is read through Prometheus and the cluster-wide reads whatever the
# alert's namespace.
CLUSTER_SCOPED_KINDS = frozenset({"node", "namespace", "persistentvolume", "storageclass", "clusterrole", "clusterrolebinding",
                                  "priorityclass", "runtimeclass", "customresourcedefinition", "volumeattachment"})


def alert_namespaces(case: dict) -> list[tuple[str, str]]:
    """(where, namespace) an investigation of the case's alert is limited to — the webhook takes the alert's namespace
    label for the investigator's token: the posted alert's label (the case's namespace unless labels give one; "" for
    none), and with a rule the namespace match picks the fired alert by."""
    alert = case.get("alert") or {}
    out = [("labels", str((alert.get("labels") or {}).get("namespace", case.get("namespace", ""))))]
    if alert.get("rule"):
        out.append(("match", str((alert.get("match") or {}).get("namespace", case.get("namespace", "")))))
    return out


def check_alert_scope(case: dict, truth: dict | None) -> list[str]:
    """A case whose alert would give the investigator a token for one namespace while a truth cause is in another: it
    could not read that cause. A cause of a kind with no namespace, and an alert with no namespace, are not held."""
    if not isinstance(case.get("alert"), dict) or not truth:
        return []
    problems = []
    for where, ns in alert_namespaces(case):
        if not ns:
            continue
        for tc in truth.get("causes") or []:
            kind, cause_ns, _ = split_resource(tc["resource"])
            if kind not in CLUSTER_SCOPED_KINDS and cause_ns and cause_ns != ns.lower():
                problems.append(f"alert {where} namespace {ns!r}, but cause {tc['resource']} is in {cause_ns!r}: "
                                "the investigator's token would read only the alert's namespace")
    return problems


def alert_name(case: dict) -> str:
    alert = case.get("alert") or {}
    return (alert.get("labels") or {}).get("alertname") or alert.get("rule") or ""


def alert_after(case: dict) -> float:
    """Seconds after the fault start a synthetic alert is posted: alert.after_seconds, else the case's first ask time."""
    alert = case.get("alert") or {}
    if alert.get("after_seconds") is not None:
        return alert["after_seconds"]
    first = ask_times(case)[0]
    return 0 if first is None else first


def fill_placeholders(obj, marks: dict):
    """A copy of obj with {{NAME}} replaced by marks[NAME]; a string that is only an unknown placeholder becomes None."""
    if isinstance(obj, dict):
        return {k: fill_placeholders(v, marks) for k, v in obj.items()}
    if isinstance(obj, list):
        return [fill_placeholders(v, marks) for v in obj]
    if isinstance(obj, str):
        whole = _PLACEHOLDER.fullmatch(obj)
        if whole:
            return marks.get(whole.group(1))
        return _PLACEHOLDER.sub(lambda m: marks.get(m.group(1)) or m.group(0), obj)
    return obj


def _fences(text: str) -> list[tuple[list[str], str, re.Match]]:
    return [([w for w in re.split(r"[^a-z0-9_-]+", m.group(1).lower()) if w], m.group(2), m) for m in _FENCE.finditer(text or "")]


def _loose(words: list[str], body: str) -> dict | None:
    """A ```json (or untagged) block's object when it holds causes or no_fault: what extract_block reads as loose."""
    if words not in ([], ["json"]):
        return None
    try:
        block = json.loads(body)
    except ValueError:
        return None
    return block if isinstance(block, dict) and ("causes" in block or "no_fault" in block) else None


def strip_blocks(text: str) -> str:
    """The text without its rca blocks and the loose blocks extract_block would read."""
    out, at = [], 0
    for words, body, m in _fences(text):
        if "rca" in words or _loose(words, body) is not None:
            out.append(text[at:m.start()])
            at = m.end()
    return "".join(out) + (text or "")[at:]


def extract_block(answer: str) -> tuple[dict | None, str]:
    """The last rca block of an answer — a fence whose info words hold rca in any case (```rca, ```RCA, ```json rca)
    — as (object, "ok"); with none, the last ```json (or untagged) block holding an object with causes or no_fault as
    (object, "loose"); else (None, "missing" | "invalid")."""
    fences = _fences(answer)
    tagged = [body for words, body, _ in fences if "rca" in words]
    if tagged:
        try:
            block = json.loads(tagged[-1])
        except ValueError:
            return None, "invalid"
        return (block, "ok") if isinstance(block, dict) else (None, "invalid")
    for words, body, _ in reversed(fences):
        block = _loose(words, body)
        if block is not None:
            return block, "loose"
    return None, "missing"


def parse_time(value) -> datetime | None:
    if not isinstance(value, str) or not value.strip():
        return None
    text = re.sub(r"\.\d+", "", value.strip()).replace("Z", "+00:00").replace("z", "+00:00")
    try:
        t = datetime.fromisoformat(text)
    except ValueError:
        return None
    return t if t.tzinfo else t.replace(tzinfo=timezone.utc)


def _kind(text: str | None) -> str | None:
    if not text:
        return None
    k = text.strip().lower().split(".")[0]
    return _KIND_ALIASES.get(k, k)


def _is_kind(part: str) -> bool:
    # a namespace is a lowercase DNS label: a dot ("deployments.apps") or a capital ("NetworkChaos") makes a kind
    return "." in part or part != part.lower() or _kind(part) in _KNOWN_KINDS


def normal_kind(value) -> str:
    """A cause kind as KINDS writes it: "ConfigChange", "config-change" and "Config change" are "config_change"."""
    text = re.sub(r"(?<=[a-z0-9])(?=[A-Z])", "_", str(value or "").strip())
    return re.sub(r"[\s_-]+", "_", text).strip("_").lower()


def split_resource(text: str) -> tuple[str | None, str | None, str]:
    """"Kind/namespace/name" → (kind, namespace, name); "Kind/name" → (kind, None, name); "namespace/name" (a first
    part that is no kind) → (None, namespace, name); "name" → (None, None, name)."""
    parts = [p.strip() for p in str(text).strip().split("/") if p.strip()]
    if len(parts) >= 3:
        return _kind(parts[0]), parts[1].lower(), "/".join(parts[2:]).lower()
    if len(parts) == 2:
        if _is_kind(parts[0]):
            return _kind(parts[0]), None, parts[1].lower()
        return None, parts[0].lower(), parts[1].lower()
    return None, None, (parts[0].lower() if parts else "")


def _segment(pattern: str) -> re.Pattern:
    # "*" = anything in one segment; "<new>", "<hash>" = a generated suffix.
    out = re.escape(pattern.lower()).replace(r"\*", "[^/]*")
    out = re.sub(r"\\<[^>]*\\>|<[^>]*>", "[a-z0-9-]+", out)
    return re.compile(out)


def resource_matches(pattern: str, answer: str) -> bool:
    """Whether an answer's resource is the truth's "Kind/namespace/name" (which may hold * and <...>). A part the answer
    leaves out (kind, namespace) is not held against it, except that a name of only "*" ("Node/*") is matched only by
    an answer that gives the kind: a bare name (a table, an index, a setting) is not a node."""
    pk, pns, pname = split_resource(pattern)
    ak, ans, aname = split_resource(answer)
    if not aname or not _segment(pname).fullmatch(aname):
        return False
    if not pname.strip("*") and not (pk and ak):
        return False
    if pk and ak and not _segment(pk).fullmatch(ak):
        return False
    if pns and ans and not _segment(pns).fullmatch(ans):
        return False
    return True


def canonical(text: str) -> str:
    """An answer's resource with its kind written out ("deploy/ns/x" → "deployment/ns/x")."""
    kind, ns, name = split_resource(text)
    return "/".join(p for p in (kind, ns, name) if p)


def _search_any(patterns, text: str) -> bool:
    """A truth's regular expressions, searched in the answer's text as written and with its kind written out."""
    forms = {text, canonical(text)}
    return any(re.search(p, f, re.I) for p in patterns or [] for f in forms)


def _is_truth_cause(tc: dict, resource: str) -> bool:
    return resource_matches(tc["resource"], resource) or _search_any(tc.get("accept_resources"), resource)


def _evidence(cause: dict, calls: list) -> tuple[list, list]:
    """(numbers that point at a call of this run that did not fail, the other numbers)."""
    good, bad = [], []
    for n in cause.get("evidence") or []:
        if isinstance(n, str) and n.strip().isdigit():
            n = int(n)
        if isinstance(n, int) and not isinstance(n, bool) and 1 <= n <= len(calls) and not calls[n - 1].get("failed"):
            good.append(n)
        else:
            bad.append(n)
    return good, bad


def _path(truth_path: list, answer_path: list) -> tuple[bool | None, list]:
    """Required hops in order: each one at a later place in the answer's path than the one before (greedy earliest
    match). Hops that are not required are only reported."""
    path = [str(p) for p in answer_path if p is not None]

    def hit(hop, text):
        return resource_matches(hop["resource"], text) or _search_any(hop.get("accept"), text)

    hops, at, ok = [], 0, True
    for hop in truth_path:
        if hop.get("required"):
            found = next((i for i in range(at, len(path)) if hit(hop, path[i])), None)
            if found is None:
                ok = False
            else:
                at = found + 1
        else:
            found = next((i for i, p in enumerate(path) if hit(hop, p)), None)
        hops.append({"role": hop.get("role"), "resource": hop["resource"], "required": bool(hop.get("required")), "at": found})
    required = [h for h in hops if h["required"]]
    return (ok if required else None), hops


def score_rca(answer: str, truth: dict, calls: list) -> dict:
    """Score an answer's rca block against a filled truth (README "The answer block"): every truth cause named with an
    accepted kind, no decoy named as a cause (a control: no_fault and no cause other than kind none), less for each
    extra cause — the same resource named again under a kind its truth cause does not take is one too — and more than
    EXTRAS_ALLOWED extras fail. started_at, the path and the evidence are reported next to it, not folded into pass;
    pass_grounded is pass with every named cause pointing at a call that answered."""
    return score_block(*extract_block(answer), truth, calls)


def block_of_result(result) -> tuple[dict | None, str]:
    """An investigation's stored `result` (the rca block the server took off the report while
    features.alertInvestigation.evidenceCheck or ledger is on) as (block, status) for score_block: each evidence
    {call, tool} back to its call number. (None, "missing") when the row has no result."""
    if not isinstance(result, dict):
        return None, "missing"
    status = result.get("status") or "ok"
    if status != "ok":
        return None, status
    causes = []
    for c in result.get("causes") or []:
        if isinstance(c, dict):
            calls = [e.get("call") for e in c.get("evidence") or [] if isinstance(e, dict)]
            causes.append({**c, "evidence": [n for n in calls if isinstance(n, int)]})
    return {"no_fault": result.get("no_fault"), "causes": causes, "path": result.get("path") or [],
            "ruled_out": result.get("ruled_out") or []}, "ok"


def likely_cause(report: str) -> tuple[str, str]:
    """The report's "Likely cause" section (the investigator's four headings, investigation/prompt.py) and
    "likely_cause"; the whole report and "whole" when it has no such heading. An rca block is left out."""
    text = strip_blocks(report or "")
    heads = list(_HEADING.finditer(text))
    for i, m in enumerate(heads):
        if m.group(1).strip().rstrip(":").lower() == "likely cause":
            end = heads[i + 1].start() if i + 1 < len(heads) else len(text)
            return text[m.end():end].strip(), "likely_cause"
    return text.strip(), "whole"


def _text_names(text: str) -> set[str]:
    """What in a text can name an object: each run of name characters, and its last part after a slash (a part of a URL
    path, "/api/v1/cart", is found by no _name_at, so it names nothing)."""
    out = set()
    for m in _TOKEN.finditer(text):
        t = m.group(0).strip("./-")
        if t:
            out.add(t)
            out.add(t.rsplit("/", 1)[-1])
    return out


def _sentences(text: str) -> list[str]:
    """The text's sentences; a line or a bullet is one too."""
    out = []
    for sentence in _SENTENCE_BREAK.split(text or ""):
        sentence = _BULLET.sub("", sentence).strip()
        if sentence:
            out.append(sentence)
    return out


def _clauses(sentence: str, spans: list) -> list[tuple[int, int]]:
    """(start, end) of a sentence's clauses, parted at _CLAUSE_BREAK; a part that names no object (spans: (start, end,
    name) of the objects named) goes on the part before it: "restarted and caused the errors", "busier but unrelated",
    "checkout and the nodes are fine"."""
    parts, at = [], 0
    for m in _CLAUSE_BREAK.finditer(sentence):
        parts.append((at, m.start()))
        at = m.end()
    parts.append((at, len(sentence)))
    out: list[tuple[int, int]] = []
    for start, end in parts:
        if out and not any(start <= a and b <= end for a, b, _ in spans):
            out[-1] = (out[-1][0], end)
        else:
            out.append((start, end))
    return out


def _name_at(name: str) -> re.Pattern:
    # a name ends at a character that cannot be part of it: an ASCII letter, digit, "_" or "-" continues it, Hangul does
    # not, so "storefront-config가" holds the name and its particle
    return re.compile(r"(?<![A-Za-z0-9_./-])" + re.escape(name) + r"(?![A-Za-z0-9_-])")


def _nearest(start: int, end: int, spans: list, after_first: bool = False):
    """The name of spans ((start, end, name)) nearest before start, else the one nearest after end; after_first: after,
    else before. None when spans is empty."""
    before = [s for s in spans if s[1] <= start]
    after = [s for s in spans if s[0] >= end]
    b = max(before, key=lambda s: s[1])[2] if before else None
    a = min(after, key=lambda s: s[0])[2] if after else None
    return (a or b) if after_first else (b or a)


def _kind_spans(text: str) -> list[tuple[int, int, str]]:
    """(start, end, kind) of the kind words in text, one kind to a stretch of it: at one place the longer match, then
    KIND_WORDS' order ("memory limit" is oom, not oom and resource_limit)."""
    found = sorted(((m.start(), m.end(), n, kind) for n, (kind, pattern) in enumerate(KIND_WORDS.items())
                    for m in re.finditer(pattern, text, re.I) if m.end() > m.start()), key=lambda x: (x[0], x[0] - x[1], x[2]))
    out, upto = [], -1
    for start, end, _, kind in found:
        if start >= upto:
            out.append((start, end, kind))
            upto = end
    return out


def _whose(at: int, places: dict) -> list:
    """The causes a kind word at `at` speaks of: the cause named nearest before it ("images has a bad image"), else the
    one named nearest after it ("a bad image in images")."""
    before = {i: max(e for _, e in spans if e <= at) for i, spans in places.items() if any(e <= at for _, e in spans)}
    if before:
        best = max(before.values())
        return [i for i, e in before.items() if e == best]
    after = {i: min(b for b, _ in spans if b >= at) for i, spans in places.items() if any(b >= at for b, _ in spans)}
    best = min(after.values(), default=None)
    return [i for i, b in after.items() if b == best]


def _whom(at: int, here: set, places: dict) -> list:
    """The causes a kind word at `at` speaks of: the one its clause names (here), else _whose."""
    return sorted(here) if len(here) == 1 else _whose(at, places)


def score_text(report: str, truth: dict) -> dict:
    """Score a report's words against a filled truth when it has no rca block (the alert path with v0.7.9's switches
    off), clause by clause in its "Likely cause" section (else the whole report). A sentence — a line or a bullet is one
    too — parts into clauses at _CLAUSE_BREAK, a part naming no object going on the one before it. In a clause, each
    NO_FAULT_WORDS or CLEAR_WORDS rules out the one object named nearest before it (else after it); the other objects
    named there stay. NO_FAULT_WORDS in a clause, or in its part before or after a colon, naming no object and not
    speaking of the others (OTHERS_WORDS: "no problems elsewhere") is the report saying there is no fault (no_fault).
    A blame word blames one object: CAUSE_WORDS and FAIL_WORDS the one named nearest before them, CAUSED_BY_WORDS the
    one nearest after; FAIL_WORDS blame no object of the truth's path, whose failure is the symptom.

    A fault case passes when the report does not say there is no fault, names each truth cause — its resource or an
    accept_resources form — somewhere it is not ruled out, gives it a word of its kind or an accepted kind
    (KIND_WORDS; for a ConfigMap or Secret cause a change, CHANGE_WORDS, is config_change), blames no decoy and holds no
    more than EXTRAS_ALLOWED extras. A kind word counts in a sentence naming a cause, outside the clauses whose every
    object is ruled out and outside the ruling-out words, with the objects' own names taken out; one stretch of words
    is one kind; it speaks of one cause: the one its clause names, else the one named nearest before it, else after
    it ("endpoints" a hop's accept takes stays a word). An extra, as in the block, is each other object (a decoy or a Kind/name, not one of the truth's causes, also_ok
    or path) the section names without ruling it out, and each kind word a cause is given beyond its own kinds and one
    more (the symptom's: "throttled, so it is slow"); each costs EXTRA_CAUSE_PENALTY.

    A control passes when the report says there is no fault and blames no decoy and no other Kind/name object
    (suspects). Weaker than the block's check; it is there so a run with the block and one without compare on one
    measure."""
    text, section = likely_cause(report)
    truth_causes = truth.get("causes") or []
    decoys, also_ok, path = truth.get("decoys") or [], truth.get("also_ok") or [], truth.get("path") or []

    def of_truth(n):
        return any(_is_truth_cause(tc, n) for tc in truth_causes)

    def decoy(n):
        return not of_truth(n) and any(resource_matches(d["resource"], n) for d in decoys)

    def in_truth(n):  # a cause, a part of one, or a hop of its path (the symptom named beside its cause)
        return (of_truth(n) or any(resource_matches(a, n) for a in also_ok)
                or any(resource_matches(h["resource"], n) or _search_any(h.get("accept"), n) for h in path))

    def other_object(n):
        return not in_truth(n) and (decoy(n) or ("/" in n and split_resource(n)[0] in _KNOWN_KINDS))

    def own_name(n):  # a name its object's words are taken out of before kind words are read; not a word a hop's accept takes
        return ("/" in n or of_truth(n) or decoy(n) or any(resource_matches(a, n) for a in also_ok)
                or any(resource_matches(h["resource"], n) for h in path))

    def config_cause(i):
        return split_resource(truth_causes[i]["resource"])[0] in CONFIG_KINDS

    no_fault = False
    named_as = {i: set() for i in range(len(truth_causes))}
    ruled_out = {i: False for i in range(len(truth_causes))}
    said = {i: set() for i in range(len(truth_causes))}
    extra_objects, decoys_named, decoys_ruled_out, suspects = set(), set(), set(), set()
    for sentence in _sentences(text):
        objects = {n for n in _text_names(sentence) if in_truth(n) or other_object(n)}
        spans = sorted((m.start(), m.end(), n) for n in objects for m in _name_at(n).finditer(sentence))
        live_by_clause, places = [], {}
        cleared_text = sentence
        for cs, ce in _clauses(sentence, spans):
            clause = sentence[cs:ce]
            here = [(a, b, n) for a, b, n in spans if cs <= a and b <= ce]
            clears = [m for w in (NO_FAULT_WORDS, CLEAR_WORDS) for m in w.finditer(clause)]
            # "No fault found: thumbnailer restarted once" says so for the whole report: the part before a colon names nothing
            part_at = 0
            for part in clause.split(":"):
                inside = [s for s in here if cs + part_at <= s[0] and s[1] <= cs + part_at + len(part)]
                if NO_FAULT_WORDS.search(part) and not inside and not OTHERS_WORDS.search(part):
                    no_fault = True
                part_at += len(part) + 1
            out = {_nearest(cs + m.start(), cs + m.end(), here) for m in clears} - {None}
            for m in clears:
                cleared_text = cleared_text[:cs + m.start()] + " " * (m.end() - m.start()) + cleared_text[cs + m.end():]
            live = [s for s in here if s[2] not in out]
            for n in out:
                for i, tc in enumerate(truth_causes):
                    if _is_truth_cause(tc, n):
                        ruled_out[i] = True
                if decoy(n):
                    decoys_ruled_out.add(n)
            in_clears = [(cs + m.start(), cs + m.end()) for m in clears]
            for words, after_first, fails in ((CAUSE_WORDS, False, False), (CAUSED_BY_WORDS, True, False), (FAIL_WORDS, False, True)):
                for m in words.finditer(clause):
                    at, upto = cs + m.start(), cs + m.end()
                    if any(a <= at < b for a, b in in_clears):
                        continue  # "not the cause", "did not break"
                    n = _nearest(at, upto, live, after_first)
                    if n is None or of_truth(n) or (fails and in_truth(n)):
                        continue
                    if decoy(n):
                        decoys_named.add(n)
                    elif other_object(n):
                        suspects.add(n)
            extra_objects |= {n for _, _, n in live if other_object(n)}
            causes_here = set()
            for a, b, n in live:
                for i, tc in enumerate(truth_causes):
                    if _is_truth_cause(tc, n):
                        named_as[i].add(n)
                        causes_here.add(i)
                        places.setdefault(i, []).append((a, b))
            if live or not here:  # a clause whose every object is ruled out says nothing of a cause's kind
                live_by_clause.append((cs, ce, causes_here))
        if not places:
            continue
        words = _blank(cleared_text, {n for n in objects if own_name(n)})
        for cs, ce, here in live_by_clause:
            for a, _, kind in _kind_spans(words[cs:ce]):
                for i in _whom(cs + a, here, places):
                    said[i].add(kind)
            for m in CHANGE_WORDS.finditer(words[cs:ce]):
                for i in _whom(cs + m.start(), here, places):
                    if config_cause(i):
                        said[i].add("config_change")
    causes, extras = [], len(extra_objects)
    for i, tc in enumerate(truth_causes):
        own = {tc["kind"], *(tc.get("accept_kinds") or [])}
        other = sorted(said[i] - own)
        extras += max(0, len(other) - 1)
        kind_found = bool(said[i] & own)
        causes.append({"resource": tc["resource"], "kind": tc["kind"], "resource_found": bool(named_as[i]),
                       "kind_found": kind_found, "found": bool(named_as[i]) and kind_found, "other_kinds": other,
                       "named_as": sorted(named_as[i])[:3], "ruled_out": ruled_out[i] and not named_as[i]})
    if truth.get("control"):
        ok, extras = no_fault and not decoys_named and not suspects, 0
        score = 1.0 if ok else 0.0
    else:
        ok = (bool(causes) and not no_fault and all(c["found"] for c in causes) and not decoys_named
              and extras <= EXTRAS_ALLOWED)
        score = max(0.0, 1.0 - EXTRA_CAUSE_PENALTY * extras) if ok else 0.0
    return {"section": section, "pass": ok, "score": score, "no_fault": no_fault, "causes": causes, "extras": extras,
            "extra_objects": sorted(extra_objects), "decoys_named": sorted(decoys_named),
            "decoys_ruled_out": sorted(decoys_ruled_out - decoys_named), "suspects": sorted(suspects)}


def _blank(text: str, names) -> str:
    """text with each name written over in spaces, so the places of the other words stay."""
    for n in sorted(names, key=len, reverse=True):
        text = _name_at(n).sub(lambda m: " " * len(m.group(0)), text)
    return text


def score_block(block: dict | None, status: str, truth: dict, calls: list) -> dict:
    """score_rca for a block already read (from an answer, or an investigation's stored result)."""
    out = {"block": status, "pass": False, "pass_grounded": False, "score": 0.0, "no_fault": None, "causes": [], "extras": [],
           "decoys_taken": [], "also_ok_named": [], "time_ok": None, "path_ok": None, "path": [], "ungrounded": 0,
           "bad_evidence": [], "malformed": 0}
    if block is None:
        return out
    no_fault = block.get("no_fault") is True
    out["no_fault"] = no_fault
    answer_causes = []
    for c in block.get("causes") or []:
        if isinstance(c, dict) and isinstance(c.get("resource"), str) and c["resource"].strip():
            answer_causes.append(c)
        else:
            out["malformed"] += 1
    real = [c for c in answer_causes if normal_kind(c.get("kind")) != "none"]
    truth_causes = truth.get("causes") or []

    # A truth cause's answer is the first answer cause naming it with an accepted kind, else the first naming it.
    picks = []
    for tc in truth_causes:
        kinds = {normal_kind(k) for k in (tc["kind"], *(tc.get("accept_kinds") or []))}
        named = [i for i, c in enumerate(real) if _is_truth_cause(tc, c["resource"])]
        right = [i for i in named if normal_kind(real[i].get("kind")) in kinds]
        picks.append((tc, named, right))
    used = {i for _, named, right in picks for i in (right or named[:1])}

    # Each other answer cause is the same resource again, a part of a truth cause (also_ok), a decoy or an extra.
    for i, c in enumerate(real):
        r = c["resource"]
        if i in used:
            continue
        if any(_is_truth_cause(tc, r) for tc in truth_causes):
            out["extras"].append(r)
        elif any(resource_matches(a, r) for a in truth.get("also_ok") or []):
            out["also_ok_named"].append(r)
        elif any(resource_matches(d["resource"], r) for d in truth.get("decoys") or []):
            out["decoys_taken"].append(r)
        else:
            out["extras"].append(r)
        good, bad = _evidence(c, calls)
        out["bad_evidence"] += bad
        out["ungrounded"] += 0 if good else 1

    start = parse_time(truth.get("fault_start"))
    tolerance = truth.get("time_tolerance_seconds") or DEFAULT_TIME_TOLERANCE_SECONDS
    times = []
    for tc, named_at, right_at in picks:
        named = [real[i] for i in named_at]
        right = [real[i] for i in right_at]
        pick = (right or named or [None])[0]
        row = {"resource": tc["resource"], "kind": tc["kind"], "found": bool(right), "resource_found": bool(named),
               "answer_resource": pick and pick["resource"], "answer_kind": pick and pick.get("kind"),
               "time_ok": None, "grounded": None}
        if pick:
            good, bad = _evidence(pick, calls)
            out["bad_evidence"] += bad
            out["ungrounded"] += 0 if good else 1
            row["grounded"] = bool(good)
            if start is not None:
                t = parse_time(pick.get("started_at"))
                row["time_ok"] = t is not None and abs((t - start).total_seconds()) <= tolerance
                times.append(row["time_ok"])
        out["causes"].append(row)
    if times:
        out["time_ok"] = all(times)

    out["path_ok"], out["path"] = _path(truth.get("path") or [], block.get("path") or [])

    if truth.get("control"):
        out["pass"] = no_fault and not real
    else:
        out["pass"] = ((not no_fault) and bool(truth_causes) and all(r["found"] for r in out["causes"]) and not out["decoys_taken"]
                       and len(out["extras"]) <= EXTRAS_ALLOWED)
    if out["pass"]:
        out["score"] = max(0.0, 1.0 - EXTRA_CAUSE_PENALTY * len(out["extras"]))
    out["pass_grounded"] = out["pass"] and out["ungrounded"] == 0
    return out
