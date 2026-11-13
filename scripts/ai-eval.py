#!/usr/bin/env python3
"""AI analysis evaluation on the kind dev clusters (evals/ai/README.md).

Each case under evals/ai/<NN>_<name>/ makes a problem in its own namespace (case.json + setup.yaml), asks the AI
chat a question as an operator would, and checks the answer: every expected fact present (each a list of regular
expressions, any one matching), nothing forbidden, the tools it must call called. It records the tool calls, the
tokens and the seconds per case, deletes the namespace, and writes a JSON report and a markdown table. The model is
whatever the dev install's default is (scripts/kind-model-subscription.sh, deploy/kind/modelconfig-ollama.yaml):
run it once per model.

A case with the hard-case fields (evals/ai/README.md "Hard cases") runs in stages in one setup: setup, a normal
baseline, the fault injected, each question form asked at each ask time (--repeat times each), the fault undone,
the namespace deleted. Its answer ends in an rca block scored against truth.json, whose filled copy is written
next to the report.

  python3 scripts/ai-eval.py --out /tmp/eval            # every case
  python3 scripts/ai-eval.py --out /tmp/eval 03 07      # cases whose id starts with 03 or 07
  python3 scripts/ai-eval.py --out /tmp/eval --repeat 3 --keep
  python3 scripts/ai-eval.py --cases evals/ai-hard --list
  python3 scripts/ai-eval.py --cases evals/ai-hard --out /tmp/eval-hard 06

Credentials come from the cluster (the admin password in kubeast-secrets) and are never printed.
"""
from __future__ import annotations

import argparse
import base64
import json
import os
import re
import subprocess
import sys
import tempfile
import time
import urllib.request
from pathlib import Path

import ai_eval_rca as rca

ROOT = Path(__file__).resolve().parent.parent
CASES = ROOT / "evals" / "ai"
BASE = os.environ.get("E2E_BASE_URL", "http://localhost:30080").rstrip("/")
KIND = {"self": "kubeast", "default": "kubeast-b"}  # Kubeast cluster ID → kind cluster
READ_PASSWORD = "Eval-read-pass1!"


def kubeconfig(kind_name: str, cache: dict) -> str:
    if kind_name not in cache:
        path = Path(tempfile.mkdtemp(prefix="ai-eval-")) / "kubeconfig"
        path.write_text(subprocess.run(["kind", "get", "kubeconfig", "--name", kind_name], check=True, capture_output=True, text=True).stdout)
        path.chmod(0o600)
        cache[kind_name] = str(path)
    return cache[kind_name]


def sh(cmd: str, kc: str, timeout: int = 300, env: dict | None = None) -> subprocess.CompletedProcess:
    return subprocess.run(["bash", "-c", cmd], env={**os.environ, "KUBECONFIG": kc, **(env or {})}, capture_output=True, text=True, timeout=timeout)


def request(method: str, path: str, token: str = "", body: dict | None = None, timeout: int = 60, cluster: str = ""):
    data = json.dumps(body).encode() if body is not None else None
    req = urllib.request.Request(BASE + path, data=data, method=method)
    req.add_header("Content-Type", "application/json")
    req.add_header("X-Requested-With", "XMLHttpRequest")
    if token:
        req.add_header("Authorization", f"Bearer {token}")
    if cluster:
        req.add_header("X-Cluster-Name", cluster)  # the chat takes its cluster from this header, as the screen sends it
    return urllib.request.urlopen(req, timeout=timeout)


def login(email: str, password: str) -> str:
    with request("POST", "/api/v1/auth/login", body={"email": email, "password": password}) as r:
        return json.load(r)["access_token"]


def admin_password(kc: str) -> str:
    out = sh("kubectl -n kubeast get secret kubeast-secrets -o jsonpath='{.data.DEFAULT_ADMIN_PASSWORD}'", kc).stdout
    return base64.b64decode(out).decode()


def read_user(admin: str, cluster: str, stamp: str) -> tuple[str, str]:
    """A member with Read on cluster; returns (user id, token)."""
    with request("GET", "/api/v1/auth/roles", admin) as r:
        roles = json.load(r)
    roles = roles if isinstance(roles, list) else roles.get("roles") or roles.get("items") or []
    member = next(x for x in roles if x["name"].lower() == "member")
    email = f"ai-eval-read-{stamp}@kubeast.local"
    with request("POST", "/api/v1/auth/admin/users", admin, {"name": "AI eval read", "email": email, "password": READ_PASSWORD, "role_id": member["id"]}) as r:
        uid = json.load(r)["id"]
    request("PUT", f"/api/v1/auth/admin/users/{uid}/cluster-roles/{cluster}", admin, {"role": "Read"}).close()
    return uid, login(email, READ_PASSWORD)


