"""On PostgreSQL: an approved run's end and its ai.tool.execute row (and an exec's k8s.pod.exec row) land together
(end_tool_run), and so do the
shutdown's close of a cut run and its ai.tool.interrupt row (close_cut_tool_approval). An outcome row the audit table
refuses aborts the end's transaction and the run still ends, on its own, since it has run; a close whose row is refused
leaves the approval approved for a later look. Two engines on one database stand for two replicas.

Same throwaway database as tests/test_approval_interrupted_postgres.py; skipped when DBMIGRATE_TEST_DATABASE_URL is
unset."""

import asyncio
import copy
import os

import pytest
from sqlalchemy import text

from app.database import INTERRUPTED_RESULT, DatabaseService, utcnow
from app.db_session import POOL_MAX_DEFAULT, POOL_MAX_ENV
from app.services import audit_writer
from tests.test_approval_interrupted_postgres import FAKE, PATCH, URL_ENV, replicas  # noqa: F401

pytestmark = pytest.mark.skipif(not os.getenv(URL_ENV), reason=f"{URL_ENV} not set: needs a PostgreSQL server")


async def _approved(db):
    row = await db.create_tool_approval(session_id="s1", user_id="u1", user_email="u1@example.com", cluster="prod",
                                        tool="k8s_patch_resource", args=copy.deepcopy(PATCH))
    assert await db.transition_tool_approval(row.id, "pending", status="approved", decided_at=utcnow())
    return row


def _outcome(row):
    return dict(action="ai.tool.execute", actor_user_id="u1", cluster=row.cluster, target_type="deployment", target_id="web",
                namespace="shop", after={"approval_id": row.id, "tool": row.tool, "approved": True})


async def _audit_rows(db, action):
    async with db.engine.connect() as conn:
        found = await conn.execute(text(
            "SELECT after->>'approval_id', after->>'end_reason', result FROM auth_audit_logs WHERE action = :action ORDER BY id"),
            {"action": action})
        return [tuple(r) for r in found.all()]


async def _refuse(db, action, name):
    async with db.engine.begin() as conn:
        await conn.execute(text(f"ALTER TABLE auth_audit_logs ADD CONSTRAINT {name} CHECK (action <> '{action}')"))


async def test_the_end_and_its_outcome_row_land_together(replicas):
    db, other = replicas
    row = await _approved(db)
    ended = await db.end_tool_run(row.id, "approved", _outcome(row), status="executed", result="patched")
    assert (ended.status, ended.result) == ("executed", "patched")
    # read on the other engine: both were committed
    assert (await other.get_tool_approval(row.id)).status == "executed"
    assert await _audit_rows(other, "ai.tool.execute") == [(row.id, None, "success")]


async def test_with_one_connection_in_the_pool_the_end_lands_and_returns_the_ended_row(replicas, monkeypatch):
    db, other = replicas
    row = await _approved(db)
    monkeypatch.setenv(POOL_MAX_ENV, "1")
    small = DatabaseService(db.database_url)
    try:
        ended = await asyncio.wait_for(
            small.end_tool_run(row.id, "approved", _outcome(row), status="executed", result="patched"), 10)
    finally:
        await small.engine.dispose()
    assert (ended.status, ended.result) == ("executed", "patched")
    assert await _audit_rows(other, "ai.tool.execute") == [(row.id, None, "success")]


async def test_as_many_ends_at_once_as_the_pool_has_connections_each_return_their_ended_row(replicas, monkeypatch):
    db, other = replicas
    rows = [await _approved(db) for _ in range(POOL_MAX_DEFAULT)]
    monkeypatch.delenv(POOL_MAX_ENV, raising=False)
    full = DatabaseService(db.database_url)
    real = audit_writer.write_audit
    together = asyncio.Barrier(POOL_MAX_DEFAULT)

    async def held(**kw):
        if kw.get("conn") is not None:
            await together.wait()  # every end holds its connection at the same moment
        return await real(**kw)

    monkeypatch.setattr(audit_writer, "write_audit", held)
    try:
        ended = await asyncio.wait_for(asyncio.gather(*(
            full.end_tool_run(r.id, "approved", _outcome(r), status="executed") for r in rows)), 20)
    finally:
        await full.engine.dispose()
    assert [(e.id, e.status) for e in ended] == [(r.id, "executed") for r in rows]
    assert sorted(await _audit_rows(other, "ai.tool.execute")) == sorted((r.id, None, "success") for r in rows)


