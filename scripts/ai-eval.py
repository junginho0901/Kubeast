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

A hard case's row also carries `second`, the second scoring (scripts/ai_eval_second.py), next to the first; the table gives
the incidents and the controls of the second one apart.

With --alerts the alert investigation is measured instead of the chat (README "The alert path"): each hard case
with an `alert` runs in stages as above, but instead of the questions its alert reaches Kubeast's webhook — through
the second cluster's Prometheus and Alertmanager when the case's test rule is loaded there, or posted by the runner in
Alertmanager's form — and the investigation's report is scored against truth.json.

  python3 scripts/ai-eval.py --out /tmp/eval            # every case
  python3 scripts/ai-eval.py --out /tmp/eval 03 07      # cases whose id starts with 03 or 07
  python3 scripts/ai-eval.py --out /tmp/eval --repeat 3 --keep
  python3 scripts/ai-eval.py --cases evals/ai-hard --list
  python3 scripts/ai-eval.py --cases evals/ai-hard --out /tmp/eval-hard 06
  python3 scripts/ai-eval.py --cases evals/ai-hard --out /tmp/eval-hard --namespace-suffix random
  python3 scripts/ai-eval.py --cases evals/ai-hard --alerts --alert-source auto --out /tmp/eval-alerts

A hard case asks as a member made for it with Read on its cluster only (--user admin asks as the admin), so the
chat cannot read the investigations or the audit log of earlier runs. An HTTP error, a timeout or a dropped
connection is kept as that answer's error (a 429 or 5xx is tried once more) and the case goes on. Credentials come
from the cluster (the admin password and the webhook token in kubeast-secrets) and are never printed. The runner
signs in again before its token's lifetime is over and on a 401, so one call can run a whole round; the report files
are written again after each case, so a run that stops keeps the cases it finished.
"""
from __future__ import annotations

import argparse
import base64
import hashlib
import hmac
import http.client
import importlib.util
import json
import os
import random
import re
import secrets
import shlex
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
import ai_eval_second as second  # noqa: E402

ROOT = Path(__file__).resolve().parent.parent
CASES = ROOT / "evals" / "ai"
BASE = os.environ.get("E2E_BASE_URL", "http://localhost:30080").rstrip("/")
KIND = {"self": "kubeast", "default": "kubeast-b"}  # Kubeast cluster ID → kind cluster
# A token is used until this long before its lifetime is over (or a quarter of a short lifetime), then renewed: longer
# than a chat turn or an investigation step may run (the cases' timeout_seconds, at most 420, and a minute), since the
# server hands the token on to the turn's tool calls.
RENEW_MARGIN_SECONDS = 480
POLL_SECONDS = 5
# A read the alert path waits on is tried again POLL_SECONDS after a request error; this many failures in a row end that
# run of the case as a setup error (the case and the round go on).
POLL_ERRORS_IN_A_ROW = 6
ALERT_SOURCES = ("real", "auto", "synthetic")
INVESTIGATION_END = ("done", "failed", "skipped")
USERS = ("read", "admin")
# One chat turn's request error: a 429 or 5xx is tried once more after this wait; this many in a row end the case.
RETRY_STATUSES = (429, 500, 502, 503, 504)
RETRY_WAIT_SECONDS = 20
MAX_ERRORS_IN_A_ROW = 3
REQUEST_ERRORS = (urllib.error.URLError, http.client.HTTPException, OSError)
RESULT_CHARS = 4000  # of each tool result, in the saved answers
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


def token_lifetime(token: str) -> float | None:
    """exp − iat of a JWT, both written by the server's clock; None when it holds no such numbers."""
    try:
        part = token.split(".")[1]
        claims = json.loads(base64.urlsafe_b64decode(part + "=" * (-len(part) % 4)))
        life = float(claims["exp"]) - float(claims["iat"])
    except (IndexError, KeyError, TypeError, ValueError):
        return None
    return life if life > 0 else None


class Api:
    """Kubeast's API as one account. It signs in on first use and again before the token's lifetime is over — exp − iat
    counted on this machine's monotonic clock from the sign-in, so no server time is compared with this machine's — and
    once more on a 401, sending that call again once. The password stays in memory and is never printed."""

    def __init__(self, email: str, password: str):
        self.email, self._password = email, password
        self._token, self._renew_at, self.logins = "", 0.0, 0

    def login(self) -> str:
        """The sign-in token from the answer's Set-Cookie header."""
        # The sign-in cookie, which auth-service names by AUTH_COOKIE_NAME (kubeast.token when unset): with that variable set
        # here, __Host-<name> and <name> are read first, then __Host-kubeast.token and kubeast.token, the first one set taken.
        name = os.environ.get("AUTH_COOKIE_NAME", "")
        session_cookies = ((f"__Host-{name}", name) if name else ()) + ("__Host-kubeast.token", "kubeast.token")
        with request("POST", "/api/v1/auth/login", body={"email": self.email, "password": self._password}) as r:
            cookies = dict(c.split(";", 1)[0].strip().partition("=")[::2] for c in r.headers.get_all("Set-Cookie") or [])
        token = next((cookies[n] for n in session_cookies if cookies.get(n)), "")
        if not token:
            raise RuntimeError(f"sign-in of {self.email} set no {' or '.join(session_cookies)} cookie")
        self._token = token
        self.logins += 1
        life = token_lifetime(self._token)
        self._renew_at = float("inf") if life is None else time.monotonic() + life - min(RENEW_MARGIN_SECONDS, life / 4)
        return self._token

    def token(self) -> str:
        if not self._token or time.monotonic() >= self._renew_at:
            self.login()
        return self._token

    def open(self, method: str, path: str, body: dict | None = None, timeout: int = 60, cluster: str = ""):
        try:
            return request(method, path, self.token(), body, timeout, cluster)
        except urllib.error.HTTPError as e:
            if e.code != 401:
                raise
            e.close()
        self.login()
        return request(method, path, self._token, body, timeout, cluster)

    def json(self, method: str, path: str, body: dict | None = None, timeout: int = 60):
        with self.open(method, path, body, timeout) as r:
            raw = r.read()
        return json.loads(raw) if raw else None


