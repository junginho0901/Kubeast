"""The same alert's earlier investigations (features.alertInvestigation.pastReports.window, investigation/past.py): what one
read takes and whose rows it may take, the alert window's list, and that nothing of them reaches an investigation, which
reads no stored report through alerts_inbox either. With the switch off: test_past_investigations_off.py."""

import dataclasses
import json
import re
from datetime import timedelta
from pathlib import Path

import pytest
from sqlalchemy import text
from sqlalchemy.dialects import postgresql

from app.services.investigation import inbox, past, runner, store
from app.services.investigation import settings as inv_settings
from tests.test_alert_inbox import client, labels
from tests.test_alert_investigation import NOW, FakeService, cfg, completion, install_loop, row, tool_call
from tests.test_investigation_window import STARTED, at_now, first_message
from tests.test_switch_cases import CASES

# The index the read goes by, as the migration makes it.
MIGRATION = Path(__file__).parents[2] / "pkg/dbmigrate/migrations/00014_alert_investigations.sql"
DEDUPE_INDEX = re.search(r"CREATE INDEX IF NOT EXISTS idx_alert_investigations_dedupe .*?;", MIGRATION.read_text())[0]

MARK = "KUBEAST-PLANT-PAST"


@pytest.fixture
async def db(tmp_path):
    from app.database import DatabaseService

    db = DatabaseService(f"sqlite+aiosqlite:///{tmp_path}/past.db")
    await db.init_db()
    async with db.engine.begin() as conn:
        await conn.execute(text("CREATE TABLE clusters (id VARCHAR PRIMARY KEY, created_at TIMESTAMP)"))  # auth-service's
        await conn.execute(text(DEDUPE_INDEX))
        for cluster in ("self", "default"):
            await conn.execute(past._CLUSTERS.insert().values(id=cluster, created_at=NOW - timedelta(days=400)))
    yield db
    await db.engine.dispose()


def found(resource="Deployment/apps/web", kind="rollout", *, verified=True, tools=("k8s_get_events",), outcome="cause_found", **over):
    """An investigation's `result` that found a cause, as investigation/result.py shapes it."""
    cause = {"resource": resource, "kind": kind, "started_at": None, "evidence": [{"call": i, "tool": t} for i, t in enumerate(tools, 1)],
             "raw_evidence": list(range(1, len(tools) + 1))}
    if verified is not None:
        cause["verified"] = verified
    return {"version": 1, "status": "ok", "no_fault": False, "causes": [cause], "path": [], "ruled_out": [], "hypotheses": [],
            "asked_again": False, "verdict": {"outcome": outcome, "said": outcome, "why": []}, **over}


async def put(db, ago=timedelta(days=1), *, result=None, status="done", report="## Summary\nx", **kw):
    fields = dict(cluster="self", fingerprint="fp1", namespace="apps", alertname="KubePodCrashLooping", starts_at=NOW - ago,
                  received_at=NOW - ago)
    fields.update(kw)
    inv = await store.insert(db, status="running", **fields)
    await store.finish(db, inv, status=status, report=report, result=found() if result is None else result)
    await store.bump_repeat(db, inv, NOW - ago)  # last seen when it was received: no later firing folded into it
    return inv


async def read_ids(db, **kw):
    return [p.id for p in await past.read(db, **{**dict(cluster="self", fingerprint="fp1", namespace="apps", before=NOW, now=NOW), **kw})]


# --- the switch -----------------------------------------------------------------------------------------------------


@pytest.mark.parametrize("case", CASES, ids=lambda c: repr(c["value"]))
def test_the_switch_reads_the_one_switch_rule(monkeypatch, case):
    monkeypatch.delenv("ALERT_INVESTIGATION_PAST_WINDOW", raising=False)
    assert inv_settings.load().past_window is False
    monkeypatch.setenv("ALERT_INVESTIGATION_PAST_WINDOW", case["value"])
    assert inv_settings.load().past_window is case["on"]


