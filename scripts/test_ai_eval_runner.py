"""Checks scripts/ai-eval.py's chat path against a stand-in of Kubeast's API (a local HTTP server): a hard case asks as
a Read account made for it, a request error keeps the answers already received (a 429 or 5xx tried once more, three in
a row end the case), a failing setup step or wait is a setup error, the question forms take turns, the round records
the investigation and inbox counts and the report is written after each case. No cluster: the runner's shell steps and
clock are replaced, so nothing here reaches kubectl, kind or a model.

  python3 -m pytest -q scripts/test_ai_eval_runner.py
  python3 scripts/test_ai_eval_runner.py        # the same checks without pytest
"""
import argparse
import importlib.util
import json
import os
import re
import subprocess
import sys
import tempfile
import threading
import time
import urllib.parse
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

HERE = Path(__file__).resolve().parent
ROOT = HERE.parent
sys.path.insert(0, str(HERE))


def _load_ai_eval():
    spec = importlib.util.spec_from_file_location("ai_eval_runner_under_test", HERE / "ai-eval.py")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


AI_EVAL = _load_ai_eval()
PASSWORD = "admin-pass"


def block_for(question: str) -> dict:
    """The right block for the namespace the question names."""
    ns = re.search(r"shop-[0-9]+(?:-[a-z0-9]+)?", question).group(0)
    return {"no_fault": False, "causes": [{"resource": f"ConfigMap/{ns}/settings-b", "kind": "config_change", "started_at": None,
                                           "evidence": [1]}], "path": [], "ruled_out": []}


class FakeTime:
    """The runner's clock: sleep moves monotonic on at once; wall time and formatting stay real."""

    def __init__(self):
        self.now = 1000.0

    def monotonic(self):
        return self.now

    def sleep(self, seconds):
        self.now += max(0.0, seconds)

    def __getattr__(self, name):
        return getattr(time, name)


class FakeKubeast:
    """The routes the chat path calls. chat_script holds what each chat answers in turn: "ok", "slow" (later than the
    case's timeout) or an HTTP status; past its end, `then`."""

    def __init__(self):
        self.tokens: dict[str, str] = {}   # token → email
        self.users: dict[str, dict] = {}
        self.grants: list[tuple] = []
        self.deleted: list[str] = []
        self.sessions: list[str] = []      # the email each chat session was opened as
        self.chats = 0
        self.chat_script: list = []
        self.then = "ok"
        self.on_chat = lambda n: None
        self.totals = {"investigations": 2, "inbox": 3}
        self.lock = threading.Lock()

    def email_of(self, headers):
        auth = headers.get("Authorization", "")
        return self.tokens.get(auth[7:]) if auth.startswith("Bearer ") else None

    def handle(self, method, path, query, headers, body):
        with self.lock:
            if path == "/api/v1/auth/login":
                user = next((u for u in self.users.values() if u["email"] == body.get("email")), None)
                if not ((body.get("email") == "admin" and body.get("password") == PASSWORD)
                        or (user and body.get("password") == user["password"])):
                    return 401, {"detail": "bad credentials"}
                token = f"t{len(self.tokens) + 1}"
                self.tokens[token] = body["email"]
                return 200, {"access_token": token}
            who = self.email_of(headers)
            if who is None:
                return 401, {"detail": "Unauthorized"}
            admin = who == "admin"
            if path == "/api/v1/auth/roles":
                return 200, [{"id": 1, "name": "Admin"}, {"id": 2, "name": "Member"}, {"id": 3, "name": "Read"}]
            if path == "/api/v1/auth/admin/users" and method == "POST" and admin:
                uid = f"u{len(self.users) + 1}"
                self.users[uid] = dict(body, id=uid)
                return 201, {"id": uid}
            if path.startswith("/api/v1/auth/admin/users/") and admin:
                parts = path.split("/")
                if method == "PUT" and "cluster-roles" in parts:
                    self.grants.append((parts[6], parts[8], body))
                    return 200, {}
                if method == "DELETE":
                    self.users.pop(parts[6], None)
                    self.deleted.append(parts[6])
                    return 204, None
            if path == "/api/v1/sessions" and method == "POST":
                self.sessions.append(who)
                return 201, {"id": f"s{len(self.sessions)}"}
            if path.startswith("/api/v1/sessions/") and method == "DELETE":
                return 204, None
            if path.startswith("/api/v1/ai/sessions/") and path.endswith("/chat"):
                self.chats += 1
                action = self.chat_script[self.chats - 1] if self.chats <= len(self.chat_script) else self.then
                self.on_chat(self.chats)
                if isinstance(action, int):
                    return action, {"detail": "stand-in error"}
                events = [{"model_info": {"model": "claude-haiku-5-5", "provider": "claude-code"}},
                          {"function": "k8s_get_resources", "args": {"resource_type": "configmaps"}, "call_id": 1},
                          {"function_result": "k8s_get_resources", "result": "settings-b", "call_id": 1},
                          {"content": "The ConfigMap settings-b changed.\n\n```rca\n" + json.dumps(block_for(body["message"])) + "\n```\n"},
                          {"usage": {"total_tokens": 100}}]
                return (200, "".join(f"data: {json.dumps(e)}\n\n" for e in events) + "data: [DONE]\n\n", action == "slow")
            if path in ("/api/v1/ai/investigations", "/api/v1/alerts/inbox"):
                if not admin and path.endswith("investigations"):
                    return 403, {"detail": "permission required: admin.investigations.read"}
                key = "investigations" if path.endswith("investigations") else "inbox"
                return 200, {"items": [], "total": self.totals[key]}
            return 404, {"detail": f"no route {method} {path}"}


