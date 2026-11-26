"""features.alertInvestigation.pastReports.window changes no investigation: off (unset, or any value that is not on) or on,
and whatever ALERT_INVESTIGATION_PAST_MODEL says, an alert investigation sends the model the same bytes — its messages,
its tool list, the answer length —, keeps the same report, tool calls and result and writes the same audit rows, over an
alert with a namespace and one without, with every investigation switch of the chart's defaults and with none. Off, the
alert's window, its marks, "Investigate now" and its report answer the same bytes whether or not the screen asks for the
earlier investigations, the bytes they answer with it on when the screen does not ask. Each is held as a sha256."""

import hashlib
import itertools
import json
from datetime import timedelta
from types import SimpleNamespace

import pytest

from app.services.investigation import inbox, runner, store
from app.services.investigation import settings as inv_settings
from tests.test_alert_inbox import client, labels
from tests.test_alert_investigation import NOW, FakeCompletions, FakeService, completion, row, tool_call
from tests.test_investigation_narrowing import NARROWING, anomaly_rank_on
from tests.test_investigation_window import CHANGES, STARTED, at_now

WINDOW, MODEL = "ALERT_INVESTIGATION_PAST_WINDOW", "ALERT_INVESTIGATION_PAST_MODEL"
DEFAULTS = ("ALERT_INVESTIGATION_RULES", "ALERT_INVESTIGATION_CHANGES_FIRST", "ALERT_INVESTIGATION_NARROW_FIRST",
            "ALERT_INVESTIGATION_LEDGER", "ALERT_INVESTIGATION_EVIDENCE_CHECK", "ALERT_INVESTIGATION_VERDICT",
            "AI_RULE_CARDS_INVESTIGATIONS", "ANOMALY_RANK_ENABLED")
RUNS = [f"{ns}, {s}: {part}" for ns in ("apps", "no namespace") for s in ("defaults", "none")
        for part in ("calls", "tool calls", "kept", "audit")]
_DATABASES = itertools.count()

TOOLS = ("k8s_get_resources", "k8s_get_events", "k8s_get_pod_logs", "timeline", "anomaly_rank", "alerts_inbox", "alerts_list",
         "k8s_delete_resource")
BLOCK = "\n\n```rca\n" + json.dumps({
    "outcome": "cause_found", "symptom": {"resource": "Pod/apps/pod-1", "evidence": [3]}, "no_fault": False,
    "causes": [{"resource": "Pod/apps/pod-1", "kind": "crash", "started_at": None, "evidence": [3, 4]}], "path": ["Pod/apps/pod-1"],
    "ruled_out": [], "hypotheses": [{"id": "h1", "statement": "pod-1 crashes", "resource": "Pod/apps/pod-1", "state": "cause",
                                     "for": [3], "against": []}]}) + "\n```"


class AsSent(FakeCompletions):
    """Each call as it was sent: the runner goes on adding to the messages list it passed."""

    async def create(self, **kw):
        return await super().create(**json.loads(json.dumps(kw, default=str)))


class Service(FakeService):
    def __init__(self):
        super().__init__([])
        self.completions = AsSent([
            completion(calls=[tool_call("c1", "k8s_get_resources", {"resource_type": "pods", "namespace": "apps"}),
                              tool_call("c2", "alerts_inbox", {"alert_id": "a1", "with_report": True})]),
            completion(calls=[tool_call("c3", "alerts_inbox", {"status": "firing"}), tool_call("c4", "k8s_delete_resource", {"resource_type": "pod"})]),
            completion(content="## Summary\npod-1 crashes." + BLOCK), completion(content="## Summary\npod-1 crashes, again." + BLOCK)])
        self.client = SimpleNamespace(chat=SimpleNamespace(completions=self.completions))
        self.k8s_service = SimpleNamespace()

    def _get_tools_definition(self):
        return [{"type": "function", "function": {"name": n}} for n in TOOLS]

    async def _execute_function_with_context(self, name, args, ctx):
        self.executed.append((name, args))
        return {"timeline": CHANGES, "anomaly_rank": NARROWING, "alerts_inbox": json.dumps({"id": "a1", "investigation_report": "## Summary\nx"})}.get(
            name, "NAME READY\npod-1 0/1")


def _sha(value) -> str:
    return hashlib.sha256(json.dumps(value, ensure_ascii=False, sort_keys=True, default=str).encode()).hexdigest()


