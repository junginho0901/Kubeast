"""Checks the hard cases in evals/ai-hard and the OpenTelemetry demo's alert rules (deploy/kind/otel-demo-rules.json)
without a cluster: every case loads with no field problem, --list shows the cases and no truth, a hidden case shows
only in the total, each truth.json scores a right answer as right and a decoy as wrong, and the rules file has the
shape Prometheus reads.

  python3 -m pytest -q scripts/test_ai_eval_cases.py
  python3 scripts/test_ai_eval_cases.py        # the same checks without pytest
"""
import fnmatch
import importlib.util
import json
import re
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path

HERE = Path(__file__).resolve().parent
ROOT = HERE.parent
HARD = ROOT / "evals" / "ai-hard"
RULES = ROOT / "deploy" / "kind" / "otel-demo-rules.json"
SECOND_CLUSTER = ROOT / "deploy" / "kind" / "second-cluster.yaml"
DEMO_SCRIPT = HERE / "kind-otel-demo.sh"

sys.path.insert(0, str(HERE))

import ai_eval_rca as rca  # noqa: E402


def _load_ai_eval():
    spec = importlib.util.spec_from_file_location("ai_eval", HERE / "ai-eval.py")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


AI_EVAL = _load_ai_eval()

GROUPS = {"hidden_cause", "trap", "control", "past"}
ROLES = {"cause", "via", "symptom"}
PLACEHOLDERS = {"SETUP_TIME", "INJECT_TIME", "UNDO_TIME"}
MARKS = {"SETUP_TIME": "2026-01-01T00:00:00Z", "INJECT_TIME": "2026-01-01T00:05:00Z", "UNDO_TIME": "2026-01-01T00:10:00Z"}
CALLS = [{"tool": "timeline", "failed": False}, {"tool": "k8s_get_resources", "failed": False}]
# Words in what a case applies that would tell the model the answer (README "Hard cases").
ANSWER_WORDS = re.compile(r"\b(fault|faulty|broken|decoy|truth|inject|injected|injection|chaos|bug)\b", re.I)


def all_cases() -> list:
    cases, problems = AI_EVAL.load_cases(HARD, [], True)
    assert problems == [], problems
    return cases


def truth_of(case_dir: Path) -> dict:
    return json.loads((case_dir / "truth.json").read_text())


def as_answered(resource: str) -> str:
    """A truth resource as an answer would write it: a generated suffix and a wildcard given real letters."""
    return re.sub(r"<[^>]*>", "7f9c4", resource).replace("*", "kind-worker")


def block(causes, no_fault=False, path=()) -> str:
    body = {"no_fault": no_fault, "causes": causes, "path": list(path), "ruled_out": []}
    return "What I looked at.\n\n```rca\n" + json.dumps(body) + "\n```\n"


def cause(resource, kind, started_at=None):
    return {"resource": resource, "kind": kind, "started_at": started_at, "evidence": [1]}


CLUSTER_KINDS = {"Node", "Namespace", "PersistentVolume", "StorageClass", "ClusterRole", "ClusterRoleBinding"}


def resource_form(resource: str) -> bool:
    """Kind/namespace/name, or Kind/name for a kind of the cluster."""
    parts = resource.split("/")
    return all(parts) and (len(parts) == 3 or (len(parts) == 2 and parts[0] in CLUSTER_KINDS))


def test_every_hard_case_loads_with_no_field_problem():
    cases = all_cases()
    folders = sorted(d.name for d in HARD.iterdir() if (d / "case.json").exists())
    assert [d.name for d, _ in cases] == folders and len(cases) == 16
    namespaces = [c["namespace"] for _, c in cases]
    assert len(set(namespaces)) == len(namespaces), "two cases share a namespace"
    for d, c in cases:
        assert c["id"] == d.name
        assert rca.is_staged(c) and c["answer_format"] == "rca_block_v0", d.name
        assert c["group"] in GROUPS, d.name
        assert c["question"] and c["question_vague"] and c["question"] != c["question_vague"], d.name
        assert isinstance(c.get("hidden", False), bool), d.name
        assert (d / "setup.yaml").exists() and (d / "truth.json").exists() and (d / "NOTES.md").exists(), d.name
        steps = " ".join(s for key in ("setup_cmds", "inject_cmds", "undo_cmds", "cleanup_cmds") for s in c.get(key, []))
        for name in re.findall(r"\$CASE_DIR/([\w./-]+)", steps):
            assert (d / name).exists(), f"{d.name}: {name} named in a step is not in the folder"