@pytest.mark.parametrize("case", CASES, ids=lambda c: repr(c["value"]))
def test_no_switch_gives_a_model_the_earlier_investigations(monkeypatch, case):
    """The settings have the window's switch alone: ALERT_INVESTIGATION_PAST_MODEL, whatever it says, changes none of them."""
    monkeypatch.delenv("ALERT_INVESTIGATION_PAST_MODEL", raising=False)
    before = inv_settings.load()
    monkeypatch.setenv("ALERT_INVESTIGATION_PAST_MODEL", case["value"])
    assert inv_settings.load() == before
    assert [f.name for f in dataclasses.fields(inv_settings.InvestigationSettings) if f.name.startswith("past")] == ["past_window"]
    with pytest.raises(TypeError):
        cfg(past_model=True)


# --- what one read takes ----------------------------------------------------------------------------------------------


def _statement(limit=past.READ_ROWS):
    return past.statement(cluster="self", fingerprint="fp1", namespace="apps", before=NOW, now=NOW, limit=limit)


def test_a_read_is_of_a_few_rows_and_never_of_a_reports_text():
    sql = str(_statement().compile(dialect=postgresql.dialect(), compile_kwargs={"literal_binds": True}))
    columns = sql.split("FROM")[0]
    assert re.findall(r"alert_investigations\.(\w+)", columns) == ["id", "received_at", "result"]
    assert "LIMIT 20" in sql and past.READ_ROWS == 20 and past.MAX_LINES == 5 and past.DAYS == 30
    assert "LIMIT 20" in str(_statement(10_000).compile(dialect=postgresql.dialect(), compile_kwargs={"literal_binds": True}))
    assert "LIMIT 5" in str(_statement(5).compile(dialect=postgresql.dialect(), compile_kwargs={"literal_binds": True}))


@pytest.mark.asyncio
async def test_a_read_goes_by_the_dedupe_index_over_that_alerts_rows_alone(db):
    plan = []
    async with db.engine.connect() as conn:
        sql = str(_statement().compile(dialect=conn.dialect, compile_kwargs={"literal_binds": True}))
        plan = [r[-1] for r in (await conn.execute(text(f"EXPLAIN QUERY PLAN {sql}"))).all()]
    assert any("USING INDEX idx_alert_investigations_dedupe (cluster=? AND fingerprint=? AND received_at>? AND received_at<?)" in p
               for p in plan), plan
    assert not any("SCAN alert_investigations" in p or "TEMP B-TREE" in p for p in plan), plan


@pytest.mark.asyncio
async def test_a_read_gives_the_alerts_done_investigations_of_thirty_days_newest_first(db):
    ids = [await put(db, timedelta(days=d)) for d in (29, 3, 1)]
    await put(db, timedelta(days=30, minutes=1))                   # past the thirty days
    for status in ("failed", "skipped", "running", "queued"):
        await put(db, timedelta(days=2), status=status)
    await put(db, timedelta(0))                                    # received with the one at hand
    await put(db, timedelta(hours=-1))                             # after it
    got = await past.read(db, cluster="self", fingerprint="fp1", namespace="apps", before=NOW, now=NOW)
    assert [p.id for p in got] == ids[::-1]


@pytest.mark.asyncio
async def test_a_read_takes_no_other_clusters_namespaces_or_alerts_row(db):
    mine = await put(db)
    await put(db, cluster="default")
    await put(db, namespace="billing")
    await put(db, namespace="")
    await put(db, fingerprint="fp2")
    read = lambda **kw: past.read(db, **{**dict(cluster="self", fingerprint="fp1", namespace="apps", before=NOW, now=NOW), **kw})  # noqa: E731
    assert [p.id for p in await read()] == [mine]
    assert [p.id for p in await read(namespace="")] not in ([], [mine])  # an alert without a namespace: the one without, no other
    assert len(await read(namespace="")) == 1
    assert await read(namespace="nowhere") == [] and await read(cluster="third") == [] and await read(fingerprint="fp9") == []


