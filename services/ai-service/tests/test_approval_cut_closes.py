"""An approved write whose request the shutdown cancels (uvicorn's --timeout-graceful-shutdown, 20 s) ends at once on its
own server: failed, masked, with an ai.tool.interrupt row (end_reason shutdown) in the same transaction. It does not
wait for the first look past APPROVED_RUN_LIMIT_SECONDS. The close runs in a task of its own (approval_runs), so the
request's cancel scope, which cancels each of its awaits again, does not cut it, and the lifespan's end waits for it.
A run whose end had begun keeps that end."""
import asyncio
import contextlib
import gc
import io
import json
import logging

import anyio
import pytest
from fastapi import HTTPException

from app.database import INTERRUPTED_RESULT
from app.services import approval_runs, audit_writer
from app.services.audit_target import write_tool_input
from tests.test_approval_end_transaction import FAKE, PATCH, TOOL, _actions, _answered, _api, _card, _press, db  # noqa: F401


@pytest.fixture(autouse=True)
def _no_runs_left():
    yield
    approval_runs._open.clear()


@pytest.fixture
def rows(monkeypatch):
    written = []

    async def ready():
        return None

    async def probe():
        return True, None

    async def write(**kw):
        if kw["action"] == "ai.tool.interrupt":
            await asyncio.sleep(0.2)  # a database that takes a moment: the request has gone by the time the row lands
        written.append(kw)
        return True

    monkeypatch.setattr(audit_writer, "require_audit_ready", ready)
    monkeypatch.setattr(audit_writer, "audit_ready", probe)
    monkeypatch.setattr(audit_writer, "write_audit", write)
    monkeypatch.setenv("AI_WRITE_APPROVAL", "true")
    monkeypatch.setattr("app.services.approval_token.sign", lambda *a, **k: "tok")
    return written


def _in_the_call(entered):
    async def call():
        entered.set()
        await asyncio.sleep(60)  # tool-server is still on it when the shutdown's 20 s are up
    return call


async def _ended_by_the_shutdown(db, rows, row):
    ended = await db.get_tool_approval(row.id)
    assert (ended.status, ended.result) == ("failed", INTERRUPTED_RESULT)
    assert FAKE not in json.dumps(ended.args) and ended.args["resource_name"] == "web"
    assert _actions(rows) == ["ai.tool.approve", "ai.tool.interrupt"]
    cut = rows[-1]
    assert (cut["actor_user_id"], cut["cluster"], cut["target_type"], cut["target_id"], cut["namespace"]) == (
        "system", "prod", "deployment", "web", "shop")
    assert cut["after"]["end_reason"] == "shutdown" and cut["after"]["approval_id"] == row.id
    assert cut["after"]["approved_by"] == "u1" and cut["conn"] is not None, "ended with the approval in one transaction"
    asked = write_tool_input(TOOL, PATCH)
    assert {k: cut["after"][k] for k in asked} == asked and FAKE not in json.dumps(cut["after"])


async def test_a_run_the_shutdown_cuts_during_its_call_ends_at_once(db, rows, monkeypatch):
    entered = asyncio.Event()
    api = _api(monkeypatch, _in_the_call(entered))
    row = await _card(db)
    press = asyncio.create_task(_press(api, row))
    await entered.wait()
    press.cancel()
    with pytest.raises(asyncio.CancelledError):
        await press
    await _ended_by_the_shutdown(db, rows, row)
    assert not approval_runs._open

    api = _api(monkeypatch, _answered)
    with pytest.raises(HTTPException) as refused:
        await _press(api, row)
    assert refused.value.status_code == 409, "nothing runs it again"


async def test_the_close_finishes_though_the_requests_cancel_scope_cancels_it_again(db, rows, monkeypatch):
    entered = asyncio.Event()
    api = _api(monkeypatch, _in_the_call(entered))
    row = await _card(db)
    async with anyio.create_task_group() as requests:
        requests.start_soon(_press, api, row)
        await entered.wait()
        requests.cancel_scope.cancel()  # Starlette's task group when uvicorn cancels the request
    assert (await db.get_tool_approval(row.id)).status == "approved", "the request has gone; its close has not landed"
    assert await approval_runs.settle(5) == 0
    await _ended_by_the_shutdown(db, rows, row)


async def test_the_lifespans_end_waits_for_a_cut_run_to_close(db, rows, monkeypatch):
    import main

    entered = asyncio.Event()
    api = _api(monkeypatch, _in_the_call(entered))
    row = await _card(db)
    async with main.lifespan(main.app):
        press = asyncio.create_task(_press(api, row))
        await entered.wait()
        press.cancel()  # uvicorn cancels the requests past its graceful wait, then ends the lifespan
    await _ended_by_the_shutdown(db, rows, row)
    with pytest.raises(asyncio.CancelledError):
        await press


async def test_a_cancel_after_the_end_began_keeps_that_end(db, rows, monkeypatch):
    began = asyncio.Event()
    real = db.end_tool_run

    async def slow_end(*a, **k):
        began.set()
        await asyncio.sleep(0.2)
        return await real(*a, **k)

    monkeypatch.setattr(db, "end_tool_run", slow_end)
    api = _api(monkeypatch, _answered)
    row = await _card(db)
    press = asyncio.create_task(_press(api, row))
    await began.wait()
    press.cancel()
    with pytest.raises(asyncio.CancelledError):
        await press
    assert await approval_runs.settle(5) == 0
    ended = await db.get_tool_approval(row.id)
    assert (ended.status, ended.result) == ("executed", "deployment.apps/web patched")
    assert _actions(rows) == ["ai.tool.approve", "ai.tool.execute"], "no close over the end"


