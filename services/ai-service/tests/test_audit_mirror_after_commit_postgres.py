"""A row written in the caller's transaction on PostgreSQL counts only once that transaction commits: an insert the
table refuses and a commit that fails after a good insert print no stdout line, and the failed commit leaves readiness
probing a write (_write_broken) instead of saying writes work. The interrupted-approval sweep with AUDIT_FAIL_CLOSED
is the caller.

Runs against the server named by DBMIGRATE_TEST_DATABASE_URL, as tests/test_approval_interrupted_postgres.py does, in
a throwaway database made from the ORM models and the audit table of migration 00001; skipped when it is unset."""

import copy
import json
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
# Checked when the transaction commits, after the insert itself was taken.
REFUSE_AT_COMMIT = [
    """CREATE FUNCTION refuse_interrupt_rows() RETURNS trigger LANGUAGE plpgsql AS $$
       BEGIN IF NEW.action = 'ai.tool.interrupt' THEN RAISE EXCEPTION 'audit table refuses interrupt rows at commit'; END IF;
       RETURN NULL; END $$""",
    """CREATE CONSTRAINT TRIGGER refuse_at_commit AFTER INSERT ON auth_audit_logs DEFERRABLE INITIALLY DEFERRED
       FOR EACH ROW EXECUTE FUNCTION refuse_interrupt_rows()""",
]
FAKE = "fake-secret-value"
PATCH = {"resource_type": "deployment", "resource_name": "web", "namespace": "shop",
         "patch": {"spec": {"template": {"spec": {"containers": [{"name": "app", "env": [{"name": "DB_PASSWORD", "value": FAKE}]}]}}}}}


@pytest.fixture
async def db(monkeypatch):
    import asyncpg

    from app.database import Base, DatabaseService

    raw = os.environ[URL_ENV]
    name = f"ai_mirror_test_{uuid.uuid4().hex[:12]}"
    admin = await asyncpg.connect(raw)
    await admin.execute(f'CREATE DATABASE "{name}"')
    service = DatabaseService(urlunsplit(urlsplit(raw)._replace(scheme="postgresql+asyncpg", path="/" + name)))
    monkeypatch.setenv("AUDIT_FAIL_CLOSED", "true")
    monkeypatch.setattr(app.database, "db_service", service)
    monkeypatch.setattr(app.database, "db_initialized", True)
    monkeypatch.setattr(app.database, "interrupted_checked", True)
    try:
        async with service.engine.begin() as conn:
            await conn.run_sync(Base.metadata.create_all)
            await conn.execute(text(AUDIT_TABLE))
        await service.create_session("s1", user_id="u1", title="t")
        yield service
    finally:
        await service.engine.dispose()
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
        rows = await conn.execute(text("SELECT after->>'approval_id' FROM auth_audit_logs WHERE action = 'ai.tool.interrupt' ORDER BY id"))
        return [r[0] for r in rows.all()]


def _mirrored(out):
    return [json.loads(line)["audit"] for line in out.splitlines() if line.startswith("{") and '"action":"ai.tool.interrupt"' in line]


async def test_an_insert_the_table_refuses_prints_nothing_at_each_look(db, capsys):
    left = await _left_by_a_stopped_server(db)
    async with db.engine.begin() as conn:
        await conn.execute(text("ALTER TABLE auth_audit_logs ADD CONSTRAINT refuse_interrupt CHECK (action <> 'ai.tool.interrupt')"))

    for _ in range(3):
        assert await db.close_interrupted_tool_approvals() == 0
    assert (await db.get_tool_approval(left.id)).status == "approved"
    assert _mirrored(capsys.readouterr().out) == []

    async with db.engine.begin() as conn:
        await conn.execute(text("ALTER TABLE auth_audit_logs DROP CONSTRAINT refuse_interrupt"))
    assert await db.close_interrupted_tool_approvals() == 1
    [line] = _mirrored(capsys.readouterr().out)
    assert line["after"]["approval_id"] == left.id and await _interrupt_rows(db) == [left.id]
    assert audit_writer._write_broken is False


async def test_a_commit_that_fails_after_a_good_insert_counts_as_a_failed_write(db, capsys):
    left = await _left_by_a_stopped_server(db)
    async with db.engine.begin() as conn:
        for statement in REFUSE_AT_COMMIT:
            await conn.execute(text(statement))
    failures = audit_writer.write_failures

    assert await db.close_interrupted_tool_approvals() == 0
    kept = await db.get_tool_approval(left.id)
    assert (kept.status, kept.result, kept.args) == ("approved", None, PATCH), "the commit took the UPDATE back with it"
    assert await _interrupt_rows(db) == [] and _mirrored(capsys.readouterr().out) == []
    assert audit_writer._write_broken is True and audit_writer.write_failures == failures + 1
    assert audit_writer._ready_cache["at"] == 0.0, "the next readiness check probes a write"

    async with db.engine.begin() as conn:
        await conn.execute(text("DROP TRIGGER refuse_at_commit ON auth_audit_logs"))
    assert await db.close_interrupted_tool_approvals() == 1
    ended = await db.get_tool_approval(left.id)
    assert ended.status == "failed" and ended.result == INTERRUPTED_RESULT and FAKE not in str(ended.args)
    assert len(_mirrored(capsys.readouterr().out)) == 1 and await _interrupt_rows(db) == [left.id]
    assert audit_writer._write_broken is False
