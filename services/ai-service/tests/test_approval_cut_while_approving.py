"""A shutdown that cancels an approve while its approval is moving from pending to approved (approval_runs.approving):
the move finishes in a task of its own, and an approval it moved is closed at once, failed with an ai.tool.interrupt
row (end_reason shutdown), with nothing run; it does not wait for the first look past APPROVED_RUN_LIMIT_SECONDS. An
approval another press moved first is left to that press."""
import asyncio

import anyio
import pytest

from app.database import INTERRUPTED_RESULT, utcnow
from app.services import approval_runs
from tests.test_approval_cut_closes import rows  # noqa: F401
from tests.test_approval_end_transaction import _actions, _api, _card, _press, db  # noqa: F401


@pytest.fixture(autouse=True)
def _no_runs_left():
    yield
    approval_runs._open.clear()


def _never_called(calls):
    async def call():
        calls.append(1)
        return "deployment.apps/web patched"
    return call


def _move_then_wait(db, monkeypatch, moved_by_another=False):
    """The pending → approved move commits, then the request waits a moment before it hears so: the shutdown's cancel
    lands there. moved_by_another: another press moves it first, so this press's move finds it no longer pending."""
    real = db.transition_tool_approval
    began = asyncio.Event()

    async def move(approval_id, from_status, **fields):
        if from_status != "pending":
            return await real(approval_id, from_status, **fields)
        if moved_by_another:
            assert await real(approval_id, "pending", status="approved", decided_at=utcnow())
        moved = await real(approval_id, from_status, **fields)
        began.set()
        await asyncio.sleep(0.2)
        return moved

    monkeypatch.setattr(db, "transition_tool_approval", move)
    return began


async def _closed_with_nothing_run(db, rows, row, calls):
    ended = await db.get_tool_approval(row.id)
    assert (ended.status, ended.result) == ("failed", INTERRUPTED_RESULT)
    assert _actions(rows) == ["ai.tool.interrupt"] and rows[-1]["after"]["end_reason"] == "shutdown"
    assert rows[-1]["conn"] is not None, "ended with the approval in one transaction"
    assert not calls, "tool-server was never called"


async def test_a_cut_during_the_move_closes_the_approval_it_moved(db, rows, monkeypatch):
    calls = []
    api = _api(monkeypatch, _never_called(calls))
    row = await _card(db)
    began = _move_then_wait(db, monkeypatch)
    press = asyncio.create_task(_press(api, row))
    await began.wait()
    press.cancel()
    with pytest.raises(asyncio.CancelledError):
        await press
    assert await approval_runs.settle(5) == 0
    await _closed_with_nothing_run(db, rows, row, calls)


async def test_the_close_finishes_though_the_requests_cancel_scope_cancels_it_again(db, rows, monkeypatch):
    calls = []
    api = _api(monkeypatch, _never_called(calls))
    row = await _card(db)
    began = _move_then_wait(db, monkeypatch)
    async with anyio.create_task_group() as requests:
        requests.start_soon(_press, api, row)
        await began.wait()
        requests.cancel_scope.cancel()  # Starlette's task group when uvicorn cancels the request
    assert approval_runs._open, "the request has gone; the move and its close are still under way"
    assert await approval_runs.settle(5) == 0
    await _closed_with_nothing_run(db, rows, row, calls)


async def test_a_cut_during_a_move_another_press_made_first_closes_nothing(db, rows, monkeypatch):
    calls = []
    api = _api(monkeypatch, _never_called(calls))
    row = await _card(db)
    began = _move_then_wait(db, monkeypatch, moved_by_another=True)
    press = asyncio.create_task(_press(api, row))
    await began.wait()
    press.cancel()
    with pytest.raises(asyncio.CancelledError):
        await press
    assert await approval_runs.settle(5) == 0
    kept = await db.get_tool_approval(row.id)
    assert (kept.status, kept.result) == ("approved", None), "the other press's run is its own"
    assert _actions(rows) == [] and not calls
