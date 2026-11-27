"""Checks scripts/ai-eval.py's sign-in and its alert path against a stand-in of Kubeast's API (a local HTTP server):
signing in again on a 401 and before the token's lifetime is over, and a case run through the alert path — the alert
posted or fired, its investigation found by its start, waited for and scored, the alerts resolved at the end. No
cluster: the runner's shell steps and clock are replaced, so nothing here reaches kubectl, kind or docker.

  python3 -m pytest -q scripts/test_ai_eval_alerts.py
  python3 scripts/test_ai_eval_alerts.py        # the same checks without pytest
"""
import argparse
import base64
import contextlib
import hashlib
import hmac
import importlib.util
import io
import json
import os
import subprocess
import sys
import tempfile
import threading
import time
import urllib.error
import urllib.parse
from datetime import datetime, timezone
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))


def _load_ai_eval():
    spec = importlib.util.spec_from_file_location("ai_eval_under_test", HERE / "ai-eval.py")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


AI_EVAL = _load_ai_eval()
WEBHOOK_TOKEN = "webhook-secret"
PASSWORD = "admin-pass"

RIGHT_REPORT = ("## Summary\ncheckout fails.\n\n## What I checked\n- k8s_get_resources: pods\n- loki_query: errors\n\n"
                "## Likely cause\nThe ConfigMap settings-b changed a setting that the pricing pods read.\n\n## Next steps\n- Roll back.\n")
NO_FAULT_REPORT = ("## Summary\nchecked.\n\n## What I checked\n- k8s_get_resources: pods\n\n"
                   "## Likely cause\nNo fault found: every call works as expected.\n\n## Next steps\n- None.\n")
DECOY_REPORT = ("## Summary\nchecked.\n\n## What I checked\n- k8s_get_resources: pods\n\n"
                "## Likely cause\nthumbnailer keeps crashing and breaks the orders.\n\n## Next steps\n- Restart it.\n")


class FakeTime:
    """The runner's clock: sleep moves monotonic on at once; wall time and formatting stay real."""

    def __init__(self):
        self.now = 1000.0

    def monotonic(self):
        return self.now

    def sleep(self, seconds):
        self.now += max(0.0, seconds)

    def __getattr__(self, name):  # time(), gmtime(), strftime() ...
        return getattr(time, name)


def jwt(claims: dict) -> str:
    body = base64.urlsafe_b64encode(json.dumps(claims).encode()).decode().rstrip("=")
    return f"eyJhbGciOiJub25lIn0.{body}.sig"


def utc(value: str) -> str:
    """A time as the API answers it: naive UTC isoformat + Z (microseconds kept), as ai-service's _iso writes."""
    t = datetime.fromisoformat(value.replace("Z", "+00:00")).astimezone(timezone.utc).replace(tzinfo=None)
    return t.isoformat() + "Z"