def ask(token: str, cluster: str, question: str, timeout: int) -> dict:
    """One chat turn: the model, the tool calls (name, args, error or not), the answer, the usage, the seconds."""
    with request("POST", "/api/v1/sessions", token, {"title": "ai-eval"}, cluster=cluster) as r:
        sid = json.load(r)["id"]
    out = {"model": None, "provider": None, "calls": [], "answer": "", "error": None, "tokens": 0, "model_calls": 0}
    started = time.monotonic()
    try:
        with request("POST", f"/api/v1/ai/sessions/{sid}/chat", token, {"message": question}, timeout=timeout, cluster=cluster) as r:
            for raw in r:
                line = raw.decode("utf-8", "replace").strip()
                if not line.startswith("data: ") or line == "data: [DONE]":
                    continue
                try:
                    e = json.loads(line[6:])
                except ValueError:
                    continue
                if "model_info" in e:
                    out["model"], out["provider"] = e["model_info"].get("model"), e["model_info"].get("provider")
                if "function" in e and "args" in e:
                    out["calls"].append({"tool": e["function"], "args": e["args"], "failed": False})
                if "function_result" in e:
                    text = str(e.get("result", ""))[:400]
                    failed = text.lstrip().startswith('{"error"') or '"error": "Error in' in text
                    for c in reversed(out["calls"]):
                        if c["tool"] == e["function_result"] and "result" not in c:
                            c["result"], c["failed"] = text, failed
                            break
                if "content" in e:
                    out["answer"] += e["content"]
                if "error" in e:
                    out["error"] = str(e["error"])[:300]
                if isinstance(e.get("usage"), dict):  # one per model call
                    out["tokens"] += int(e["usage"].get("total_tokens") or 0)
                    out["model_calls"] += 1
    finally:
        out["seconds"] = round(time.monotonic() - started, 1)
        try:
            request("DELETE", f"/api/v1/sessions/{sid}", token).close()
        except Exception:
            pass
    return out


def grade(case: dict, run: dict) -> dict:
    text = run["answer"]
    missing = [group for group in case.get("expect", []) if not any(re.search(p, text, re.I) for p in group)]
    forbidden = [p for p in case.get("forbid", []) if re.search(p, text, re.I)]
    called = {c["tool"] for c in run["calls"]}
    no_tool = [group for group in case.get("tools", []) if not called.intersection(group)]
    return {"pass": not missing and not forbidden and not no_tool and not run["error"],
            "missing": missing, "forbidden": forbidden, "tools_missing": no_tool}


def now_utc() -> str:
    return time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())


def prepare(case: dict, case_dir: Path, kc: str) -> tuple[str | None, tuple[str, float]]:
    """A fresh namespace, setup.yaml, setup_cmds and the wait. Returns (setup error, SETUP_TIME as (UTC, monotonic)),
    SETUP_TIME taken once setup.yaml is applied."""
    ns = case["namespace"]
    env = {"CASE_DIR": str(case_dir)}
    sh(f"kubectl delete namespace {ns} --ignore-not-found --wait=true", kc)
    sh(f"kubectl create namespace {ns} && kubectl label namespace {ns} kubeast.io/ai-eval=true", kc)
    if (case_dir / "setup.yaml").exists():
        r = sh(f"kubectl -n {ns} apply -f {case_dir / 'setup.yaml'}", kc)
        if r.returncode:
            return r.stderr[-400:], ("", 0.0)
    setup_time = (now_utc(), time.monotonic())
    for step in case.get("setup_cmds", []):
        sh(step.replace("$NS", ns), kc, timeout=600, env=env)
    wait = case.get("wait")
    if wait:
        deadline = time.monotonic() + case.get("wait_seconds", 240)
        while time.monotonic() < deadline and sh(wait.replace("$NS", ns), kc, env=env).returncode != 0:
            time.sleep(5)
    return None, setup_time


