"""An approved write whose run never wrote its outcome — the ai-service running it stopped between pending → approved
and the end (out of memory, a lost node, the shutdown cutting the request) — does not stay approved for good: past
APPROVED_RUN_LIMIT_SECONDS a new card, an opened card or the first database use ends it failed, masked, with an
ai.tool.interrupt row. A run still going on another server is left alone, and nothing runs it again."""
import asyncio
import copy
import json
from datetime import timedelta
from types import SimpleNamespace

import pytest
from fastapi import HTTPException

import app.database
from app.database import APPROVED_RUN_LIMIT_SECONDS, INTERRUPTED_RESULT, DatabaseService, utcnow
from app.services import audit_writer

FAKE = "fake-secret-value"
PATCH = {
    "resource_type": "deployment", "resource_name": "web", "namespace": "shop",
    "patch": {"spec": {"template": {"spec": {"containers": [{"name": "app", "env": [{"name": "DB_PASSWORD", "value": FAKE}]}]}}}},
}


@pytest.fixture
def rows(monkeypatch):
    written = []

    async def ready():
        return None

    async def probe():
        return True, None

    async def write(**kw):
        written.append(kw)
        return True

    monkeypatch.setattr(audit_writer, "require_audit_ready", ready)
    monkeypatch.setattr(audit_writer, "audit_ready", probe)
    monkeypatch.setattr(audit_writer, "write_audit", write)
    monkeypatch.setenv("AI_WRITE_APPROVAL", "true")
    monkeypatch.setattr("app.services.approval_token.sign", lambda *a, **k: "tok")
    return written


@pytest.fixture
async def store(tmp_path):
    service = DatabaseService(f"sqlite+aiosqlite:///{tmp_path}/interrupted.db")
    await service.init_db()
    await service.create_session("s1", user_id="u1", title="t")
    yield service
    await service.engine.dispose()


@pytest.fixture
async def db(store, rows, monkeypatch):
    async def get():
        return store

    monkeypatch.setattr(app.database, "get_db_service", get)
    return store


def _api(monkeypatch, call=None, build=None, ran=None):
    import app.api as api

    class Service:
        tool_server = SimpleNamespace(last_access=None, last_requests=None)

        async def _call_tool_server(self, tool, args, **_kw):
            if ran is not None:
                ran.append(tool)
            if call is not None:
                await call()
            return "ok"

    async def built(_authorization, cluster_name=None):
        if build is not None:
            await build()
        return Service()

    monkeypatch.setattr(api, "_caller", lambda _auth: SimpleNamespace(user_id="u1"))
    monkeypatch.setattr(api, "_extract_audit_meta", lambda _request, _auth: ({"user_id": "u1", "email": "u1@example.com"}, {}))
    monkeypatch.setattr(api, "_build_ai_service", built)
    monkeypatch.setattr("app.services.ai.permissions.app_permission_error", lambda *a, **k: None)
    return api


async def _card(db):
    return await db.create_tool_approval(session_id="s1", user_id="u1", user_email="u1@example.com", cluster="prod",
                                         tool="k8s_patch_resource", args=copy.deepcopy(PATCH))


async def _cut():
    raise asyncio.CancelledError()  # uvicorn's --timeout-graceful-shutdown cancels a request still running


async def _left_by_a_stopped_server(db, seconds_ago):
    """What a server killed right after pending → approved leaves in the database."""
    row = await _card(db)
    assert await db.transition_tool_approval(row.id, "pending", status="approved", decided_at=utcnow() - timedelta(seconds=seconds_ago))
    return row


def _interrupts(rows):
    return [r for r in rows if r["action"] == "ai.tool.interrupt"]