class FakeKubeast:
    """The routes the runner calls. Investigations go queued → running → done over the polls of their list."""

    def __init__(self, lifetime=7200, with_exp=True):
        self.lifetime, self.with_exp = lifetime, with_exp
        self.password = PASSWORD
        self.valid: set[str] = set()
        self.logins = 0
        self.unauthorized = 0
        self.webhooks: list[dict] = []
        self.inbox: list[dict] = []
        self.invs: list[dict] = []
        self.report = lambda alert: RIGHT_REPORT
        self.result = None           # what a done investigation stores as `result` (switches on)
        self.refuse = False          # the webhook answers duplicate instead of queueing
        self.noise = True            # each webhook also queues an investigation of another firing of the same alert
        self.polls_to_finish = 3
        self.chats = 0
        self.expire_at_chat = None
        self.invalidate_at_poll = None
        self.list_polls = 0
        self.late_exact = False      # the webhook queues another firing's investigation of the alert first, its own one poll later
        self.list_errors: dict = {}  # investigation list poll number → the HTTP status it answers instead
        self.list_error_after = None # from this poll on, every investigation list read answers 502
        self.webhook_errors: list = []  # statuses the next firing posts answer, in turn
        self.pending: list[tuple[int, tuple]] = []
        self.lock = threading.Lock()
        self.seq = 0

    # --- state helpers ---
    def next_id(self, prefix):
        self.seq += 1
        return f"{prefix}-{self.seq}"

    def add_row(self, cluster, alert, receiver):
        row = {"id": self.next_id("row"), "cluster": cluster, "fingerprint": alert["fingerprint"], "alertname": alert["labels"].get("alertname", ""),
               "namespace": alert["labels"].get("namespace", ""), "labels": dict(alert["labels"]), "annotations": dict(alert.get("annotations") or {}),
               "summary": (alert.get("annotations") or {}).get("summary", ""), "status": "firing", "starts_at": utc(alert["startsAt"]),
               "first_received_at": datetime.now(timezone.utc).replace(tzinfo=None).isoformat() + "Z", "generator_url": alert.get("generatorURL", ""),
               "receiver": receiver, "investigation": None}
        self.inbox.append(row)
        return row

    def add_inv(self, cluster, alertname, fingerprint, starts_at, report=None):
        inv = {"id": self.next_id("inv"), "cluster": cluster, "alertname": alertname, "fingerprint": fingerprint, "starts_at": starts_at,
               "status": "queued", "polls": 0, "report": report}
        self.invs.insert(0, inv)  # newest first
        return inv

    def fire(self, cluster, labels, annotations, starts_at, fingerprint="am0f1e2d3c4b5a69"):
        """What Alertmanager's delivery leaves: the inbox row and its queued investigation; then another firing's
        investigation of the same fingerprint with an earlier start, newer than it, which is not this firing's."""
        alert = {"labels": labels, "annotations": annotations, "startsAt": starts_at, "fingerprint": fingerprint,
                 "generatorURL": "http://prometheus/graph"}
        row = self.add_row(cluster, alert, "kubeast")
        self.add_inv(cluster, labels["alertname"], fingerprint, row["starts_at"])
        self.add_inv(cluster, labels["alertname"], fingerprint, utc("2026-01-01T00:00:00Z"), report=NO_FAULT_REPORT)
        return row

    def summary(self, inv):
        return {k: inv[k] for k in ("id", "cluster", "alertname", "status")}

    def detail(self, inv):
        done = inv["status"] == "done"
        report = (inv["report"] or self.report(inv)) if done else None
        return {**self.summary(inv), "fingerprint": inv["fingerprint"], "starts_at": inv["starts_at"], "report": report,
                "model": "claude-haiku-5-5", "provider": "claude-code", "total_tokens": 4321 if done else None,
                "iterations": 3 if done else None, "duration_ms": 41500 if done else None, "error": None,
                "tool_calls": [{"tool": "k8s_get_resources", "args": {"resource_type": "pods"}, "step": 1, "result_chars": 900, "requests": 1},
                               {"tool": "loki_query", "args": {"query": "{}"}, "step": 2, "error": "timeout"}] if done else [],
                **({"result": self.result} if done and self.result is not None else {})}

    # --- routes ---
    def handle(self, method, path, query, headers, body):
        with self.lock:
            if path == "/api/v1/auth/login":
                if body.get("password") != self.password:
                    return 401, {"detail": "bad credentials"}
                self.logins += 1
                claims = {"sub": "admin", "iat": 1_700_000_000, "n": self.logins}
                if self.with_exp:
                    claims["exp"] = 1_700_000_000 + self.lifetime
                token = jwt(claims)
                self.valid.add(token)
                return 200, {"access_token": token}
            if path == "/api/v1/alerts/webhook":
                return self.webhook(query, headers, body)
            auth = headers.get("Authorization", "")
            if not auth.startswith("Bearer ") or auth[7:] not in self.valid:
                self.unauthorized += 1
                return 401, {"detail": "Unauthorized"}
            if path == "/api/v1/ping":
                return 200, {"ok": True}
            if path == "/api/v1/sessions" and method == "POST":
                self.chats += 1
                if self.chats == self.expire_at_chat:  # the token ends between two asks of a long round
                    self.valid.clear()
                    self.unauthorized += 1
                    return 401, {"detail": "token expired"}
                return 201, {"id": f"s{self.chats}"}
            if path.startswith("/api/v1/sessions/") and method == "DELETE":
                return 204, None
            if path.startswith("/api/v1/ai/sessions/") and path.endswith("/chat"):
                block = {"no_fault": False, "causes": [{"resource": "ConfigMap/shop-90/settings-b", "kind": "config_change",
                                                        "started_at": None, "evidence": [1]}], "path": [], "ruled_out": []}
                events = [{"model_info": {"model": "claude-haiku-5-5", "provider": "claude-code"}},
                          {"function": "k8s_get_resources", "args": {"resource_type": "configmaps"}},
                          {"function_result": "k8s_get_resources", "result": "settings-b"},
                          {"content": "The ConfigMap settings-b changed.\n\n```rca\n" + json.dumps(block) + "\n```\n"},
                          {"usage": {"total_tokens": 100}}]
                return 200, "".join(f"data: {json.dumps(e)}\n\n" for e in events) + "data: [DONE]\n\n"
            if path == "/api/v1/alerts/inbox":
                rows = [r for r in self.inbox if r["cluster"] == query["cluster"] and query.get("q", "") in r["alertname"]]
                return 200, {"items": [{k: v for k, v in r.items() if k not in ("annotations", "generator_url", "receiver")} for r in rows]}
            if path.startswith("/api/v1/alerts/inbox/"):
                row = next((r for r in self.inbox if r["id"] == path.rsplit("/", 1)[1]), None)
                return (200, row) if row else (404, {"detail": "alert not found"})
            if path == "/api/v1/ai/investigations":
                self.list_polls += 1
                if self.list_polls in self.list_errors:
                    return self.list_errors[self.list_polls], {"detail": "stand-in error"}
                if self.list_error_after is not None and self.list_polls >= self.list_error_after:
                    return 502, {"detail": "stand-in error"}
                if self.invalidate_at_poll == self.list_polls:
                    self.valid.clear()
                    self.unauthorized += 1
                    return 401, {"detail": "token expired"}
                for at, args in list(self.pending):
                    if self.list_polls >= at:
                        self.pending.remove((at, args))
                        self.add_inv(*args)
                for inv in self.invs:
                    if inv["status"] in ("queued", "running"):
                        inv["polls"] += 1
                        inv["status"] = "done" if inv["polls"] >= self.polls_to_finish else "running"
                items = [self.summary(i) for i in self.invs if i["cluster"] == query["cluster"]]
                return 200, {"items": items[: int(query.get("limit", 50))], "total": len(items)}
            if path.startswith("/api/v1/ai/investigations/"):
                inv = next((i for i in self.invs if i["id"] == path.rsplit("/", 1)[1]), None)
                return (200, self.detail(inv)) if inv else (404, {"detail": "investigation not found"})
            return 404, {"detail": f"no route {method} {path}"}

    def webhook(self, query, headers, body):
        cluster = query.get("cluster", "")
        own = hmac.new(WEBHOOK_TOKEN.encode(), cluster.encode(), hashlib.sha256).hexdigest()
        if headers.get("Authorization") != f"Bearer {own}":
            return 401, {"detail": "invalid webhook token"}
        if self.webhook_errors and body["alerts"][0]["status"] == "firing":
            return self.webhook_errors.pop(0), {"detail": "stand-in error"}
        self.webhooks.append({"cluster": cluster, "body": body})
        counts = {"accepted": 0, "duplicate": 0, "resolved": 0, "stored": 0}
        for alert in body["alerts"]:
            counts["stored"] += 1
            if alert["status"] == "resolved":
                for r in self.inbox:
                    if r["fingerprint"] == alert["fingerprint"]:
                        r["status"] = "resolved"
                counts["resolved"] += 1
                continue
            row = self.add_row(cluster, alert, body["receiver"])
            if self.refuse:
                counts["duplicate"] += 1
                continue
            if self.late_exact:
                self.add_inv(cluster, row["alertname"], row["fingerprint"], utc("2026-01-01T00:00:00Z"), report=NO_FAULT_REPORT)
                self.pending.append((self.list_polls + 2, (cluster, row["alertname"], row["fingerprint"], row["starts_at"])))
            else:
                self.add_inv(cluster, row["alertname"], row["fingerprint"], row["starts_at"])
            if self.noise:  # another firing of the same alert, queued right after this one
                self.add_inv(cluster, row["alertname"], "other-firing", row["starts_at"], report=NO_FAULT_REPORT)
            counts["accepted"] += 1
        return 200, counts


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
                status, answer = outer.fake.handle(self.command, url.path, query, self.headers, body)
                stream = isinstance(answer, str)
                data = answer.encode() if stream else b"" if answer is None else json.dumps(answer).encode()
                self.send_response(status)
                self.send_header("Content-Type", "text/event-stream" if stream else "application/json")
                self.send_header("Content-Length", str(len(data)))
                if url.path == "/api/v1/auth/login" and status == 200:  # the token in the cookie too, as auth-service sets it
                    self.send_header("Set-Cookie", f"kubeast.token={answer['access_token']}; Path=/; HttpOnly; SameSite=Strict")
                self.end_headers()
                self.wfile.write(data)

            do_GET = do_POST = do_PUT = do_DELETE = _serve

            def log_message(self, *args):
                pass

        self.httpd = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        self.thread = threading.Thread(target=self.httpd.serve_forever, daemon=True)

    def __enter__(self):
        self.thread.start()
        self.saved = {k: getattr(AI_EVAL, k) for k in ("BASE", "time", "sh", "kubeconfig", "rule_loaded")}
        AI_EVAL.BASE = f"http://127.0.0.1:{self.httpd.server_address[1]}"
        self.clock = FakeTime()
        AI_EVAL.time = self.clock
        self.commands: list[str] = []
        self.on_command = lambda cmd: None

        def sh(cmd, kc, timeout=300, env=None):
            self.commands.append(cmd)
            self.on_command(cmd)
            return subprocess.CompletedProcess(["bash", "-c", cmd], 0, "", "")

        AI_EVAL.sh = sh
        AI_EVAL.kubeconfig = lambda name, cache: "/nonexistent/kubeconfig"
        AI_EVAL.rule_loaded = lambda cluster, rule: False
        return self

    def __exit__(self, *exc):
        for k, v in self.saved.items():
            setattr(AI_EVAL, k, v)
        self.httpd.shutdown()
        self.httpd.server_close()


