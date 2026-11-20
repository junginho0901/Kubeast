"""Approved write-tool runs of this process, so that a shutdown cutting one ends it at once.

uvicorn cancels a request still running --timeout-graceful-shutdown (20 s, Dockerfile) after SIGTERM. A run cut there
before its end began is ended right away (DatabaseService.close_cut_tool_approval: failed, masked, an ai.tool.interrupt
row with end_reason shutdown) instead of at the first look past APPROVED_RUN_LIMIT_SECONDS; a run whose end began keeps
that end. Both go in a task of their own behind asyncio.shield, since the request's cancel scope cancels each of its
awaits again. The lifespan's end waits for them (settle, main.py): once it returns the event loop cancels what is left,
and a run not closed by then is ended by that later look, as one a killed process left.
"""
from __future__ import annotations

import asyncio
import logging
from contextlib import asynccontextmanager
from typing import Any, AsyncIterator, Awaitable, Optional

log = logging.getLogger(__name__)


class Run:
    """One approved run, from its approval leaving `pending` on this request until its end or close is written."""

    __slots__ = ("approval_id", "task")

    def __init__(self, approval_id: str):
        self.approval_id = approval_id
        self.task: Optional[asyncio.Task] = None  # its end or its close, once one has begun

    async def ending(self, end: Awaitable[Any]) -> Any:
        """The run's end (the approval leaves `approved` with its outcome row), finished even when the request is
        cancelled meanwhile; from here a cancel closes nothing."""
        self.task = _hold(self, end, "end")
        return await asyncio.shield(self.task)


# Per process, as the runs are: another server's runs are its own.
_open: set[Run] = set()


def _hold(run: Run, step: Awaitable[Any], what: str) -> asyncio.Task:
    task = asyncio.ensure_future(step)

    def done(finished: asyncio.Task) -> None:
        if run.task is finished:
            _open.discard(run)
        if not finished.cancelled() and finished.exception() is not None:
            log.warning("approval %s: the run's %s was not written: %s", run.approval_id, what,
                        finished.exception().__class__.__name__)

    task.add_done_callback(done)
    return task


@asynccontextmanager
async def running(db: Any, approval_id: str) -> AsyncIterator[Run]:
    """The block is the run of approval_id, which this request has just moved to `approved`. A cancel before the
    run's end began closes the run, then goes on."""
    run = Run(approval_id)
    _open.add(run)
    try:
        yield run
    except asyncio.CancelledError:
        if run.task is None:
            run.task = _hold(run, db.close_cut_tool_approval(approval_id), "close")
            try:
                await asyncio.shield(run.task)
            except Exception:
                pass  # logged when it ends
        raise
    finally:
        if run.task is None:
            _open.discard(run)


async def settle(timeout: float) -> int:
    """Waits up to timeout seconds for this process's runs to end or close: the lifespan's end, after uvicorn has
    cancelled the requests still running. Returns how many are left."""
    loop = asyncio.get_running_loop()
    deadline = loop.time() + timeout
    while _open and loop.time() < deadline:
        await asyncio.sleep(0.05)
    if _open:
        log.warning("%d approved run(s) not ended at shutdown: the first look past the run limit ends them", len(_open))
    return len(_open)