async def test_a_cut_whose_row_cannot_be_stored_leaves_the_approval_for_the_next_look(db, rows, monkeypatch):
    async def write(**kw):
        rows.append(kw)
        return kw["action"] != "ai.tool.interrupt"

    monkeypatch.setattr(audit_writer, "write_audit", write)
    entered = asyncio.Event()
    api = _api(monkeypatch, _in_the_call(entered))
    row = await _card(db)
    press = asyncio.create_task(_press(api, row))
    await entered.wait()
    press.cancel()
    with pytest.raises(asyncio.CancelledError):
        await press
    kept = await db.get_tool_approval(row.id)
    assert (kept.status, kept.result, kept.args) == ("approved", None, PATCH), "nothing of the row moved"
    assert _actions(rows) == ["ai.tool.approve", "ai.tool.interrupt"] and not approval_runs._open


async def test_a_close_leaves_a_row_that_is_not_approved_as_it_is(db, rows):
    row = await _card(db)
    assert await db.close_cut_tool_approval(row.id) is False
    assert await db.close_cut_tool_approval("no-such-approval") is False
    assert (await db.get_tool_approval(row.id)).status == "pending" and rows == []


@contextlib.contextmanager
def _pod_log():
    """What the kubeast.ai stdout handler, the one kubectl logs reads, writes meanwhile."""
    from app.services.ai import debug_dump

    out = next(h for h in debug_dump.log.handlers if isinstance(h, logging.StreamHandler))
    buf = io.StringIO()
    before = out.setStream(buf)
    try:
        yield buf
    finally:
        out.setStream(before)


def _lines(buf):
    return [line.split(" kubeast.ai ", 1)[1] for line in buf.getvalue().splitlines() if " kubeast.ai " in line]


async def test_settle_gives_up_after_its_time(db):
    with _pod_log() as buf:
        async with approval_runs.running(db, "a1"):
            assert await approval_runs.settle(0.1) == 1
    assert not approval_runs._open
    assert _lines(buf) == ["1 approved run(s) not ended at shutdown: the first look past the run limit ends them"]
    assert " WARNING " in buf.getvalue()


async def test_a_close_that_fails_is_one_warning_line_in_the_pod_log(db, monkeypatch):
    async def broken(approval_id):
        raise RuntimeError("password=hunter2")

    monkeypatch.setattr(db, "close_cut_tool_approval", broken)
    entered = asyncio.Event()

    async def cut():
        async with approval_runs.running(db, "a1"):
            entered.set()
            await asyncio.sleep(10)

    with _pod_log() as buf:
        task = asyncio.create_task(cut())
        await entered.wait()
        task.cancel()
        with pytest.raises(asyncio.CancelledError):
            await task
    assert _lines(buf) == ["approval a1: the run's close was not written: RuntimeError"]
    assert " WARNING " in buf.getvalue()
    assert "hunter2" not in buf.getvalue() and not approval_runs._open


@pytest.mark.parametrize("step", ["end", "close", "move", "close of a move"])
async def test_a_step_refused_once_the_request_has_gone_is_one_line_with_the_errors_name(db, rows, monkeypatch, caplog, step):
    """asyncio.shield gives the error of a task whose waiter was cancelled to the event loop, whose asyncio logger writes
    its text and traceback to stderr, which kubectl logs shows as well."""
    at = asyncio.Event()

    async def refused(*_a, **_k):
        at.set()
        await asyncio.sleep(0.1)  # the database takes a moment: the request has gone by then
        raise RuntimeError("password=hunter2")

    move = db.transition_tool_approval

    async def moved_slowly(*a, **k):
        moved = await move(*a, **k)
        at.set()
        await asyncio.sleep(0.1)
        return moved

    for name, stand_in in {
        "end": {"end_tool_run": refused},
        "close": {"close_cut_tool_approval": refused},
        "move": {"transition_tool_approval": refused},
        "close of a move": {"transition_tool_approval": moved_slowly, "close_cut_tool_approval": refused},
    }[step].items():
        monkeypatch.setattr(db, name, stand_in)
    api = _api(monkeypatch, _in_the_call(at) if step == "close" else _answered)
    row = await _card(db)
    with _pod_log() as buf:
        async with anyio.create_task_group() as requests:
            requests.start_soon(_press, api, row)
            await at.wait()
            requests.cancel_scope.cancel()  # Starlette's task group: it cancels each await of the request again
        assert await approval_runs.settle(5) == 0
    gc.collect()  # an error nobody read is logged when its task goes
    what = "end" if step == "end" else "close"
    assert _lines(buf) == [f"approval {row.id}: the run's {what} was not written: RuntimeError"]
    assert [r.getMessage() for r in caplog.records if r.name == "asyncio"] == []
    assert "hunter2" not in caplog.text + buf.getvalue()


@pytest.mark.parametrize("name", ["end_tool_run", "transition_tool_approval"])
async def test_a_step_refused_while_the_request_is_there_is_the_requests_error(db, rows, monkeypatch, name):
    async def refused(*_a, **_k):
        raise RuntimeError("the database is away")

    row = await _card(db)
    monkeypatch.setattr(db, name, refused)
    with pytest.raises(RuntimeError, match="the database is away"):
        await _press(_api(monkeypatch, _answered), row)
    assert not approval_runs._open
