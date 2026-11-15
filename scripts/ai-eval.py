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
  python3 scripts/ai-eval.py --cases evals/ai-hard --out /tmp/eval-hard --namespace-suffix random

A hard case asks as a member made for it with Read on its cluster only (--user admin asks as the admin), so the
chat cannot read the investigations or the audit log of earlier runs. An HTTP error, a timeout or a dropped
connection is kept as that answer's error (a 429 or 5xx is tried once more) and the case goes on; the report is
written after each case. Credentials come from the cluster (the admin password in kubeast-secrets) and are never
printed.
"""
from __future__ import annotations

import argparse
import base64
import http.client
import json
import os
import random
import re
import secrets
import shutil
import string
import subprocess
import sys
import tempfile
import time
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))  # python3 -I leaves the script's folder out

import ai_eval_rca as rca  # noqa: E402

ROOT = Path(__file__).resolve().parent.parent
CASES = ROOT / "evals" / "ai"
BASE = os.environ.get("E2E_BASE_URL", "http://localhost:30080").rstrip("/")
KIND = {"self": "kubeast", "default": "kubeast-b"}  # Kubeast cluster ID → kind cluster
USERS = ("read", "admin")
# One chat turn's request error: a 429 or 5xx is tried once more after this wait; this many in a row end the case.
RETRY_STATUSES = (429, 500, 502, 503, 504)
RETRY_WAIT_SECONDS = 20
MAX_ERRORS_IN_A_ROW = 3
REQUEST_ERRORS = (urllib.error.URLError, http.client.HTTPException, OSError)
SUFFIX = re.compile(r"^[a-z0-9]{1,8}$")


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
    """A member with Read on cluster (the whole cluster, no other); returns (user id, token). A member holds no
    admin.audit.read or admin.investigations.read, so the chat's audit_search and investigations refuse it. Its
    password is made for this account and kept in memory only, so one left behind by a failed delete opens to no one."""
    password = secrets.token_urlsafe(24)
    with request("GET", "/api/v1/auth/roles", admin) as r:
        roles = json.load(r)
    roles = roles if isinstance(roles, list) else roles.get("roles") or roles.get("items") or []
    member = next(x for x in roles if x["name"].lower() == "member")
    email = f"ai-eval-read-{stamp}@kubeast.local"
    with request("POST", "/api/v1/auth/admin/users", admin, {"name": "AI eval read", "email": email, "password": password, "role_id": member["id"]}) as r:
        uid = json.load(r)["id"]
    try:
        request("PUT", f"/api/v1/auth/admin/users/{uid}/cluster-roles/{cluster}", admin, {"role": "Read"}).close()
        return uid, login(email, password)
    except BaseException:
        request("DELETE", f"/api/v1/auth/admin/users/{uid}", admin).close()
        raise


def result_text(result) -> tuple[str, bool]:
    """A tool result as text (cut to 400 characters) and whether it is an error: the stream's JSON text, or an object."""
    text = result if isinstance(result, str) else json.dumps(result, ensure_ascii=False, default=str)
    head = text.lstrip()
    try:
        obj = json.loads(head) if head.startswith("{") else None
    except ValueError:  # cut, or not JSON
        obj = None
    failed = bool(obj.get("error")) if isinstance(obj, dict) else head.startswith('{"error"')
    return text[:400], failed or '"error": "Error in' in text


def add_event(out: dict, e: dict) -> None:
    """One event of the chat stream into a turn's record. A tool result goes to its call by call_id when both carry
    one, else to the earliest call of that tool still without a result."""
    if "model_info" in e:
        out["model"], out["provider"] = e["model_info"].get("model"), e["model_info"].get("provider")
    if "function" in e and "args" in e:
        out["calls"].append({"tool": e["function"], "args": e["args"], "failed": False, **({"call_id": e["call_id"]} if e.get("call_id") is not None else {})})
    if "function_result" in e:
        text, failed = result_text(e.get("result", ""))
        open_calls = [c for c in out["calls"] if "result" not in c]
        call = next((c for c in open_calls if e.get("call_id") is not None and c.get("call_id") == e["call_id"]), None)
        call = call or next((c for c in open_calls if c["tool"] == e["function_result"]), None)
        if call is not None:
            call["result"], call["failed"] = text, failed
    if "content" in e:
        out["answer"] += e["content"]
    if "error" in e:
        out["error"] = str(e["error"])[:300]
    if isinstance(e.get("usage"), dict):  # one per model call
        out["tokens"] += int(e["usage"].get("total_tokens") or 0)
        out["model_calls"] += 1


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
                if isinstance(e, dict):
                    add_event(out, e)
    finally:
        out["seconds"] = round(time.monotonic() - started, 1)
        try:
            request("DELETE", f"/api/v1/sessions/{sid}", token).close()
        except Exception:
            pass
    return out


