"""A row that lands shows the audit table takes rows, so a refusal readiness cached (up to READY_TTL_SEC) ends with it:
an approval pressed right after a chat row was stored is not answered 503 from a probe that failed a moment before.
For a row written on its own and for one written in the caller's transaction (it lands with commit_row). On a
SQLAlchemy connection to sqlite standing in under a postgresql URL, as test_audit_fail_closed.py does."""
import time
from types import SimpleNamespace

import pytest
from sqlalchemy import text
from sqlalchemy.ext.asyncio import create_async_engine

import app.database
from app.services import audit_writer

COLUMNS = ("service, action, actor_user_id, actor_email, target_user_id, target_email, target_type, target_id, "
           "before, after, request_ip, user_agent, request_id, path, cluster, namespace, result, error")


@pytest.fixture
async def engine(tmp_path, monkeypatch):
    engine = create_async_engine(f"sqlite+aiosqlite:///{tmp_path / 'audit.db'}")
    async with engine.begin() as conn:
        await conn.execute(text(f"CREATE TABLE auth_audit_logs (id INTEGER PRIMARY KEY, {COLUMNS})"))

    async def db():
        return SimpleNamespace(database_url="postgresql+asyncpg://stand-in", engine=engine)

    monkeypatch.setenv("AUDIT_FAIL_CLOSED", "true")
    monkeypatch.setattr(app.database, "get_db_service", db)
    yield engine
    await engine.dispose()


def _refused_a_moment_ago():
    audit_writer._ready_cache.update(at=time.monotonic(), ok=False, error="timeout")


async def test_a_row_written_on_its_own_ends_a_cached_refusal(engine, capsys):
    _refused_a_moment_ago()
    with pytest.raises(audit_writer.AuditUnavailable):
        await audit_writer.require_audit_ready()

    assert await audit_writer.write_audit(action="ai.chat.send") is True
    assert await audit_writer.audit_ready() == (True, None)
    await audit_writer.require_audit_ready()  # no raise
    capsys.readouterr()


async def test_a_row_in_the_callers_transaction_ends_it_once_committed(engine, capsys):
    _refused_a_moment_ago()
    async with engine.connect() as conn:
        await conn.begin()
        assert await audit_writer.write_audit(action="ai.tool.interrupt", conn=conn) is True
        assert (await audit_writer.audit_ready())[0] is False, "not landed before the commit"
        await audit_writer.commit_row(conn, action="ai.tool.interrupt")
    assert await audit_writer.audit_ready() == (True, None)
    capsys.readouterr()


async def test_a_row_that_fails_still_drops_the_cache_to_probe_a_write(engine, capsys):
    audit_writer._ready_cache.update(at=time.monotonic(), ok=True, error=None)
    async with engine.begin() as conn:
        await conn.execute(text("DROP TABLE auth_audit_logs"))
    assert await audit_writer.write_audit(action="ai.chat.send") is False
    assert audit_writer._ready_cache["at"] == 0.0 and audit_writer._write_broken is True
    capsys.readouterr()