def test_hidden_cases_run_only_with_the_flag():
    every = {d.name for d, _ in all_cases()}
    hidden = {d.name for d, c in all_cases() if c.get("hidden")}
    shown, problems = AI_EVAL.load_cases(HARD, [], False)
    assert problems == [] and hidden
    assert {d.name for d, _ in shown} == every - hidden


def _list(*extra) -> subprocess.CompletedProcess:
    return subprocess.run([sys.executable, "-I", str(HERE / "ai-eval.py"), "--cases", str(HARD), "--list", *extra],
                          capture_output=True, text=True, timeout=60)


def test_list_shows_every_case_and_no_truth():
    shown, every = _list(), _list("--hidden")
    assert shown.returncode == 0 and every.returncode == 0, shown.stdout + shown.stderr + every.stderr
    assert "problem:" not in every.stdout
    for d, c in all_cases():
        assert f"| {c['id']} |" in every.stdout
        assert (f"| {c['id']} |" in shown.stdout) == (not c.get("hidden")), d.name
        truth = truth_of(d)
        told = [truth["symptom"]] + [tc["resource"] for tc in truth["causes"]]
        told += [x["resource"] for x in truth["decoys"]] + [x["why"] for x in truth["decoys"]]
        for text in told:
            assert text not in every.stdout + every.stderr, f"{d.name}: --list printed {text!r}"


def test_hidden_results_show_only_a_total_of_two_or_more():
    truth = {"control": False, "causes": [{"resource": "ConfigMap/shop-x/settings", "kind": "config_change"}]}
    scored = rca.score_rca(block([cause("ConfigMap/shop-x/settings", "config_change")]), truth, CALLS)
    row = {"title": "t", "form": "question", "ask_after": 300, "run": 1, "missing": [], "forbidden": [],
           "tools_missing": [], "calls": CALLS, "tokens": 0, "seconds": 1.0, "error": None, "rca": scored, "model": "m"}
    seen = dict(row, id="04_seen", hidden=False, **{"pass": True, "pass_grounded": True})
    kept = [dict(row, id="08_kept", hidden=True, **{"pass": False}), dict(row, id="08_kept", hidden=True, run=2, **{"pass": True})]
    other = dict(row, id="15_other", hidden=True, **{"pass": True})
    text = AI_EVAL.table([seen, *kept])
    assert "04_seen" in text and "08_kept" not in text
    assert "숨김 사례 1개: 결과는 JSON에만" in text and "1/2" not in text
    assert "정답 1/1 (근거 있는 정답 1) · 숨김 빼고 · 모델 m" in text
    text = AI_EVAL.table([seen, *kept, other])
    assert "숨김 사례 2개: 정답 2/3" in text and "15_other" not in text
    for only_hidden in (kept, kept[:1], [other]):
        text = AI_EVAL.table(only_hidden, {"user": "read", "namespace_suffix": None, "before": {"default": {"investigations": 0, "inbox": 0}}})
        assert "숨김 사례만 든 실행: 결과는 JSON에만 · 모델 m" in text, text
        assert not re.search(r"정답 \d|\d/[12]\b", text) and "08_kept" not in text and "15_other" not in text, text


def test_every_hard_case_runs_under_a_namespace_suffix():
    root = Path(tempfile.mkdtemp(prefix="ai-eval-suffix-"))
    try:
        for d, c in all_cases():
            ns = c["namespace"]
            new_dir, new = AI_EVAL.with_suffix(d, c, "zz9", root)
            assert new_dir != d and new["namespace"] == f"{ns}-zz9" and new["id"] == c["id"], d.name
            for form in ("question", "question_vague"):  # 01, 07 and 10 ask about otel-demo, not their own namespace
                assert (f"{ns}-zz9" in new[form]) == (ns in c[form]), (d.name, form)
            whole = re.compile(r"(?<![A-Za-z0-9-])" + re.escape(ns) + r"(?![A-Za-z0-9-])")
            for f in sorted(new_dir.iterdir()):
                if f.suffix in (".json", ".yaml"):
                    assert not whole.search(f.read_text()), f"{d.name}/{f.name} still names {ns}"
            truth = json.loads((d / "truth.json").read_text())
            moved = rca.fill_placeholders(json.loads((new_dir / "truth.json").read_text()), MARKS)
            if truth["control"]:
                assert rca.score_rca(block([], no_fault=True), moved, CALLS)["pass"], d.name
                continue
            right = [cause(tc["resource"], tc["kind"], moved["fault_start"]) for tc in moved["causes"]]
            assert rca.score_rca(block(right), moved, CALLS)["pass"], d.name
            assert all(tc["resource"].split("/")[1] != ns for tc in moved["causes"]), d.name
            old = [cause(tc["resource"], tc["kind"]) for tc in truth["causes"] if tc["resource"].split("/")[1] == ns]
            if old and not any(tc.get("accept_resources") for tc in moved["causes"]):
                assert not rca.score_rca(block(old), moved, CALLS)["pass"], d.name
    finally:
        shutil.rmtree(root, ignore_errors=True)


