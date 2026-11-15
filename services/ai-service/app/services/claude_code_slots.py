"""The install-wide limit on Claude Code runs (chart ai.providers.claudeCode.maxConcurrentTotal), shared by every
ai-service replica through the rows of claude_code_slots (services/pkg/dbmigrate 00027).

A run takes a slot with one short conditional UPDATE: the slot is free (owner '') or its holder has not refreshed its
heartbeat for STALE_SECONDS. While the run goes on its holder refreshes the heartbeat every HEARTBEAT_SECONDS, and it
sets the slot free as soon as the run ends, whatever ended it. No lock is held for the run: the slot of a server that
stops goes stale and the next taker has it STALE_SECONDS later. On PostgreSQL the database's clock dates every
heartbeat, so the servers' clocks need not agree; sqlite (local dev, tests) has this process's. A run whose server
could not write its heartbeat for STALE_SECONDS loses the slot to the next taker and goes on (_keep_beating).
"""
from __future__ import annotations

import asyncio
import logging
import socket
import uuid
from contextlib import asynccontextmanager
from datetime import UTC, datetime, timedelta
from typing import AsyncIterator, Callable, Optional

from sqlalchemy import text

log = logging.getLogger(__name__)

STALE_SECONDS = 60.0
HEARTBEAT_SECONDS = 15.0
POLL_SECONDS = 1.0

# The slots this process has made sure exist: (engine, lane) → how many.
_made: dict[tuple[int, str], int] = {}


class Busy(Exception):
    """No slot came free before the deadline."""


def new_owner() -> str:
    """One run's name in the table: the server's host name (the pod's) and a random suffix."""
    return f"{socket.gethostname()}-{uuid.uuid4().hex[:12]}"


def _stamp(at: datetime) -> str:
    return at.strftime("%Y-%m-%d %H:%M:%S.%f")


def _clock(db) -> tuple[str, str, dict]:
    """(now, the time before which a heartbeat is stale, their parameters) as SQL."""
    if db.engine.dialect.name == "postgresql":
        return "NOW()", "NOW() - make_interval(secs => :stale)", {"stale": float(STALE_SECONDS)}
    now = datetime.now(UTC).replace(tzinfo=None)
    return ":now", ":stale_before", {"now": _stamp(now), "stale_before": _stamp(now - timedelta(seconds=STALE_SECONDS))}


async def _make(db, lane: str, total: int) -> None:
    key = (id(db.engine), lane)
    if _made.get(key, 0) >= total:
        return
    async with db.async_session() as s:
        await s.execute(
            text("INSERT INTO claude_code_slots (lane, slot, owner) VALUES (:lane, :slot, '') ON CONFLICT DO NOTHING"),
            [{"lane": lane, "slot": n} for n in range(total)],
        )
        await s.commit()
    _made[key] = total


def _free(stale: str) -> str:
    return f"(owner = '' OR heartbeat_at IS NULL OR heartbeat_at < {stale})"


async def claim(db, lane: str, slot: int, owner: str) -> bool:
    """The conditional UPDATE that gives owner the slot only while it is free or stale as the row is written: of two
    servers taking one slot at once the second waits for the first's UPDATE and finds the slot no longer free."""
    now, stale, params = _clock(db)
    async with db.async_session() as s:
        result = await s.execute(
            text(f"UPDATE claude_code_slots SET owner = :owner, heartbeat_at = {now} "
                 f"WHERE lane = :lane AND slot = :slot AND {_free(stale)}"),
            {"lane": lane, "slot": slot, "owner": owner, **params},
        )
        await s.commit()
        return result.rowcount == 1


async def take(db, lane: str, total: int, owner: str) -> Optional[int]:
    """One of the lane's first `total` slots for `owner`, or None when every one is held."""
    await _make(db, lane, total)
    _, stale, params = _clock(db)
    async with db.async_session() as s:
        rows = await s.execute(
            text(f"SELECT slot FROM claude_code_slots WHERE lane = :lane AND slot < :total AND {_free(stale)} ORDER BY slot"),
            {"lane": lane, "total": total, **params},
        )
        candidates = [r[0] for r in rows.all()]
    for slot in candidates:
        if await claim(db, lane, slot, owner):
            return slot
    return None


