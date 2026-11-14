"""The install-wide Claude Code limit (app/services/claude_code_slots.py) on sqlite: two DatabaseServices on one file
stand for two replicas. tests/test_claude_code_slots_postgres.py runs the same against PostgreSQL."""
import asyncio
import sys

import pytest
from sqlalchemy import text

from app.services import claude_code, claude_code_slots
from tests.test_claude_code import OK, make_sdk


@pytest.fixture
async def servers(tmp_path, monkeypatch):
    from app.database import DatabaseService

    url = f"sqlite+aiosqlite:///{tmp_path}/shared.db"
    dbs = [DatabaseService(url), DatabaseService(url)]
    await dbs[0].init_db()
    monkeypatch.setattr(claude_code_slots, "_made", {})
    monkeypatch.setattr(claude_code_slots, "POLL_SECONDS", 0.02)
    yield dbs
    for db in dbs:
        await db.engine.dispose()


async def rows(db):
    async with db.async_session() as s:
        return [tuple(r) for r in (await s.execute(text(
            "SELECT lane, slot, owner FROM claude_code_slots ORDER BY lane, slot"))).all()]


async def test_a_second_server_waits_for_the_one_slot_and_gets_it_when_the_first_ends(servers):
    order = []
    first_in = asyncio.Event()

    async def first():
        async with claude_code_slots.held(servers[0], "chat", 1):
            order.append("first in")
            first_in.set()
            await asyncio.sleep(0.2)
            order.append("first out")

    async def second():
        await first_in.wait()
        async with claude_code_slots.held(servers[1], "chat", 1) as slot:
            order.append(f"second in {slot}")

    await asyncio.wait_for(asyncio.gather(first(), second()), 5)
    assert order == ["first in", "first out", "second in 0"]
    assert [owner for _, _, owner in await rows(servers[0])] == [""]  # set free at the end


async def test_a_slot_taken_between_another_servers_read_and_write_stays_with_the_first(servers):
    """Both servers read slot 0 as free; the first writes it; the second's write finds it held and takes nothing."""
    assert await claude_code_slots.take(servers[0], "chat", 1, "first") == 0
    assert await claude_code_slots.claim(servers[1], "chat", 0, "second") is False
    assert [owner for *_, owner in await rows(servers[0])] == ["first"]


async def test_two_slots_let_two_servers_run_at_once_and_a_third_waits(servers):
    running, most = 0, 0

    async def run(db):
        nonlocal running, most
        async with claude_code_slots.held(db, "chat", 2):
            running += 1
            most = max(most, running)
            await asyncio.sleep(0.1)
            running -= 1

    await asyncio.wait_for(asyncio.gather(run(servers[0]), run(servers[1]), run(servers[0])), 5)
    assert most == 2


async def test_a_holder_that_stops_beating_is_set_free_after_the_stale_time(servers, monkeypatch):
    monkeypatch.setattr(claude_code_slots, "STALE_SECONDS", 0.3)
    loop = asyncio.get_running_loop()
    # a server that died holding the slot: it took it and never beats or sets it free again
    assert await claude_code_slots.take(servers[0], "chat", 1, "gone-server") == 0
    started = loop.time()
    async with asyncio.timeout(5), claude_code_slots.held(servers[1], "chat", 1) as slot:
        waited = loop.time() - started
        assert slot == 0 and [owner for *_, owner in await rows(servers[1])] != ["gone-server"]
    assert 0.25 <= waited < 2


async def test_a_live_holder_keeps_its_slot_past_the_stale_time(servers, monkeypatch):
    monkeypatch.setattr(claude_code_slots, "STALE_SECONDS", 0.3)
    monkeypatch.setattr(claude_code_slots, "HEARTBEAT_SECONDS", 0.05)
    held_long = asyncio.Event()

    async def holder():
        async with claude_code_slots.held(servers[0], "chat", 1):
            await asyncio.sleep(0.8)
            held_long.set()

    async def other():
        await asyncio.sleep(0.05)
        async with claude_code_slots.held(servers[1], "chat", 1):
            return held_long.is_set()

    _, waited_for_the_end = await asyncio.wait_for(asyncio.gather(holder(), other()), 5)
    assert waited_for_the_end


async def test_an_error_in_the_run_sets_the_slot_free(servers):
    with pytest.raises(RuntimeError):
        async with claude_code_slots.held(servers[0], "chat", 1):
            raise RuntimeError("the run failed")
    assert [owner for *_, owner in await rows(servers[0])] == [""]


