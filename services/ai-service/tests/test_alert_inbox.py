"""Alert inbox: every alert Alertmanager sent, one row per alert, the status the screen shows, Kubeast's handling
marks with their audit rows, and who may read it (the whole cluster, as the alert store read)."""

from datetime import datetime, timedelta

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from app.services.investigation import inbox, store

NOW = datetime(2026, 10, 20, 3, 0, 0)
STARTS = datetime(2026, 10, 20, 2, 50, 0)


@pytest.fixture
async def sqlite_db(tmp_path):
    from app.database import DatabaseService

    db = DatabaseService(f"sqlite+aiosqlite:///{tmp_path}/inbox.db")
    await db.init_db()
    yield db
    await db.engine.dispose()


def labels(name="KubePodCrashLooping", severity="critical", **extra):
    return {"alertname": name, "severity": severity, "namespace": "apps", "pod": "api-1", **extra}


async def put(db, fp="fp1", firing=True, starts_at=STARTS, now=NOW, ends_at=None, **lab):
    return await inbox.record(
        db, cluster="self", fingerprint=fp, firing=firing, starts_at=starts_at, ends_at=ends_at, labels=labels(**lab),
        annotations={"summary": "api-1 restarts"}, generator_url="http://prometheus/graph", alertmanager_url="http://am:9093",
        receiver="kubeast", group_key="{}:{alertname=\"X\"}", now=now,
    )


async def rows_of(db, **kw):
    rows, total, counts = await inbox.list_rows(db, cluster="self", stale_before=NOW - timedelta(hours=8), **kw)
    return rows, total, counts


@pytest.mark.asyncio
async def test_one_alert_is_one_row_until_it_resolves_and_a_new_firing_is_a_new_row(sqlite_db):
    db = sqlite_db
    assert await put(db) == "new"
    assert await put(db, now=NOW + timedelta(hours=4)) == "repeat"  # repeat_interval resend
    rows, total, _ = await rows_of(db)
    assert total == 1 and rows[0].received_count == 2 and rows[0].state == "firing"
    assert rows[0].first_received_at == NOW and rows[0].last_received_at == NOW + timedelta(hours=4)
    assert await put(db, firing=False, now=NOW + timedelta(hours=5), ends_at=NOW + timedelta(hours=4, minutes=58)) == "resolved"
    row = (await rows_of(db))[0][0]
    assert row.state == "resolved" and row.resolved_at == NOW + timedelta(hours=4, minutes=58) and row.received_count == 3
    # a second resolved copy counts and keeps the first resolved time
    assert await put(db, firing=False, now=NOW + timedelta(hours=5, minutes=2), ends_at=NOW + timedelta(hours=5)) == "repeat"
    assert (await inbox.get(db, row.id)).resolved_at == NOW + timedelta(hours=4, minutes=58)
    # a late firing copy (an HA pair) of the same alert does not open it again
    assert await put(db, now=NOW + timedelta(hours=5, minutes=1)) == "repeat"
    assert (await inbox.get(db, row.id)).state == "resolved"
    # it fires again later: Alertmanager sends a new startsAt
    assert await put(db, starts_at=STARTS + timedelta(hours=6), now=NOW + timedelta(hours=6)) == "new"
    rows, total, counts = await rows_of(db)
    assert total == 2 and [r.state for r in rows] == ["firing", "resolved"]  # firing first


@pytest.mark.asyncio
async def test_every_severity_is_kept_and_a_resolved_alert_never_seen_firing_is_kept_too(sqlite_db):
    db = sqlite_db
    await put(db, fp="info", severity="info")
    assert await put(db, fp="late", firing=False, ends_at=NOW - timedelta(minutes=1)) == "resolved"
    rows, total, counts = await rows_of(db)
    assert total == 2 and counts == {"firing": 1, "stale": 0, "resolved": 1}
    assert {r.fingerprint: (r.severity, r.state) for r in rows} == {"info": ("info", "firing"), "late": ("critical", "resolved")}