@pytest.mark.asyncio
async def test_a_cluster_registered_again_under_its_name_starts_with_none(db):
    await put(db, timedelta(days=3))
    newer = await put(db, timedelta(days=1))
    async with db.engine.begin() as conn:
        await conn.execute(text("DELETE FROM clusters WHERE id = 'self'"))
    assert await read_ids(db) == []  # removed: not read at all
    async with db.engine.begin() as conn:
        await conn.execute(past._CLUSTERS.insert().values(id="self", created_at=NOW - timedelta(days=2)))
    assert await read_ids(db) == [newer]


@pytest.mark.asyncio
async def test_a_result_is_read_whatever_shape_it_has(db):
    """A run with no block, one the server could not read, one written without the verdict, and shapes nothing writes."""
    results = [None, {}, found(status="missing", causes=[]), found(causes=None), found(causes=["x", {"resource": None}]),
               {k: v for k, v in found().items() if k != "verdict"}, found(verdict={"outcome": "sure"}),
               {**{k: v for k, v in found(causes=[]).items() if k != "verdict"}, "no_fault": True},
               {k: v for k, v in found(causes=[]).items() if k != "verdict"}]
    for n, result in enumerate(results):
        inv = await put(db, timedelta(hours=n + 1))
        await store.finish(db, inv, status="done", result=result)
    got = await past.read(db, cluster="self", fingerprint="fp1", namespace="apps", before=NOW, now=NOW)
    assert [p.outcome for p in got] == [None, None, None, "cause_found", "cause_found", "cause_found", None, "no_fault", "cannot_tell"]


# --- the run --------------------------------------------------------------------------------------------------------


REPORT = "## Summary\nweb restarts."
BLOCK = "\n\n```rca\n" + json.dumps({"no_fault": False, "causes": [{"resource": "Deployment/apps/db", "kind": "dependency_down",
                                                                    "started_at": None, "evidence": [1]}], "path": [], "ruled_out": []}) + "\n```"


class InboxTool(FakeService):
    def _get_tools_definition(self):
        return super()._get_tools_definition() + [{"type": "function", "function": {"name": "alerts_inbox"}}]


async def run(monkeypatch, db, service, audits=None, progress=None, row_kw=None, **kw):
    install_loop(monkeypatch, service, audits if audits is not None else [])
    at_now(monkeypatch)

    async def token(c, cluster, ns):  # an alert without a namespace too
        return "investigator-token"

    monkeypatch.setattr(runner, "fetch_token", token)

    async def get_db():
        if isinstance(db, Exception):
            raise db
        return db

    monkeypatch.setattr(runner, "get_db_service", get_db)
    return await runner.investigate(cfg(max_steps=5, **kw), row(starts_at=STARTED, received_at=NOW, **(row_kw or {})),
                                    progress if progress is not None else {})


def sent(service, n=0):
    return json.loads(json.dumps(service.completions.calls[n], default=str))


@pytest.mark.parametrize("namespace", ["apps", ""], ids=["an alert with a namespace", "one without"])
@pytest.mark.parametrize("value, refused", [(True, True), ("true", True), (1, True), (False, False), ("false", False), (None, False)])
@pytest.mark.asyncio
async def test_a_run_reads_no_stored_report_through_alerts_inbox(monkeypatch, db, namespace, value, refused):
    """Whatever the switch: a stored report is what a model wrote then, with no call of this run behind it and no rule on
    how old it is. The call is not run, its row is a failure, and the model is told to read the alert without it."""
    args = {"alert_id": "a1", **({} if value is None else {"with_report": value})}
    for on in (False, True):
        script = [completion(calls=[tool_call("c1", "alerts_inbox", args)]), completion(content=REPORT)]
        service, audits = InboxTool(script), []
        out = await run(monkeypatch, db, service, audits, row_kw={"namespace": namespace}, past_window=on)
        assert (service.executed == []) is refused, on
        call = next(a for a in audits if a["action"] == "ai.tool.call")
        assert (call["result"] == "failure") is refused and bool(out["tool_calls"][0].get("error")) is refused
        if refused:
            said = service.completions.calls[1]["messages"][-1]["content"]
            assert past.NO_REPORT in said and "pod-1" not in said
            assert out["tool_calls"][0]["error"] == call["error"] == "reports of earlier investigations are not read here"
        else:
            assert service.executed == [("alerts_inbox", args)]