def test_each_truth_fits_its_case_and_the_scorer():
    for d, c in all_cases():
        truth = truth_of(d)
        raw = (d / "truth.json").read_text()
        assert truth["id"] == c["id"], d.name
        assert truth["control"] == (c["group"] == "control"), d.name
        for name in re.findall(r"\{\{(\w+)\}\}", raw):
            assert name in PLACEHOLDERS, f"{d.name}: {{{{{name}}}}}"
        if "{{INJECT_TIME}}" in raw:
            assert c.get("inject_cmds"), d.name
        if "{{UNDO_TIME}}" in raw:
            assert c.get("undo_cmds"), d.name
        if truth["fault_start"] == "{{SETUP_TIME}}":
            assert c.get("fault_start_at") == "setup", d.name
        elif truth["fault_start"] is not None:
            assert c.get("fault_start_at", "inject") == "inject", d.name
        for tc in truth["causes"]:
            assert resource_form(tc["resource"]) and tc["kind"] in rca.KINDS, d.name
            assert set(tc.get("accept_kinds") or []) <= set(rca.KINDS), d.name
            for p in tc.get("accept_resources") or []:
                re.compile(p)
        for hop in truth["path"]:
            assert resource_form(hop["resource"]) and hop["role"] in ROLES, d.name
            for p in hop.get("accept") or []:
                re.compile(p)
        for x in truth["decoys"]:
            assert resource_form(x["resource"]) and x["why"], d.name
        for x in truth["also_ok"]:
            assert resource_form(x), d.name

        filled = rca.fill_placeholders(truth, MARKS)
        if truth["control"]:
            assert truth["causes"] == [] and truth["path"] == [], d.name
            assert rca.score_rca(block([], no_fault=True), filled, CALLS)["pass"], d.name
            for x in truth["decoys"]:
                s = rca.score_rca(block([cause(as_answered(x["resource"]), "crash")]), filled, CALLS)
                assert not s["pass"] and s["decoys_taken"] == [as_answered(x["resource"])], (d.name, x["resource"])
            continue
        right = [cause(tc["resource"], tc["kind"], filled["fault_start"]) for tc in truth["causes"]]
        path = [as_answered(h["resource"]) for h in truth["path"]]
        s = rca.score_rca(block(right, path=path), filled, CALLS)
        assert s["pass"] and s["score"] == 1.0, (d.name, s)
        assert s["time_ok"] is True and s["path_ok"] is True and s["ungrounded"] == 0, (d.name, s)
        assert not rca.score_rca(block([], no_fault=True), filled, CALLS)["pass"], d.name
        for x in truth["decoys"]:
            s = rca.score_rca(block(right + [cause(as_answered(x["resource"]), "crash")]), filled, CALLS)
            assert not s["pass"] and s["decoys_taken"] == [as_answered(x["resource"])], (d.name, x["resource"])