async def test_of_two_ends_one_moves_the_row_and_writes_its_outcome_row(replicas):
    db, other = replicas
    row = await _approved(db)
    assert await db.end_tool_run(row.id, "approved", _outcome(row), status="executed") is not None
    assert await other.end_tool_run(row.id, "approved", _outcome(row), status="failed") is None
    assert await _audit_rows(other, "ai.tool.execute") == [(row.id, None, "success")]


async def test_an_outcome_row_the_table_refuses_leaves_the_run_ended_without_it(replicas):
    db, other = replicas
    row = await _approved(db)
    await _refuse(db, "ai.tool.execute", "refuse_execute")
    failures = audit_writer.write_failures
    ended = await db.end_tool_run(row.id, "approved", _outcome(row), status="executed", result="patched")
    assert (ended.status, ended.result) == ("executed", "patched"), "the run has run: it ends without its row"
    assert (await other.get_tool_approval(row.id)).status == "executed"
    assert await _audit_rows(other, "ai.tool.execute") == []
    assert audit_writer.write_failures == failures + 2, "refused in the end's transaction, then on its own"


def _pod_exec(row):
    return dict(action="k8s.pod.exec", actor_user_id="u1", cluster=row.cluster, target_type="pod", target_id="web-0",
                namespace="shop", after={"approval_id": row.id, "tool": "k8s_execute_command"})


async def test_an_execs_pod_exec_row_lands_with_the_end(replicas):
    db, other = replicas
    row = await _approved(db)
    ended = await db.end_tool_run(row.id, "approved", _outcome(row), [_pod_exec(row)], status="executed", result="ran")
    assert ended.status == "executed"
    assert await _audit_rows(other, "ai.tool.execute") == [(row.id, None, "success")]
    assert await _audit_rows(other, "k8s.pod.exec") == [(row.id, None, "success")]


async def test_a_pod_exec_row_the_table_refuses_rolls_back_the_outcome_row_with_it(replicas):
    db, other = replicas
    row = await _approved(db)
    await _refuse(db, "k8s.pod.exec", "refuse_pod_exec")
    failures = audit_writer.write_failures
    ended = await db.end_tool_run(row.id, "approved", _outcome(row), [_pod_exec(row)], status="executed", result="ran")
    assert ended.status == "executed", "the run has run: it ends on its own"
    assert await _audit_rows(other, "ai.tool.execute") == [(row.id, None, "success")], "written once, after the end"
    assert await _audit_rows(other, "k8s.pod.exec") == []
    assert audit_writer.write_failures == failures + 2, "refused in the end's transaction, then on its own"


async def test_a_cut_close_and_its_row_land_together_or_not_at_all(replicas):
    db, other = replicas
    row = await _approved(db)
    await _refuse(db, "ai.tool.interrupt", "refuse_interrupt")
    assert await db.close_cut_tool_approval(row.id) is False
    kept = await other.get_tool_approval(row.id)
    assert (kept.status, kept.result, kept.args) == ("approved", None, PATCH), "the move was rolled back with the insert"
    assert await _audit_rows(other, "ai.tool.interrupt") == []

    async with db.engine.begin() as conn:
        await conn.execute(text("ALTER TABLE auth_audit_logs DROP CONSTRAINT refuse_interrupt"))
    assert await db.close_cut_tool_approval(row.id) is True
    ended = await other.get_tool_approval(row.id)
    assert (ended.status, ended.result) == ("failed", INTERRUPTED_RESULT) and FAKE not in str(ended.args)
    assert await _audit_rows(other, "ai.tool.interrupt") == [(row.id, "shutdown", "success")]
    assert await other.close_cut_tool_approval(row.id) is False, "an ended row is not ended again"