@pytest.mark.asyncio
async def test_nothing_of_the_earlier_investigations_reaches_a_run(monkeypatch, db):
    """The window on and ALERT_INVESTIGATION_PAST_MODEL set: a run whose alert has earlier investigations sends the model
    what one sent before they were there, keeps what it kept, and reads none of them."""
    monkeypatch.setenv("ALERT_INVESTIGATION_PAST_MODEL", "true")
    read = []

    async def recorded(*a, **kw):
        read.append(kw)
        return []

    def service():
        answer = completion(content=REPORT + BLOCK)
        return FakeService([completion(calls=[tool_call("c1", "k8s_get_resources", {"resource_type": "pods", "namespace": "apps"})]),
                            answer, answer])

    switches = dict(past_window=True, evidence_check=True, verdict=True)
    before, first = service(), {}
    a = await run(monkeypatch, db, before, progress=first, **switches)
    result = found("Deployment/apps/db", "dependency_down", path=[MARK], ruled_out=[f"Pod/apps/{MARK}"])
    result["causes"][0]["named_by"] = [{"call": 1, "tool": "k8s_get_events"}]  # as a run with the switch on kept it
    for d in (1, 2, 3):
        await put(db, timedelta(days=d), result=result, report=f"## Summary\n{MARK}")
    monkeypatch.setattr(past, "read", recorded)
    after, second = service(), {}
    b = await run(monkeypatch, db, after, progress=second, **switches)
    assert read == [] and a == b
    assert {k: v for k, v in first.items() if k != "usage"} == {k: v for k, v in second.items() if k != "usage"}
    every = [sent(after, n) for n in range(len(after.completions.calls))]
    assert [sent(before, n) for n in range(len(before.completions.calls))] == every and len(every) >= 2
    said = json.dumps(every, ensure_ascii=False)
    assert MARK not in said and "PAST" not in said and "past_investigations" not in second
    assert "named_by" not in json.dumps(b["result"]) and "PAST" not in first_message(after)


@pytest.mark.asyncio
async def test_the_runs_audit_row_names_no_earlier_investigation(monkeypatch, db):
    await put(db, timedelta(days=1))
    monkeypatch.setenv("ALERT_INVESTIGATION_PAST_MODEL", "true")
    audits, service = [], FakeService([completion(content=REPORT)])
    install_loop(monkeypatch, service, audits)
    at_now(monkeypatch)

    async def get_db():
        return db

    async def finish(_db, inv_id, **f):
        pass

    monkeypatch.setattr(runner, "get_db_service", get_db)
    monkeypatch.setattr(runner.store, "finish", finish)
    assert await runner.run_one(cfg(past_window=True), None, row(received_at=NOW)) == "done"
    after = next(a for a in audits if a["action"] == "ai.investigation.run")["after"]
    assert "past_investigations" not in after


# --- the alert's window -----------------------------------------------------------------------------------------------


async def put_alert(db, ago=timedelta(hours=1), *, fp="fp1", cluster="self", namespace="apps"):
    await inbox.record(db, cluster=cluster, fingerprint=fp, firing=True, starts_at=NOW - ago, ends_at=None, labels=labels(namespace=namespace),
                       annotations={"summary": "s"}, generator_url="", alertmanager_url="", receiver="kubeast", group_key="g", now=NOW - ago)
    rows, _, _ = await inbox.list_rows(db, cluster=cluster, stale_before=NOW - timedelta(days=90))
    return next(r for r in rows if r.fingerprint == fp and r.starts_at == NOW - ago).id


def window(monkeypatch, db, **kw):
    return client(monkeypatch, db, at=NOW, **{"past_window": True, **kw})


def url(item, query="?past=true"):
    return f"/api/v1/alerts/inbox/{item}{query}"


