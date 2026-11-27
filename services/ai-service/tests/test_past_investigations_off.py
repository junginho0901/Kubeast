"""With both switches of features.alertInvestigation.pastReports off (unset, or any value that is not on), an alert
investigation sends the model the bytes it sent before them — its messages, its tool list, the answer length —, keeps the
same report, tool calls and result and writes the same audit rows, and the alert's window, its marks, "Investigate now" and
its report answer the same bytes, whether or not the screen asks for the earlier investigations. Each is held as the
sha256 of what main 0773e121 sends and answers (none of the code under test is in it: `recorded` runs there as here), over
an alert with a namespace and one without, with every investigation switch of the chart's defaults and with none."""

import hashlib
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

PAST = ("ALERT_INVESTIGATION_PAST_WINDOW", "ALERT_INVESTIGATION_PAST_MODEL")
DEFAULTS = ("ALERT_INVESTIGATION_RULES", "ALERT_INVESTIGATION_CHANGES_FIRST", "ALERT_INVESTIGATION_NARROW_FIRST",
            "ALERT_INVESTIGATION_LEDGER", "ALERT_INVESTIGATION_EVIDENCE_CHECK", "ALERT_INVESTIGATION_VERDICT",
            "AI_RULE_CARDS_INVESTIGATIONS", "ANOMALY_RANK_ENABLED")

# What main 0773e121 gives (the run of each case by namespace and switches, then the alert window's answers).
MAIN = {
    "apps, defaults: calls": "9c816a9d379e341e10674ece0803924e1cbb3888d8dcef3f3f73d9e33564f88f",
    "apps, defaults: tool calls": "581c24ca617732c51253c48b2b2d1fdd6d46c05c0fba776698c9923a45d2c2e5",
    "apps, defaults: kept": "aa1d3905549a2698d4c5924cf3a0122a654fac9c0dac0091100c4398cfbd2ff4",
    "apps, defaults: audit": "bd13aea226a6f75b87d821484896bbdf7de04e906b9213d369894624dccf0e46",
    "apps, none: calls": "59227398f28042b5b6f66447a9779ea904924ef94c3e0871cd46e0048c105186",
    "apps, none: tool calls": "c45a433fce67b09e9e3e57f8c1cdf1d065fd37325d345dfe7a14d6ec98ef0947",
    "apps, none: kept": "45bb256884d0c73c38f68f6258b96d8e9692f06a7344580fa730574ba1a58089",
    "apps, none: audit": "cabd958b0868d9229e84308d9c36ce86883006dd4b16e202e1e52d2bbad7333b",
    "no namespace, defaults: calls": "864566fc3e7403a1d87e828c682e6b8d29c5420dd4ff2684d9cd7fbd8daa84c0",
    "no namespace, defaults: tool calls": "74d814729afa5b62691d8b04579415adaf03bbf831e760e898ab98afd4ee4658",
    "no namespace, defaults: kept": "e37cf529d724d43236cc7fee8d0529aba762130aa1b823945f523c601c80ba2a",
    "no namespace, defaults: audit": "0740ffe19ebe259a8276345caf0582eedc6fef74536fef8a52c1a868bc8afd40",
    "no namespace, none: calls": "6f134611cc0454f7cfabc8aaac540bc1a1e803db04891dfe89f09ad15e3f40b2",
    "no namespace, none: tool calls": "c45a433fce67b09e9e3e57f8c1cdf1d065fd37325d345dfe7a14d6ec98ef0947",
    "no namespace, none: kept": "45bb256884d0c73c38f68f6258b96d8e9692f06a7344580fa730574ba1a58089",
    "no namespace, none: audit": "aa1d62767ec0bc621b4bfd6983d228fc6b48c8d60cd10b3a61d92241c90abc92",
    "window: answers": "841670ab5d1ceabbfbaa4c6a970166a0d191000af90487cf04639878efc99fd6",
    "window: audit": "f7de6f16b3efba0e54c63d94f9c62d1dfcdd39a4c326d3317274a55561931c1b",
    "window, asked: answers": "841670ab5d1ceabbfbaa4c6a970166a0d191000af90487cf04639878efc99fd6",
    "window, asked: audit": "f7de6f16b3efba0e54c63d94f9c62d1dfcdd39a4c326d3317274a55561931c1b",
}

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

    db = DatabaseService(f"sqlite+aiosqlite:///{tmp_path}/off{len(query)}.db")
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
        c, audits = client(monkeypatch, db, at=NOW, matrix={"self": ("resource.pod.read", "resource.alert.investigate")}, **inv_settings_off())
        base = "/api/v1/alerts/inbox/alert-1"
        answers = [c.get(base + query), c.patch(base + query, json={"done": True}), c.post(base + "/investigate" + query),
                   c.get(base + "/investigation"), c.get("/api/v1/alerts/inbox?cluster=self")]
        assert [a.status_code for a in answers] == [200] * 5
        return {"answers": _sha([a.text for a in answers]), "audit": _sha(audits)}
    finally:
        await db.engine.dispose()


def inv_settings_off() -> dict:
    """The past switches as the environment gives them, for a settings class that has them."""
    s = inv_settings.load()
    return {f: getattr(s, f) for f in ("past_window", "past_model") if hasattr(s, f)}


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


@pytest.mark.parametrize("value", [None, "false", "", "off", "0"])
@pytest.mark.asyncio
async def test_off_everything_is_as_main_has_it(monkeypatch, tmp_path, value):
    for name in PAST:
        monkeypatch.delenv(name, raising=False) if value is None else monkeypatch.setenv(name, value)
    got = await recorded(monkeypatch, tmp_path)
    assert got == MAIN
    assert got["window: answers"] == got["window, asked: answers"]


@pytest.mark.asyncio
async def test_the_pins_see_the_switches(monkeypatch, tmp_path):
    """The same run with a switch on is not main's: what is pinned is what the switches change."""
    monkeypatch.setenv("ALERT_INVESTIGATION_PAST_MODEL", "true")
    monkeypatch.setenv("ALERT_INVESTIGATION_PAST_WINDOW", "true")
    got = await recorded(monkeypatch, tmp_path)
    changed = {name for name in MAIN if got[name] != MAIN[name]}
    assert changed == {f"{ns}, {s}: {part}" for ns in ("apps", "no namespace") for s in ("defaults", "none")
                       for part in ("calls", "tool calls", "kept", "audit")} | {"window, asked: answers"}
