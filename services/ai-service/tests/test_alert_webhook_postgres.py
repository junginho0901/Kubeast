"""The webhook's alert lock on PostgreSQL: two replicas (two engines on one database) get one alert at one moment.

Runs against the server named by DBMIGRATE_TEST_DATABASE_URL, as the Go services' Postgres tests do, in a
throwaway database made from the ORM models; skipped when it is unset."""

import asyncio
import os
import uuid
from datetime import datetime
from urllib.parse import urlsplit, urlunsplit

import pytest
from sqlalchemy import text

from app.services.investigation import store, webhook
from app.services.investigation.settings import InvestigationSettings

URL_ENV = "DBMIGRATE_TEST_DATABASE_URL"
NOW = datetime(2026, 11, 14, 3, 0, 0)

pytestmark = pytest.mark.skipif(not os.getenv(URL_ENV), reason=f"{URL_ENV} not set: needs a PostgreSQL server")


@pytest.fixture
async def replicas():
    import asyncpg

    from app.database import Base, DatabaseService

    raw = os.environ[URL_ENV]
    name = f"ai_webhook_test_{uuid.uuid4().hex[:12]}"
    admin = await asyncpg.connect(raw)
    await admin.execute(f'CREATE DATABASE "{name}"')
    url = urlunsplit(urlsplit(raw)._replace(scheme="postgresql+asyncpg", path="/" + name))
    dbs = [DatabaseService(url), DatabaseService(url)]
    try:
        async with dbs[0].engine.begin() as conn:
            await conn.run_sync(Base.metadata.create_all)
        yield dbs
    finally:
        for db in dbs:
            await db.engine.dispose()
        await admin.execute(f'DROP DATABASE "{name}" WITH (FORCE)')
        await admin.close()


async def test_two_replicas_given_one_alert_at_once_queue_one_investigation(replicas, monkeypatch):
    real_insert = store.insert

    async def slow_insert(db, **fields):
        await asyncio.sleep(0.3)  # the other replica's delivery reaches its own decision meanwhile
        return await real_insert(db, **fields)

    monkeypatch.setattr(store, "insert", slow_insert)
    cfg = InvestigationSettings(enabled=True, webhook_token="t", internal_token="i", max_per_hour=0, daily_token_budget=0)
    msg = webhook.AmWebhook(
        version="4", groupKey="g", status="firing", receiver="kubeast", externalURL="http://alertmanager:9093",
        alerts=[webhook.AmAlert(status="firing", labels={"alertname": "KubePodCrashLooping", "severity": "critical"},
                                startsAt="2026-11-14T02:59:00Z", fingerprint="fp1")],
    )
    counts = await asyncio.gather(*(webhook.gate_and_queue(db, cfg, "self", msg, NOW) for db in replicas))
    assert sorted((c["accepted"], c["duplicate"]) for c in counts) == [(0, 1), (1, 0)]
    rows, total = await store.list_rows(replicas[0])
    assert total == 1 and (rows[0].status, rows[0].repeat_count) == ("queued", 2)


async def test_two_replicas_given_two_alerts_at_once_queue_no_more_than_the_hourly_cap(replicas, monkeypatch):
    real_insert = store.insert

    async def slow_insert(db, **fields):
        await asyncio.sleep(0.3)  # the other replica's alert reaches its own count meanwhile
        return await real_insert(db, **fields)

    monkeypatch.setattr(store, "insert", slow_insert)
    cfg = InvestigationSettings(enabled=True, webhook_token="t", internal_token="i", max_per_hour=1, daily_token_budget=0)

    def message(name, fingerprint):
        return webhook.AmWebhook(
            version="4", groupKey="g", status="firing", receiver="kubeast", externalURL="http://alertmanager:9093",
            alerts=[webhook.AmAlert(status="firing", labels={"alertname": name, "severity": "critical"},
                                    startsAt="2026-11-14T02:59:00Z", fingerprint=fingerprint)],
        )

    counts = await asyncio.gather(
        webhook.gate_and_queue(replicas[0], cfg, "self", message("KubePodCrashLooping", "fp1"), NOW),
        webhook.gate_and_queue(replicas[1], cfg, "self", message("KubeNodeNotReady", "fp2"), NOW),
    )
    assert sorted((c["accepted"], c["skipped"]) for c in counts) == [(0, 1), (1, 0)]
    rows, total = await store.list_rows(replicas[0])
    assert total == 2 and sorted(r.status for r in rows) == ["queued", "skipped"]
    assert "hourly cap" in next(r.skip_reason for r in rows if r.status == "skipped")


async def test_a_delivery_decides_on_one_connection(replicas):
    """Every read and write of the decision goes through the session holding the alert's lock and the hourly lock:
    replicas with one connection each still decide two alerts at once, one queued and one past the cap."""
    from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker, create_async_engine

    for db in replicas:
        url = db.engine.url
        await db.engine.dispose()
        db.engine = create_async_engine(url, pool_size=1, max_overflow=0, pool_timeout=3)
        db.async_session = async_sessionmaker(db.engine, class_=AsyncSession, expire_on_commit=False)
    cfg = InvestigationSettings(enabled=True, webhook_token="t", internal_token="i", max_per_hour=1, daily_token_budget=0)

    def message(name, fingerprint):
        return webhook.AmWebhook(
            version="4", groupKey="g", status="firing", receiver="kubeast", externalURL="http://alertmanager:9093",
            alerts=[webhook.AmAlert(status="firing", labels={"alertname": name, "severity": "critical"},
                                    startsAt="2026-11-14T02:59:00Z", fingerprint=fingerprint)],
        )

    counts = await asyncio.wait_for(asyncio.gather(
        webhook.gate_and_queue(replicas[0], cfg, "self", message("KubePodCrashLooping", "fp1"), NOW),
        webhook.gate_and_queue(replicas[1], cfg, "self", message("KubeNodeNotReady", "fp2"), NOW),
    ), 10)
    assert sorted((c["accepted"], c["skipped"]) for c in counts) == [(0, 1), (1, 0)]


async def test_the_hourly_lock_waits_past_the_session_limits(replicas):
    db = replicas[0]
    limits = text("SELECT current_setting('lock_timeout'), current_setting('statement_timeout')")
    async with db.async_session() as s:
        await s.execute(text("SET lock_timeout = '15s'"))
        await s.execute(text("SET statement_timeout = '30s'"))
        await s.commit()
        async with store.hourly_cap_locked(db, s):
            held = tuple((await s.execute(limits)).one())
        await s.commit()
        after = tuple((await s.execute(limits)).one())
    assert held == (store.HOURLY_CAP_LOCK_WAIT, store.HOURLY_CAP_LOCK_WAIT)
    assert after == ("15s", "30s")
