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

# What an extra cause (not a truth cause, not in also_ok, not a decoy) takes off a right answer's 1.0.
EXTRA_CAUSE_PENALTY = 0.25
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

# The free-text check of a report (score_text): words that say a cause of each kind, and words that say there is no
# fault. Broad on purpose — the check only has to read the same way with and without the rca block.
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
    "node": r"\bnode\b|notready|not ready|cordon|taint|노드",
    "dependency_down": r"no (ready )?endpoints|scaled (down|to (0|zero))|replicas:? 0|connection refused|unavailable|\bdown\b|엔드포인트|중단",
    "dependency_slow": r"slow|latency|timeout|timed out|느려|지연",
    "storage": r"\bpvc|persistentvolume|volume|disk|storage|볼륨|디스크|스토리지",
}
NO_FAULT_WORDS = re.compile(
    r"no (current |ongoing |active |real )?(fault|problem|issue|outage|failure|incident)s?\b|nothing (is |was )?(wrong|broken|failing)"
    r"|not (a|an) (fault|problem|issue|incident)|no (action|fix) (is )?(needed|required)"
    r"|(working|running|behaving) (normally|as expected)|expected behaviou?r|false (positive|alarm)"
    r"|정상(적|입니다|이다|으로|임)|문제(가|는)? 없|이상(이|은)? 없|장애(가|는)? 없", re.I)
_HEADING = re.compile(r"^[ \t]{0,3}#{1,6}[ \t]+(.+?)[ \t#]*$", re.M)  # an ATX heading: a space after the #s
_TOKEN = re.compile(r"[A-Za-z0-9][A-Za-z0-9._/-]*")

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
_PLACEHOLDER = re.compile(r"\{\{(\w+)\}\}")
_BLOCK = re.compile(r"```[ \t]*rca[ \t]*\r?\n(.*?)```", re.S)


def is_staged(case: dict) -> bool:
    return any(k in case for k in STAGED_FIELDS)


def question_forms(case: dict) -> list[tuple[str, str]]:
    """(form, text): the specific question, then the vague one when the case has it."""
    forms = [("question", case["question"])]
    if case.get("question_vague"):
        forms.append(("question_vague", case["question_vague"]))
    return forms


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
    return problems + check_alert(case, has_truth)


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


def extract_block(answer: str) -> tuple[dict | None, str]:
    """The last ```rca block of an answer as (object, "ok"), or (None, "missing" | "invalid")."""
    blocks = _BLOCK.findall(answer or "")
    if not blocks:
        return None, "missing"
    try:
        block = json.loads(blocks[-1])
    except ValueError:
        return None, "invalid"
    return (block, "ok") if isinstance(block, dict) else (None, "invalid")


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


def split_resource(text: str) -> tuple[str | None, str | None, str]:
    """"Kind/namespace/name" → (kind, namespace, name); "Kind/name" → (kind, None, name); "name" → (None, None, name)."""
    parts = [p.strip() for p in str(text).strip().split("/") if p.strip()]
    if len(parts) >= 3:
        return _kind(parts[0]), parts[1].lower(), "/".join(parts[2:]).lower()
    if len(parts) == 2:
        return _kind(parts[0]), None, parts[1].lower()
    return None, None, (parts[0].lower() if parts else "")


def _segment(pattern: str) -> re.Pattern:
    # "*" = anything in one segment; "<new>", "<hash>" = a generated suffix.
    out = re.escape(pattern.lower()).replace(r"\*", "[^/]*")
    out = re.sub(r"\\<[^>]*\\>|<[^>]*>", "[a-z0-9-]+", out)
    return re.compile(out)