@pytest.mark.asyncio
async def test_a_message_without_startsat_folds_into_the_alerts_newest_row(sqlite_db):
    db = sqlite_db
    assert await put(db, fp="hand", starts_at=None) == "new"
    assert await put(db, fp="hand", starts_at=None, now=NOW + timedelta(minutes=5)) == "repeat"
    assert await put(db, fp="hand", starts_at=None, firing=False, now=NOW + timedelta(minutes=9)) == "resolved"
    row = (await rows_of(db))[0][0]
    assert row.starts_at == NOW and row.received_count == 3 and row.resolved_at == NOW + timedelta(minutes=9)
    # firing again after that is a new alert
    assert await put(db, fp="hand", starts_at=None, now=NOW + timedelta(minutes=20)) == "new"


@pytest.mark.asyncio
async def test_status_unknown_after_the_stale_window_and_the_filters(sqlite_db):
    db = sqlite_db
    await put(db, fp="old", now=NOW - timedelta(hours=9))
    await put(db, fp="fresh", now=NOW - timedelta(hours=1))
    await put(db, fp="gone", firing=False)
    cutoff = NOW - timedelta(hours=8)
    rows, total, counts = await rows_of(db)
    assert counts == {"firing": 1, "stale": 1, "resolved": 1}
    assert {r.fingerprint: inbox.status_of(r, cutoff) for r in rows} == {"old": "stale", "fresh": "firing", "gone": "resolved"}
    assert [r.fingerprint for r in (await rows_of(db, status="stale"))[0]] == ["old"]
    assert [r.fingerprint for r in (await rows_of(db, status="firing"))[0]] == ["fresh"]
    assert (await rows_of(db, severity="warning"))[1] == 0
    other = await inbox.list_rows(db, cluster="default", stale_before=cutoff)
    assert other[1] == 0  # another cluster's inbox is its own


@pytest.mark.asyncio
async def test_marks_change_only_what_was_asked_and_restore_puts_them_back(sqlite_db):
    db = sqlite_db
    await put(db)
    row = (await rows_of(db))[0][0]
    before, after, columns = await inbox.set_marks(db, row.id, {"acknowledged": True, "assignee": "a@x"}, "a@x", NOW)
    assert before == {"acknowledged": False, "assignee": ""} and after == {"acknowledged": True, "assignee": "a@x"}
    got = await inbox.get(db, row.id)
    assert got.acked_by == "a@x" and got.acked_at == NOW and got.assignee == "a@x"
    # the same value again changes nothing, not even who wrote it
    assert (await inbox.set_marks(db, row.id, {"acknowledged": True}, "b@x", NOW))[:2] == ({}, {})
    await inbox.set_marks(db, row.id, {"note": "first"}, "a@x", NOW)
    assert (await inbox.set_marks(db, row.id, {"note": "first"}, "b@x", NOW + timedelta(minutes=1)))[:2] == ({}, {})
    got = await inbox.get(db, row.id)
    assert got.note_by == "a@x" and got.note_at == NOW
    await inbox.set_marks(db, row.id, {"note": ""}, "a@x", NOW)
    before, after, columns = await inbox.set_marks(db, row.id, {"note": "restarted the pod", "done": True}, "b@x", NOW)
    assert after == {"note": "restarted the pod", "done": True}
    await inbox.restore_marks(db, row.id, columns)
    got = await inbox.get(db, row.id)
    assert got.note == "" and got.done_at is None and got.acked_by == "a@x"  # back to before that change only
    assert (await rows_of(db, open_only=True))[1] == 1 and (await rows_of(db, assignee="a@x"))[1] == 1
    await put(db, fp="other")
    other = [r for r in (await rows_of(db))[0] if r.fingerprint == "other"][0]
    await inbox.set_marks(db, other.id, {"done": True}, "a@x", NOW)
    rows, total, _ = await rows_of(db, open_only=True)
    assert total == 1 and rows[0].id == row.id  # the done one is left out
    assert await inbox.set_marks(db, "nope", {"done": True}, "a@x", NOW) is None