async def test_a_cancelled_run_sets_the_slot_free(servers):
    inside = asyncio.Event()

    async def run():
        async with claude_code_slots.held(servers[0], "chat", 1):
            inside.set()
            await asyncio.sleep(5)

    task = asyncio.create_task(run())
    await inside.wait()
    task.cancel()
    with pytest.raises(asyncio.CancelledError):
        await task
    assert [owner for *_, owner in await rows(servers[0])] == [""]


async def test_slots_past_a_lowered_limit_are_not_taken(servers):
    await claude_code_slots.take(servers[0], "chat", 3, "a")
    await claude_code_slots.take(servers[0], "chat", 3, "b")
    assert await claude_code_slots.take(servers[1], "chat", 2, "c") is None  # slots 0 and 1 held; 2 is past the limit
    assert await claude_code_slots.take(servers[1], "chat", 3, "c") == 2


@pytest.fixture
def on(monkeypatch, servers):
    """The provider on, its chat slots in the shared file: each call to server() is one more replica's process."""
    monkeypatch.setattr(claude_code.settings, "AI_CLAUDE_CODE_ENABLED", True, raising=False)
    sdk = make_sdk([("sleep", 0.1), ("result", OK)])
    monkeypatch.setitem(sys.modules, "claude_agent_sdk", sdk)
    return sdk


async def test_the_install_wide_limit_holds_where_the_server_would_run_more(on, monkeypatch, servers):
    """maxConcurrent 2 on this server, maxConcurrentTotal 1: one run at a time; with a total of 2, two."""
    async def database():
        return servers[0]

    monkeypatch.setattr(claude_code, "_database", database)
    monkeypatch.setattr(claude_code.settings, "AI_CLAUDE_CODE_MAX_CONCURRENT", 2, raising=False)
    ask = [{"role": "user", "content": "x"}]
    for total, most in ((1, 1), (2, 2)):
        monkeypatch.setattr(claude_code, "_semaphores", {})
        monkeypatch.setattr(claude_code.settings, "AI_CLAUDE_CODE_MAX_CONCURRENT_TOTAL", total, raising=False)
        on.state["max_running"] = 0
        await asyncio.gather(*(claude_code.complete(ask, model="m", token="t") for _ in range(3)))
        assert on.state["max_running"] == most


async def test_the_default_install_wide_limit_is_the_per_server_one(monkeypatch):
    monkeypatch.setattr(claude_code.settings, "AI_CLAUDE_CODE_MAX_CONCURRENT", 3, raising=False)
    monkeypatch.setattr(claude_code.settings, "AI_CLAUDE_CODE_MAX_CONCURRENT_TOTAL", 0, raising=False)
    assert claude_code.max_concurrent_total() == 3
    monkeypatch.setattr(claude_code.settings, "AI_CLAUDE_CODE_MAX_CONCURRENT_TOTAL", 5, raising=False)
    assert claude_code.max_concurrent_total() == 5


async def test_a_chat_run_takes_a_server_slot_then_an_install_slot(on, monkeypatch, servers):
    monkeypatch.setattr(claude_code, "_semaphores", {})
    taken = []
    real_held = claude_code_slots.held

    def held(db, lane, total, *a, **kw):
        taken.append((lane, total, claude_code._sem("chat").locked()))
        return real_held(db, lane, total, *a, **kw)

    async def database():
        return servers[0]

    monkeypatch.setattr(claude_code_slots, "held", held)
    monkeypatch.setattr(claude_code, "_database", database)
    await claude_code.complete([{"role": "user", "content": "x"}], model="m", token="t")
    assert taken == [("chat", 1, True)]  # the server's slot was already held when the install's was asked for


async def test_an_investigation_never_touches_the_install_wide_slots(on, monkeypatch):
    monkeypatch.setattr(claude_code, "_semaphores", {})

    async def no_database():
        raise AssertionError("the investigator's lane read the slots")

    monkeypatch.setattr(claude_code, "_database", no_database)
    await claude_code.complete([{"role": "user", "content": "x"}], model="m", token="t", lane="investigation")
    assert len(on.state["options"]) == 1


async def test_with_the_provider_off_nothing_reads_the_slots(monkeypatch):
    monkeypatch.setattr(claude_code.settings, "AI_CLAUDE_CODE_ENABLED", False, raising=False)

    async def no_database():
        raise AssertionError("the slots were read with the provider off")

    monkeypatch.setattr(claude_code, "_database", no_database)
    with pytest.raises(claude_code.ClaudeCodeError, match="off"):
        await claude_code.complete([{"role": "user", "content": "x"}], model="m", token="t")