class Server:
    def __init__(self, fake: FakeKubeast):
        self.fake = fake
        outer = self

        class Handler(BaseHTTPRequestHandler):
            def _serve(self):
                url = urllib.parse.urlsplit(self.path)
                query = dict(urllib.parse.parse_qsl(url.query))
                length = int(self.headers.get("Content-Length") or 0)
                body = json.loads(self.rfile.read(length)) if length else {}
                status, answer, *slow = outer.fake.handle(self.command, url.path, query, self.headers, body)
                if slow and slow[0]:
                    time.sleep(1.5)  # past the case's timeout_seconds of 1: the runner's read times out
                stream = isinstance(answer, str)
                data = answer.encode() if stream else b"" if answer is None else json.dumps(answer).encode()
                try:
                    self.send_response(status)
                    self.send_header("Content-Type", "text/event-stream" if stream else "application/json")
                    self.send_header("Content-Length", str(len(data)))
                    self.end_headers()
                    self.wfile.write(data)
                except (BrokenPipeError, ConnectionResetError):
                    pass

            do_GET = do_POST = do_PUT = do_DELETE = _serve

            def log_message(self, *args):
                pass

        self.httpd = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        self.thread = threading.Thread(target=self.httpd.serve_forever, daemon=True)

    def __enter__(self):
        self.thread.start()
        self.saved = {k: getattr(AI_EVAL, k) for k in ("BASE", "time", "sh", "kubeconfig")}
        AI_EVAL.BASE = f"http://127.0.0.1:{self.httpd.server_address[1]}"
        self.clock = FakeTime()
        AI_EVAL.time = self.clock
        self.commands: list[str] = []
        self.answer = lambda cmd: (0, "", "")

        def sh(cmd, kc, timeout=300, env=None):
            self.commands.append(cmd)
            rc, out, err = self.answer(cmd)
            return subprocess.CompletedProcess(["bash", "-c", cmd], rc, out, err)

        AI_EVAL.sh = sh
        AI_EVAL.kubeconfig = lambda name, cache: "/nonexistent/kubeconfig"
        return self

    def __exit__(self, *exc):
        for k, v in self.saved.items():
            setattr(AI_EVAL, k, v)
        self.httpd.shutdown()
        self.httpd.server_close()