@pytest.mark.asyncio
async def test_an_alert_links_the_investigation_of_this_firing(sqlite_db):
    db = sqlite_db
    await put(db)
    row = (await rows_of(db))[0][0]
    assert await inbox.investigations_for(db, [row]) == {}
    old = await store.insert(db, cluster="self", fingerprint="fp1", status="done", received_at=STARTS - timedelta(days=2))
    await store.bump_repeat(db, old, STARTS - timedelta(days=1, hours=23))  # a repeat of an older firing
    assert await inbox.investigations_for(db, [row]) == {}
    await store.bump_repeat(db, old, NOW)  # this firing folded into it within the dedupe window
    assert (await inbox.investigations_for(db, [row]))[row.id].id == old
    new = await store.insert(db, cluster="self", fingerprint="fp1", status="queued", received_at=NOW)
    assert (await inbox.investigations_for(db, [row]))[row.id].id == new  # the newest one
    await store.insert(db, cluster="default", fingerprint="fp1", status="done", received_at=NOW + timedelta(minutes=1))
    assert (await inbox.investigations_for(db, [row]))[row.id].id == new  # another cluster's is not this alert's


# --- the API ----------------------------------------------------------------------------------------------------


def client(monkeypatch, db, *, matrix=None, namespaces=None, audit_ok=True, ready=True, enabled=True):
    from app import api_alert_inbox as api
    from app.security import TokenPayload, require_auth
    from app.services.audit_writer import AuditUnavailable
    from app.services.investigation.settings import InvestigationSettings

    audits = []

    async def get_db():
        return db

    async def audit(**kw):
        audits.append(kw)
        return audit_ok

    async def audit_ready():
        if not ready:
            raise AuditUnavailable("down")

    monkeypatch.setattr(api, "get_db_service", get_db)
    monkeypatch.setattr(api, "write_audit", audit)
    monkeypatch.setattr(api, "require_audit_ready", audit_ready)
    monkeypatch.setattr(api, "utcnow", lambda: NOW + timedelta(minutes=1))
    monkeypatch.setattr(api.inv_settings, "load", lambda: InvestigationSettings(enabled=enabled))
    app = FastAPI()
    app.include_router(api.router, prefix="/api/v1/alerts")
    payload = TokenPayload(user_id="u1", role="member", email="me@x", permissions=(),
                           matrix=matrix if matrix is not None else {"self": ("resource.pod.read",)}, namespaces=namespaces or {})
    app.dependency_overrides[require_auth] = lambda: payload
    return TestClient(app), audits


@pytest.mark.asyncio
async def test_the_inbox_is_for_whoever_reads_the_whole_cluster(monkeypatch, sqlite_db):
    await put(sqlite_db)
    c, _ = client(monkeypatch, sqlite_db)
    r = c.get("/api/v1/alerts/inbox?cluster=self")
    assert r.status_code == 200 and r.json()["total"] == 1 and r.json()["counts"]["firing"] == 1
    item = r.json()["items"][0]
    assert item["status"] == "firing" and item["summary"] == "api-1 restarts" and item["investigation"] is None
    assert c.get(f"/api/v1/alerts/inbox/{item['id']}").json()["annotations"] == {"summary": "api-1 restarts"}
    assert c.get("/api/v1/alerts/inbox?cluster=self&status=bogus").status_code == 400

    for kw in (dict(matrix={"default": ("resource.pod.read",)}), dict(matrix={"self": ("resource.configmap.read",)}),
               dict(namespaces={"self": ("apps",)})):
        c, _ = client(monkeypatch, sqlite_db, **kw)
        assert c.get("/api/v1/alerts/inbox?cluster=self").status_code == 403, kw
        assert c.get(f"/api/v1/alerts/inbox/{item['id']}").status_code == 404, kw  # one answer for missing and not yours
        assert c.patch(f"/api/v1/alerts/inbox/{item['id']}", json={"done": True}).status_code == 404, kw
    c, _ = client(monkeypatch, sqlite_db, matrix={"*": ("resource.*.read",)})
    assert c.get("/api/v1/alerts/inbox?cluster=self").status_code == 403  # the "*" entry holds only admin keys
    c, _ = client(monkeypatch, sqlite_db, enabled=False)
    assert c.get("/api/v1/alerts/inbox?cluster=self").status_code == 404