def admin_password(kc: str) -> str:
    out = sh("kubectl -n kubeast get secret kubeast-secrets -o jsonpath='{.data.DEFAULT_ADMIN_PASSWORD}'", kc).stdout
    return base64.b64decode(out).decode()


def read_user(admin: Api, cluster: str, stamp: str) -> tuple[str, Api]:
    """A member with Read on cluster (the whole cluster, no other); returns (user id, its API). A member holds no
    admin.audit.read or admin.investigations.read, so the chat's audit_search and investigations refuse it. Its
    password is made for this account and kept in memory only, so one left behind by a failed delete opens to no one."""
    password = secrets.token_urlsafe(24)
    roles = admin.json("GET", "/api/v1/auth/roles")
    roles = roles if isinstance(roles, list) else roles.get("roles") or roles.get("items") or []
    member = next(x for x in roles if x["name"].lower() == "member")
    email = f"ai-eval-read-{stamp}@kubeast.local"
    uid = admin.json("POST", "/api/v1/auth/admin/users", {"name": "AI eval read", "email": email, "password": password, "role_id": member["id"]})["id"]
    try:
        admin.open("PUT", f"/api/v1/auth/admin/users/{uid}/cluster-roles/{cluster}", {"role": "Read"}).close()
        reader = Api(email, password)
        reader.login()
        return uid, reader
    except BaseException:
        admin.open("DELETE", f"/api/v1/auth/admin/users/{uid}").close()
        raise


def result_text(result) -> tuple[str, bool]:
    """A tool result as text (cut to RESULT_CHARS) and whether it is an error: the stream's JSON text, or an object."""
    text = result if isinstance(result, str) else json.dumps(result, ensure_ascii=False, default=str)
    head = text.lstrip()
    try:
        obj = json.loads(head) if head.startswith("{") else None
    except ValueError:  # cut, or not JSON
        obj = None
    failed = bool(obj.get("error")) if isinstance(obj, dict) else head.startswith('{"error"')
    return text[:RESULT_CHARS], failed or '"error": "Error in' in text


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


def ask(api: Api, cluster: str, question: str, timeout: int) -> dict:
    """One chat turn: the model, the tool calls (name, args, error or not), the answer, the usage, the seconds."""
    with api.open("POST", "/api/v1/sessions", {"title": "ai-eval"}, cluster=cluster) as r:
        sid = json.load(r)["id"]
    out = {"model": None, "provider": None, "calls": [], "answer": "", "error": None, "tokens": 0, "model_calls": 0}
    started = time.monotonic()
    try:
        with api.open("POST", f"/api/v1/ai/sessions/{sid}/chat", {"message": question}, timeout=timeout, cluster=cluster) as r:
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
            api.open("DELETE", f"/api/v1/sessions/{sid}").close()
        except Exception:
            pass
    return out


def request_error(e: BaseException) -> tuple[str, int | None, bool]:
    """(what to record, the HTTP status, whether to try again) for an error of a request."""
    if isinstance(e, urllib.error.HTTPError):
        return f"HTTP {e.code} {e.reason}", e.code, e.code in RETRY_STATUSES
    return f"{type(e).__name__}: {e}", None, False


def ask_kept(api: Api, cluster: str, question: str, timeout: int) -> dict:
    """ask(), with an HTTP error, a timeout or a dropped connection kept as the turn's error (request_error,
    error_status) instead of ending the case; a 429 or 5xx is tried once more after RETRY_WAIT_SECONDS. A 401 is
    signed in again by the Api first."""
    tries: list[str] = []
    while True:
        started = time.monotonic()
        try:
            run = ask(api, cluster, question, timeout)
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


def run_case(case_dir: Path, admin: Api, kcs: dict, keep: bool, stamp: str) -> dict:
    case = json.loads((case_dir / "case.json").read_text())
    cluster, ns = case["cluster"], case["namespace"]
    kc = kubeconfig(KIND[cluster], kcs)
    error, _ = prepare(case, case_dir, kc)
    if error:
        return {"id": case["id"], "setup_error": error}
    time.sleep(case.get("settle_seconds", 0))
    uid, api = None, admin
    if case.get("user") == "read":
        uid, api = read_user(admin, cluster, stamp)
    try:
        run = ask_kept(api, cluster, case["question"], case.get("timeout_seconds", 300))
    finally:
        if uid:
            admin.open("DELETE", f"/api/v1/auth/admin/users/{uid}").close()
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


def inject(case: dict, ns: str, kc: str, env: dict, marks: dict) -> str | None:
    """inject_cmds (INJECT_TIME taken before the first) and inject_wait; the setup error that stops the case, if any."""
    if not case.get("inject_cmds"):
        return None
    marks["INJECT_TIME"] = (now_utc(), time.monotonic())
    failed = run_steps(case["inject_cmds"], ns, kc, env)
    if failed:
        return f"inject {failed}"
    if case.get("inject_wait"):
        seconds = case.get("inject_wait_seconds", rca.DEFAULT_INJECT_WAIT_SECONDS)
        ok, last = poll(case["inject_wait"].replace("$NS", ns), kc, seconds, env)
        if not ok:
            return f"inject_wait still false after {seconds} s: {last[-400:]}"
    return None


def fault_start(case: dict, marks: dict) -> float:
    return marks["SETUP_TIME" if case.get("fault_start_at") == "setup" or "INJECT_TIME" not in marks else "INJECT_TIME"][1]