@pytest.mark.asyncio
async def test_the_window_lists_the_alerts_earlier_investigations_when_the_screen_asks(monkeypatch, db):
    item = await put_alert(db)
    older = await put(db, timedelta(days=2), result=found(outcome="cannot_tell", causes=[]))
    newer = await put(db, timedelta(days=1), result=found(verified=False))
    bare = await put(db, timedelta(days=3))
    await store.finish(db, bare, status="done", result=None)
    c, audits = window(monkeypatch, db)
    got = c.get(url(item)).json()
    assert got["past_investigations"] == [
        {"id": newer, "received_at": "2026-10-12T12:00:00Z", "outcome": "cause_found", "causes_total": 1,
         "causes": [{"resource": "Deployment/apps/web", "kind": "rollout", "verified": False}]},
        {"id": older, "received_at": "2026-10-11T12:00:00Z", "outcome": "cannot_tell", "causes_total": 0, "causes": []},
        {"id": bare, "received_at": "2026-10-10T12:00:00Z", "outcome": None, "causes_total": 0, "causes": []}]
    # not asked: as before, and the list itself reads no report (no audit row of its own)
    plain = c.get(url(item, "")).json()
    assert "past_investigations" not in plain and plain == {k: v for k, v in got.items() if k != "past_investigations"}
    assert audits == []


@pytest.mark.asyncio
async def test_the_window_lists_five_and_a_masked_value_stays_its_placeholder(monkeypatch, db):
    item = await put_alert(db)
    six = [await put(db, timedelta(days=d), result=found("Pod/apps/<EMAIL_1>")) for d in range(1, 7)]
    c, _ = window(monkeypatch, db)
    listed = c.get(url(item)).json()["past_investigations"]
    assert [p["id"] for p in listed] == six[:5] and {p["causes"][0]["resource"] for p in listed} == {"Pod/apps/<EMAIL_1>"}
    many = found()
    many["causes"] = [dict(many["causes"][0], resource=f"Pod/apps/p{n}") for n in range(5)]
    await put(db, timedelta(hours=3), result=many)
    top = c.get(url(item)).json()["past_investigations"][0]
    assert [x["resource"] for x in top["causes"]] == ["Pod/apps/p0", "Pod/apps/p1", "Pod/apps/p2"] and top["causes_total"] == 5


@pytest.mark.asyncio
async def test_a_window_lists_what_came_before_its_own_investigation(monkeypatch, db):
    first, second = await put_alert(db, timedelta(days=2)), await put_alert(db, timedelta(days=1))
    of_first = await put(db, timedelta(days=2))
    of_second = await put(db, timedelta(days=1))
    c, _ = window(monkeypatch, db)
    seen = lambda item: (c.get(url(item)).json()["investigation"]["id"], [p["id"] for p in c.get(url(item)).json()["past_investigations"]])  # noqa: E731
    assert seen(second) == (of_second, [of_first])
    assert seen(first) == (of_first, [])
    # a firing with no investigation of its own: those before its first notification
    third = await put_alert(db, timedelta(hours=20))
    await put(db, timedelta(hours=10))  # a later firing's, received after this one's first notification
    assert c.get(url(third)).json()["investigation"] is None
    assert [p["id"] for p in c.get(url(third)).json()["past_investigations"]] == [of_second, of_first]


@pytest.mark.asyncio
async def test_the_window_lists_nothing_of_another_cluster_namespace_or_alert(monkeypatch, db):
    item = await put_alert(db)
    for other in (dict(cluster="default"), dict(namespace="billing"), dict(namespace=""), dict(fingerprint="fp2"), dict(status="failed")):
        await put(db, **other)
    await put(db, timedelta(days=31))
    c, _ = window(monkeypatch, db)
    assert c.get(url(item)).json()["past_investigations"] == []


@pytest.mark.parametrize("kw", [dict(matrix={"default": ("resource.pod.read",)}), dict(matrix={"self": ("resource.configmap.read",)}),
                                dict(namespaces={"self": ("apps",)})], ids=["another cluster", "no read", "a namespace only"])