CASE = {
    "id": "90_test_case", "title": "pricing reads a bad setting", "cluster": "default", "namespace": "shop-90",
    "question": "default 클러스터 shop-90에서 결제 금액 조회가 실패한대. 원인이 뭐야?", "question_vague": "shop-90이 좀 이상해. 봐줄래?",
    "answer_format": "rca_block_v0", "expect": [["settings-b"]], "tools": [],
    "inject_cmds": ["kubectl -n $NS apply -f $CASE_DIR/inject.yaml"], "ask_after_seconds": [300],
    "undo_cmds": ["kubectl -n $NS rollout undo deploy/pricing"], "baseline_seconds": 60, "cooldown_seconds": 30, "timeout_seconds": 420,
}
TRUTH = {
    "id": "90_test_case", "control": False, "fault_start": "{{INJECT_TIME}}", "time_tolerance_seconds": 120,
    "causes": [{"resource": "ConfigMap/shop-90/settings-b", "kind": "config_change", "accept_resources": [], "accept_kinds": []}],
    "path": [], "also_ok": [], "decoys": [{"resource": "Deployment/shop-90/checkout", "why": "the caller"}],
}


def case_dir(case: dict, truth: dict, root: Path | None = None) -> Path:
    root = root or Path(tempfile.mkdtemp(prefix="ai-eval-runner-test-"))
    d = root / case["id"]
    d.mkdir()
    (d / "case.json").write_text(json.dumps(case, ensure_ascii=False))
    (d / "truth.json").write_text(json.dumps(truth))
    (d / "setup.yaml").write_text("apiVersion: v1\nkind: ConfigMap\nmetadata: {name: settings-b}\ndata: {url: http://catalog.shop-90.svc:8080}\n")
    return d


def run(case=CASE, repeat=2, user="read"):
    d = case_dir(case, TRUTH)
    admin = AI_EVAL.login("admin", PASSWORD)
    args = argparse.Namespace(repeat=repeat, keep=False, user=user)
    return AI_EVAL.run_staged_case(d, json.loads((d / "case.json").read_text()), admin, {}, args, "20261115000000", d.parent / "truth")


# --- the account ---

def test_a_hard_case_asks_as_a_read_account_made_for_it():
    fake = FakeKubeast()
    with Server(fake) as srv:
        results = run()
    assert len(results) == 4 and all(r["pass"] and r["user"] == "read" for r in results), results
    uid, cluster, body = fake.grants[0]
    assert len(fake.grants) == 1 and cluster == "default" and body == {"role": "Read"}  # the whole cluster, no namespace list
    assert fake.deleted == [uid] and fake.users == {}
    assert set(fake.sessions) == {"ai-eval-read-20261115000000-90@kubeast.local"}
    assert any(c.startswith("kubectl delete namespace shop-90") for c in srv.commands)


def test_user_admin_and_a_cases_own_user():
    fake = FakeKubeast()
    with Server(fake):
        results = run(repeat=1, user="admin")
        assert fake.grants == [] and set(fake.sessions) == {"admin"} and all(r["user"] == "admin" for r in results)
        results = run(case={**CASE, "user": "read"}, repeat=1, user="admin")
    assert len(fake.grants) == 1 and all(r["user"] == "read" for r in results)
    assert AI_EVAL.user_of({"question": "q"}, argparse.Namespace(user="read")) == "admin"  # an easy case: its own field
    assert AI_EVAL.user_of({"question": "q", "user": "read"}, argparse.Namespace(user="admin")) == "read"


def test_a_read_account_that_cannot_be_made_is_a_setup_error():
    fake = FakeKubeast()
    with Server(fake) as srv:
        AI_EVAL_login = AI_EVAL.login
        try:
            AI_EVAL.login = lambda email, password: (_ for _ in ()).throw(AI_EVAL.urllib.error.URLError("refused")) if email != "admin" else AI_EVAL_login(email, password)
            admin = AI_EVAL_login("admin", PASSWORD)
            d = case_dir(CASE, TRUTH)
            results = AI_EVAL.run_staged_case(d, CASE, admin, {}, argparse.Namespace(repeat=1, keep=False, user="read"), "20261115000000", d.parent / "truth")
        finally:
            AI_EVAL.login = AI_EVAL_login
    assert results[0]["setup_error"].startswith("read account: URLError") and fake.chats == 0
    assert fake.users == {} and len(fake.deleted) == 1  # the half-made account is deleted
    assert not any("inject.yaml" in c for c in srv.commands)


