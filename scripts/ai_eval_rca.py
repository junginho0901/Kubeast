"""Hard cases for scripts/ai-eval.py: the answer block (rca_block_v0), its scoring, the per-run truth copy, the order
of a case's steps and the case checks. Pure functions only — nothing here reaches a cluster or the API, so
scripts/test_ai_eval_rca.py checks it with made-up answers.
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
                 "fault_duration_seconds", "undo_cmds", "ask_after_seconds", "cooldown_seconds")

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
    return problems


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
    block, status = extract_block(answer)
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
