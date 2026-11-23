"""On PostgreSQL: an approved run's end and its ai.tool.execute row land together (end_tool_run). An outcome row the audit
table refuses aborts the end's transaction and the run still ends, on its own, since it has run. Two engines on one
database stand for two replicas.

Same throwaway database as tests/test_approval_interrupted_postgres.py; skipped when DBMIGRATE_TEST_DATABASE_URL is
unset."""

import copy
import os

import pytest
from sqlalchemy import text

from app.database import utcnow
from app.services import audit_writer
from tests.test_approval_interrupted_postgres import PATCH, URL_ENV, replicas  # noqa: F401

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