async def beat(db, lane: str, owner: str) -> bool:
    """Refreshes the heartbeat of owner's slot; False when it no longer holds one."""
    now, _, params = _clock(db)
    async with db.async_session() as s:
        result = await s.execute(
            text(f"UPDATE claude_code_slots SET heartbeat_at = {now} WHERE lane = :lane AND owner = :owner"),
            {"lane": lane, "owner": owner, **{k: v for k, v in params.items() if k == "now"}},
        )
        await s.commit()
        return result.rowcount > 0


async def release(db, lane: str, owner: str) -> None:
    """Sets owner's slot free (also one it took in an UPDATE whose answer it never read)."""
    async with db.async_session() as s:
        await s.execute(
            text("UPDATE claude_code_slots SET owner = '', heartbeat_at = NULL WHERE lane = :lane AND owner = :owner"),
            {"lane": lane, "owner": owner},
        )
        await s.commit()


async def _release_soon(db, lane: str, owner: str) -> None:
    """release, finished even when the run that called it is cancelled meanwhile."""
    def said(done: asyncio.Task) -> None:
        if not done.cancelled() and done.exception() is not None:
            log.warning("Claude Code slot of %s not set free (it goes stale in %d s): %s",
                        owner, int(STALE_SECONDS), done.exception())

    task = asyncio.ensure_future(release(db, lane, owner))
    task.add_done_callback(said)
    try:
        await asyncio.shield(task)
    except asyncio.CancelledError:
        raise
    except Exception:
        pass  # logged by the callback


async def _keep_beating(db, lane: str, owner: str) -> None:
    """Refreshes owner's heartbeat until cancelled. A slot found taken (its heartbeat could not be written for
    STALE_SECONDS, so another run took it as stale) is not taken back, beating stops and the run goes on: this
    server's own limit (its semaphore, held for the whole run) still holds, and the install runs one more than its
    limit until this run ends, at most the turn timeout. Ending the run instead would lose an answer being written
    because the database did not answer, the same database the audit row of that end would have to reach. The
    release at the end matches the owner, so it leaves the taker's slot alone."""
    while True:
        await asyncio.sleep(HEARTBEAT_SECONDS)
        try:
            if not await beat(db, lane, owner):
                log.warning("Claude Code slot of %s was taken by another run after %d s without a heartbeat; this run "
                            "goes on, one over the install-wide limit until it ends", owner, int(STALE_SECONDS))
                return
        except Exception as e:
            log.warning("Claude Code slot heartbeat of %s failed: %s", owner, e)


@asynccontextmanager
async def held(db, lane: str, total: int, deadline: Optional[float] = None,
               on_wait: Optional[Callable[[], None]] = None) -> AsyncIterator[int]:
    """Holds one of the lane's `total` slots until the block ends. Asks again every POLL_SECONDS while all are held,
    calling on_wait before each wait, and raises Busy once the event loop's clock passes `deadline` (None: no end)."""
    owner = new_owner()
    loop = asyncio.get_running_loop()
    try:
        slot = await take(db, lane, total, owner)
        while slot is None:
            if on_wait is not None:
                on_wait()
            left = None if deadline is None else deadline - loop.time()
            if left is not None and left <= 0:
                raise Busy()
            await asyncio.sleep(POLL_SECONDS if left is None else min(POLL_SECONDS, left))
            slot = await take(db, lane, total, owner)
    except Busy:
        raise
    except BaseException:
        await _release_soon(db, lane, owner)  # cancelled during an UPDATE that took a slot
        raise
    beating = asyncio.create_task(_keep_beating(db, lane, owner))
    try:
        yield slot
    finally:
        beating.cancel()
        await _release_soon(db, lane, owner)