def _go_strings(text: str) -> list[str]:
    return re.findall(r'"([^"]+)"', text)


def test_the_read_account_holds_no_admin_reads():
    """What the product gives a member with Read on a cluster: auth-service's seeded roles and the tables that say what
    each tool asks (ai-service, tool-server). README "Hard cases" leans on this; alerts_inbox is the one way left."""
    schema = (ROOT / "services/auth-service-go/internal/repository/repository_schema.go").read_text()
    tools = _go_strings(re.search(r"var ReadAIToolPermissions = \[\]string\{(.*?)\n\}", schema, re.S).group(1))
    seeded = re.search(r'\{"Read", "[^"]*", append\(\[\]string\{(.*?)\}, ReadAIToolPermissions\.\.\.\)\}', schema, re.S)
    read = set(_go_strings(seeded.group(1))) | set(tools)
    assert re.search(r'\{"Member", "[^"]*", nil\}', schema), "Member holds permissions of its own"
    assert "*" not in read and not [p for p in read if p.startswith("admin.")], read
    assert "ai.tool.investigations" not in read and "ai.tool.audit_search" not in read
    screen = (ROOT / "services/ai-service/app/services/ai/screen_permissions.py").read_text()
    assert '"investigations": _always("admin.investigations.read")' in screen
    assert '"audit_search": _always("admin.audit.read")' in screen
    # alerts_inbox (with_report: an investigation's report) is a Read tool for whoever reads the whole cluster
    assert "ai.tool.alerts_inbox" in read and '"alerts_inbox": _always("resource.pod.read")' in screen
    assert "resource.*.read" in read
    inbox = (ROOT / "services/ai-service/app/api_alert_inbox.py").read_text()
    assert 'READ_PERMISSION = "resource.pod.read"' in inbox and "features.alertInvestigation.enabled" in inbox


# --- request errors ---

def test_a_502_keeps_the_answers_already_received():
    fake = FakeKubeast()
    fake.chat_script = ["ok", "ok", 502, 502, "ok"]
    with Server(fake) as srv:
        results = run()
    assert [r["pass"] for r in results] == [True, True, False, True], results
    bad = results[2]
    assert bad["error"] == "request failed: HTTP 502 Bad Gateway" and bad["error_status"] == 502 and bad["request_error"]
    assert bad["tries"] == ["HTTP 502 Bad Gateway", "HTTP 502 Bad Gateway"] and bad["rca"]["block"] == "missing"
    assert fake.chats == 5 and results[3]["tokens"] == 100
    assert "tries" not in results[0] and results[2]["stage"]["errors"] == []
    assert any("rollout undo" in c for c in srv.commands) and any(c.startswith("kubectl delete namespace shop-90") for c in srv.commands)


def test_a_429_is_tried_once_more():
    fake = FakeKubeast()
    fake.chat_script = ["ok", 429, "ok", "ok", "ok"]
    with Server(fake):
        results = run()
    assert [r["pass"] for r in results] == [True, True, True, True] and fake.chats == 5
    assert results[1]["tries"] == ["HTTP 429 Too Many Requests"] and "request_error" not in results[1]


def test_three_request_errors_in_a_row_end_the_case():
    fake = FakeKubeast()
    fake.then = 503
    with Server(fake) as srv:
        results = run(repeat=3)
    assert len(results) == 3 and all(r["request_error"] and r["error_status"] == 503 for r in results)
    assert fake.chats == 6  # each tried once more
    assert results[0]["stage"]["errors"] == ["stopped after 3 request errors in a row"]
    assert sum("rollout undo" in c for c in srv.commands) == 1 and fake.users == {}


def test_a_timeout_is_kept_and_the_case_goes_on():
    fake = FakeKubeast()
    fake.chat_script = ["slow", "ok"]
    with Server(fake):
        results = run(case={**CASE, "timeout_seconds": 1}, repeat=1)
    assert [r["pass"] for r in results] == [False, True] and fake.chats == 2  # a timeout is not tried again
    assert results[0]["request_error"] and results[0]["error_status"] is None and "timed out" in results[0]["error"], results[0]


# --- setup ---