# The workload where the symptom shows, with the kind the pod list shows, is not the cause of these cases (README
# "Hard cases"): it misses alone and costs nothing beside a right cause. WRONG_KIND: the cause under a kind of the
# symptom. ALSO_RIGHT: other forms a NOTES.md takes.
SYMPTOM_ONLY = {
    "18_moved_namespace_old_address": [("Deployment/shop-18/web", "dependency_down"), ("Pod/shop-18/web-7f9c4d8b6-x2k4p", "dns")],
    "19_route_missing_hostname": [("Deployment/shop-19/edge", "config_change")],
    "20_boot_fails_one_env": [("Pod/shop-20/shop-web-7f9c4d8b6-x2k4p", "crash"), ("Pod/shop-20/shop-web-7f9c4d8b6-x2k4p", "rollout")],
    "21_oom_cascade": [("StatefulSet/shop-21/search", "oom"), ("StatefulSet/shop-21/search", "rollout"), ("Pod/shop-21/search-1", "oom")],
    "22_workers_over_memory": [("Deployment/shop-22/shop-api", "oom"), ("Deployment/shop-22/shop-api", "rollout")],
}
WRONG_KIND = {
    "20_boot_fails_one_env": [("Deployment/shop-20/shop-web", "crash")],
    "21_oom_cascade": [("ConfigMap/shop-21/search-indexes-2", "oom")],
    "22_workers_over_memory": [("ConfigMap/shop-22/shop-api-settings", "oom"), ("ConfigMap/shop-22/shop-api-settings", "resource_limit")],
}
ALSO_RIGHT = {
    "16_past_outage": [("Deployment/shop-16/payments", "config_change")],
    "18_moved_namespace_old_address": [("ConfigMap/shop-18/web-settings", "dns")],
    "19_route_missing_hostname": [("Service/shop-19/frontdoor", "config_change"), ("frontdoor", "rollout")],
    "20_boot_fails_one_env": [("Deployment/shop-20/shop-web", "rollout"), ("ReplicaSet/shop-20/shop-web-7f9c4d8b6", "rollout"),
                              ("ConfigMap/shop-20/shop-web-release-2-4-0", "config_change"), ("ConfigMap/shop-20/shop-web-config", "config_change")],
    "21_oom_cascade": [("ConfigMap/shop-21/search-indexes-2", "rollout")],
    "22_workers_over_memory": [("ConfigMap/shop-22/shop-api-settings", "config_change")],
}


def test_the_symptom_alone_is_not_the_cause():
    cases = {d.name: d for d, _ in all_cases()}
    assert set(SYMPTOM_ONLY) | set(WRONG_KIND) | set(ALSO_RIGHT) <= set(cases)
    for name, answers in SYMPTOM_ONLY.items():
        filled = rca.fill_placeholders(truth_of(cases[name]), MARKS)
        right = [cause(tc["resource"], tc["kind"]) for tc in filled["causes"]]
        for resource, kind in answers:
            assert not rca.score_rca(block([cause(resource, kind)]), filled, CALLS)["pass"], (name, resource, kind)
            s = rca.score_rca(block(right + [cause(resource, kind)]), filled, CALLS)
            assert s["pass"] and s["score"] == 1.0, (name, resource, kind, s)
    for name, answers in WRONG_KIND.items():
        filled = rca.fill_placeholders(truth_of(cases[name]), MARKS)
        for resource, kind in answers:
            assert not rca.score_rca(block([cause(resource, kind)]), filled, CALLS)["pass"], (name, resource, kind)
    for name, answers in ALSO_RIGHT.items():
        filled = rca.fill_placeholders(truth_of(cases[name]), MARKS)
        for resource, kind in answers:
            s = rca.score_rca(block([cause(resource, kind)]), filled, CALLS)
            assert s["pass"] and s["score"] == 1.0, (name, resource, kind, s)


def test_a_namespace_a_case_makes_besides_its_own_says_nothing_of_the_case():
    own = {c["namespace"] for _, c in all_cases()}
    made: dict = {}
    for d, c in all_cases():
        setup, cleanup = " ".join(c.get("setup_cmds", [])), " ".join(c.get("cleanup_cmds", []))
        assert "kubeast.io/ai-eval" not in setup, f"{d.name}: a label the case's own namespace has"
        for ns in re.findall(r"kubectl create namespace ([a-z0-9-]+)", setup):
            assert not re.search(r"-\d+$", ns), f"{d.name}: {ns} carries a number"
            assert ns not in own and ns not in made, f"{d.name}: {ns} is also {made.get(ns, 'a case namespace')}"
            made[ns] = d.name
            assert re.search(rf"kubectl delete namespace {re.escape(ns)}(\s|$)", cleanup), f"{d.name}: {ns} is not deleted by name"
    assert made, "no case makes a second namespace"


def test_what_a_case_applies_holds_no_answer_word():
    for d, _ in all_cases():
        for manifest in sorted(d.glob("*.yaml")):
            hit = ANSWER_WORDS.search(manifest.read_text())
            assert not hit, f"{d.name}/{manifest.name}: {hit.group(0)!r}"