class Stage:
    """A staged case's marks, errors and undo, and its end: the undo of an injection that ran (even in part) and was not
    undone, the namespace and cleanup_cmds (both left with --keep), the filled truth copy, the marks on each result and
    the cooldown."""

    def __init__(self, case: dict, case_dir: Path, kc: str):
        self.case, self.kc, self.ns = case, kc, case["namespace"]
        self.env = {"CASE_DIR": str(case_dir)}
        self.truth = json.loads((case_dir / "truth.json").read_text()) if (case_dir / "truth.json").exists() else None
        self.rules = second.load_rules(case_dir)
        self.marks: dict[str, tuple[str, float]] = {}
        self.errors: list[str] = []
        self.undone = False

    def utc_marks(self) -> dict:
        return {k: v[0] for k, v in self.marks.items()}

    def filled_truth(self) -> dict:
        return rca.fill_placeholders(self.truth, self.utc_marks())

    def undo(self) -> None:
        if self.case.get("undo_cmds"):
            failed = run_steps(self.case["undo_cmds"], self.ns, self.kc, self.env)
            if failed:
                self.errors.append(f"undo {failed}")
        self.marks["UNDO_TIME"] = (now_utc(), time.monotonic())
        self.undone = True

    def close(self, results: list[dict], keep: bool, interrupted: bool, truth_dir: Path) -> None:
        if not keep:
            if not self.undone and "INJECT_TIME" in self.marks and self.case.get("undo_cmds"):
                self.undo()
            sh(f"kubectl delete namespace {self.ns} --ignore-not-found --wait=false", self.kc)
            for step in self.case.get("cleanup_cmds", []):
                sh(step.replace("$NS", self.ns), self.kc, env=self.env)
        if self.truth is not None and self.marks:
            truth_dir.mkdir(parents=True, exist_ok=True)
            copy = {**self.filled_truth(), **({"scoring": self.rules} if self.rules else {})}
            (truth_dir / f"{self.case['id']}.json").write_text(json.dumps(copy, ensure_ascii=False, indent=1) + "\n")
        for r in results:
            r["stage"] = {**self.utc_marks(), "errors": self.errors}
        if not keep and not interrupted:
            time.sleep(self.case.get("cooldown_seconds", 0))


def run_staged_case(case_dir: Path, case: dict, admin: Api, kcs: dict, args, stamp: str, truth_dir: Path) -> list[dict]:
    """A hard case in one setup: setup → baseline → inject → asks (each form × --repeat at each ask time, the undo of a
    fault_duration_seconds case among them) → undo → namespace and cleanup → cooldown. One result per ask."""
    cluster = case["cluster"]
    st = Stage(case, case_dir, kubeconfig(KIND[cluster], kcs))
    results: list[dict] = []
    user = user_of(case, args)
    head = {"id": case["id"], "title": case.get("title", ""), "hidden": bool(case.get("hidden")), "namespace": st.ns, "user": user}
    uid, interrupted = None, False
    try:
        api = admin
        if user == "read":
            try:
                uid, api = read_user(admin, cluster, f"{stamp}-{case['id'][:2]}")
            except (*REQUEST_ERRORS, ValueError, KeyError, StopIteration) as e:
                results.append({**head, "setup_error": f"read account: {request_error(e)[0]}"[:400]})
                return results
        error, setup_time = prepare(case, case_dir, st.kc)
        if error:
            results.append({**head, "setup_error": error})
            return results
        st.marks["SETUP_TIME"] = setup_time
        time.sleep(case.get("settle_seconds", 0) + case.get("baseline_seconds", 0))
        error = inject(case, st.ns, st.kc, st.env, st.marks)
        if error:
            results.append({**head, "setup_error": error})
            return results
        start = fault_start(case, st.marks)
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
                st.undo()
                continue
            due = time.monotonic() if at is None else start + at
            for form, question, n in rca.ask_order(case, args.repeat):
                late = max(0.0, time.monotonic() - due)
                asked_at = now_utc()
                run = ask_kept(api, cluster, rca.question_with_format(question, case.get("answer_format")), case.get("timeout_seconds", 300))
                r = {**head, "form": form, "ask_after": at, "asked_at": asked_at, "late_seconds": round(late), "run": n,
                     **run, **grade(case, run)}
                if case.get("answer_format") == "rca_block_v0" and st.truth is not None:
                    r["prose_pass"] = r["pass"]
                    r["rca"] = rca.score_rca(run["answer"], st.filled_truth(), run["calls"])
                    r["pass"] = r["rca"]["pass"] and not run["error"]
                    r["pass_grounded"] = r["pass"] and r["rca"]["ungrounded"] == 0
                    r["second"] = second.score_answer(run["answer"], st.filled_truth(), run["calls"], run["error"], st.rules)
                results.append(r)
                shown = "done" if head["hidden"] else ("pass" if r["pass"] else "FAIL")
                print(f"{case['id']} {form} {when(at)} run {n}: {shown} — {len(run['calls'])} calls, {run['seconds']} s", flush=True)
                in_a_row = in_a_row + 1 if run.get("request_error") else 0
                if in_a_row >= MAX_ERRORS_IN_A_ROW:
                    st.errors.append(f"stopped after {in_a_row} request errors in a row")
                    break
    except BaseException:
        interrupted = True
        raise
    finally:
        if uid:
            try:
                admin.open("DELETE", f"/api/v1/auth/admin/users/{uid}").close()
            except REQUEST_ERRORS as e:
                st.errors.append(f"read account not deleted: {request_error(e)[0]}"[:300])
        st.close(results, args.keep, interrupted, truth_dir)
    return results


# --- the alert path (README "The alert path") ---

def webhook_token(kcs: dict) -> str:
    out = sh("kubectl -n kubeast get secret kubeast-secrets -o jsonpath='{.data.ALERT_WEBHOOK_TOKEN}'", kubeconfig("kubeast", kcs)).stdout
    return base64.b64decode(out).decode()


def cluster_webhook_token(token: str, cluster: str) -> str:
    """One cluster's webhook token, as ai-service's webhook.cluster_token makes it; taken with
    features.alertInvestigation.webhookClusterTokensOnly too."""
    return hmac.new(token.encode(), cluster.encode(), hashlib.sha256).hexdigest()


def post_alert(cluster: str, alert: dict, token: str) -> dict:
    """One alert to the webhook in Alertmanager's message form (version 4); the webhook's counts. A 429 or 5xx is sent
    once more after RETRY_WAIT_SECONDS."""
    message = {"version": "4", "groupKey": '{}:{alertname="%s"}' % alert["labels"].get("alertname", ""), "status": alert["status"],
               "receiver": "ai-eval", "externalURL": "http://ai-eval.invalid", "alerts": [alert]}
    for n in range(2):
        try:
            with request("POST", f"/api/v1/alerts/webhook?cluster={urllib.parse.quote(cluster)}", cluster_webhook_token(token, cluster), message) as r:
                return json.load(r)
        except urllib.error.HTTPError as e:
            e.close()
            if n or e.code not in RETRY_STATUSES:
                raise
        time.sleep(RETRY_WAIT_SECONDS)
    raise AssertionError("unreachable")