def run_case(case_dir: Path, admin: str, kcs: dict, keep: bool, stamp: str) -> dict:
    case = json.loads((case_dir / "case.json").read_text())
    cluster, ns = case["cluster"], case["namespace"]
    kc = kubeconfig(KIND[cluster], kcs)
    error, _ = prepare(case, case_dir, kc)
    if error:
        return {"id": case["id"], "setup_error": error}
    time.sleep(case.get("settle_seconds", 0))
    uid, token = None, admin
    if case.get("user") == "read":
        uid, token = read_user(admin, cluster, stamp)
    try:
        run = ask(token, cluster, case["question"], case.get("timeout_seconds", 300))
    finally:
        if uid:
            request("DELETE", f"/api/v1/auth/admin/users/{uid}", admin).close()
        if not keep:
            sh(f"kubectl delete namespace {ns} --ignore-not-found --wait=false", kc)
            for step in case.get("cleanup_cmds", []):
                sh(step.replace("$NS", ns), kc)
    return {"id": case["id"], "title": case["title"], **run, **grade(case, run)}


def run_steps(steps: list, ns: str, kc: str, env: dict) -> str | None:
    """Shell steps in order; the first that fails ends them with its stderr."""
    for i, step in enumerate(steps, 1):
        r = sh(step.replace("$NS", ns), kc, timeout=600, env=env)
        if r.returncode:
            return f"step {i}: {(r.stderr or r.stdout)[-400:]}"
    return None


def poll(cmd: str, kc: str, seconds: int, env: dict) -> bool:
    deadline = time.monotonic() + seconds
    while True:
        if sh(cmd, kc, env=env).returncode == 0:
            return True
        if time.monotonic() >= deadline:
            return False
        time.sleep(5)


def run_staged_case(case_dir: Path, case: dict, admin: str, kcs: dict, args, stamp: str, truth_dir: Path) -> list[dict]:
    """A hard case in one setup: setup → baseline → inject → asks (each form × --repeat at each ask time, the undo of a
    fault_duration_seconds case among them) → undo → namespace and cleanup → cooldown. One result per ask."""
    cluster, ns = case["cluster"], case["namespace"]
    kc = kubeconfig(KIND[cluster], kcs)
    env = {"CASE_DIR": str(case_dir)}
    truth = json.loads((case_dir / "truth.json").read_text()) if (case_dir / "truth.json").exists() else None
    marks: dict[str, tuple[str, float]] = {}
    errors: list[str] = []
    results: list[dict] = []
    head = {"id": case["id"], "title": case.get("title", ""), "hidden": bool(case.get("hidden"))}
    uid, undone, interrupted = None, False, False

    def utc_marks() -> dict:
        return {k: v[0] for k, v in marks.items()}

    def undo() -> None:
        nonlocal undone
        if case.get("undo_cmds"):
            failed = run_steps(case["undo_cmds"], ns, kc, env)
            if failed:
                errors.append(f"undo {failed}")
        marks["UNDO_TIME"] = (now_utc(), time.monotonic())
        undone = True

    try:
        error, setup_time = prepare(case, case_dir, kc)
        if error:
            results.append({**head, "setup_error": error})
            return results
        marks["SETUP_TIME"] = setup_time
        time.sleep(case.get("settle_seconds", 0) + case.get("baseline_seconds", 0))
        if case.get("inject_cmds"):
            marks["INJECT_TIME"] = (now_utc(), time.monotonic())
            failed = run_steps(case["inject_cmds"], ns, kc, env)
            if failed:
                results.append({**head, "setup_error": f"inject {failed}"})
                return results
            if case.get("inject_wait"):
                seconds = case.get("inject_wait_seconds", rca.DEFAULT_INJECT_WAIT_SECONDS)
                if not poll(case["inject_wait"].replace("$NS", ns), kc, seconds, env):
                    results.append({**head, "setup_error": f"inject_wait still false after {seconds} s"})
                    return results
        start = marks["SETUP_TIME" if case.get("fault_start_at") == "setup" or "INJECT_TIME" not in marks else "INJECT_TIME"][1]
        token = admin
        if case.get("user") == "read":
            uid, token = read_user(admin, cluster, stamp)
        for what, at in rca.schedule(case):
            if at is not None:
                wait = start + at - time.monotonic()
                if wait > 60:
                    print(f"{case['id']}: {what} at +{at} s, waiting {round(wait)} s", flush=True)
                time.sleep(max(0.0, wait))
            if what == "undo":
                undo()
                continue
            late = 0.0 if at is None else max(0.0, time.monotonic() - (start + at))
            for form, question in rca.question_forms(case):
                for n in range(args.repeat):
                    asked_at = now_utc()
                    run = ask(token, cluster, rca.question_with_format(question, case.get("answer_format")), case.get("timeout_seconds", 300))
                    r = {**head, "form": form, "ask_after": at, "asked_at": asked_at, "late_seconds": round(late), "run": n + 1,
                         **run, **grade(case, run)}
                    if case.get("answer_format") == "rca_block_v0" and truth is not None:
                        r["prose_pass"] = r["pass"]
                        r["rca"] = rca.score_rca(run["answer"], rca.fill_placeholders(truth, utc_marks()), run["calls"])
                        r["pass"] = r["rca"]["pass"] and not run["error"]
                    results.append(r)
                    shown = "done" if head["hidden"] else ("pass" if r["pass"] else "FAIL")
                    print(f"{case['id']} {form} {when(at)} run {n + 1}: {shown} — {len(run['calls'])} calls, {run['seconds']} s", flush=True)
    except BaseException:
        interrupted = True
        raise
    finally:
        if uid:
            request("DELETE", f"/api/v1/auth/admin/users/{uid}", admin).close()
        if not args.keep:
            if not undone and "INJECT_TIME" in marks and case.get("undo_cmds"):  # an injection that ran, even in part
                undo()
            sh(f"kubectl delete namespace {ns} --ignore-not-found --wait=false", kc)
            for step in case.get("cleanup_cmds", []):
                sh(step.replace("$NS", ns), kc, env=env)
        if truth is not None and marks:
            truth_dir.mkdir(parents=True, exist_ok=True)
            (truth_dir / f"{case['id']}.json").write_text(json.dumps(rca.fill_placeholders(truth, utc_marks()), ensure_ascii=False, indent=1) + "\n")
        for r in results:
            r["stage"] = {**utc_marks(), "errors": errors}
        if not args.keep and not interrupted:
            time.sleep(case.get("cooldown_seconds", 0))
    return results