def resource_matches(pattern: str, answer: str) -> bool:
    """Whether an answer's resource is the truth's "Kind/namespace/name" (which may hold * and <...>). A part the answer
    leaves out (kind, namespace) is not held against it."""
    pk, pns, pname = split_resource(pattern)
    ak, ans, aname = split_resource(answer)
    if not aname or not _segment(pname).fullmatch(aname):
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
    extra cause. started_at, the path and the evidence are reported next to it, not folded into pass."""
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
    text = _BLOCK.sub("", report or "")
    heads = list(_HEADING.finditer(text))
    for i, m in enumerate(heads):
        if m.group(1).strip().rstrip(":").lower() == "likely cause":
            end = heads[i + 1].start() if i + 1 < len(heads) else len(text)
            return text[m.end():end].strip(), "likely_cause"
    return text.strip(), "whole"


def _text_names(text: str) -> set[str]:
    """What in a text can name an object: each run of name characters, and its last part after a slash."""
    out = set()
    for t in _TOKEN.findall(text):
        t = t.strip("./-")
        if t:
            out.add(t)
            out.add(t.rsplit("/", 1)[-1])
    return out


def _named_in_text(pattern: str, name: str) -> bool:
    # A name that is only a wildcard ("Node/*") names something only when the text gives the kind too.
    if not split_resource(pattern)[2].strip("*") and "/" not in name:
        return False
    return resource_matches(pattern, name)


def score_text(report: str, truth: dict) -> dict:
    """Score a report's words against a filled truth when it has no rca block (the alert path with v0.7.9's switches
    off): in its "Likely cause" section (else the whole report) each truth cause named — its resource or an
    accept_resources form — with a word of its kind or an accepted kind (KIND_WORDS); a control passes when that section
    says there is no fault (NO_FAULT_WORDS). Decoys named there are listed, not held against it: a report names what it
    ruled out in the same words. Weaker than the block's check; it is there so a run with the block and one without
    compare on one measure."""
    text, section = likely_cause(report)
    names = _text_names(text)
    no_fault = bool(NO_FAULT_WORDS.search(text))
    causes = []
    truth_causes = truth.get("causes") or []
    truth_names = {n for n in names if any(_is_truth_cause(tc, n) for tc in truth_causes)}
    # the kind is read with the cause's own names taken out, so "settings-b" alone does not say "setting"
    rest = text
    for n in sorted(truth_names, key=len, reverse=True):
        rest = re.sub(r"(?<![\w./-])" + re.escape(n) + r"(?![\w-])", " ", rest)
    for tc in truth_causes:
        named = sorted(n for n in names if _is_truth_cause(tc, n))
        kinds = [tc["kind"], *(tc.get("accept_kinds") or [])]
        kind_words = [k for k in kinds if k in KIND_WORDS and re.search(KIND_WORDS[k], rest, re.I)]
        causes.append({"resource": tc["resource"], "kind": tc["kind"], "resource_found": bool(named),
                       "kind_found": bool(kind_words), "found": bool(named) and bool(kind_words), "named_as": named[:3]})
    decoys = sorted({n for n in names - truth_names for d in truth.get("decoys") or [] if _named_in_text(d["resource"], n)})
    if truth.get("control"):
        ok = no_fault
    else:
        ok = bool(causes) and all(c["found"] for c in causes)
    return {"section": section, "pass": ok, "score": 1.0 if ok else 0.0, "no_fault": no_fault, "causes": causes,
            "decoys_named": decoys}


def score_block(block: dict | None, status: str, truth: dict, calls: list) -> dict:
    """score_rca for a block already read (from an answer, or an investigation's stored result)."""
    out = {"block": status, "pass": False, "score": 0.0, "no_fault": None, "causes": [], "extras": [], "decoys_taken": [],
           "also_ok_named": [], "time_ok": None, "path_ok": None, "path": [], "ungrounded": 0, "bad_evidence": [],
           "malformed": 0}
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
    real = [c for c in answer_causes if str(c.get("kind", "")).lower() != "none"]
    truth_causes = truth.get("causes") or []

    # Each answer cause is a truth cause, a part of one (also_ok), a decoy or an extra — in that order.
    for c in real:
        r = c["resource"]
        if any(_is_truth_cause(tc, r) for tc in truth_causes):
            continue
        if any(resource_matches(a, r) for a in truth.get("also_ok") or []):
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
    for tc in truth_causes:
        named = [c for c in real if _is_truth_cause(tc, c["resource"])]
        kinds = {tc["kind"], *(tc.get("accept_kinds") or [])}
        right = [c for c in named if str(c.get("kind", "")).lower() in kinds]
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
        out["pass"] = (not no_fault) and bool(truth_causes) and all(r["found"] for r in out["causes"]) and not out["decoys_taken"]
    if out["pass"]:
        out["score"] = max(0.0, 1.0 - EXTRA_CAUSE_PENALTY * len(out["extras"]))
    return out