def request_error(e: BaseException) -> tuple[str, int | None, bool]:
    """(what to record, the HTTP status, whether to try again) for an error of a request."""
    if isinstance(e, urllib.error.HTTPError):
        return f"HTTP {e.code} {e.reason}", e.code, e.code in RETRY_STATUSES
    return f"{type(e).__name__}: {e}", None, False


def ask_kept(token: str, cluster: str, question: str, timeout: int) -> dict:
    """ask(), with an HTTP error, a timeout or a dropped connection kept as the turn's error (request_error,
    error_status) instead of ending the case; a 429 or 5xx is tried once more after RETRY_WAIT_SECONDS."""
    tries: list[str] = []
    while True:
        started = time.monotonic()
        try:
            run = ask(token, cluster, question, timeout)
        except REQUEST_ERRORS as e:
            why, status, again = request_error(e)
            if isinstance(e, urllib.error.HTTPError):
                e.close()
            tries.append(why)
            if again and len(tries) == 1:
                time.sleep(RETRY_WAIT_SECONDS)
                continue
            return {"model": None, "provider": None, "calls": [], "answer": "", "error": f"request failed: {why}"[:300], "tokens": 0,
                    "model_calls": 0, "seconds": round(time.monotonic() - started, 1), "request_error": True, "error_status": status,
                    "tries": tries}
        if tries:
            run["tries"] = tries
        return run


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
    SETUP_TIME taken once setup.yaml is applied. A failing setup step, or a wait still false at wait_seconds, is a
    setup error with the end of its output."""
    ns = case["namespace"]
    env = {"CASE_DIR": str(case_dir)}
    sh(f"kubectl delete namespace {ns} --ignore-not-found --wait=true", kc)
    sh(f"kubectl create namespace {ns} && kubectl label namespace {ns} kubeast.io/ai-eval=true", kc)
    if (case_dir / "setup.yaml").exists():
        r = sh(f"kubectl -n {ns} apply -f {case_dir / 'setup.yaml'}", kc)
        if r.returncode:
            return r.stderr[-400:], ("", 0.0)
    setup_time = (now_utc(), time.monotonic())
    failed = run_steps(case.get("setup_cmds", []), ns, kc, env)
    if failed:
        return f"setup {failed}", setup_time
    wait = case.get("wait")
    if wait:
        seconds = case.get("wait_seconds", 240)
        ok, last = poll(wait.replace("$NS", ns), kc, seconds, env)
        if not ok:
            return f"wait still false after {seconds} s: {last[-400:]}", setup_time
    return None, setup_time


def user_of(case: dict, args) -> str:
    """read or admin: a case's own user: read, else --user for a hard case (read by default), else admin."""
    if case.get("user") == "read":
        return "read"
    return (getattr(args, "user", None) or "read") if rca.is_staged(case) else "admin"


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
        run = ask_kept(token, cluster, case["question"], case.get("timeout_seconds", 300))
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