def when(at) -> str:
    return "now" if at is None else f"+{at}s"


def table(results: list[dict]) -> str:
    rows = ["| 사례 | 정답 | 빠진 사실 | 안 부른 도구 | 도구 호출 (실패) | 토큰 | 초 |", "|---|---|---|---|---|---|---|"]
    shown = [r for r in results if not r.get("hidden")]
    for r in shown:
        if "setup_error" in r:
            rows.append(f"| {r['id']} | 준비 실패 | {r['setup_error'][:80]} | | | | |")
            continue
        usage = r.get("tokens") or ""
        calls = f"{len(r['calls'])} ({sum(1 for c in r['calls'] if c['failed'])})"
        missing = " · ".join(g[0] for g in r["missing"]) + (f" · 금지 {r['forbidden']}" if r["forbidden"] else "") + (f" · 오류 {r['error']}" if r.get("error") else "")
        tools = " · ".join("/".join(g) for g in r["tools_missing"])
        name = f"{r['id']} {r['title']}" + (f" · {r['form']} {when(r['ask_after'])} #{r['run']}" if "form" in r else "")
        rows.append(f"| {name} | {'✅' if r['pass'] else '❌'} | {missing} | {tools} | {calls} | {usage} | {r['seconds']} |")
    scored = [r for r in shown if "rca" in r]
    if scored:
        rows += ["", "| 사례 · 질문 · 시점 · 회차 | 원인 | 점수 | 미끼 | 더 댄 것 | 시각 | 경로 | 근거 없음 | 묶음 |",
                 "|---|---|---|---|---|---|---|---|---|"]
        mark = {True: "✅", False: "❌", None: "-"}
        for r in scored:
            s = r["rca"]
            rows.append(f"| {r['id']} · {r['form']} · {when(r['ask_after'])} · #{r['run']} | {mark[s['pass']]} | {s['score']:.2f} | "
                        f"{' · '.join(s['decoys_taken'])} | {' · '.join(s['extras'])} | {mark[s['time_ok']]} | {mark[s['path_ok']]} | "
                        f"{s['ungrounded']} | {s['block']} |")
    hidden = [r for r in results if r.get("hidden")]
    if hidden:
        rows.append(f"\n숨김 사례 {len({r['id'] for r in hidden})}개: 정답 {sum(1 for r in hidden if r.get('pass'))}/{len(hidden)} (사례별 결과는 JSON에만)")
    ok = sum(1 for r in results if r.get("pass"))
    rows.append(f"\n정답 {ok}/{len(results)} · 모델 {next((r['model'] for r in results if r.get('model')), '?')}")
    return "\n".join(rows)