class PollFailed(Exception):
    """A read the alert path waits on failed POLL_ERRORS_IN_A_ROW times in a row."""


def steady(read, *args, tick=None):
    """read(*args), tried again POLL_SECONDS later after a request error (an HTTP error, a timeout, a dropped
    connection; a 401 is signed in again by the Api first), with tick() between; PollFailed after
    POLL_ERRORS_IN_A_ROW in a row."""
    why = ""
    for n in range(POLL_ERRORS_IN_A_ROW):
        try:
            return read(*args)
        except REQUEST_ERRORS as e:
            why = request_error(e)[0]
            if isinstance(e, urllib.error.HTTPError):
                e.close()
        if n + 1 < POLL_ERRORS_IN_A_ROW:
            if tick:
                tick()
            time.sleep(POLL_SECONDS)
    raise PollFailed(f"{POLL_ERRORS_IN_A_ROW} reads in a row failed: {why}"[:300])


def synthetic_alert(case: dict, fingerprint: str, starts_at: str) -> dict:
    """The case's alert as Alertmanager would send it: alertname, the case's namespace and severity warning unless its
    labels say otherwise, and a fingerprint of the run's own."""
    alert = case["alert"]
    labels = {"alertname": rca.alert_name(case), "namespace": case["namespace"], "severity": "warning", **(alert.get("labels") or {})}
    return {"status": "firing", "labels": labels, "annotations": dict(alert.get("annotations") or {}), "startsAt": starts_at,
            "endsAt": "0001-01-01T00:00:00Z", "generatorURL": "", "fingerprint": fingerprint}


def replay_alert(item: dict, n: int) -> dict:
    """The alert Alertmanager sent (its inbox window), again under a fingerprint of its own: the investigator reads the
    same labels, annotations and start, and the webhook takes it as a new alert instead of a repeat."""
    return {"status": "firing", "labels": dict(item["labels"]), "annotations": dict(item.get("annotations") or {}),
            "startsAt": item["starts_at"], "endsAt": "0001-01-01T00:00:00Z", "generatorURL": item.get("generator_url") or "",
            "fingerprint": f"{item['fingerprint'][:48]}-replay{n}"}


def resolved(alert: dict) -> dict:
    return {**alert, "status": "resolved", "endsAt": now_utc()}


def rule_loaded(cluster: str, rule: str) -> bool:
    """Whether the cluster's Prometheus (NodePort 30090 on its kind node, deploy/kind/second-cluster.yaml) has an alert
    rule of that name loaded, that is whether the add-on that puts the test rules in is up."""
    try:
        r = subprocess.run(["docker", "exec", f"{KIND[cluster]}-control-plane", "curl", "-sf", "http://127.0.0.1:30090/api/v1/rules"],
                           capture_output=True, text=True, timeout=30)
        groups = json.loads(r.stdout)["data"]["groups"] if r.returncode == 0 else []
    except (OSError, subprocess.TimeoutExpired, ValueError, KeyError, TypeError):
        return False
    return any(x.get("name") == rule for g in groups for x in g.get("rules") or [])


def pick_source(case: dict, choice: str) -> tuple[str | None, str | None]:
    """real when the case's test rule is loaded; otherwise synthetic with --alert-source auto, or a problem."""
    rule = (case.get("alert") or {}).get("rule")
    if choice == "synthetic":
        return "synthetic", None
    if rule and rule_loaded(case["cluster"], rule):
        return "real", None
    if choice == "auto":
        return "synthetic", None
    why = f"test rule {rule} is not loaded in the Prometheus of cluster {case['cluster']}" if rule else "the case names no test rule (alert.rule)"
    return None, f"{why}; --alert-source auto or synthetic posts the alert instead"


def investigation_ids(admin: Api, cluster: str) -> set[str]:
    return {s["id"] for s in investigations(admin, cluster)}


def investigations(admin: Api, cluster: str) -> list[dict]:
    """The cluster's newest 200 investigations, newest first (summaries: no audit row is written for them)."""
    return admin.json("GET", f"/api/v1/ai/investigations?cluster={urllib.parse.quote(cluster)}&limit=200")["items"]


def inbox_rows(admin: Api, cluster: str, alertname: str) -> list[dict]:
    q = urllib.parse.urlencode({"cluster": cluster, "q": alertname, "limit": 200})
    return [r for r in admin.json("GET", f"/api/v1/alerts/inbox?{q}")["items"] if r.get("alertname") == alertname]


def same_time(a, b) -> bool:
    if not a or not b:
        return False
    return a == b or (rca.parse_time(a) is not None and rca.parse_time(a) == rca.parse_time(b))


def wait_until(t: float, tick) -> None:
    while True:
        tick()
        left = t - time.monotonic()
        if left <= 0:
            return
        time.sleep(min(POLL_SECONDS, left))


def wait_for_fired(admin: Api, case: dict, before: set, deadline: float, tick) -> dict | None:
    """The first new firing inbox row of the case's alert whose labels hold alert.match (the case's namespace unless it
    says otherwise; "" for a label the alert does not carry), as Alertmanager delivered it; None at the deadline."""
    alert = case["alert"]
    name, match = rca.alert_name(case), {"namespace": case["namespace"], **(alert.get("match") or {})}
    while True:
        tick()
        fresh = [r for r in steady(inbox_rows, admin, case["cluster"], name, tick=tick) if r["id"] not in before and r.get("status") == "firing"
                 and all(((r.get("labels") or {}).get(k) or "") == v for k, v in match.items())]
        if fresh:
            return min(fresh, key=lambda r: r.get("first_received_at") or "")
        if time.monotonic() >= deadline:
            return None
        time.sleep(POLL_SECONDS)