CASE = {
    "id": "90_test_alert", "title": "pricing reads a bad setting", "cluster": "default", "namespace": "shop-90",
    "question": "default 클러스터 shop-90에서 결제 금액 조회가 실패한대. 원인이 뭐야?", "answer_format": "rca_block_v0",
    "expect": [["settings-b"]], "tools": [], "inject_cmds": ["kubectl -n $NS apply -f $CASE_DIR/inject.yaml"],
    "ask_after_seconds": [300], "fault_duration_seconds": 100, "undo_cmds": ["kubectl -n $NS rollout undo deploy/pricing"],
    "baseline_seconds": 60, "cooldown_seconds": 30,
    "alert": {"labels": {"alertname": "ServiceRequestsFailing", "service": "checkout"},
              "annotations": {"summary": "Some of checkout's price lookups fail"}},
}
TRUTH = {
    "id": "90_test_alert", "control": False, "fault_start": "{{INJECT_TIME}}", "time_tolerance_seconds": 120,
    "causes": [{"resource": "ConfigMap/shop-90/settings-b", "kind": "config_change", "accept_resources": ["settings-b"], "accept_kinds": []}],
    "path": [], "also_ok": [], "decoys": [{"resource": "Deployment/shop-90/checkout", "why": "the caller"}],
}
CONTROL_CASE = {**CASE, "id": "91_test_control", "namespace": "shop-91", "inject_cmds": ["kubectl -n $NS exec deploy/thumbnailer -- kill 1"],
                "fault_duration_seconds": None, "undo_cmds": []}
CONTROL_TRUTH = {"id": "91_test_control", "control": True, "fault_start": None, "causes": [], "path": [], "also_ok": [],
                 "decoys": [{"resource": "Deployment/shop-91/thumbnailer", "why": "restarted once"}]}


def case_dir(case: dict, truth: dict) -> Path:
    d = Path(tempfile.mkdtemp(prefix="ai-eval-alert-test-")) / case["id"]
    d.mkdir()
    (d / "case.json").write_text(json.dumps({k: v for k, v in case.items() if v is not None}))
    (d / "truth.json").write_text(json.dumps(truth))
    return d


def run(case=CASE, truth=TRUTH, repeat=2, source="synthetic", server=None, **more):
    d = case_dir(case, truth)
    loaded = json.loads((d / "case.json").read_text())
    admin = AI_EVAL.Api("admin", PASSWORD)
    args = argparse.Namespace(repeat=repeat, keep=False, alert_source=source, **more)
    results = AI_EVAL.run_alert_case(d, loaded, admin, {}, args, "20261115000000", d.parent / "truth", WEBHOOK_TOKEN)
    return results, admin, d


# --- signing in ---

def test_api_signs_in_again_on_a_401_and_sends_the_call_again():
    fake = FakeKubeast()
    with Server(fake):
        api = AI_EVAL.Api("admin", PASSWORD)
        assert api.json("GET", "/api/v1/ping") == {"ok": True} and api.logins == 1
        fake.valid.clear()  # the token stopped being accepted (expired, revoked, a restart with a new key)
        assert api.json("GET", "/api/v1/ping") == {"ok": True}
        assert api.logins == 2 and fake.unauthorized == 1


def test_api_renews_the_token_before_its_lifetime_is_over():
    fake = FakeKubeast(lifetime=7200)
    with Server(fake) as srv:
        api = AI_EVAL.Api("admin", PASSWORD)
        api.json("GET", "/api/v1/ping")
        srv.clock.sleep(7200 - 480 - 1)
        api.json("GET", "/api/v1/ping")
        assert api.logins == 1
        srv.clock.sleep(2)
        api.json("GET", "/api/v1/ping")
        assert api.logins == 2 and fake.unauthorized == 0  # renewed before the call, not after a refusal