def poll(cmd: str, kc: str, seconds: int, env: dict) -> tuple[bool, str]:
    """Whether cmd succeeded before the deadline, and its last output."""
    deadline = time.monotonic() + seconds
    while True:
        r = sh(cmd, kc, env=env)
        if r.returncode == 0:
            return True, r.stdout
        if time.monotonic() >= deadline:
            return False, (r.stderr or r.stdout or f"exit {r.returncode}")
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
    user = user_of(case, args)
    head = {"id": case["id"], "title": case.get("title", ""), "hidden": bool(case.get("hidden")), "namespace": ns, "user": user}
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
        token = admin
        if user == "read":
            try:
                uid, token = read_user(admin, cluster, f"{stamp}-{case['id'][:2]}")
            except (*REQUEST_ERRORS, ValueError, KeyError, StopIteration) as e:
                results.append({**head, "setup_error": f"read account: {request_error(e)[0]}"[:400]})
                return results
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
                ok, last = poll(case["inject_wait"].replace("$NS", ns), kc, seconds, env)
                if not ok:
                    results.append({**head, "setup_error": f"inject_wait still false after {seconds} s: {last[-400:]}"})
                    return results
        start = marks["SETUP_TIME" if case.get("fault_start_at") == "setup" or "INJECT_TIME" not in marks else "INJECT_TIME"][1]
        in_a_row = 0
        for what, at in rca.schedule(case):
            if in_a_row >= MAX_ERRORS_IN_A_ROW:
                break
            if at is not None:
                wait = start + at - time.monotonic()
                if wait > 60:
                    print(f"{case['id']}: {what} at +{at} s, waiting {round(wait)} s", flush=True)
                time.sleep(max(0.0, wait))
            if what == "undo":
                undo()
                continue
            due = time.monotonic() if at is None else start + at
            for form, question, n in rca.ask_order(case, args.repeat):
                late = max(0.0, time.monotonic() - due)
                asked_at = now_utc()
                run = ask_kept(token, cluster, rca.question_with_format(question, case.get("answer_format")), case.get("timeout_seconds", 300))
                r = {**head, "form": form, "ask_after": at, "asked_at": asked_at, "late_seconds": round(late), "run": n,
                     **run, **grade(case, run)}
                if case.get("answer_format") == "rca_block_v0" and truth is not None:
                    r["prose_pass"] = r["pass"]
                    r["rca"] = rca.score_rca(run["answer"], rca.fill_placeholders(truth, utc_marks()), run["calls"])
                    r["pass"] = r["rca"]["pass"] and not run["error"]
                    r["pass_grounded"] = r["pass"] and r["rca"]["ungrounded"] == 0
                results.append(r)
                shown = "done" if head["hidden"] else ("pass" if r["pass"] else "FAIL")
                print(f"{case['id']} {form} {when(at)} run {n}: {shown} — {len(run['calls'])} calls, {run['seconds']} s", flush=True)
                in_a_row = in_a_row + 1 if run.get("request_error") else 0
                if in_a_row >= MAX_ERRORS_IN_A_ROW:
                    errors.append(f"stopped after {in_a_row} request errors in a row")
                    break
    except BaseException:
        interrupted = True
        raise
    finally:
        if uid:
            try:
                request("DELETE", f"/api/v1/auth/admin/users/{uid}", admin).close()
            except REQUEST_ERRORS as e:
                errors.append(f"read account not deleted: {request_error(e)[0]}"[:300])
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


def table(results: list[dict], round_info: dict | None = None, final: bool = True) -> str:
    """The markdown table: one row per shown result, the rca scores, and the totals. A hidden case's results are left
    out; their total is given only in a run's last table (final) and only when two or more hidden cases have a scored
    row (a case whose setup failed has none), so no line, and no change between the tables written during a run, gives
    one hidden case's score."""
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
        rows += ["", "| 사례 · 질문 · 시점 · 회차 | 원인 | 근거 있는 정답 | 점수 | 미끼 | 더 댄 것 | 시각 | 경로 | 근거 없음 | 묶음 |",
                 "|---|---|---|---|---|---|---|---|---|---|"]
        mark = {True: "✅", False: "❌", None: "-"}
        for r in scored:
            s = r["rca"]
            rows.append(f"| {r['id']} · {r['form']} · {when(r['ask_after'])} · #{r['run']} | {mark[s['pass']]} | {mark[s.get('pass_grounded')]} | "
                        f"{s['score']:.2f} | {' · '.join(s['decoys_taken'])} | {' · '.join(s['extras'])} | {mark[s['time_ok']]} | "
                        f"{mark[s['path_ok']]} | {s['ungrounded']} | {s['block']} |")
    model = next((r["model"] for r in results if r.get("model")), "?")
    hidden = [r for r in results if r.get("hidden")]
    hidden_scored = [r for r in hidden if "setup_error" not in r]
    scored_ids = {r["id"] for r in hidden_scored}
    if hidden and not shown:
        rows.append(f"\n숨김 사례만 든 실행: 결과는 JSON에만 · 모델 {model}")
    else:
        if hidden and not final:
            rows.append("\n숨김 사례: 합계는 실행이 끝난 뒤의 표에만 (사례별 결과는 JSON에만)")
        elif len(scored_ids) >= 2:
            rows.append(f"\n숨김 사례 {len(scored_ids)}개: 정답 {sum(1 for r in hidden_scored if r.get('pass'))}/{len(hidden_scored)} (사례별 결과는 JSON에만)")
        elif hidden:
            rows.append("\n숨김 사례: 채점된 사례가 둘이 안 되어 결과는 JSON에만")
        ok = sum(1 for r in shown if r.get("pass"))
        grounded = sum(1 for r in shown if r.get("pass_grounded"))
        rows.append(f"\n정답 {ok}/{len(shown)}" + (f" (근거 있는 정답 {grounded})" if scored else "") + (" · 숨김 빼고" if hidden else "") + f" · 모델 {model}")
    if round_info:
        rows.append(round_line(round_info))
    return "\n".join(rows)