async def test_a_run_cut_after_its_approval_ends_failed_once_its_time_is_past(db, rows, monkeypatch):
    api = _api(monkeypatch, call=_cut)
    row = await _card(db)
    with pytest.raises(asyncio.CancelledError):
        await api.approve_tool_approval(row.id, request=SimpleNamespace(), authorization="Bearer x")
    assert [r["action"] for r in rows] == ["ai.tool.approve"]

    # within the limit it may still be running on its server: nothing ends it
    assert (await api.get_tool_approval(row.id, authorization="Bearer x"))["status"] == "approved"
    await _card(db)
    assert (await db.get_tool_approval(row.id)).status == "approved"

    await db.update_tool_approval(row.id, decided_at=utcnow() - timedelta(seconds=APPROVED_RUN_LIMIT_SECONDS + 1))
    card = await api.get_tool_approval(row.id, authorization="Bearer x")
    assert card["status"] == "failed" and card["result"] == INTERRUPTED_RESULT
    assert FAKE not in json.dumps(card["args"]) and card["args"]["resource_name"] == "web"
    assert FAKE not in json.dumps((await db.get_tool_approval(row.id)).args)
    [ended] = _interrupts(rows)
    assert (ended["actor_user_id"], ended["actor_email"], ended.get("result", "success")) == ("system", "system", "success")
    assert (ended["cluster"], ended["target_type"], ended["target_id"], ended["namespace"]) == ("prod", "deployment", "web", "shop")
    assert ended["after"]["approval_id"] == row.id and ended["after"]["approved_by"] == "u1"
    assert ended["after"]["session_id"] == "s1" and ended["after"]["end_reason"] == "interrupted"

    await api.get_tool_approval(row.id, authorization="Bearer x")
    assert len(_interrupts(rows)) == 1, "an ended row is not ended again"


async def test_a_new_card_ends_what_a_killed_server_left(db, rows):
    old = await _left_by_a_stopped_server(db, APPROVED_RUN_LIMIT_SECONDS + 60)
    recent = await _left_by_a_stopped_server(db, APPROVED_RUN_LIMIT_SECONDS - 60)
    new = await _card(db)
    assert new.status == "pending"
    assert (await db.get_tool_approval(old.id)).status == "failed"
    assert (await db.get_tool_approval(recent.id)).status == "approved", "a run within its time is its server's"
    assert [r["after"]["approval_id"] for r in _interrupts(rows)] == [old.id]


async def test_the_first_database_use_of_a_process_ends_them(store, rows, monkeypatch):
    left = await _left_by_a_stopped_server(store, APPROVED_RUN_LIMIT_SECONDS * 10)
    monkeypatch.setattr(app.database, "db_service", store)
    monkeypatch.setattr(app.database, "db_initialized", True)
    monkeypatch.setattr(app.database, "interrupted_checked", False)
    assert await app.database.get_db_service() is store
    assert (await store.get_tool_approval(left.id)).status == "failed"
    assert len(_interrupts(rows)) == 1
    again = await _left_by_a_stopped_server(store, APPROVED_RUN_LIMIT_SECONDS * 10)
    await app.database.get_db_service()
    assert (await store.get_tool_approval(again.id)).status == "approved", "once per process, not on every use"


async def test_of_two_servers_one_ends_the_row(db, rows):
    left = await _left_by_a_stopped_server(db, APPROVED_RUN_LIMIT_SECONDS + 60)
    ended = await asyncio.gather(*(db.close_interrupted_tool_approvals() for _ in range(4)))
    assert sum(ended) == 1 and len(_interrupts(rows)) == 1
    assert (await db.get_tool_approval(left.id)).status == "failed"


async def test_a_run_in_progress_is_left_to_its_server(db, rows, monkeypatch):
    seen = []

    async def meanwhile():
        row = (await db.list_tool_approvals("s1", "u1", pending_only=False))[0]
        seen.append(await db.close_interrupted_tool_approvals())
        await _card(db)
        seen.append((await db.get_tool_approval(row.id)).status)

    api = _api(monkeypatch, call=meanwhile)
    row = await _card(db)
    answer = await api.approve_tool_approval(row.id, request=SimpleNamespace(), authorization="Bearer x")
    assert seen == [0, "approved"]
    assert answer["status"] == "executed" and not _interrupts(rows)