def test_a_short_lifetime_renews_at_three_quarters():
    fake = FakeKubeast(lifetime=400)
    with Server(fake) as srv:
        api = AI_EVAL.Api("admin", PASSWORD)
        api.json("GET", "/api/v1/ping")
        srv.clock.sleep(299)
        api.json("GET", "/api/v1/ping")
        assert api.logins == 1
        srv.clock.sleep(2)
        api.json("GET", "/api/v1/ping")
        assert api.logins == 2


def test_a_token_without_exp_is_renewed_on_a_401_only():
    fake = FakeKubeast(with_exp=False)
    with Server(fake) as srv:
        api = AI_EVAL.Api("admin", PASSWORD)
        api.json("GET", "/api/v1/ping")
        srv.clock.sleep(10 * 3600)
        api.json("GET", "/api/v1/ping")
        assert api.logins == 1
        fake.valid.clear()
        api.json("GET", "/api/v1/ping")
        assert api.logins == 2


def test_a_refused_sign_in_after_a_401_is_raised():
    fake = FakeKubeast()
    with Server(fake):
        api = AI_EVAL.Api("admin", PASSWORD)
        api.json("GET", "/api/v1/ping")
        fake.valid.clear()
        fake.password = "changed"
        try:
            api.json("GET", "/api/v1/ping")
        except urllib.error.HTTPError as e:
            assert e.code == 401
        else:
            raise AssertionError("no error")


def test_token_lifetime_reads_exp_less_iat():
    assert AI_EVAL.token_lifetime(jwt({"iat": 100, "exp": 7300})) == 7200
    assert AI_EVAL.token_lifetime(jwt({"iat": 100})) is None
    assert AI_EVAL.token_lifetime(jwt({"iat": 100, "exp": 50})) is None
    assert AI_EVAL.token_lifetime("not-a-jwt") is None


# --- the alert path ---

def test_synthetic_alerts_are_posted_found_by_their_start_scored_and_resolved():
    fake = FakeKubeast()
    with Server(fake) as srv:
        undone_after = []
        srv.on_command = lambda cmd: undone_after.append(len(fake.webhooks)) if "rollout undo" in cmd else None
        results, admin, d = run(server=srv)
    assert [r["run"] for r in results] == [1, 2] and all("setup_error" not in r for r in results), results
    firing = [w for w in fake.webhooks if w["body"]["alerts"][0]["status"] == "firing"]
    gone = [w for w in fake.webhooks if w["body"]["alerts"][0]["status"] == "resolved"]
    assert len(firing) == 2 and len(gone) == 2
    sent = [w["body"]["alerts"][0] for w in firing]
    assert len({a["fingerprint"] for a in sent}) == 2
    assert {a["fingerprint"] for a in sent} == {w["body"]["alerts"][0]["fingerprint"] for w in gone}
    for a in sent:
        assert a["labels"] == {"alertname": "ServiceRequestsFailing", "namespace": "shop-90", "severity": "warning", "service": "checkout"}
        assert a["annotations"] == CASE["alert"]["annotations"]
        assert datetime.fromisoformat(a["startsAt"].replace("Z", "+00:00")) <= datetime.now(timezone.utc)
    ours = {i["fingerprint"]: i["id"] for i in fake.invs if i["fingerprint"] != "other-firing"}
    for r, a in zip(results, sent, strict=True):
        assert r["form"] == "alert" and r["alert_source"] == "synthetic" and r["ask_after"] == 300
        assert r["investigation_id"] == ours[a["fingerprint"]] and r["matched_by"] == "starts_at"
        assert r["pass"] and r["score"] == 1.0 and r["text"]["pass"] and r["prose_pass"]
        assert r["tokens"] == 4321 and r["model_calls"] == 3 and r["seconds"] == 41.5 and r["model"] == "claude-haiku-5-5"
        assert [c["tool"] for c in r["calls"]] == ["k8s_get_resources", "loki_query"] and r["calls"][1]["failed"]
        assert r["calls"][0]["requests"] == 1 and r["calls"][0]["result_chars"] == 900
        assert "rca" not in r and "wrong_suspect" not in r  # switches off: no block; not a control
        assert set(r["stage"]) >= {"SETUP_TIME", "INJECT_TIME", "UNDO_TIME"}
    assert results[0]["late_seconds"] == 0
    assert any("inject.yaml" in c for c in srv.commands)
    assert undone_after == [0]  # fault_duration_seconds (100 s) undid it while the runner waited for +300 s, once
    assert any(c.startswith("kubectl delete namespace shop-90") and "--wait=false" in c for c in srv.commands)
    assert (d.parent / "truth" / "90_test_alert.json").exists()


def test_switches_on_score_the_stored_block_beside_the_words():
    fake = FakeKubeast()
    fake.result = {"version": 1, "status": "ok", "no_fault": False, "path": [], "ruled_out": [], "hypotheses": [],
                   "causes": [{"resource": "ConfigMap/shop-90/settings-b", "kind": "config_change", "started_at": None,
                               "evidence": [{"call": 1, "tool": "k8s_get_resources"}]}]}
    fake.report = lambda inv: NO_FAULT_REPORT.replace("No fault found: every call works as expected.", "Unclear from the reads.")
    with Server(fake):
        results, _, _ = run(repeat=1)
    r = results[0]
    assert r["rca"]["pass"] and r["rca"]["block"] == "ok" and r["rca"]["ungrounded"] == 0
    assert not r["text"]["pass"] and not r["pass"]  # pass is the words' check, the same measure with the switches off