@pytest.mark.asyncio
async def test_who_may_not_read_the_alert_sees_neither_the_list_nor_a_report(monkeypatch, db, kw):
    item, inv = await put_alert(db), await put(db)
    c, audits = window(monkeypatch, db, **kw)
    assert c.get(url(item)).status_code == 404
    assert c.patch(url(item), json={"done": True}).status_code == 404
    assert c.get(url(item, f"/investigation?past={inv}")).status_code == 404
    assert not any(a["result"] == "success" for a in audits if "result" in a)


@pytest.mark.asyncio
async def test_a_listed_report_opens_with_its_audit_row_and_no_other_does(monkeypatch, db):
    item = await put_alert(db)
    inv = await put(db, report="## Summary\nOOM")
    c, audits = window(monkeypatch, db)
    r = c.get(url(item, f"/investigation?past={inv}"))
    assert r.status_code == 200 and r.json()["report"] == "## Summary\nOOM" and r.json()["id"] == inv
    assert audits[-1]["action"] == "ai.investigation.view" and audits[-1]["target_id"] == inv and audits[-1]["after"]["from"] == "inbox"
    others = [await put(db, **kw) for kw in (dict(cluster="default"), dict(namespace="billing"), dict(fingerprint="fp2"), dict(status="failed"),
                                             dict(ago=timedelta(days=31)))]
    for other in [*others, "inv-none", "x" * 64]:
        assert c.get(url(item, f"/investigation?past={other}")).status_code == 404, other
    assert c.get(url(item, f"/investigation?past={'x' * 65}")).status_code == 422
    assert [a["target_id"] for a in audits] == [inv]  # nothing opened, nothing to record
    c, _ = window(monkeypatch, db, audit_ok=False)
    assert c.get(url(item, f"/investigation?past={inv}")).status_code == 503  # no audit row, no report
    c, _ = window(monkeypatch, db, past_window=False)
    assert c.get(url(item, f"/investigation?past={inv}")).status_code == 404


@pytest.mark.asyncio
async def test_a_list_that_could_not_be_read_leaves_the_window(monkeypatch, db, caplog):
    item = await put_alert(db)
    await put(db)

    async def fails(*a, **kw):
        raise RuntimeError("postgresql://kubeast:hunter2@db/kubeast")

    monkeypatch.setattr(past, "read", fails)
    c, _ = window(monkeypatch, db)
    r = c.get(url(item))
    assert r.status_code == 200 and r.json()["past_investigations"] is None and r.json()["alertname"] == "KubePodCrashLooping"
    assert "could not be read" in caplog.text and "hunter2" not in caplog.text


@pytest.mark.asyncio
async def test_a_mark_and_investigate_now_answer_with_the_list_when_the_screen_asks(monkeypatch, db):
    item, inv = await put_alert(db), await put(db)
    c, _ = window(monkeypatch, db, permissions=("resource.alert.investigate",),
                  matrix={"self": ("resource.pod.read", "resource.alert.investigate")})
    assert [p["id"] for p in c.patch(url(item), json={"done": True}).json()["past_investigations"]] == [inv]
    assert "past_investigations" not in c.patch(url(item, ""), json={"done": False}).json()
    assert "past_investigations" not in c.post(url(item, "/investigate")).json()
    assert [p["id"] for p in c.post(url(item, "/investigate?past=true")).json()["past_investigations"]] == [inv]


@pytest.mark.asyncio
async def test_with_the_switch_off_the_window_lists_nothing(monkeypatch, db):
    item = await put_alert(db)
    await put(db)
    monkeypatch.setenv("ALERT_INVESTIGATION_PAST_MODEL", "true")
    c, _ = window(monkeypatch, db, past_window=False)
    assert "past_investigations" not in c.get(url(item)).json()  # the screen asks, the switch is off
    c, _ = window(monkeypatch, db)
    assert len(c.get(url(item)).json()["past_investigations"]) == 1
