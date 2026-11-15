"""Checks scripts/ai-eval.py's sign-in and its alert path against a stand-in of Kubeast's API (a local HTTP server):
signing in again on a 401 and before the token's lifetime is over, and a case run through the alert path — the alert
posted or fired, its investigation found by its start, waited for and scored, the alerts resolved at the end. No
cluster: the runner's shell steps and clock are replaced, so nothing here reaches kubectl, kind or docker.

  python3 -m pytest -q scripts/test_ai_eval_alerts.py
  python3 scripts/test_ai_eval_alerts.py        # the same checks without pytest
"""
import argparse
import base64
import hashlib
import hmac
import importlib.util
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


def run(case=CASE, truth=TRUTH, repeat=2, source="synthetic", server=None):
    d = case_dir(case, truth)
    loaded = json.loads((d / "case.json").read_text())
    admin = AI_EVAL.Api("admin", PASSWORD)
    args = argparse.Namespace(repeat=repeat, keep=False, alert_source=source)
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
    assert "숨김 사례 1개" in text


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