def test_the_second_scoring_is_recorded_beside_the_first():
    fake = FakeKubeast()
    with Server(fake):
        results, _, d = run(repeat=1)
    r = results[0]
    assert r["pass"] and r["text"]["pass"] and "rca" not in r and "stored_result" not in r  # the first scoring as it was
    assert r["second"]["by"] == "text" and r["second"]["pass"] is None and r["second"]["text"]["pass"]  # words are reported, not decided on
    assert r["second"]["outcome"] == "cause" and "block" not in r["second"]
    stored = {"version": 1, "status": "ok", "no_fault": False, "path": [], "ruled_out": [], "hypotheses": [],
              "causes": [{"resource": "Deployment/shop-90/checkout", "kind": "crash", "started_at": None, "evidence": []}]}
    fake = FakeKubeast()
    fake.result = stored
    with Server(fake):
        results, _, _ = run(repeat=1)
    r = results[0]
    assert r["pass"] and not r["rca"]["pass"]  # the first scoring: pass is the words'
    assert r["second"]["by"] == "block" and not r["second"]["pass"] and r["second"]["miss"] == "cause_not_named" and r["second"]["text"]["pass"]
    assert r["stored_result"] == stored  # what a later scoring reads
    assert "block_outcome" not in r["second"]["block"]  # no verdict in the result: the block's own outcome
    fake = FakeKubeast()
    fake.result = {**stored, "verdict": {"outcome": "cannot_tell", "said": "cause_found", "why": ["no_symptom"], "looked_at": [],
                                         "checked_normal": [], "not_looked_at": []}}
    with Server(fake):
        results, _, _ = run(case=CONTROL_CASE, truth=CONTROL_TRUTH, repeat=1)
    s = results[0]["second"]
    assert s["control"] and s["outcome"] == "cannot_tell" and s["miss"] == "cannot_tell" and not s["pass"]  # the outcome the server keeps
    assert s["block"]["block_outcome"] == "cause" and results[0]["stored_result"] == fake.result
    fake = FakeKubeast()
    fake.report = lambda inv: NO_FAULT_REPORT
    with Server(fake):
        results, _, _ = run(case=CONTROL_CASE, truth=CONTROL_TRUTH, repeat=1)
    assert results[0]["second"]["control"] and results[0]["second"]["outcome"] == "no_fault" and results[0]["second"]["text"]["pass"]


def test_the_rules_of_a_case_are_kept_with_its_truth_copy():
    rules = {"accept_kinds": [{"cause": "ConfigMap/shop-90/settings-b", "kinds": ["rollout"], "notes": "`rollout` too"}]}
    fake = FakeKubeast()
    d = case_dir(CASE, TRUTH)
    (d / "scoring.json").write_text(json.dumps(rules))
    with Server(fake):
        AI_EVAL.run_alert_case(d, json.loads((d / "case.json").read_text()), AI_EVAL.Api("admin", PASSWORD), {},
                               argparse.Namespace(repeat=1, keep=False, alert_source="synthetic"), "20261115000000", d.parent / "truth", WEBHOOK_TOKEN)
    copy = json.loads((d.parent / "truth" / "90_test_alert.json").read_text())
    assert copy.pop("scoring") == {**rules, "facts": CASE["expect"]}
    assert {k: v for k, v in copy.items() if k != "fault_start"} == {k: v for k, v in TRUTH.items() if k != "fault_start"}
    with Server(FakeKubeast()):
        _, _, d = run(repeat=1, case={**CASE, "expect": []})
    assert "scoring" not in json.loads((d.parent / "truth" / "90_test_alert.json").read_text())


def _recording(tool, args, result, cluster="default"):
    replay = AI_EVAL.tool_replay()
    return replay.path_for(Path("/x"), tool, replay.key(cluster, tool, args)).name, {"format": 1, "tool": tool, "cluster": cluster, "result": result,
                                                                                    "recorded_at": "2026-11-25T01:00:00Z"}


def test_the_reader_in_the_pod_gives_each_recording_it_has():
    folder = Path(tempfile.mkdtemp(prefix="ai-eval-recordings-"))
    name, record = _recording("k8s_get_resources", {"resource_type": "pods"}, "p" * 5000)
    (folder / name).write_text(json.dumps(record))
    (folder / "loki_query-bad.json").write_text("{")
    out = subprocess.run([sys.executable, "-I", "-c", AI_EVAL.RECORDINGS_READER, str(folder), "4000", name, "none-0.json", "loki_query-bad.json"],
                         capture_output=True, text=True, timeout=30)
    assert out.returncode == 0, out.stderr
    assert json.loads(out.stdout) == {name: ["p" * 4000, 5000, "2026-11-25T01:00:00Z"]}


def test_the_key_of_a_recording_is_ai_services():
    replay = AI_EVAL.tool_replay()
    assert replay.key("default", "timeline", {"namespace": " shop-90 ", "cluster": "x", "kind": None}) == replay.key("default", "timeline", {"namespace": "shop-90"})
    assert replay.key("self", "timeline", {"namespace": "shop-90"}) != replay.key("default", "timeline", {"namespace": "shop-90"})
    assert (replay.MODE_ENV, replay.DIR_ENV) == ("AI_TOOL_REPLAY_MODE", "AI_TOOL_REPLAY_DIR")
    ran = (AI_EVAL.ROOT / "services/ai-service/app/services/investigation/runner.py").read_text()
    assert "service._execute_function_with_context(name, args, context)" in ran and '"tool": name, "args": args' in ran  # what is recorded is what the row holds


def _with_recordings(srv, pods, held):
    """sh of a stand-in install whose ai-service pods hold these recordings ({pod: {name: [text, chars, at]}})."""
    plain = AI_EVAL.sh

    def sh(cmd, kc, timeout=300, env=None):
        done = plain(cmd, kc, timeout, env)
        if " get pods " in cmd:
            return subprocess.CompletedProcess([], 0, "".join(f"pod/{p}\n" for p in pods), "")
        if " exec " in cmd and "-c ai-service" in cmd:
            pod = next(p for p in pods if f"pod/{p} " in cmd)
            if held.get(pod) is None:
                return subprocess.CompletedProcess([], 1, "", "pod not running")
            return subprocess.CompletedProcess([], 0, json.dumps({k: v for k, v in held[pod].items() if k in cmd}), "")
        return done

    AI_EVAL.sh = sh


