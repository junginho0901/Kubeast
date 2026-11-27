"""The read of an alert's earlier investigations on PostgreSQL: what it gives is what sqlite gives
(test_past_investigations.py) and it goes by the dedupe index, whatever else the table holds.

Runs against the server named by DBMIGRATE_TEST_DATABASE_URL, as the Go services' Postgres tests do, in a throwaway
database made from the ORM models; skipped when it is unset."""

import os
import uuid
from datetime import timedelta
from urllib.parse import urlsplit, urlunsplit

import pytest
from sqlalchemy import insert, text

from app.database import AlertInvestigation
from app.services.investigation import past
from tests.test_past_investigations import DEDUPE_INDEX, NOW, found, put

URL_ENV = "DBMIGRATE_TEST_DATABASE_URL"

pytestmark = pytest.mark.skipif(not os.getenv(URL_ENV), reason=f"{URL_ENV} not set: needs a PostgreSQL server")


@pytest.fixture
async def db():
    import asyncpg

    from app.database import Base, DatabaseService

    raw = os.environ[URL_ENV]
    name = f"ai_past_test_{uuid.uuid4().hex[:12]}"
    admin = await asyncpg.connect(raw)
    await admin.execute(f'CREATE DATABASE "{name}"')
    service = DatabaseService(urlunsplit(urlsplit(raw)._replace(scheme="postgresql+asyncpg", path="/" + name)))
    try:
        async with service.engine.begin() as conn:
            await conn.run_sync(Base.metadata.create_all)
            await conn.execute(text("CREATE TABLE clusters (id VARCHAR PRIMARY KEY, created_at TIMESTAMP NOT NULL DEFAULT NOW())"))
            await conn.execute(text(DEDUPE_INDEX))
            await conn.execute(past._CLUSTERS.insert().values(id="self", created_at=NOW - timedelta(days=400)))
        yield service
    finally:
        await service.engine.dispose()
        await admin.execute(f'DROP DATABASE "{name}" WITH (FORCE)')
        await admin.close()


async def read(db, **kw):
    return await past.read(db, **{**dict(cluster="self", fingerprint="fp1", namespace="apps", before=NOW, now=NOW), **kw})


async def test_the_read_gives_the_alerts_own_rows_of_thirty_days_newest_first(db):
    ids = [await put(db, timedelta(days=d)) for d in (29, 3, 1)]
    for other in (dict(ago=timedelta(days=31)), dict(cluster="default"), dict(namespace="billing"), dict(namespace=""),
                  dict(fingerprint="fp2"), dict(status="failed"), dict(ago=timedelta(0))):
        await put(db, **other)
    got = await read(db)
    assert [p.id for p in got] == ids[::-1]
    assert got[0].causes[0].resource == "Deployment/apps/web" and got[0].outcome == "cause_found"
    assert len(await read(db, limit=2)) == 2
    async with db.engine.begin() as conn:
        await conn.execute(text("UPDATE clusters SET created_at = :at"), {"at": NOW - timedelta(days=2)})
    assert [p.id for p in await read(db)] == ids[:1:-1]
    async with db.engine.begin() as conn:
        await conn.execute(text("DELETE FROM clusters"))
    assert await read(db) == []


async def test_the_read_goes_by_the_dedupe_index_over_a_table_of_many_alerts(db):
    rows = [dict(id=f"inv-{n}", cluster="self", fingerprint=f"other-{n % 400}", namespace="apps", status="done", result=found(),
                 received_at=NOW - timedelta(minutes=n), last_seen_at=NOW - timedelta(minutes=n)) for n in range(8000)]
    async with db.engine.begin() as conn:
        for start in range(0, len(rows), 500):
            await conn.execute(insert(AlertInvestigation), rows[start:start + 500])
    mine = await put(db)
    async with db.engine.connect() as conn:
        await conn.execution_options(isolation_level="AUTOCOMMIT")
        await conn.execute(text("ANALYZE alert_investigations"))
        sql = str(past.statement(cluster="self", fingerprint="fp1", namespace="apps", before=NOW, now=NOW, limit=20).compile(
            dialect=conn.dialect, compile_kwargs={"literal_binds": True}))
        plan = "\n".join(r[0] for r in (await conn.execute(text(f"EXPLAIN {sql}"))).all())
    assert "idx_alert_investigations_dedupe" in plan and "Seq Scan on alert_investigations" not in plan, plan
    assert [p.id for p in await read(db)] == [mine]