def test_a_failed_setup_step_is_a_setup_error():
    fake = FakeKubeast()
    with Server(fake) as srv:
        srv.answer = lambda cmd: (1, "", "x" * 500 + "boom") if "setup-step" in cmd else (0, "", "")
        results = run(case={**CASE, "setup_cmds": ["true", "kubectl apply -f setup-step.yaml"]})
    assert len(results) == 1 and results[0]["setup_error"] == "setup step 2: " + ("x" * 500 + "boom")[-400:]
    assert fake.chats == 0 and not any("inject.yaml" in c for c in srv.commands)
    assert any(c.startswith("kubectl delete namespace shop-90") for c in srv.commands) and fake.users == {}


def test_a_wait_still_false_is_a_setup_error():
    fake = FakeKubeast()
    with Server(fake) as srv:
        srv.answer = lambda cmd: (1, "0/2 ready\n", "") if cmd.startswith("kubectl -n shop-90 wait") else (0, "", "")
        results = run(case={**CASE, "wait": "kubectl -n $NS wait --for=condition=Available deploy/pricing", "wait_seconds": 30})
    assert results[0]["setup_error"] == "wait still false after 30 s: 0/2 ready\n" and fake.chats == 0
    assert sum(c.startswith("kubectl -n shop-90 wait") for c in srv.commands) == 7  # every 5 s for 30 s, and once at the end


def test_inject_wait_still_false_names_its_last_output():
    fake = FakeKubeast()
    with Server(fake) as srv:
        srv.answer = lambda cmd: (1, "", "no OOMKilled yet") if "lastState" in cmd else (0, "", "")
        results = run(case={**CASE, "inject_wait": "kubectl -n $NS get pod -o jsonpath={..lastState}", "inject_wait_seconds": 10})
    assert results[0]["setup_error"] == "inject_wait still false after 10 s: no OOMKilled yet"


# --- the asks ---

def test_forms_take_turns_and_each_answer_has_its_own_lateness():
    fake = FakeKubeast()
    with Server(fake) as srv:
        fake.on_chat = lambda n: srv.clock.sleep(30)  # each answer takes 30 s
        results = run(repeat=2)
    assert [(r["form"], r["run"]) for r in results] == [("question", 1), ("question_vague", 1), ("question_vague", 2), ("question", 2)]
    assert [r["late_seconds"] for r in results] == [0, 30, 60, 90]


def test_tool_results_go_to_their_own_call():
    out = {"calls": [], "answer": ""}
    for e in [{"function": "loki_query", "args": {"q": "a"}, "call_id": 1}, {"function": "loki_query", "args": {"q": "b"}, "call_id": 2},
              {"function_result": "loki_query", "result": '{"error": "timeout"}', "call_id": 2},
              {"function_result": "loki_query", "result": "lines", "call_id": 1}]:
        AI_EVAL.add_event(out, e)
    assert [(c["args"]["q"], c["result"], c["failed"]) for c in out["calls"]] == [("a", "lines", False), ("b", '{"error": "timeout"}', True)]
    out = {"calls": [], "answer": ""}
    for e in [{"function": "k8s_get_events", "args": {"n": 1}}, {"function": "k8s_get_events", "args": {"n": 2}},
              {"function_result": "k8s_get_events", "result": {"error": "forbidden"}},
              {"function_result": "k8s_get_events", "result": '{"error": null, "items": []}'}]:
        AI_EVAL.add_event(out, e)
    assert [(c["args"]["n"], c["failed"]) for c in out["calls"]] == [(1, True), (2, False)]  # the earliest call without a result
    assert out["calls"][0]["result"] == '{"error": "forbidden"}'


# --- the round ---