def test_tool_results_of_an_investigation_are_kept_from_the_recordings():
    name, _ = _recording("k8s_get_resources", {"resource_type": "pods"}, "")
    fake = FakeKubeast()
    with Server(fake) as srv:
        _with_recordings(srv, ["ai-service-a", "ai-service-b"], {"ai-service-a": {}, "ai-service-b": {name: ["three pods", 9000, "2026-11-25T01:00:00Z"]}})
        results, _, _ = run(repeat=1, recordings="/tmp/rec")
    r = results[0]
    assert r["calls"][0]["result"] == "three pods" and r["calls"][0]["recorded_chars"] == 9000 and r["calls"][0]["recorded_at"] == "2026-11-25T01:00:00Z"
    assert "result" not in r["calls"][1] and r["tool_results"] == {"kept": 1, "of": 2}
    assert any("/tmp/rec" in c and name in c for c in srv.commands)
    with Server(FakeKubeast()):
        results, _, _ = run(repeat=1)
    assert "tool_results" not in results[0] and "result" not in results[0]["calls"][0]  # off: as it was


def test_recordings_that_cannot_be_read_are_said_and_the_run_goes_on():
    fake = FakeKubeast()
    with Server(fake) as srv:
        _with_recordings(srv, ["ai-service-a"], {"ai-service-a": None})
        results, _, _ = run(repeat=1, recordings="/tmp/rec")
    assert results[0]["pass"] and results[0]["tool_results"]["kept"] == 0 and "pod not running" in results[0]["tool_results"]["error"]
    with Server(fake) as srv:
        _with_recordings(srv, [], {})
        results, _, _ = run(repeat=1, recordings="/tmp/rec")
    assert results[0]["tool_results"]["error"] == "no ai-service pod"


def test_a_repeated_read_gets_no_result_of_its_own():
    name, _ = _recording("k8s_get_resources", {"resource_type": "pods"}, "")
    calls = [{"tool": "k8s_get_resources", "args": {"resource_type": "pods"}, "failed": False},
             {"tool": "k8s_get_resources", "args": {"resource_type": "pods"}, "failed": False, "repeat_of": 1}]
    with Server(FakeKubeast()) as srv:
        _with_recordings(srv, ["ai-service-a"], {"ai-service-a": {name: ["three pods", 10, "t"]}})
        kept = AI_EVAL.keep_tool_results({}, "/tmp/rec", "default", calls)
    assert calls[0]["result"] == "three pods" and "result" not in calls[1] and kept == {"kept": 1, "of": 1}


def test_alert_tool_results_needs_a_recording_install_and_the_alert_path():
    root = Path(tempfile.mkdtemp(prefix="ai-eval-recording-"))
    (root / CASE["id"]).mkdir()
    (root / CASE["id"] / "case.json").write_text(json.dumps(CASE))
    (root / CASE["id"] / "truth.json").write_text(json.dumps(TRUTH))

    def main(env, *flags):
        fake, out, errors = FakeKubeast(), Path(tempfile.mkdtemp(prefix="ai-eval-recording-out-")) / "out", io.StringIO()
        saved_argv, saved = sys.argv, AI_EVAL.webhook_token
        with Server(fake) as srv, contextlib.redirect_stderr(errors), contextlib.redirect_stdout(io.StringIO()):
            plain = AI_EVAL.sh
            AI_EVAL.sh = lambda cmd, kc, timeout=300, env_=None, **kw: (
                subprocess.CompletedProcess([], 0, env, "") if "get deploy ai-service" in cmd else plain(cmd, kc, timeout, kw.get("env")))
            _with_recordings(srv, ["ai-service-a"], {"ai-service-a": {}})
            try:
                AI_EVAL.webhook_token = lambda kcs: WEBHOOK_TOKEN
                sys.argv = ["ai-eval.py", "--cases", str(root), "--out", str(out), *flags]
                os.environ["E2E_USER_PASSWORD"] = PASSWORD
                try:
                    code = AI_EVAL.main()
                except SystemExit as e:
                    code = e.code
            finally:
                sys.argv = saved_argv
                os.environ.pop("E2E_USER_PASSWORD", None)
                AI_EVAL.webhook_token = saved
        return code, errors.getvalue(), fake, out

    code, errors, fake, out = main("\n\n", "--alerts", "--alert-tool-results")
    assert code == 2 and "AI_TOOL_REPLAY_MODE" in errors and fake.webhooks == [] and not out.exists(), errors
    code, errors, fake, _ = main("replay\n/tmp/rec\n", "--alerts", "--alert-tool-results")
    assert code == 2 and fake.webhooks == []
    code, errors, fake, _ = main("record\n/tmp/rec\n", "--alert-tool-results")
    assert code == 2 and "--alerts" in errors
    code, errors, fake, out = main("record\n/tmp/rec\n", "--alerts", "--alert-tool-results")
    rows = json.loads(next(out.glob("*-claude-haiku-5-5.json")).read_text())
    assert code == 0 and rows[0]["tool_results"] == {"kept": 0, "of": 2}, errors


def test_a_missing_block_with_the_switches_on_is_recorded():
    fake = FakeKubeast()
    fake.result = {"version": 1, "status": "missing", "no_fault": None, "causes": [], "path": [], "ruled_out": [], "hypotheses": []}
    with Server(fake):
        results, _, _ = run(repeat=1)
    assert results[0]["rca"]["block"] == "missing" and not results[0]["rca"]["pass"] and results[0]["text"]["pass"]


def test_a_control_records_whether_the_report_named_a_suspect():
    fake = FakeKubeast()
    reports = iter([NO_FAULT_REPORT, DECOY_REPORT])
    chosen = {}
    fake.report = lambda inv: chosen.setdefault(inv["id"], next(reports))
    with Server(fake):
        results, _, _ = run(case=CONTROL_CASE, truth=CONTROL_TRUTH)
    assert [r["wrong_suspect"] for r in results] == [False, True]
    assert [r["pass"] for r in results] == [True, False]
    assert results[1]["text"]["decoys_named"] == ["thumbnailer"]