@pytest.mark.asyncio
async def test_a_mark_writes_its_audit_row_and_is_put_back_when_the_row_fails(monkeypatch, sqlite_db):
    await put(sqlite_db)
    row = (await rows_of(sqlite_db))[0][0]
    c, audits = client(monkeypatch, sqlite_db)
    r = c.patch(f"/api/v1/alerts/inbox/{row.id}", json={"acknowledged": True, "assignee": "me", "note": "  looking  "})
    assert r.status_code == 200 and r.json()["acknowledged"] and r.json()["assignee"] == "me@x" and r.json()["note"] == "looking"
    assert audits[0]["action"] == "alert.inbox.update" and audits[0]["target_id"] == row.id and audits[0]["cluster"] == "self"
    assert audits[0]["after"]["after"] == {"acknowledged": True, "assignee": "me@x", "note": "looking"}
    assert audits[0]["after"]["before"] == {"acknowledged": False, "assignee": "", "note": ""}
    assert c.get("/api/v1/alerts/inbox?cluster=self&mine=true").json()["total"] == 1
    # nothing changed: no row; nothing asked: 400; someone else is not assignable
    assert c.patch(f"/api/v1/alerts/inbox/{row.id}", json={"acknowledged": True}).status_code == 200 and len(audits) == 1
    assert c.patch(f"/api/v1/alerts/inbox/{row.id}", json={}).status_code == 400
    assert c.patch(f"/api/v1/alerts/inbox/{row.id}", json={"assignee": "other@x"}).status_code == 422

    c, audits = client(monkeypatch, sqlite_db, audit_ok=False)
    assert c.patch(f"/api/v1/alerts/inbox/{row.id}", json={"done": True}).status_code == 503
    assert (await inbox.get(sqlite_db, row.id)).done_at is None  # no audit row, no mark
    c, audits = client(monkeypatch, sqlite_db, ready=False)
    assert c.patch(f"/api/v1/alerts/inbox/{row.id}", json={"done": True}).status_code == 503 and audits == []


@pytest.mark.asyncio
async def test_the_report_opens_from_the_inbox_with_its_audit_row(monkeypatch, sqlite_db):
    await put(sqlite_db)
    row = (await rows_of(sqlite_db))[0][0]
    c, audits = client(monkeypatch, sqlite_db)
    assert c.get(f"/api/v1/alerts/inbox/{row.id}/investigation").status_code == 404
    inv = await store.insert(sqlite_db, cluster="self", fingerprint="fp1", status="queued", received_at=NOW)
    await store.finish(sqlite_db, inv, status="done", report="## Summary\nOOM")
    assert c.get("/api/v1/alerts/inbox?cluster=self").json()["items"][0]["investigation"] == {"id": inv, "status": "done"}
    r = c.get(f"/api/v1/alerts/inbox/{row.id}/investigation")
    assert r.status_code == 200 and r.json()["report"] == "## Summary\nOOM"
    assert audits[-1]["action"] == "ai.investigation.view" and audits[-1]["target_id"] == inv and audits[-1]["after"]["from"] == "inbox"
    c, _ = client(monkeypatch, sqlite_db, audit_ok=False)
    assert c.get(f"/api/v1/alerts/inbox/{row.id}/investigation").status_code == 503
    c, _ = client(monkeypatch, sqlite_db, namespaces={"self": ("apps",)})
    assert c.get(f"/api/v1/alerts/inbox/{row.id}/investigation").status_code == 404