def find_investigation(admin: Api, cluster: str, row: dict, before: set, deadline: float, tick) -> tuple[dict | None, str]:
    """The investigation of this firing, waited for until it is done, failed or skipped: a new one (not in before) of the
    row's fingerprint that holds the row's starts_at — #909's match, by the alert's own start and never by comparing a
    received time with it — else the newest new one of that fingerprint, given up for one that holds the starts_at when
    one comes while it runs. Returns (its detail, "starts_at" or "fingerprint"), or (None, why)."""
    details: dict[str, dict] = {}
    chosen, how, looked = None, "", time.monotonic()
    while True:
        tick()
        items = steady(investigations, admin, cluster, tick=tick)
        if how != "starts_at":
            new = [s for s in items if s["id"] not in before and s.get("alertname") == row["alertname"]]
            for s in new:
                if s["id"] not in details:  # a detail read writes ai.investigation.view: once per investigation
                    details[s["id"]] = steady(admin.json, "GET", f"/api/v1/ai/investigations/{s['id']}", tick=tick)
            mine = [details[s["id"]] for s in new if details[s["id"]].get("fingerprint") == row["fingerprint"]]
            exact = [d for d in mine if same_time(d.get("starts_at"), row.get("starts_at"))]
            if exact or (mine and chosen is None):
                chosen, how = (exact or mine)[0]["id"], "starts_at" if exact else "fingerprint"
            elif chosen is None and time.monotonic() - looked > 30:
                linked = (steady(admin.json, "GET", f"/api/v1/alerts/inbox/{row['id']}", tick=tick).get("investigation") or {}).get("id")
                if linked in before:
                    return None, f"folded into the earlier investigation {linked} (features.alertInvestigation.dedupeHours)"
        if chosen is not None:
            summary = next((s for s in items if s["id"] == chosen), None)
            if summary is not None and summary.get("status") in INVESTIGATION_END:
                return steady(admin.json, "GET", f"/api/v1/ai/investigations/{chosen}", tick=tick), how
        if time.monotonic() >= deadline:
            if chosen is not None:
                return None, f"investigation {chosen} not finished in time"
            return None, ("no investigation of this alert was queued: features.alertInvestigation.automatic off, its severity "
                          "not in severities, or a cap")
        time.sleep(POLL_SECONDS)


def alert_result(case: dict, truth: dict, detail: dict, rules: dict | None = None) -> dict:
    """An investigation's detail as a result row: the report as the answer, its tool calls, tokens, model calls and run
    time; the report's words scored with score_text (pass and score, the same with v0.7.9's switches on or off), its
    rca block — the stored result (kept as stored_result), else a block still in the report — with score_block beside it,
    expect as prose_pass; the second scoring, with the outcome the server keeps when the result holds one, as second."""
    calls = [{"tool": c.get("tool"), "args": c.get("args"), "failed": bool(c.get("error")),
              **{k: c[k] for k in ("step", "error", "result_chars", "requests", "repeat_of") if k in c}} for c in detail.get("tool_calls") or []]
    status = detail.get("status")
    error = None if status == "done" else f"investigation {status}: {detail.get('error') or detail.get('skip_reason') or ''}"[:300]
    run = {"model": detail.get("model"), "provider": detail.get("provider"), "calls": calls, "answer": detail.get("report") or "",
           "error": error, "tokens": detail.get("total_tokens") or 0, "model_calls": detail.get("iterations") or 0,
           "seconds": round((detail.get("duration_ms") or 0) / 1000, 1)}
    r = {"investigation_id": detail.get("id"), **run, **grade(case, run)}
    r["prose_pass"] = r["pass"]
    r["text"] = rca.score_text(run["answer"], truth)
    block, block_status = rca.block_of_result(detail.get("result"))
    if detail.get("result") is None:
        block, block_status = rca.extract_block(run["answer"])
    if detail.get("result") is not None or block_status != "missing":
        r["rca"] = rca.score_block(block, block_status, truth, calls)
    if detail.get("result") is not None:
        r["stored_result"] = detail["result"]
    r["second"] = second.score_report(run["answer"], block, block_status, truth, calls, error, rules, second.kept_outcome(detail.get("result")))
    r["pass"] = r["text"]["pass"] and not error
    r["score"] = r["text"]["score"] if not error else 0.0
    if truth.get("control"):
        r["wrong_suspect"] = not r["text"]["pass"]
    return r


# What a pod of ai-service gives of its recorded tool answers: {file name: [the answer's first n characters, its length,
# recorded_at]} for the names asked that it holds.
RECORDINGS_READER = """
import json, os, sys
out = {}
for name in sys.argv[3:]:
    try:
        with open(os.path.join(sys.argv[1], name), encoding="utf-8") as f:
            record = json.load(f)
        text = str(record["result"])
        out[name] = [text[:int(sys.argv[2])], len(text), record.get("recorded_at")]
    except (OSError, ValueError, KeyError, TypeError):
        pass
print(json.dumps(out, ensure_ascii=False))
"""


def tool_replay():
    """ai-service's tool_replay.py, for the key and the file name of a recording (at module level it imports only the
    standard library)."""
    name = "ai_eval_tool_replay"
    if name not in sys.modules:
        spec = importlib.util.spec_from_file_location(name, ROOT / "services" / "ai-service" / "app" / "services" / "ai" / "tool_replay.py")
        sys.modules[name] = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(sys.modules[name])
    return sys.modules[name]


def recordings_dir(kcs: dict) -> str | None:
    """The directory ai-service records tool answers in, None unless it runs with AI_TOOL_REPLAY_MODE=record."""
    replay = tool_replay()
    env = '.spec.template.spec.containers[?(@.name=="ai-service")].env[?(@.name=="%s")].value'
    path = "{%s}{\"\\n\"}{%s}" % (env % replay.MODE_ENV, env % replay.DIR_ENV)
    out = sh(f"kubectl -n kubeast get deploy ai-service -o jsonpath={shlex.quote(path)}", kubeconfig("kubeast", kcs)).stdout.splitlines()
    mode, directory = [*(x.strip() for x in out), "", ""][:2]
    return directory if mode.lower() == replay.RECORD and directory else None