def test_the_real_alert_is_waited_for_and_later_runs_replay_it():
    fake = FakeKubeast()
    starts = "2026-11-15T10:00:00.123456Z"
    labels = {"alertname": "ServiceRequestsFailing", "namespace": "shop-90", "severity": "warning", "kubeast_eval": "ai-hard"}
    with Server(fake) as srv:
        AI_EVAL.rule_loaded = lambda cluster, rule: (cluster, rule) == ("default", "ServiceRequestsFailing")
        srv.on_command = lambda cmd: fake.fire("default", labels, {"summary": "checkout fails"}, starts) if "inject.yaml" in cmd else None
        case = {**CASE, "alert": {**CASE["alert"], "rule": "ServiceRequestsFailing"}}
        results, _, _ = run(case=case, source="real")
    assert [r["alert_source"] for r in results] == ["real", "replay"], results
    real = results[0]
    first = next(i for i in reversed(fake.invs) if i["fingerprint"] == "am0f1e2d3c4b5a69")  # the firing's own, not the newer one
    assert real["investigation_id"] == first["id"] and real["matched_by"] == "starts_at" and real["ask_after"] is None
    assert real["starts_at"] == utc(starts)
    posted = [w["body"]["alerts"][0] for w in fake.webhooks]
    assert [a["status"] for a in posted] == ["firing", "resolved"]  # the replay, then its resolve; Alertmanager resolves its own
    assert posted[0]["labels"] == labels and posted[0]["startsAt"] == utc(starts)
    assert posted[0]["annotations"] == {"summary": "checkout fails"} and posted[0]["fingerprint"] == "am0f1e2d3c4b5a69-replay2"
    assert results[1]["pass"] and results[1]["fingerprint"] == "am0f1e2d3c4b5a69-replay2"


def test_real_without_its_rule_loaded_is_not_run_and_auto_posts_instead():
    fake = FakeKubeast()
    with Server(fake):
        results, _, _ = run(source="real")
        assert len(results) == 1 and "--alert-source auto" in results[0]["setup_error"] and fake.webhooks == []
        results, _, _ = run(source="auto", repeat=1)
    assert results[0]["alert_source"] == "synthetic" and results[0]["pass"]


def test_an_alert_the_webhook_does_not_queue_is_a_setup_error():
    fake = FakeKubeast()
    fake.refuse = True
    with Server(fake):
        results, _, _ = run(repeat=1)
    assert "queued no investigation" in results[0]["setup_error"] and "'duplicate': 1" in results[0]["setup_error"]
    assert [w["body"]["alerts"][0]["status"] for w in fake.webhooks] == ["firing", "resolved"]


def test_a_401_in_the_middle_of_a_case_signs_in_again_and_goes_on():
    fake = FakeKubeast()
    fake.invalidate_at_poll = 2
    with Server(fake):
        results, admin, _ = run(repeat=1)
    assert results[0]["pass"] and admin.logins == 2 and fake.unauthorized == 1


def test_an_investigation_of_its_start_that_comes_later_is_taken_over_one_of_its_fingerprint():
    fake = FakeKubeast()
    fake.late_exact, fake.noise = True, False
    with Server(fake):
        results, _, _ = run(repeat=1)
    r = results[0]
    exact = next(i for i in fake.invs if i["fingerprint"] == r["fingerprint"] and i["starts_at"] == r["starts_at"])
    assert r["matched_by"] == "starts_at" and r["investigation_id"] == exact["id"] and r["pass"], r
    assert len([i for i in fake.invs if i["fingerprint"] == r["fingerprint"]]) == 2


def test_a_502_while_waiting_is_read_again_and_the_case_goes_on():
    fake = FakeKubeast()
    fake.list_errors = {3: 502}
    with Server(fake):
        results, _, _ = run(repeat=1)
    assert results[0]["pass"] and "setup_error" not in results[0] and fake.list_polls >= 4, results


def test_reads_failing_in_a_row_end_that_run_only():
    fake = FakeKubeast()
    fake.list_error_after = 2  # the list read before the fault answers; every read after it fails
    with Server(fake) as srv:
        results, _, _ = run(repeat=2)
    assert [r["run"] for r in results] == [1, 2], results
    for r in results:
        assert r["setup_error"] == f"request failed: {AI_EVAL.POLL_ERRORS_IN_A_ROW} reads in a row failed: HTTP 502 Bad Gateway", r
    assert [w["body"]["alerts"][0]["status"] for w in fake.webhooks] == ["firing", "firing", "resolved", "resolved"]
    assert any(c.startswith("kubectl delete namespace shop-90") for c in srv.commands)


def test_a_webhook_post_answered_503_is_sent_once_more():
    fake = FakeKubeast()
    fake.webhook_errors = [503]
    with Server(fake):
        results, _, _ = run(repeat=1)
    assert results[0]["pass"] and "setup_error" not in results[0], results
    fake = FakeKubeast()
    fake.webhook_errors = [503, 503]
    with Server(fake):
        results, _, _ = run(repeat=1)
    assert results[0]["setup_error"] == "request failed: HTTP 503 Service Unavailable", results


def test_hidden_alert_lines_say_done_and_name_no_truth():
    fake = FakeKubeast()
    screen = io.StringIO()
    with Server(fake), contextlib.redirect_stdout(screen):
        results, _, _ = run(case={**CASE, "hidden": True}, repeat=1)
    lines = [x for x in screen.getvalue().splitlines() if x.startswith("90_test_alert alert")]
    assert results[0]["pass"] and len(lines) == 1 and ": done — " in lines[0] and "pass" not in lines[0], lines
    root = Path(tempfile.mkdtemp(prefix="ai-eval-hidden-scope-"))
    for cid, hidden in (("90_shown", False), ("91_kept", True)):
        (root / cid).mkdir()
        (root / cid / "case.json").write_text(json.dumps({**CASE, "id": cid, "hidden": hidden, "alert": {**CASE["alert"], "labels": {
            **CASE["alert"]["labels"], "namespace": "elsewhere"}}}))
        (root / cid / "truth.json").write_text(json.dumps({**TRUTH, "id": cid}))
    _, problems = AI_EVAL.load_cases(root, [], True, alerts=True)
    shown = [x for x in problems if x.startswith("90_shown")]
    kept = [x for x in problems if x.startswith("91_kept")]
    assert shown and "ConfigMap/shop-90/settings-b" in shown[0], problems
    assert kept and not any("settings-b" in x or "shop-90" in x for x in kept), kept