# The rules file: rulefmt's fields (Prometheus refuses unknown ones), names, durations, and expressions whose
# brackets close (promtool is not on the dev machines; the first `kind-otel-demo.sh up` checks the rest).
GROUP_FIELDS = {"name", "interval", "limit", "query_offset", "rules", "labels"}
RULE_FIELDS = {"record", "alert", "expr", "for", "keep_firing_for", "labels", "annotations"}
DURATION = re.compile(r"^(\d+y)?(\d+w)?(\d+d)?(\d+h)?(\d+m)?(\d+s)?(\d+ms)?$")
LABEL_NAME = re.compile(r"^[a-zA-Z_][a-zA-Z0-9_]*$")
METRIC_NAME = re.compile(r"^[a-zA-Z_:][a-zA-Z0-9_:]*$")


def brackets_close(expr: str) -> bool:
    text = re.sub(r'"(?:[^"\\]|\\.)*"', '""', expr)
    pairs, stack = {")": "(", "]": "[", "}": "{"}, []
    for ch in text:
        if ch in "([{":
            stack.append(ch)
        elif ch in pairs:
            if not stack or stack.pop() != pairs[ch]:
                return False
    return not stack


def test_brackets_close():
    assert brackets_close('sum by (a) (rate(m{l="x)"}[5m])) > 0')
    assert not brackets_close("sum(rate(m[5m])")
    assert not brackets_close("sum(m[5m)]")


def test_the_demo_rules_have_the_shape_prometheus_reads():
    groups = json.loads(RULES.read_text())["groups"]
    assert groups and set(json.loads(RULES.read_text())) == {"groups"}
    alerts = []
    for g in groups:
        assert set(g) <= GROUP_FIELDS and g["name"] and g["rules"], g
        assert g["name"] != "kubeast-e2e"
        for r in g["rules"]:
            assert set(r) <= RULE_FIELDS, r
            assert ("alert" in r) != ("record" in r), r
            assert isinstance(r["expr"], str) and r["expr"].strip() and brackets_close(r["expr"]), r
            for key in ("for", "keep_firing_for"):
                if key in r:
                    assert r[key] and DURATION.match(r[key]), r
            for name, value in {**r.get("labels", {}), **r.get("annotations", {})}.items():
                assert LABEL_NAME.match(name) and isinstance(value, str), (r, name)
                assert value.count("{{") == value.count("}}"), (r, name)
            if "alert" in r:
                alerts.append(r)
                assert METRIC_NAME.match(r["alert"]), r
                # ai-prometheus-discovery.spec.ts reads the rules whose name holds "kubeaste2e" and expects its own only
                assert "kubeaste2e" not in r["alert"].lower(), r
                labels = r["labels"]
                assert labels["kubeast_eval"] == "otel-demo" and labels["namespace"] == "otel-demo", r
                assert labels["severity"] in ("critical", "warning"), r  # the investigator's default severities
    exprs = " ".join(r["expr"] for r in alerts)
    assert 'status_code="STATUS_CODE_ERROR"' in exprs, "no error rate rule"
    assert "histogram_quantile(" in exprs, "no latency rule"
    assert "kube_pod_container_status_restarts_total" in exprs, "no restart rule"


def test_prometheus_reads_the_key_the_script_writes_and_sends_only_its_alerts():
    script = DEMO_SCRIPT.read_text()
    key = re.search(r'^RULES_KEY="([^"]+)"', script, re.M).group(1)
    assert re.search(r'^RULES="\$ROOT/deploy/kind/otel-demo-rules\.json"$', script, re.M)
    config = SECOND_CLUSTER.read_text()
    files = [f.strip() for f in re.search(r"^\s*rule_files: \[(.*)\]$", config, re.M).group(1).split(",")]
    assert "/etc/prometheus/rules.yml" in files
    assert any(fnmatch.fnmatch(f"/etc/prometheus/{key}", f) for f in files if "*" in f), (key, files)
    assert re.search(r"source_labels: \[kubeast_eval\]\n\s*regex: \.\+\n\s*action: keep", config)
    e2e_rules = config.split("rules.yml: |", 1)[1].split("\n---", 1)[0]
    assert "kubeast_eval" not in e2e_rules, "an e2e rule would be sent to Alertmanager"


if __name__ == "__main__":
    tests = [(n, f) for n, f in sorted(globals().items()) if n.startswith("test_") and callable(f)]
    failed = 0
    for name, fn in tests:
        try:
            fn()
            print(f"ok   {name}")
        except AssertionError as e:
            failed += 1
            print(f"FAIL {name}: {e!r}")
    print(f"{len(tests) - failed} passed, {failed} failed")
    sys.exit(1 if failed else 0)