async def _run(monkeypatch, namespace, switches) -> dict:
    for name in DEFAULTS:
        monkeypatch.setenv(name, "true" if name in switches else "false")
    anomaly_rank_on(monkeypatch, on="ANOMALY_RANK_ENABLED" in switches)
    at_now(monkeypatch)
    service, audits, kept = Service(), [], []

    async def token(c, cluster, ns):
        return "investigator-token"

    async def build(c, t, cluster):
        return service

    async def audit(**kw):
        audits.append(kw)
        return True

    async def audit_ready():
        return True, None

    async def finish(db, inv_id, **fields):
        kept.append({"id": inv_id, **fields})

    async def no_database():
        raise RuntimeError("an investigation reads no database of its own here")

    for name, fn in (("fetch_token", token), ("build_service", build), ("write_audit", audit), ("audit_ready", audit_ready),
                     ("get_db_service", no_database)):
        monkeypatch.setattr(runner, name, fn)
    monkeypatch.setattr(runner.store, "finish", finish)
    alert = row(namespace=namespace, starts_at=STARTED, received_at=NOW, requested_by="",
                labels={"alertname": "KubePodCrashLooping", "pod": "pod-1", **({"namespace": namespace} if namespace else {})})
    assert await runner.run_one(inv_settings.load(), None, alert) == "done"
    for a in audits:
        a["after"].pop("duration_ms", None)
    return {"calls": _sha([{k: c.get(k) for k in ("messages", "tools", "max_tokens", "tool_choice")} for c in service.completions.calls]),
            "tool calls": _sha(service.executed), "kept": _sha(kept), "audit": _sha(audits)}


async def _window(monkeypatch, tmp_path, query) -> dict:
    from app.database import DatabaseService

    db = DatabaseService(f"sqlite+aiosqlite:///{tmp_path}/off{next(_DATABASES)}.db")  # one of its own each time
    await db.init_db()
    try:
        monkeypatch.setattr(inbox, "uuid", SimpleNamespace(uuid4=lambda: "alert-1"))
        await inbox.record(db, cluster="self", fingerprint="fp1", firing=True, starts_at=NOW, ends_at=None, labels=labels(),
                           annotations={"summary": "s"}, generator_url="", alertmanager_url="", receiver="kubeast", group_key="g", now=NOW)
        for n, at in enumerate((NOW - timedelta(days=1), NOW)):
            await store.insert(db, id=f"inv-{n}", cluster="self", fingerprint="fp1", namespace="apps", alertname="KubePodCrashLooping",
                               starts_at=at, received_at=at, status="running")
            await store.finish(db, f"inv-{n}", status="done", report=f"## Summary\n{n}", finished_at=at + timedelta(minutes=1))
            await store.bump_repeat(db, f"inv-{n}", at)
        c, audits = client(monkeypatch, db, at=NOW, matrix={"self": ("resource.pod.read", "resource.alert.investigate")},
                           past_window=inv_settings.load().past_window)
        base = "/api/v1/alerts/inbox/alert-1"
        answers = [c.get(base + query), c.patch(base + query, json={"done": True}), c.post(base + "/investigate" + query),
                   c.get(base + "/investigation"), c.get("/api/v1/alerts/inbox?cluster=self")]
        assert [a.status_code for a in answers] == [200] * 5
        return {"answers": _sha([a.text for a in answers]), "audit": _sha(audits)}
    finally:
        await db.engine.dispose()


async def recorded(monkeypatch, tmp_path) -> dict:
    out = {}
    for namespace in ("apps", ""):
        for name, switches in (("defaults", DEFAULTS), ("none", ())):
            for part, sha in (await _run(monkeypatch, namespace, switches)).items():
                out[f"{namespace or 'no namespace'}, {name}: {part}"] = sha
    for asked, query in (("", ""), (", asked", "?past=true")):
        for part, sha in (await _window(monkeypatch, tmp_path, query)).items():
            out[f"window{asked}: {part}"] = sha
    return out


def _set(monkeypatch, name, value):
    monkeypatch.delenv(name, raising=False) if value is None else monkeypatch.setenv(name, value)


@pytest.mark.parametrize("model", [None, "true", "on", "false"])
@pytest.mark.parametrize("value", [None, "false", "", "off", "0"])
@pytest.mark.asyncio
async def test_off_everything_is_as_on_when_the_screen_does_not_ask(monkeypatch, tmp_path, value, model):
    _set(monkeypatch, MODEL, model)
    monkeypatch.setenv(WINDOW, "true")
    on = await recorded(monkeypatch, tmp_path)
    _set(monkeypatch, WINDOW, value)
    off = await recorded(monkeypatch, tmp_path)
    assert {k: off[k] for k in RUNS} == {k: on[k] for k in RUNS}
    assert off["window: answers"] == off["window, asked: answers"] == on["window: answers"]
    assert off["window: audit"] == off["window, asked: audit"] == on["window: audit"] == on["window, asked: audit"]


@pytest.mark.asyncio
async def test_the_pins_see_the_switch(monkeypatch, tmp_path):
    """On, and asked, the window's answers hold the list: what is pinned is what the switch changes, and only there."""
    monkeypatch.delenv(WINDOW, raising=False)
    off = await recorded(monkeypatch, tmp_path)
    monkeypatch.setenv(WINDOW, "true")
    monkeypatch.setenv(MODEL, "true")
    on = await recorded(monkeypatch, tmp_path)
    assert {name for name in off if on[name] != off[name]} == {"window, asked: answers"}
    assert len(set(off.values())) > 4  # the runs of each case differ from each other: the pins see what they hold