def test_a_round_records_counts_runs_under_a_suffix_and_writes_after_each_case():
    fake = FakeKubeast()
    root = Path(tempfile.mkdtemp(prefix="ai-eval-round-"))
    case_dir({**CASE, "id": "90_a"}, {**TRUTH, "id": "90_a"}, root)
    case_dir({**CASE, "id": "91_b", "namespace": "shop-91", "question": "shop-91 원인?", "question_vague": "shop-91?"},
             json.loads(json.dumps({**TRUTH, "id": "91_b"}).replace("shop-90", "shop-91")), root)
    out = root / "out"
    on_disk = []
    real = AI_EVAL.run_staged_case

    def one_case(d, case, *rest):
        on_disk.append([r["id"] for f in out.glob("*-claude-haiku-5-5.json") for r in json.loads(f.read_text())] if out.exists() else [])
        return real(d, case, *rest)

    saved_argv = sys.argv
    with Server(fake) as srv:
        fake.on_chat = lambda n: fake.totals.__setitem__("inbox", 3 + n)
        try:
            AI_EVAL.run_staged_case = one_case
            sys.argv = ["ai-eval.py", "--cases", str(root), "--out", str(out), "--namespace-suffix", "ab12"]
            os.environ["E2E_USER_PASSWORD"] = PASSWORD
            assert AI_EVAL.main() == 0
        finally:
            sys.argv = saved_argv
            os.environ.pop("E2E_USER_PASSWORD", None)
            AI_EVAL.run_staged_case = real
    assert on_disk == [[], ["90_a", "90_a"]]
    rows = json.loads(next(out.glob("*-claude-haiku-5-5.json")).read_text())
    assert [(r["id"], r["namespace"]) for r in rows] == [("90_a", "shop-90-ab12")] * 2 + [("91_b", "shop-91-ab12")] * 2
    assert all(r["pass"] for r in rows), rows
    assert any(c.startswith("kubectl create namespace shop-90-ab12 ") for c in srv.commands)
    assert not any(re.search(r"shop-90(?![\w-])", c) for c in srv.commands)
    info = json.loads(next(out.glob("*-round.json")).read_text())
    assert info["user"] == "read" and info["namespace_suffix"] == "ab12"
    assert info["before"] == {"default": {"investigations": 2, "inbox": 3}} and info["after"] == {"default": {"investigations": 2, "inbox": 7}}
    md = next(out.glob("*-claude-haiku-5-5.md")).read_text()
    assert "라운드: 계정 read · 네임스페이스 꼬리 ab12 · 조사/알림함 default 2/3 → default 2/7" in md
    truth = json.loads(next(out.glob("*-truth/90_a.json")).read_text())
    assert truth["causes"][0]["resource"] == "ConfigMap/shop-90-ab12/settings-b"


def test_a_namespace_suffix_is_written_only_as_a_whole_name():
    d = case_dir({**CASE, "question": "shop-90에서 실패, shop-901 말고, my-shop-90 말고"}, TRUTH)
    root = Path(tempfile.mkdtemp(prefix="ai-eval-suffix-"))
    new_dir, case = AI_EVAL.with_suffix(d, json.loads((d / "case.json").read_text()), "k3", root)
    assert case["namespace"] == "shop-90-k3" and case["question"] == "shop-90-k3에서 실패, shop-901 말고, my-shop-90 말고"
    assert "http://catalog.shop-90-k3.svc:8080" in (new_dir / "setup.yaml").read_text()
    assert json.loads((new_dir / "truth.json").read_text())["causes"][0]["resource"] == "ConfigMap/shop-90-k3/settings-b"
    assert json.loads((d / "case.json").read_text())["namespace"] == "shop-90"  # the case folder itself is left as it is
    assert AI_EVAL.with_suffix(d, CASE, None, root) == (d, CASE)
    assert AI_EVAL.namespace_suffix(None) is None and re.fullmatch(r"[a-z0-9]{4}", AI_EVAL.namespace_suffix("random"))
    for bad in ("AB", "a-b", "123456789"):
        try:
            AI_EVAL.namespace_suffix(bad)
        except ValueError:
            continue
        raise AssertionError(bad)


if __name__ == "__main__":
    tests = [(n, f) for n, f in sorted(globals().items()) if n.startswith("test_") and callable(f)]
    failed = 0
    for name, fn in tests:
        try:
            fn()
            print(f"ok   {name}")
        except Exception as e:  # an error the runner raises fails the test it came from, not the whole run
            failed += 1
            print(f"FAIL {name}: {e!r}")
    print(f"{len(tests) - failed} passed, {failed} failed")
    sys.exit(1 if failed else 0)