def keep_tool_results(kcs: dict, directory: str, cluster: str, calls: list[dict]) -> dict:
    """Give each call of an investigation that ran the answer ai-service recorded for it, cut to RESULT_CHARS (result,
    recorded_chars, recorded_at); a repeat it refused got no answer of its own. Read from the pods right after the
    investigation, before a later one records the same call again. Returns {kept, of[, error]}; nothing here fails a run."""
    replay = tool_replay()
    names = {i: replay.path_for(Path(directory), c["tool"] or "", replay.key(cluster, c["tool"] or "", c.get("args"))).name
             for i, c in enumerate(calls) if "repeat_of" not in c}
    kc, held, why = kubeconfig("kubeast", kcs), {}, ""
    pods = sh("kubectl -n kubeast get pods -l app=ai-service --field-selector=status.phase=Running -o name", kc).stdout.split()
    if not pods:
        why = "no ai-service pod"
    for pod in pods if names else []:
        args = " ".join(shlex.quote(x) for x in ("python", "-c", RECORDINGS_READER, directory, str(RESULT_CHARS), *sorted(set(names.values()))))
        r = sh(f"kubectl -n kubeast exec {pod} -c ai-service -- {args}", kc)
        try:
            held.update(json.loads(r.stdout) if r.returncode == 0 else {})
        except ValueError:
            why = "a pod's answer is not JSON"
        if r.returncode:
            why = (r.stderr or f"exit {r.returncode}").strip()[-200:]
    kept = 0
    for i, name in names.items():
        if name in held:
            calls[i]["result"], calls[i]["recorded_chars"], calls[i]["recorded_at"] = held[name]
            kept += 1
    return {"kept": kept, "of": len(names), **({"error": why} if why and kept < len(names) else {})}


def run_alert_case(case_dir: Path, case: dict, admin: Api, kcs: dict, args, stamp: str, truth_dir: Path, wtoken: str) -> list[dict]:
    """A hard case whose alert starts an investigation: setup → baseline → inject → the alert (--repeat runs, one after
    another) → each investigation waited for and scored → undo → namespace and cleanup → cooldown. Run 1 is the test
    rule firing through Alertmanager when it is loaded (later runs replay that alert) or the case's alert posted at
    alert.after_seconds; the alerts the runner posted are resolved at the end."""
    cluster = case["cluster"]
    alert, name = case["alert"], rca.alert_name(case)
    head = {"id": case["id"], "title": case.get("title", ""), "hidden": bool(case.get("hidden")), "form": "alert"}
    source, problem = pick_source(case, args.alert_source)
    if problem:
        return [{**head, "setup_error": problem}]
    st = Stage(case, case_dir, kubeconfig(KIND[cluster], kcs))
    results: list[dict] = []
    sent: list[dict] = []
    interrupted = False

    def tick() -> None:  # a fault_duration_seconds undo, at its time, while the runner waits
        duration = case.get("fault_duration_seconds")
        if duration is not None and not st.undone and "INJECT_TIME" in st.marks and time.monotonic() >= st.marks["INJECT_TIME"][1] + duration:
            st.undo()

    try:
        error, setup_time = prepare(case, case_dir, st.kc)
        if error:
            results.append({**head, "setup_error": error})
            return results
        st.marks["SETUP_TIME"] = setup_time
        time.sleep(case.get("settle_seconds", 0) + case.get("baseline_seconds", 0))
        try:
            before = steady(investigation_ids, admin, cluster, tick=tick)
            rows_before = {r["id"] for r in steady(inbox_rows, admin, cluster, name, tick=tick)} if source == "real" else set()
        except PollFailed as e:
            results.append({**head, "setup_error": f"before the fault: {e}"})
            return results
        error = inject(case, st.ns, st.kc, st.env, st.marks)
        if error:
            results.append({**head, "setup_error": error})
            return results
        start = fault_start(case, st.marks)
        fired = None
        for n in range(args.repeat):
            run_head = {**head, "run": n + 1}
            src = None
            try:
                at = None
                if source == "real" and n == 0:
                    src = "real"
                    row = wait_for_fired(admin, case, rows_before, start + alert.get("fire_wait_seconds", rca.DEFAULT_FIRE_WAIT_SECONDS), tick)
                    if row is None:
                        results.append({**run_head, "alert_source": src, "setup_error": f"{name} did not fire within "
                                        f"{alert.get('fire_wait_seconds', rca.DEFAULT_FIRE_WAIT_SECONDS)} s of the fault start"})
                        break
                    fired = steady(admin.json, "GET", f"/api/v1/alerts/inbox/{row['id']}", tick=tick)
                    triggered, sent_at = time.monotonic(), now_utc()
                else:
                    src = "synthetic" if source == "synthetic" else "replay"
                    if src == "replay" and fired is None:
                        results.append({**run_head, "alert_source": src, "setup_error": "no fired alert to send again: run 1 did not get one"})
                        continue
                    if src == "synthetic":
                        at = rca.alert_after(case)
                        if n == 0:
                            wait_until(start + at, tick)
                    triggered, sent_at = time.monotonic(), now_utc()
                    if src == "synthetic":
                        # started a minute before it is sent, as Alertmanager's are, but not before the fault (#909's e2e)
                        starts = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime(time.time() - min(60.0, max(0.0, triggered - start))))
                        message = synthetic_alert(case, f"ai-eval-{stamp}-{case['id'][:24]}-{n + 1}", starts)
                    else:
                        message = replay_alert(fired, n + 1)
                    counts = post_alert(cluster, message, wtoken)
                    sent.append(message)
                    if counts.get("accepted") != 1:
                        results.append({**run_head, "alert_source": src, "setup_error": f"the webhook queued no investigation: {counts}"})
                        continue
                    rows = steady(inbox_rows, admin, cluster, message["labels"]["alertname"], tick=tick)
                    row = next((r for r in rows if r["fingerprint"] == message["fingerprint"]), None)
                    if row is None:
                        results.append({**run_head, "alert_source": src, "setup_error": "the alert is not in the inbox after the webhook took it"})
                        continue
                deadline = time.monotonic() + alert.get("investigation_wait_seconds", rca.DEFAULT_INVESTIGATION_WAIT_SECONDS)
                detail, how = find_investigation(admin, cluster, row, before, deadline, tick)
                trigger = {"alert_source": src, "ask_after": at, "asked_at": sent_at, "alert_after_seconds": round(triggered - start),
                           "late_seconds": 0 if at is None else round(max(0.0, triggered - (start + at))),
                           "waited_seconds": round(time.monotonic() - triggered), "fingerprint": row["fingerprint"],
                           "starts_at": row.get("starts_at"), "matched_by": how if detail else None}
                if detail is None:
                    results.append({**run_head, **trigger, "setup_error": how})
                    continue
                before.add(detail["id"])
                r = {**run_head, **trigger, **alert_result(case, st.filled_truth(), detail, st.rules)}
                if getattr(args, "recordings", None):
                    r["tool_results"] = keep_tool_results(kcs, args.recordings, cluster, r["calls"])
                results.append(r)
                shown = "done" if head["hidden"] else ("pass" if r["pass"] else "FAIL")
                print(f"{case['id']} alert {src} run {n + 1}: {shown} — {len(r['calls'])} calls, {r['seconds']} s", flush=True)
            except (PollFailed, *REQUEST_ERRORS, ValueError) as e:  # this run only: the next runs and cases go on
                why = str(e) if isinstance(e, PollFailed) else request_error(e)[0] if isinstance(e, REQUEST_ERRORS) else type(e).__name__
                if isinstance(e, urllib.error.HTTPError):
                    e.close()
                results.append({**run_head, "alert_source": src, "setup_error": f"request failed: {why}"[:400]})
    except BaseException:
        interrupted = True
        raise
    finally:
        for message in sent:  # the inbox rows the runner made stop firing, so no later case reads them as open
            try:
                post_alert(cluster, resolved(message), wtoken)
            except (urllib.error.URLError, OSError, ValueError) as e:
                st.errors.append(f"resolve {message['fingerprint']}: {e}"[:300])
        st.close(results, args.keep, interrupted, truth_dir)
    return results


