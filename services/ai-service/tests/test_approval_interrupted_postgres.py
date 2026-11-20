"""An interrupted approval and its ai.tool.interrupt row on PostgreSQL: one transaction on one connection, so they land
together or not at all, and of two servers one ends the approval. Two engines on one database stand for two replicas.

Runs against the server named by DBMIGRATE_TEST_DATABASE_URL, as tests/test_claude_code_slots_postgres.py does, in a
throwaway database made from the ORM models and the audit table of migration 00001; skipped when it is unset."""

import asyncio
import copy
import os
import uuid
from datetime import timedelta
from urllib.parse import urlsplit, urlunsplit

import pytest
from sqlalchemy import text

import app.database
from app.database import APPROVED_RUN_LIMIT_SECONDS, INTERRUPTED_RESULT, utcnow
from app.services import audit_writer

URL_ENV = "DBMIGRATE_TEST_DATABASE_URL"

pytestmark = pytest.mark.skipif(not os.getenv(URL_ENV), reason=f"{URL_ENV} not set: needs a PostgreSQL server")

# The columns of auth_audit_logs that ai-service writes (services/pkg/dbmigrate/migrations/00001_baseline.sql).
AUDIT_TABLE = """
CREATE TABLE auth_audit_logs (
    id SERIAL PRIMARY KEY, service VARCHAR, action VARCHAR NOT NULL, actor_user_id VARCHAR, actor_email VARCHAR,
    target_user_id VARCHAR, target_email VARCHAR, target_type VARCHAR, target_id VARCHAR,
    before JSONB DEFAULT '{}', after JSONB DEFAULT '{}', request_ip VARCHAR, user_agent VARCHAR, request_id VARCHAR,
    path VARCHAR, cluster VARCHAR, namespace VARCHAR, result VARCHAR NOT NULL DEFAULT 'success', error TEXT,
    created_at TIMESTAMP NOT NULL DEFAULT NOW()
)
"""
FAKE = "fake-secret-value"
PATCH = {"resource_type": "deployment", "resource_name": "web", "namespace": "shop",
         "patch": {"spec": {"template": {"spec": {"containers": [{"name": "app", "env": [{"name": "DB_PASSWORD", "value": FAKE}]}]}}}}}


@pytest.fixture
async def replicas(monkeypatch):
    import asyncpg

    from app.database import Base, DatabaseService

    raw = os.environ[URL_ENV]
    name = f"ai_interrupt_test_{uuid.uuid4().hex[:12]}"
    admin = await asyncpg.connect(raw)
    await admin.execute(f'CREATE DATABASE "{name}"')
    url = urlunsplit(urlsplit(raw)._replace(scheme="postgresql+asyncpg", path="/" + name))
    dbs = [DatabaseService(url), DatabaseService(url)]
    monkeypatch.setenv("AUDIT_FAIL_CLOSED", "true")
    monkeypatch.setattr(app.database, "db_service", dbs[0])
    monkeypatch.setattr(app.database, "db_initialized", True)
    monkeypatch.setattr(app.database, "interrupted_checked", True)
    try:
        async with dbs[0].engine.begin() as conn:
            await conn.run_sync(Base.metadata.create_all)
            await conn.execute(text(AUDIT_TABLE))
        await dbs[0].create_session("s1", user_id="u1", title="t")
        yield dbs
    finally:
        for db in dbs:
            await db.engine.dispose()
        await admin.execute(f'DROP DATABASE "{name}" WITH (FORCE)')
        await admin.close()


async def _left_by_a_stopped_server(db):
    row = await db.create_tool_approval(session_id="s1", user_id="u1", user_email="u1@example.com", cluster="prod",
                                        tool="k8s_patch_resource", args=copy.deepcopy(PATCH))
    old = utcnow() - timedelta(seconds=APPROVED_RUN_LIMIT_SECONDS + 60)
    assert await db.transition_tool_approval(row.id, "pending", status="approved", decided_at=old)
    return row


async def _interrupt_rows(db):
    async with db.engine.connect() as conn:
        rows = await conn.execute(text(
            "SELECT actor_user_id, target_type, target_id, after->>'approval_id' FROM auth_audit_logs "
            "WHERE action = 'ai.tool.interrupt' ORDER BY id"))
        return [tuple(r) for r in rows.all()]


async def test_an_audit_insert_the_table_refuses_leaves_the_approval_approved(replicas):
    db = replicas[0]
    left = await _left_by_a_stopped_server(db)
    async with db.engine.begin() as conn:
        await conn.execute(text("ALTER TABLE auth_audit_logs ADD CONSTRAINT refuse_interrupt CHECK (action <> 'ai.tool.interrupt')"))
    failures = audit_writer.write_failures

    assert await db.close_interrupted_tool_approvals() == 0
    kept = await db.get_tool_approval(left.id)
    assert (kept.status, kept.result, kept.args) == ("approved", None, PATCH), "the UPDATE was rolled back with the insert"
    assert await _interrupt_rows(db) == [] and audit_writer.write_failures == failures + 1

    async with db.engine.begin() as conn:
        await conn.execute(text("ALTER TABLE auth_audit_logs DROP CONSTRAINT refuse_interrupt"))
    assert await db.close_interrupted_tool_approvals() == 1
    ended = await db.get_tool_approval(left.id)
    assert ended.status == "failed" and ended.result == INTERRUPTED_RESULT and FAKE not in str(ended.args)
    assert await _interrupt_rows(db) == [("system", "deployment", "web", left.id)]


async def test_the_approval_and_its_row_land_together(replicas):
    db, other = replicas
    left = await _left_by_a_stopped_server(db)
    assert await db.close_interrupted_tool_approvals() == 1
    # read on the other engine: both were committed
    assert (await other.get_tool_approval(left.id)).status == "failed"
    assert await _interrupt_rows(other) == [("system", "deployment", "web", left.id)]


async def test_of_two_replicas_one_ends_the_approval_and_writes_one_row(replicas, monkeypatch):
    real = audit_writer.write_audit

    async def held(**kw):
        stored = await real(**kw)
        await asyncio.sleep(0.3)  # keeps the transaction open, holding the approval's row, while the other one waits
        return stored

    monkeypatch.setattr(audit_writer, "write_audit", held)
    left = await _left_by_a_stopped_server(replicas[0])
    ended = await asyncio.wait_for(
        asyncio.gather(*(replicas[n % 2].close_interrupted_tool_approvals() for n in range(4))), 20)
    assert sum(ended) == 1
    assert (await replicas[1].get_tool_approval(left.id)).status == "failed"
    assert await _interrupt_rows(replicas[1]) == [("system", "deployment", "web", left.id)]
