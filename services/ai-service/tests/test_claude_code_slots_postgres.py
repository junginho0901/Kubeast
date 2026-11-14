"""The install-wide Claude Code slots on PostgreSQL: two engines on one database stand for two replicas.

Runs against the server named by DBMIGRATE_TEST_DATABASE_URL, as tests/test_alert_webhook_postgres.py does, in a
throwaway database made from the ORM models; skipped when it is unset."""

import asyncio
import os
import uuid
from urllib.parse import urlsplit, urlunsplit

import pytest
from sqlalchemy import text

from app.services import claude_code_slots

URL_ENV = "DBMIGRATE_TEST_DATABASE_URL"

pytestmark = pytest.mark.skipif(not os.getenv(URL_ENV), reason=f"{URL_ENV} not set: needs a PostgreSQL server")


@pytest.fixture
async def replicas(monkeypatch):
    import asyncpg

    from app.database import Base, DatabaseService

    raw = os.environ[URL_ENV]
    name = f"ai_slots_test_{uuid.uuid4().hex[:12]}"
    admin = await asyncpg.connect(raw)
    await admin.execute(f'CREATE DATABASE "{name}"')
    url = urlunsplit(urlsplit(raw)._replace(scheme="postgresql+asyncpg", path="/" + name))
    dbs = [DatabaseService(url), DatabaseService(url)]
    monkeypatch.setattr(claude_code_slots, "_made", {})
    monkeypatch.setattr(claude_code_slots, "POLL_SECONDS", 0.02)
    try:
        async with dbs[0].engine.begin() as conn:
            await conn.run_sync(Base.metadata.create_all)
        yield dbs
    finally:
        for db in dbs:
            await db.engine.dispose()
        await admin.execute(f'DROP DATABASE "{name}" WITH (FORCE)')
        await admin.close()


async def owners(db):
    async with db.async_session() as s:
        return [r[0] for r in (await s.execute(text("SELECT owner FROM claude_code_slots ORDER BY slot"))).all()]


async def test_with_one_slot_the_second_replica_waits_and_gets_it_when_the_first_ends(replicas):
    order = []
    first_in = asyncio.Event()

    async def first():
        async with claude_code_slots.held(replicas[0], "chat", 1):
            order.append("first in")
            first_in.set()
            await asyncio.sleep(0.3)
            order.append("first out")

    async def second():
        await first_in.wait()
        async with claude_code_slots.held(replicas[1], "chat", 1):
            order.append("second in")

    await asyncio.wait_for(asyncio.gather(first(), second()), 5)
    assert order == ["first in", "first out", "second in"]
    assert await owners(replicas[0]) == [""]


async def test_replicas_taking_at_once_get_no_more_slots_than_the_limit(replicas):
    taken = await asyncio.gather(*(
        claude_code_slots.take(replicas[n % 2], "chat", 2, f"run-{n}") for n in range(8)))
    assert sorted(s for s in taken if s is not None) == [0, 1]
    assert sorted(o for o in await owners(replicas[0])) == sorted(f"run-{n}" for n, s in enumerate(taken) if s is not None)


async def test_a_replica_that_stops_beating_has_its_slot_set_free_after_the_stale_time(replicas, monkeypatch):
    monkeypatch.setattr(claude_code_slots, "STALE_SECONDS", 0.5)
    loop = asyncio.get_running_loop()
    assert await claude_code_slots.take(replicas[0], "chat", 1, "gone-replica") == 0
    started = loop.time()
    async with asyncio.timeout(5), claude_code_slots.held(replicas[1], "chat", 1) as slot:
        waited = loop.time() - started
        assert slot == 0 and await owners(replicas[1]) != ["gone-replica"]
    assert 0.4 <= waited < 3


async def test_a_beating_replica_keeps_its_slot_past_the_stale_time(replicas, monkeypatch):
    monkeypatch.setattr(claude_code_slots, "STALE_SECONDS", 0.5)
    monkeypatch.setattr(claude_code_slots, "HEARTBEAT_SECONDS", 0.1)
    done = asyncio.Event()

    async def holder():
        async with claude_code_slots.held(replicas[0], "chat", 1):
            await asyncio.sleep(1.2)
            done.set()

    async def other():
        await asyncio.sleep(0.1)
        async with claude_code_slots.held(replicas[1], "chat", 1):
            return done.is_set()

    _, after_the_holder = await asyncio.wait_for(asyncio.gather(holder(), other()), 5)
    assert after_the_holder