def when(at) -> str:
    return "now" if at is None else f"+{at}s"


def table(results: list[dict], round_info: dict | None = None, final: bool = True) -> str:
    """The markdown table: one row per shown result, the rca and alert scores, and the totals. A hidden case's
    results are left out; their total is given only in a run's last table (final) and only when two or more hidden
    cases have a scored row (a case whose setup failed has none), so no line, and no change between the tables written
    during a run, gives one hidden case's score."""
    rows = ["| 사례 | 정답 | 빠진 사실 | 안 부른 도구 | 도구 호출 (실패) | 토큰 | 초 |", "|---|---|---|---|---|---|---|"]
    shown = [r for r in results if not r.get("hidden")]
    mark = {True: "✅", False: "❌", None: "-"}
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
        for r in scored:
            s = r["rca"]
            rows.append(f"| {r['id']} · {r['form']} · {when(r['ask_after'])} · #{r['run']} | {mark[s['pass']]} | {mark[s.get('pass_grounded')]} | "
                        f"{s['score']:.2f} | {' · '.join(s['decoys_taken'])} | {' · '.join(s['extras'])} | {mark[s['time_ok']]} | "
                        f"{mark[s['path_ok']]} | {s['ungrounded']} | {s['block']} |")
    alerts = [r for r in shown if "text" in r]
    if alerts:
        rows += ["", "| 사례 · 회차 | 알림 | 글 채점 | 원인 이름 · 종류 | 고장 없음 | 원인으로 댄 미끼 | rca | 조사 초 | 기다린 초 |",
                 "|---|---|---|---|---|---|---|---|---|"]
        for r in alerts:
            t = r["text"]
            causes = " · ".join(f"{mark[c['resource_found']]}{mark[c['kind_found']]}" for c in t["causes"])
            rows.append(f"| {r['id']} · #{r['run']} | {r['alert_source']} | {mark[t['pass']]} | {causes} | {mark[t['no_fault']]} | "
                        f"{' · '.join(t['decoys_named'])} | {mark[r['rca']['pass']] if 'rca' in r else '-'} | {r['seconds']} | {r['waited_seconds']} |")
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
            again = (f" · 새 채점 정답 {sum(1 for r in hidden_scored if r['second']['pass'])}/{len(hidden_scored)}"
                     if all((r.get("second") or {}).get("by") == "block" for r in hidden_scored) else "")  # never parted into incidents and controls: one kind may hold one case
            rows.append(f"\n숨김 사례 {len(scored_ids)}개: 정답 {sum(1 for r in hidden_scored if r.get('pass'))}/{len(hidden_scored)}{again} (사례별 결과는 JSON에만)")
        elif hidden:
            rows.append("\n숨김 사례: 채점된 사례가 둘이 안 되어 결과는 JSON에만")
        ok = sum(1 for r in shown if r.get("pass"))
        grounded = sum(1 for r in shown if r.get("pass_grounded"))
        rows.append(f"\n정답 {ok}/{len(shown)}" + (f" (근거 있는 정답 {grounded})" if scored else "") + (" · 숨김 빼고" if hidden else "") + f" · 모델 {model}")
        rows += second.tables(shown)
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


def round_counts(api: Api, clusters: list[str]) -> dict:
    """Per cluster, how many alert investigations and alert inbox rows there are (the lists' total, read as the admin),
    or why not (the inbox answers "HTTP 404" while features.alertInvestigation is off; the investigation list answers
    either way, its earlier reports staying listed)."""
    out = {}
    for cluster in clusters:
        q = urllib.parse.quote(cluster)
        row = {}
        for key, path in (("investigations", f"/api/v1/ai/investigations?cluster={q}&limit=1"), ("inbox", f"/api/v1/alerts/inbox?cluster={q}&limit=1")):
            try:
                row[key] = (api.json("GET", path) or {}).get("total")
            except urllib.error.HTTPError as e:
                e.close()
                row[key] = f"HTTP {e.code}"
            except (*REQUEST_ERRORS, ValueError) as e:
                row[key] = type(e).__name__
        out[cluster] = row
    return out