def round_line(info: dict) -> str:
    """The round's account, namespace suffix and the alert investigations / inbox rows per cluster, before → after."""
    def counts(side):
        return " · ".join(f"{c} {v.get('investigations')}/{v.get('inbox')}" for c, v in sorted((info.get(side) or {}).items()))
    line = f"\n라운드: 계정 {info.get('user')} · 네임스페이스 꼬리 {info.get('namespace_suffix') or '없음'} · 조사/알림함 {counts('before')}"
    if "after" in info:
        line += f" → {counts('after')}"
    if info.get("alert_investigation_on"):
        line += " · 알림 조사 켬(--alert-investigation-on)"
    return line


def with_suffix(case_dir: Path, case: dict, suffix: str | None, root: Path) -> tuple[Path, dict]:
    """The case under the namespace <namespace>-<suffix>: its folder copied into root with that name written wherever the
    old one stands as a whole name (case.json, truth.json, the manifests), so the records of earlier runs —
    investigations, alerts, audit rows — name another namespace. Without a suffix, the case as it is."""
    if not suffix:
        return case_dir, case
    ns = case["namespace"]
    whole = re.compile(r"(?<![A-Za-z0-9-])" + re.escape(ns) + r"(?![A-Za-z0-9-])")
    dest = root / case_dir.name
    shutil.copytree(case_dir, dest)
    for f in sorted(dest.rglob("*")):
        if f.is_file():
            try:
                text = f.read_text(encoding="utf-8")
            except UnicodeDecodeError:
                continue
            f.write_text(whole.sub(f"{ns}-{suffix}", text), encoding="utf-8")
    return dest, json.loads((dest / "case.json").read_text())


def namespace_suffix(value: str | None) -> str | None:
    """--namespace-suffix: None without it, four random letters and digits for "random", else the value."""
    if value is None:
        return None
    if value == "random":
        return "".join(random.SystemRandom().choice(string.ascii_lowercase + string.digits) for _ in range(4))
    if not SUFFIX.match(value):
        raise ValueError(f"--namespace-suffix {value!r}: 1 to 8 lowercase letters and digits")
    return value


def round_counts(token: str, clusters: list[str]) -> dict:
    """Per cluster, how many alert investigations and alert inbox rows there are (the lists' total, read as the admin),
    or why not ("HTTP 404" while features.alertInvestigation is off)."""
    out = {}
    for cluster in clusters:
        q = urllib.parse.quote(cluster)
        row = {}
        for key, path in (("investigations", f"/api/v1/ai/investigations?cluster={q}&limit=1"), ("inbox", f"/api/v1/alerts/inbox?cluster={q}&limit=1")):
            try:
                with request("GET", path, token) as r:
                    row[key] = (json.load(r) or {}).get("total")
            except urllib.error.HTTPError as e:
                e.close()
                row[key] = f"HTTP {e.code}"
            except (*REQUEST_ERRORS, ValueError) as e:
                row[key] = type(e).__name__
        out[cluster] = row
    return out


def investigation_on(counts: dict) -> list[str]:
    """The clusters whose alert investigation is on at the round's start: their investigation list or inbox answered
    a total (off, they answer 404)."""
    return sorted(c for c, v in counts.items() if any(isinstance(v.get(k), int) and not isinstance(v.get(k), bool)
                                                     for k in ("investigations", "inbox")))


