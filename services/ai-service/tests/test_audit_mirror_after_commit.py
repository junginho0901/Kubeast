"""A row written in the caller's transaction (write_audit(conn=...), the interrupted-approval sweep with
AUDIT_FAIL_CLOSED) goes to the stdout mirror only once that transaction commits: an attempt the audit table refuses,
rolled back and tried again at each later look, prints no ai.tool.interrupt line, so the log pipeline does not count
interruptions that did not happen. On a SQLAlchemy connection to sqlite standing in under a postgresql URL; on
PostgreSQL, with a commit that fails after a good insert, in test_audit_mirror_after_commit_postgres.py."""
import copy
import json
from datetime import timedelta
from types import SimpleNamespace

import pytest
from sqlalchemy import text

import app.database
from app.database import APPROVED_RUN_LIMIT_SECONDS, INTERRUPTED_RESULT, DatabaseService, utcnow
from app.services import audit_writer

COLUMNS = ("service, action, actor_user_id, actor_email, target_user_id, target_email, target_type, target_id, "
           "before, after, request_ip, user_agent, request_id, path, cluster, namespace, result, error")
PATCH = {"resource_type": "deployment", "resource_name": "web", "namespace": "shop",
         "patch": {"spec": {"replicas": 2}}}


@pytest.fixture
async def store(tmp_path, monkeypatch):
    service = DatabaseService(f"sqlite+aiosqlite:///{tmp_path}/mirror.db")
    await service.init_db()
    await service.create_session("s1", user_id="u1", title="t")
    async with service.engine.begin() as conn:
        await conn.execute(text(f"CREATE TABLE auth_audit_logs (id INTEGER PRIMARY KEY, {COLUMNS})"))

    async def get():  # audit_writer writes into the same file, as on a PostgreSQL install
        return SimpleNamespace(database_url="postgresql+asyncpg://stand-in", engine=service.engine)

    monkeypatch.setenv("AUDIT_FAIL_CLOSED", "true")
    monkeypatch.setattr(app.database, "get_db_service", get)
    yield service
    await service.engine.dispose()


async def _left_by_a_stopped_server(db):
    row = await db.create_tool_approval(session_id="s1", user_id="u1", user_email="u1@example.com", cluster="prod",
                                        tool="k8s_patch_resource", args=copy.deepcopy(PATCH))
    assert await db.transition_tool_approval(row.id, "pending", status="approved",
                                             decided_at=utcnow() - timedelta(seconds=APPROVED_RUN_LIMIT_SECONDS + 60))
    return row


def _mirrored(out, action):
    return [json.loads(line)["audit"] for line in out.splitlines() if line.startswith("{") and f'"action":"{action}"' in line]


async def _stored(db, action):
    async with db.engine.connect() as conn:
        rows = await conn.execute(text("SELECT after FROM auth_audit_logs WHERE action = :a ORDER BY id"), {"a": action})
        return [json.loads(r[0]) for r in rows.all()]


async def test_refused_attempts_print_no_interrupt_line_and_the_one_that_lands_prints_one(store, capsys):
    left = await _left_by_a_stopped_server(store)
    async with store.engine.begin() as conn:
        await conn.execute(text("CREATE TRIGGER refuse BEFORE INSERT ON auth_audit_logs WHEN NEW.action = 'ai.tool.interrupt' "
                                "BEGIN SELECT RAISE(ABORT, 'audit table refuses interrupt rows'); END"))

    for _ in range(3):  # each look tries again: the readiness probe's own insert is taken, the interrupt row is not
        assert await store.close_interrupted_tool_approvals() == 0
    assert (await store.get_tool_approval(left.id)).status == "approved"
    assert _mirrored(capsys.readouterr().out, "ai.tool.interrupt") == [], "nothing was ended, so nothing is mirrored"
    assert audit_writer._write_broken is True

    async with store.engine.begin() as conn:
        await conn.execute(text("DROP TRIGGER refuse"))
    assert await store.close_interrupted_tool_approvals() == 1
    ended = await store.get_tool_approval(left.id)
    assert ended.status == "failed" and ended.result == INTERRUPTED_RESULT
    [line] = _mirrored(capsys.readouterr().out, "ai.tool.interrupt")
    [row] = await _stored(store, "ai.tool.interrupt")
    assert line["after"] == row and row["approval_id"] == left.id
    assert audit_writer._write_broken is False, "a row that landed with its commit"


async def test_without_fail_closed_the_row_is_mirrored_before_its_own_insert_as_before(store, capsys, monkeypatch):
    monkeypatch.setenv("AUDIT_FAIL_CLOSED", "false")
    left = await _left_by_a_stopped_server(store)
    assert await store.close_interrupted_tool_approvals() == 1
    [line] = _mirrored(capsys.readouterr().out, "ai.tool.interrupt")
    assert line["after"]["approval_id"] == left.id
    assert [r["approval_id"] for r in await _stored(store, "ai.tool.interrupt")] == [left.id]
