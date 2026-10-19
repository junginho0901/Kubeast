#!/usr/bin/env python3
"""AI analysis evaluation on the kind dev clusters (evals/ai/README.md).

Each case under evals/ai/<NN>_<name>/ makes a problem in its own namespace (case.json + setup.yaml), asks the AI
chat a question as an operator would, and checks the answer: every expected fact present (each a list of regular
expressions, any one matching), nothing forbidden, the tools it must call called. It records the tool calls, the
tokens and the seconds per case, deletes the namespace, and writes a JSON report and a markdown table. The model is
whatever the dev install's default is (scripts/kind-model-subscription.sh, deploy/kind/modelconfig-ollama.yaml):
run it once per model.

  python3 scripts/ai-eval.py --out /tmp/eval            # every case
  python3 scripts/ai-eval.py --out /tmp/eval 03 07      # cases whose id starts with 03 or 07
  python3 scripts/ai-eval.py --out /tmp/eval --repeat 3 --keep

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


def sh(cmd: str, kc: str, timeout: int = 300) -> subprocess.CompletedProcess:
    return subprocess.run(["bash", "-c", cmd], env={**os.environ, "KUBECONFIG": kc}, capture_output=True, text=True, timeout=timeout)


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


def run_case(case_dir: Path, admin: str, kcs: dict, keep: bool, stamp: str) -> dict:
    case = json.loads((case_dir / "case.json").read_text())
    cluster, ns = case["cluster"], case["namespace"]
    kc = kubeconfig(KIND[cluster], kcs)
    sh(f"kubectl delete namespace {ns} --ignore-not-found --wait=true", kc)
    sh(f"kubectl create namespace {ns} && kubectl label namespace {ns} kubeast.io/ai-eval=true", kc)
    if (case_dir / "setup.yaml").exists():
        r = sh(f"kubectl -n {ns} apply -f {case_dir / 'setup.yaml'}", kc)
        if r.returncode:
            return {"id": case["id"], "setup_error": r.stderr[-400:]}
    for step in case.get("setup_cmds", []):
        sh(step.replace("$NS", ns), kc, timeout=600)
    wait = case.get("wait")
    if wait:
        deadline = time.monotonic() + case.get("wait_seconds", 240)
        while time.monotonic() < deadline and sh(wait.replace("$NS", ns), kc).returncode != 0:
            time.sleep(5)
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


def table(results: list[dict]) -> str:
    rows = ["| 사례 | 정답 | 빠진 사실 | 안 부른 도구 | 도구 호출 (실패) | 토큰 | 초 |", "|---|---|---|---|---|---|---|"]
    for r in results:
        if "setup_error" in r:
            rows.append(f"| {r['id']} | 준비 실패 | {r['setup_error'][:80]} | | | | |")
            continue
        usage = r.get("tokens") or ""
        calls = f"{len(r['calls'])} ({sum(1 for c in r['calls'] if c['failed'])})"
        missing = " · ".join(g[0] for g in r["missing"]) + (f" · 금지 {r['forbidden']}" if r["forbidden"] else "") + (f" · 오류 {r['error']}" if r.get("error") else "")
        tools = " · ".join("/".join(g) for g in r["tools_missing"])
        rows.append(f"| {r['id']} {r['title']} | {'✅' if r['pass'] else '❌'} | {missing} | {tools} | {calls} | {usage} | {r['seconds']} |")
    ok = sum(1 for r in results if r.get("pass"))
    rows.append(f"\n정답 {ok}/{len(results)} · 모델 {next((r['model'] for r in results if r.get('model')), '?')}")
    return "\n".join(rows)


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("only", nargs="*", help="case id prefixes")
    ap.add_argument("--out", required=True, help="directory for the JSON report and the table")
    ap.add_argument("--repeat", type=int, default=1, help="runs per case")
    ap.add_argument("--keep", action="store_true", help="keep each case's namespace")
    args = ap.parse_args()
    kcs: dict = {}
    admin = login(os.environ.get("E2E_USER_EMAIL", "admin"), os.environ.get("E2E_USER_PASSWORD") or admin_password(kubeconfig("kubeast", kcs)))
    stamp = time.strftime("%Y%m%d%H%M%S", time.gmtime())
    cases = sorted(d for d in CASES.iterdir() if (d / "case.json").exists() and (not args.only or any(d.name.startswith(p) for p in args.only)))
    results = []
    for case_dir in cases:
        for n in range(args.repeat):
            r = run_case(case_dir, admin, kcs, args.keep, f"{stamp}{n}")
            r["run"] = n + 1
            results.append(r)
            print(f"{r['id']} run {n + 1}: {'pass' if r.get('pass') else 'FAIL'} — {len(r.get('calls', []))} calls, {r.get('seconds')} s", flush=True)
    out = Path(args.out)
    out.mkdir(parents=True, exist_ok=True)
    model = next((r["model"] for r in results if r.get("model")), "model")
    (out / f"{stamp}-{model}.json").write_text(json.dumps(results, ensure_ascii=False, indent=1))
    (out / f"{stamp}-{model}.md").write_text(table(results) + "\n")
    print(table(results))
    return 0


if __name__ == "__main__":
    sys.exit(main())