def load_cases(root: Path, only: list[str], hidden: bool, alerts: bool = False) -> tuple[list[tuple[Path, dict]], list[str]]:
    """(case dir, case) for each case to run, in the order they run (rca.run_order), and the problems that stop the run.
    With alerts, only the cases with an alert. A hidden case's problem lines name nothing of its truth."""
    picked, problems = [], []
    for d in sorted(d for d in root.iterdir() if (d / "case.json").exists() and (not only or any(d.name.startswith(p) for p in only))):
        try:
            case = json.loads((d / "case.json").read_text())
        except ValueError as e:
            problems.append(f"{d.name}: case.json: {e}")
            continue
        if (case.get("hidden") and not hidden) or (alerts and "alert" not in case):
            continue
        problems += [f"{d.name}: {p}" for p in rca.check_case(case, (d / "truth.json").exists())]
        if "alert" in case and (d / "truth.json").exists():
            try:
                scope = rca.check_alert_scope(case, json.loads((d / "truth.json").read_text()))
            except ValueError as e:
                scope = [f"truth.json: {e}"]
            if case.get("hidden") and scope:  # a hidden case's line names none of its truth
                scope = ["its alert's namespace is not where a cause of its truth is (hidden: the names are in its folder)"]
            problems += [f"{d.name}: {p}" for p in scope]
        if (d / second.RULES_FILE).exists():
            problems += [f"{d.name}: {p}" for p in second.case_problems(d, bool(case.get("hidden")))]
        if case.get("cluster") not in KIND:
            problems.append(f"{d.name}: cluster {case.get('cluster')!r} is not one of {sorted(KIND)}")
        picked.append((d, case))
    return rca.run_order(picked), problems


def listing(cases: list[tuple[Path, dict]]) -> str:
    rows = ["| id | cluster | namespace | staged | forms | ask after (s) | alert | truth | hidden |", "|---|---|---|---|---|---|---|---|---|"]
    for d, c in cases:
        staged = rca.is_staged(c)
        times = ", ".join("now" if t is None else str(t) for t in rca.ask_times(c)) if staged else ""
        alert = ""
        if isinstance(c.get("alert"), dict):
            alert = f"{rca.alert_name(c)} +{rca.alert_after(c)}s" + (" (rule)" if c["alert"].get("rule") else "")
        rows.append(f"| {c.get('id')} | {c.get('cluster')} | {c.get('namespace')} | {'yes' if staged else ''} | "
                    f"{len(rca.question_forms(c))} | {times} | {alert} | {'yes' if (d / 'truth.json').exists() else ''} | {'yes' if c.get('hidden') else ''} |")
    return "\n".join(rows)


def investigation_on(counts: dict) -> list[str]:
    """The clusters whose alert investigation is on at the round's start: the inbox answers a total (off, it answers
    404); the investigation list answers whether or not the switch is on, so it says nothing of it."""
    return sorted(c for c, v in counts.items() if isinstance(v.get("inbox"), int) and not isinstance(v.get("inbox"), bool))


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


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("only", nargs="*", help="case id prefixes")
    ap.add_argument("--out", help="directory for the JSON report, the table and the filled truth copies")
    ap.add_argument("--cases", default=str(CASES), help="directory of case folders (default evals/ai)")
    ap.add_argument("--repeat", type=int, default=1, help="runs per case (a hard case: asks per form and ask time, in one setup)")
    ap.add_argument("--keep", action="store_true", help="leave each case as it ends: namespace kept, no undo, no cleanup")
    ap.add_argument("--hidden", action="store_true", help="also run the cases marked hidden (the table shows only their total)")
    ap.add_argument("--list", action="store_true", help="list the cases that would run and check their fields; touches no cluster")
    ap.add_argument("--alerts", action="store_true", help="the alert investigation instead of the chat: the cases with an alert")
    ap.add_argument("--alert-source", choices=ALERT_SOURCES, default="auto",
                    help="auto (default): the test rule firing through Alertmanager where it is loaded, else the runner posts the "
                         "alert; real: only the rule, a case without a loaded rule not run; synthetic: always posted")
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
    ap.add_argument("--alert-tool-results", action="store_true",
                    help="with --alerts: keep each tool result of an investigation, as ai-service records it; ai-service must run with "
                         "AI_TOOL_REPLAY_MODE=record (README \"Recorded tool answers\")")
    args = ap.parse_args()
    if args.alert_tool_results and not args.alerts:
        ap.error("--alert-tool-results is for --alerts: a chat's tool results are in its stream")
    try:
        suffix = namespace_suffix(args.namespace_suffix)
    except ValueError as e:
        ap.error(str(e))
    cases, problems = load_cases(Path(args.cases).resolve(), args.only, args.hidden, args.alerts)  # $CASE_DIR is absolute
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
    args.recordings = recordings_dir(kcs) if args.alert_tool_results else None
    if args.alert_tool_results and not args.recordings:
        print("problem: --alert-tool-results: ai-service does not run with AI_TOOL_REPLAY_MODE=record and an AI_TOOL_REPLAY_DIR "
              "(evals/ai/README.md \"Recorded tool answers\")", file=sys.stderr)
        return 2
    admin = Api(os.environ.get("E2E_USER_EMAIL", "admin"), os.environ.get("E2E_USER_PASSWORD") or admin_password(kubeconfig("kubeast", kcs)))
    admin.login()
    wtoken = webhook_token(kcs) if args.alerts else ""
    stamp = time.strftime("%Y%m%d%H%M%S", time.gmtime())
    out = Path(args.out)
    truth_dir = out / f"{stamp}-truth"
    clusters = sorted({c["cluster"] for _, c in cases})
    round_info = {"user": "admin" if args.alerts else args.user, "namespace_suffix": suffix, "started": now_utc(),
                  "second_scoring": second.RULES, "before": round_counts(admin, clusters)}
    if not args.alerts and any(rca.is_staged(c) for _, c in cases):
        on = investigation_on(round_info["before"])
        round_info["alert_investigation_on"] = bool(on)
        if on and not args.alert_investigation_on:
            print(f"problem: features.alertInvestigation is on in {', '.join(on)} (its alert inbox answers): a Read account "
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
            if args.alerts:
                results += run_alert_case(case_dir, case, admin, kcs, args, stamp, truth_dir, wtoken)
            elif rca.is_staged(case):
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
