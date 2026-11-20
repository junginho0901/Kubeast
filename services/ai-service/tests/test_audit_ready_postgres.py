"""Audit readiness on PostgreSQL after a failed write: the probe's insert is refused while the audit table refuses
rows, and readiness comes back once it takes them, so a fail-closed ai-service does not stay refusing until a restart.

Runs against the server named by DBMIGRATE_TEST_DATABASE_URL, as tests/test_approval_interrupted_postgres.py does, in
a throwaway database holding the audit table of migration 00001; skipped when it is unset."""

import os
import uuid
from urllib.parse import urlsplit, urlunsplit

import pytest
from sqlalchemy import text

import app.database
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


@pytest.fixture
async def db(monkeypatch):
    import asyncpg

    from app.database import DatabaseService

    raw = os.environ[URL_ENV]
    name = f"ai_audit_ready_test_{uuid.uuid4().hex[:12]}"
    admin = await asyncpg.connect(raw)
    await admin.execute(f'CREATE DATABASE "{name}"')
    service = DatabaseService(urlunsplit(urlsplit(raw)._replace(scheme="postgresql+asyncpg", path="/" + name)))
    monkeypatch.setenv("AUDIT_FAIL_CLOSED", "true")
    monkeypatch.setattr(app.database, "db_service", service)
    monkeypatch.setattr(app.database, "db_initialized", True)
    monkeypatch.setattr(app.database, "interrupted_checked", True)
    try:
        async with service.engine.begin() as conn:
            await conn.execute(text(AUDIT_TABLE))
        yield service
    finally:
        await service.engine.dispose()
        await admin.execute(f'DROP DATABASE "{name}" WITH (FORCE)')
        await admin.close()


async def _actions(db):
    async with db.engine.connect() as conn:
        return [r[0] for r in await conn.execute(text("SELECT action FROM auth_audit_logs ORDER BY id"))]


async def _ready_now():
    audit_writer._ready_cache["at"] = 0.0  # the next check probes now instead of after READY_TTL_SEC
    return await audit_writer.audit_ready()


async def test_readiness_is_refused_while_the_table_refuses_rows_and_comes_back_after(db, capsys):
    assert await _ready_now() == (True, None)
    async with db.engine.begin() as conn:
        await conn.execute(text("ALTER TABLE auth_audit_logs ADD CONSTRAINT refuse_rows CHECK (service <> 'ai')"))
    failures = audit_writer.write_failures

    assert await audit_writer.write_audit(action="ai.tool.call") is False
    assert audit_writer.write_failures == failures + 1 and audit_writer._write_broken is True
    for _ in range(2):  # refused by the table on each probe, not by the connection the last probe left
        ok, error = await _ready_now()
        assert ok is False and "refuse_rows" in error
        with pytest.raises(audit_writer.AuditUnavailable):
            await audit_writer.require_audit_ready()

    async with db.engine.begin() as conn:
        await conn.execute(text("ALTER TABLE auth_audit_logs DROP CONSTRAINT refuse_rows"))
    assert await _ready_now() == (True, None)
    assert audit_writer._write_broken is False
    assert await _actions(db) == [], "the probe's insert was rolled back"
    await audit_writer.require_audit_ready()  # no raise

    assert await audit_writer.write_audit(action="ai.tool.call") is True
    assert await _actions(db) == ["ai.tool.call"]
    assert await _ready_now() == (True, None)
    capsys.readouterr()  # stdout mirror lines are not under test here