async def test_an_interrupted_approval_never_runs_again(db, rows, monkeypatch):
    ran = []
    api = _api(monkeypatch, ran=ran)
    left = await _left_by_a_stopped_server(db, APPROVED_RUN_LIMIT_SECONDS + 60)
    for press in (api.approve_tool_approval, api.reject_tool_approval):
        with pytest.raises(HTTPException) as e:
            await press(left.id, request=SimpleNamespace(), authorization="Bearer x")
        assert e.value.status_code == 409 and e.value.detail == "Approval is failed"
    assert ran == [] and (await db.get_tool_approval(left.id)).status == "failed"


async def test_a_new_card_is_made_when_ending_them_fails(db, rows, monkeypatch):
    def broken(_args):
        raise RuntimeError("cannot mask")

    left = await _left_by_a_stopped_server(db, APPROVED_RUN_LIMIT_SECONDS + 60)
    monkeypatch.setattr("app.services.audit_target.kept_tool_args", broken)
    assert (await _card(db)).status == "pending"
    assert (await db.get_tool_approval(left.id)).status == "approved" and not _interrupts(rows)


async def test_an_interrupt_row_that_cannot_be_stored_leaves_the_approval_for_the_next_sweep(db, rows, monkeypatch):
    answers = [False, True]

    async def write(**kw):
        rows.append(kw)
        return answers.pop(0)

    monkeypatch.setattr(audit_writer, "write_audit", write)
    left = await _left_by_a_stopped_server(db, APPROVED_RUN_LIMIT_SECONDS + 60)
    assert await db.close_interrupted_tool_approvals() == 0
    kept = await db.get_tool_approval(left.id)
    assert kept.status == "approved" and kept.result is None and kept.args == PATCH, "nothing of the row moved"
    assert await db.close_interrupted_tool_approvals() == 1
    ended = await db.get_tool_approval(left.id)
    assert ended.status == "failed" and ended.result == INTERRUPTED_RESULT and FAKE not in json.dumps(ended.args)
    assert len(_interrupts(rows)) == 2 and all(r["conn"] is not None for r in rows), "written in the row's transaction"


async def test_no_sweep_while_the_audit_store_cannot_take_a_row(db, rows, monkeypatch):
    async def not_ready():
        return False, "audit table refuses rows"

    monkeypatch.setattr(audit_writer, "audit_ready", not_ready)
    left = await _left_by_a_stopped_server(db, APPROVED_RUN_LIMIT_SECONDS + 60)
    assert await db.close_interrupted_tool_approvals() == 0
    assert (await db.get_tool_approval(left.id)).status == "approved" and rows == []


async def test_with_fail_closed_off_the_row_ends_and_its_audit_row_follows(db, rows, monkeypatch):
    async def refused(**kw):
        rows.append(kw)
        return False

    monkeypatch.setenv("AUDIT_FAIL_CLOSED", "false")
    monkeypatch.setattr(audit_writer, "write_audit", refused)
    left = await _left_by_a_stopped_server(db, APPROVED_RUN_LIMIT_SECONDS + 60)
    assert await db.close_interrupted_tool_approvals() == 1
    assert (await db.get_tool_approval(left.id)).status == "failed"
    [row] = _interrupts(rows)
    assert row.get("conn") is None, "its own transaction, after the row moved"


async def test_a_model_setting_that_cannot_be_used_leaves_the_card_waiting(db, rows, monkeypatch):
    async def unusable():
        raise HTTPException(status_code=503, detail="No model is configured.")

    ran = []
    api = _api(monkeypatch, build=unusable, ran=ran)
    row = await _card(db)
    with pytest.raises(HTTPException) as e:
        await api.approve_tool_approval(row.id, request=SimpleNamespace(), authorization="Bearer x")
    assert e.value.status_code == 503
    assert (await db.get_tool_approval(row.id)).status == "pending" and ran == []
    assert [(r["action"], r["result"]) for r in rows] == [("ai.tool.approve", "failure")], "a refused press is a failure row"

    api = _api(monkeypatch, ran=ran)
    answer = await api.approve_tool_approval(row.id, request=SimpleNamespace(), authorization="Bearer x")
    assert answer["status"] == "executed" and ran == ["k8s_patch_resource"]