def save(out: Path, stamp: str, results: list[dict], previous: str | None, round_info: dict | None = None,
         final: bool = True) -> str:
    """The JSON report and the table as they stand (final: the run's last table, table()), named by the model once a
    result names it, and the round's record (<stamp>-round.json); returns the name."""
    model = next((r["model"] for r in results if r.get("model")), "model")
    base = f"{stamp}-{model}"
    out.mkdir(parents=True, exist_ok=True)
    if previous and previous != base:
        for ext in (".json", ".md"):
            (out / (previous + ext)).unlink(missing_ok=True)
    (out / f"{base}.json").write_text(json.dumps(results, ensure_ascii=False, indent=1))
    (out / f"{base}.md").write_text(table(results, round_info, final) + "\n")
    if round_info is not None:
        (out / f"{stamp}-round.json").write_text(json.dumps(round_info, ensure_ascii=False, indent=1) + "\n")
    return base


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
    ap.add_argument("--user", choices=USERS, default="read",
                    help="the account a hard case asks as: read (default), a member made for the case with Read on its cluster only, "
                         "which cannot read investigations or the audit log; admin, the signed-in admin. An easy case asks as its own user field")
    ap.add_argument("--namespace-suffix", metavar="SUFFIX",
                    help="run each case in <namespace>-<SUFFIX> (random: four random letters and digits, new each run), so the "
                         "records of earlier runs name another namespace")
    ap.add_argument("--alert-investigation-on", action="store_true",
                    help="ask hard cases while features.alertInvestigation is on (the runner refuses otherwise): a Read account "
                         "can open the investigation reports, and an investigation takes the model's Claude Code place; "
                         "recorded as alert_investigation_on in <stamp>-round.json")
    args = ap.parse_args()
    try:
        suffix = namespace_suffix(args.namespace_suffix)
    except ValueError as e:
        ap.error(str(e))
    cases, problems = load_cases(Path(args.cases).resolve(), args.only, args.hidden)  # $CASE_DIR is absolute
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
    clusters = sorted({c["cluster"] for _, c in cases})
    round_info = {"user": args.user, "namespace_suffix": suffix, "started": now_utc(), "before": round_counts(admin, clusters)}
    if any(rca.is_staged(c) for _, c in cases):
        on = investigation_on(round_info["before"])
        round_info["alert_investigation_on"] = bool(on)
        if on and not args.alert_investigation_on:
            print(f"problem: features.alertInvestigation is on in {', '.join(on)} (its investigation list answers): a Read account "
                  "can open the reports and an investigation takes the model's Claude Code place. Turn it off for a chat round "
                  "(evals/ai/README.md \"Hard cases\"), or pass --alert-investigation-on to run anyway", file=sys.stderr)
            return 2
        if on:
            print(f"WARNING: features.alertInvestigation is on in {', '.join(on)}; this round is not a measure of the chat alone "
                  "(alert_investigation_on in the round record)", flush=True)
    copies = Path(tempfile.mkdtemp(prefix="ai-eval-cases-"))
    results: list[dict] = []
    saved = None
    try:
        for case_dir, case in cases:
            case_dir, case = with_suffix(case_dir, case, suffix, copies)
            if rca.is_staged(case):
                results += run_staged_case(case_dir, case, admin, kcs, args, stamp, truth_dir)
            else:
                for n in range(args.repeat):
                    r = run_case(case_dir, admin, kcs, args.keep, f"{stamp}{n}")
                    r["run"] = n + 1
                    results.append(r)
                    print(f"{r['id']} run {n + 1}: {'pass' if r.get('pass') else 'FAIL'} — {len(r.get('calls', []))} calls, {r.get('seconds')} s", flush=True)
            saved = save(out, stamp, results, saved, round_info, final=False)
    finally:
        round_info["ended"] = now_utc()
        round_info["after"] = round_counts(admin, clusters)
        saved = save(out, stamp, results, saved, round_info)
        shutil.rmtree(copies, ignore_errors=True)
    print(table(results, round_info))
    return 0


if __name__ == "__main__":
    sys.exit(main())