def test_alert_source_is_auto_by_default():
    fake = FakeKubeast()
    root = Path(tempfile.mkdtemp(prefix="ai-eval-auto-"))
    (root / CASE["id"]).mkdir()
    (root / CASE["id"] / "case.json").write_text(json.dumps(CASE))
    (root / CASE["id"] / "truth.json").write_text(json.dumps(TRUTH))
    out = root / "out"
    saved_argv, saved = sys.argv, AI_EVAL.webhook_token
    with Server(fake):
        try:
            AI_EVAL.webhook_token = lambda kcs: WEBHOOK_TOKEN
            sys.argv = ["ai-eval.py", "--cases", str(root), "--alerts", "--out", str(out)]
            os.environ["E2E_USER_PASSWORD"] = PASSWORD
            assert AI_EVAL.main() == 0
        finally:
            sys.argv = saved_argv
            os.environ.pop("E2E_USER_PASSWORD", None)
            AI_EVAL.webhook_token = saved
    rows = json.loads(next(out.glob("*-claude-haiku-5-5.json")).read_text())
    assert [(r["alert_source"], r["pass"]) for r in rows] == [("synthetic", True)], rows


def test_a_fired_alert_without_a_namespace_label_matches_an_empty_namespace():
    fake = FakeKubeast()
    labels = {"alertname": "ServiceSlow", "severity": "warning", "kubeast_eval": "ai-hard"}
    with Server(fake) as srv:
        AI_EVAL.rule_loaded = lambda cluster, rule: True
        srv.on_command = lambda cmd: fake.fire("default", labels, {"summary": "slow"}, "2026-11-15T10:00:00Z") if "inject.yaml" in cmd else None
        case = {**CASE, "alert": {"labels": {"alertname": "ServiceSlow", "namespace": ""}, "rule": "ServiceSlow", "match": {"namespace": ""}}}
        results, _, _ = run(case=case, source="real", repeat=1)
    assert results[0]["alert_source"] == "real" and "setup_error" not in results[0], results


def test_the_table_shows_alert_rows_and_hides_hidden_ones():
    fake = FakeKubeast()
    with Server(fake):
        results, _, _ = run(repeat=1)
    text = AI_EVAL.table(results + [dict(results[0], id="92_kept", hidden=True)])
    assert "| 90_test_alert · #1 | synthetic | ✅ |" in text and "92_kept" not in text
    assert "숨김 사례: 채점된 사례가 둘이 안 되어 결과는 JSON에만" in text


def test_save_keeps_finished_cases_and_names_the_file_by_model():
    out = Path(tempfile.mkdtemp(prefix="ai-eval-save-"))
    name = AI_EVAL.save(out, "20261115000000", [{"id": "01", "setup_error": "x"}], None)
    assert name == "20261115000000-model" and (out / "20261115000000-model.json").exists()
    rows = [{"id": "01", "setup_error": "x"}, {"id": "02", "title": "t", "model": "claude-haiku-5-5", "calls": [], "missing": [],
                                               "forbidden": [], "tools_missing": [], "pass": True, "seconds": 1.0}]
    name = AI_EVAL.save(out, "20261115000000", rows, name)
    assert sorted(p.name for p in out.iterdir()) == ["20261115000000-claude-haiku-5-5.json", "20261115000000-claude-haiku-5-5.md"]
    assert json.loads((out / f"{name}.json").read_text()) == rows


def test_a_chat_round_signs_in_again_when_the_token_ends_between_asks():
    fake = FakeKubeast()
    fake.expire_at_chat = 2
    with Server(fake):
        d = case_dir(CASE, TRUTH)
        admin = AI_EVAL.Api("admin", PASSWORD)
        args = argparse.Namespace(repeat=2, keep=False, user="admin")
        results = AI_EVAL.run_staged_case(d, json.loads((d / "case.json").read_text()), admin, {}, args, "20261115000000", d.parent / "truth")
    assert [(r["form"], r["run"]) for r in results] == [("question", 1), ("question", 2)], results
    assert all(r["pass"] and r["rca"]["pass"] and r["prose_pass"] and r["tokens"] == 100 for r in results)
    assert admin.logins == 2 and fake.unauthorized == 1
    assert set(results[0]["stage"]) >= {"SETUP_TIME", "INJECT_TIME", "UNDO_TIME"}


def test_a_round_writes_its_report_after_each_case():
    fake = FakeKubeast()
    root = Path(tempfile.mkdtemp(prefix="ai-eval-round-"))
    for cid in ("90_a", "91_b"):
        (root / cid).mkdir()
        (root / cid / "case.json").write_text(json.dumps({**CASE, "id": cid}))
        (root / cid / "truth.json").write_text(json.dumps({**TRUTH, "id": cid}))
    out = root / "out"
    seen = []

    def one_case(case_dir, case, *args):
        seen.append(sorted(p.name for p in out.glob("*-model.json")) if out.exists() else [])
        if case["id"] == "91_b":  # what a later case finds on disk is what a run killed there would leave
            on_disk = json.loads(next(out.glob("*-model.json")).read_text())
            assert [r["id"] for r in on_disk] == ["90_a"], on_disk
        return [{"id": case["id"], "title": "t", "form": "alert", "run": 1, "setup_error": "stand-in"}]

    saved_argv, saved = sys.argv, {k: getattr(AI_EVAL, k) for k in ("run_alert_case", "webhook_token")}
    with Server(fake):
        try:
            AI_EVAL.run_alert_case = one_case
            AI_EVAL.webhook_token = lambda kcs: WEBHOOK_TOKEN
            sys.argv = ["ai-eval.py", "--cases", str(root), "--alerts", "--out", str(out)]
            os.environ["E2E_USER_PASSWORD"] = PASSWORD
            assert AI_EVAL.main() == 0
        finally:
            sys.argv = saved_argv
            os.environ.pop("E2E_USER_PASSWORD", None)
            for k, v in saved.items():
                setattr(AI_EVAL, k, v)
    assert seen[0] == [] and len(seen[1]) == 1
    assert [r["id"] for r in json.loads(next(out.glob("*-model.json")).read_text())] == ["90_a", "91_b"]
    info = json.loads(next(out.glob("*-round.json")).read_text())
    assert info["user"] == "admin" and info["before"]["default"]["investigations"] == 0 and "after" in info  # the investigator asks


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