def load_cases(root: Path, only: list[str], hidden: bool) -> tuple[list[tuple[Path, dict]], list[str]]:
    """(case dir, case) for each case to run, and the problems that stop the run."""
    picked, problems = [], []
    for d in sorted(d for d in root.iterdir() if (d / "case.json").exists() and (not only or any(d.name.startswith(p) for p in only))):
        try:
            case = json.loads((d / "case.json").read_text())
        except ValueError as e:
            problems.append(f"{d.name}: case.json: {e}")
            continue
        if case.get("hidden") and not hidden:
            continue
        problems += [f"{d.name}: {p}" for p in rca.check_case(case, (d / "truth.json").exists())]
        if case.get("cluster") not in KIND:
            problems.append(f"{d.name}: cluster {case.get('cluster')!r} is not one of {sorted(KIND)}")
        picked.append((d, case))
    return picked, problems


def listing(cases: list[tuple[Path, dict]]) -> str:
    rows = ["| id | cluster | namespace | staged | forms | ask after (s) | truth | hidden |", "|---|---|---|---|---|---|---|---|"]
    for d, c in cases:
        staged = rca.is_staged(c)
        times = ", ".join("now" if t is None else str(t) for t in rca.ask_times(c)) if staged else ""
        rows.append(f"| {c.get('id')} | {c.get('cluster')} | {c.get('namespace')} | {'yes' if staged else ''} | "
                    f"{len(rca.question_forms(c))} | {times} | {'yes' if (d / 'truth.json').exists() else ''} | {'yes' if c.get('hidden') else ''} |")
    return "\n".join(rows)


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("only", nargs="*", help="case id prefixes")
    ap.add_argument("--out", help="directory for the JSON report, the table and the filled truth copies")
    ap.add_argument("--cases", default=str(CASES), help="directory of case folders (default evals/ai)")
    ap.add_argument("--repeat", type=int, default=1, help="runs per case (a hard case: asks per form and ask time, in one setup)")
    ap.add_argument("--keep", action="store_true", help="leave each case as it ends: namespace kept, no undo, no cleanup")
    ap.add_argument("--hidden", action="store_true", help="also run the cases marked hidden (the table shows only their total)")
    ap.add_argument("--list", action="store_true", help="list the cases that would run and check their fields; touches no cluster")
    args = ap.parse_args()
    cases, problems = load_cases(Path(args.cases), args.only, args.hidden)
    if args.list:
        print(listing(cases))
        for p in problems:
            print(f"problem: {p}")
        return 1 if problems else 0
    if not args.out:
        ap.error("--out is required unless --list")
    if problems:
        for p in problems:
            print(f"problem: {p}", file=sys.stderr)
        return 2
    kcs: dict = {}
    admin = login(os.environ.get("E2E_USER_EMAIL", "admin"), os.environ.get("E2E_USER_PASSWORD") or admin_password(kubeconfig("kubeast", kcs)))
    stamp = time.strftime("%Y%m%d%H%M%S", time.gmtime())
    out = Path(args.out)
    truth_dir = out / f"{stamp}-truth"
    results = []
    for case_dir, case in cases:
        if rca.is_staged(case):
            results += run_staged_case(case_dir, case, admin, kcs, args, stamp, truth_dir)
            continue
        for n in range(args.repeat):
            r = run_case(case_dir, admin, kcs, args.keep, f"{stamp}{n}")
            r["run"] = n + 1
            results.append(r)
            print(f"{r['id']} run {n + 1}: {'pass' if r.get('pass') else 'FAIL'} — {len(r.get('calls', []))} calls, {r.get('seconds')} s", flush=True)
    out.mkdir(parents=True, exist_ok=True)
    model = next((r["model"] for r in results if r.get("model")), "model")
    (out / f"{stamp}-{model}.json").write_text(json.dumps(results, ensure_ascii=False, indent=1))
    (out / f"{stamp}-{model}.md").write_text(table(results) + "\n")
    print(table(results))
    return 0


if __name__ == "__main__":
    sys.exit(main())
