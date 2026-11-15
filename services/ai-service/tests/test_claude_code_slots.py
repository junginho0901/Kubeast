"""The install-wide Claude Code limit (app/services/claude_code_slots.py) on sqlite: two DatabaseServices on one file
stand for two replicas. tests/test_claude_code_slots_postgres.py runs the same against PostgreSQL."""
import asyncio
import json
import sys

import pytest
from sqlalchemy import text

from app.services import claude_code, claude_code_slots
from tests.test_claude_code import OK, make_sdk, until


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
    running, most, ran = 0, 0, 0
    release = asyncio.Event()

    async def run(db):
        nonlocal running, most, ran
        async with claude_code_slots.held(db, "chat", 2):
            running, ran = running + 1, ran + 1
            most = max(most, running)
            await release.wait()
            running -= 1

    runs = asyncio.gather(run(servers[0]), run(servers[1]), run(servers[0]))
    await until(lambda: running == 2)
    await asyncio.sleep(0.1)  # longer than a poll: a third run let in would be inside by now
    assert (running, ran) == (2, 2)
    release.set()
    await asyncio.wait_for(runs, 5)
    assert most == 2 and ran == 3


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


async def test_a_run_whose_slot_was_taken_goes_on_stops_beating_and_leaves_the_takers_slot(servers, monkeypatch):
    """Another server took the slot as stale (this one could not beat for the stale time): the run is not stopped,
    one beat finds the slot taken and beating stops, and ending the run does not set the taker's slot free."""
    monkeypatch.setattr(claude_code_slots, "HEARTBEAT_SECONDS", 0.05)
    beats = []
    real_beat = claude_code_slots.beat

    async def counting_beat(db, lane, owner):
        beats.append(owner)
        return await real_beat(db, lane, owner)

    monkeypatch.setattr(claude_code_slots, "beat", counting_beat)
    async with asyncio.timeout(5), claude_code_slots.held(servers[0], "chat", 1) as slot:
        async with servers[1].async_session() as s:
            await s.execute(text("UPDATE claude_code_slots SET owner = 'taker' WHERE lane = 'chat' AND slot = :slot"),
                            {"slot": slot})
            await s.commit()
        await asyncio.sleep(0.3)
        seen = len(beats)
        await asyncio.sleep(0.2)
        assert len(beats) == seen >= 1  # beats stopped once one found the slot taken
    assert [owner for *_, owner in await rows(servers[0])] == ["taker"]


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


def holding(monkeypatch):
    """A fake SDK in place of the one installed, whose runs stay inside until the test sets state["release"]."""
    sdk = make_sdk([("hold",), ("result", OK)])
    monkeypatch.setitem(sys.modules, "claude_agent_sdk", sdk)
    return sdk


async def test_the_install_wide_limit_holds_where_the_server_would_run_more(on, monkeypatch, servers):
    """maxConcurrent 2 on this server, maxConcurrentTotal 1: one run at a time; with a total of 2, two."""
    async def database():
        return servers[0]

    monkeypatch.setattr(claude_code, "_database", database)
    monkeypatch.setattr(claude_code.settings, "AI_CLAUDE_CODE_MAX_CONCURRENT", 2, raising=False)
    ask = [{"role": "user", "content": "x"}]
    for total in (1, 2):
        sdk = holding(monkeypatch)
        monkeypatch.setattr(claude_code, "_semaphores", {})
        monkeypatch.setattr(claude_code.settings, "AI_CLAUDE_CODE_MAX_CONCURRENT_TOTAL", total, raising=False)
        runs = asyncio.gather(*(claude_code.complete(ask, model="m", token="t") for _ in range(3)))
        await until(lambda: sdk.state["running"] == total)
        await asyncio.sleep(0.1)  # longer than a poll: a run past the limit would be inside by now
        assert len(sdk.state["options"]) == total
        sdk.state["release"].set()
        await asyncio.wait_for(runs, 5)
        assert sdk.state["max_running"] == total and len(sdk.state["options"]) == 3


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


# --- waiting for a slot: at most queue_wait(), said on the chat stream, busy past it, left at once on Stop ---------

def chat_turn():
    """A chat turn's SSE events as dicts, through the real ClaudeCodeChat.turn."""
    async def run_tool(name, args, turn, call_id=None):
        return [], "[]"

    async def events():
        gen = claude_code.ClaudeCodeChat(model="m", token="t").turn(
            messages=[{"role": "user", "content": "x"}], tools=[], run_tool=run_tool, out=claude_code.TurnResult())
        return [json.loads(e.removeprefix("data: ").strip()) for e in [x async for x in gen]]
    return events()


@pytest.fixture
def one_slot(on, monkeypatch, servers):
    """The provider on with one chat slot on this server and in the install, its rows in servers[0]."""
    async def database():
        return servers[0]

    monkeypatch.setattr(claude_code, "_database", database)
    monkeypatch.setattr(claude_code, "_semaphores", {})
    monkeypatch.setattr(claude_code.settings, "AI_CLAUDE_CODE_MAX_CONCURRENT", 1, raising=False)
    monkeypatch.setattr(claude_code.settings, "AI_CLAUDE_CODE_MAX_CONCURRENT_TOTAL", 1, raising=False)
    return on


async def test_a_turn_that_waits_says_so_then_runs_when_the_slot_frees(one_slot):
    first = asyncio.create_task(claude_code.complete([{"role": "user", "content": "x"}], model="m", token="t"))
    await asyncio.sleep(0.02)
    events = await asyncio.wait_for(chat_turn(), 5)
    await first
    assert events[0] == {"queued": True} and events[1] == {"queued": False}
    assert one_slot.state["max_running"] == 1 and len(one_slot.state["options"]) == 2


async def test_a_turn_with_a_free_slot_says_nothing_of_waiting(one_slot):
    events = await chat_turn()
    assert not any("queued" in e for e in events)


async def test_a_turn_that_waits_past_the_queue_wait_ends_busy(one_slot, monkeypatch):
    monkeypatch.setattr(claude_code, "queue_wait", lambda: 0.05)
    sdk = holding(monkeypatch)
    first = asyncio.create_task(claude_code.complete([{"role": "user", "content": "x"}], model="m", token="t"))
    await until(lambda: sdk.state["running"] == 1)  # the first run holds both slots until released
    with pytest.raises(claude_code.ClaudeCodeBusy, match="Claude Code is busy; ask again in a moment"):
        await asyncio.wait_for(chat_turn(), 5)
    sdk.state["release"].set()
    await first
    assert len(sdk.state["options"]) == 1  # the busy turn never started Claude Code


async def test_a_slot_another_server_holds_past_the_queue_wait_ends_busy_and_stays_its(one_slot, monkeypatch, servers):
    monkeypatch.setattr(claude_code, "queue_wait", lambda: 0.1)
    assert await claude_code_slots.take(servers[1], "chat", 1, "other-server") == 0
    with pytest.raises(claude_code.ClaudeCodeBusy):
        await asyncio.wait_for(claude_code.complete([{"role": "user", "content": "x"}], model="m", token="t"), 5)
    assert [owner for *_, owner in await rows(servers[0])] == ["other-server"]
    assert not claude_code._sem("chat").locked()  # this server's slot was given back


async def test_stop_while_waiting_leaves_the_queue_at_once_and_takes_no_slot(one_slot, servers):
    assert await claude_code_slots.take(servers[1], "chat", 1, "other-server") == 0
    gen = claude_code.ClaudeCodeChat(model="m", token="t").turn(
        messages=[{"role": "user", "content": "x"}], tools=[], run_tool=None, out=claude_code.TurnResult())
    assert json.loads((await gen.__anext__()).removeprefix("data: ")) == {"queued": True}
    await gen.aclose()  # the user pressed Stop
    await asyncio.sleep(0.1)  # longer than a poll: a run still waiting would take the slot freed below
    await claude_code_slots.release(servers[1], "chat", "other-server")
    await asyncio.sleep(0.1)
    assert [owner for *_, owner in await rows(servers[0])] == [""]
    assert not claude_code._sem("chat").locked() and one_slot.state["options"] == []


async def test_stop_while_waiting_for_this_servers_slot_leaves_it_to_the_next(one_slot):
    first = asyncio.create_task(claude_code.complete([{"role": "user", "content": "x"}], model="m", token="t"))
    await asyncio.sleep(0.02)
    gen = claude_code.ClaudeCodeChat(model="m", token="t").turn(
        messages=[{"role": "user", "content": "x"}], tools=[], run_tool=None, out=claude_code.TurnResult())
    assert json.loads((await gen.__anext__()).removeprefix("data: ")) == {"queued": True}
    await gen.aclose()
    await first
    await claude_code.complete([{"role": "user", "content": "x"}], model="m", token="t")  # the slot is free again
    assert len(one_slot.state["options"]) == 2


def test_busy_is_its_own_kind_of_refusal_with_its_catalog_key():
    from app.services.ai import model_errors

    refusal = model_errors.classify(claude_code.ClaudeCodeBusy())
    assert (refusal.kind, refusal.key, refusal.blocks) == ("busy", "claudeCodeBusy", False)
    assert model_errors.classify(claude_code.ClaudeCodeError("Claude Code failed: busy")).kind != "busy"


def test_the_chat_error_for_busy_is_the_catalogued_text():
    from types import SimpleNamespace

    from app.services.ai import streaming

    event = streaming.model_error(SimpleNamespace(provider="claude-code"), claude_code.ClaudeCodeBusy())
    assert event == {"error": "Claude Code is busy; ask again in a moment.", "error_key": "claudeCodeBusy",
                     "error_args": {"provider": "Claude subscription"}}


def test_the_queue_wait_defaults_to_a_minute(monkeypatch):
    monkeypatch.setattr(claude_code.settings, "AI_CLAUDE_CODE_QUEUE_WAIT", None, raising=False)
    assert claude_code.queue_wait() == 60
    monkeypatch.setattr(claude_code.settings, "AI_CLAUDE_CODE_QUEUE_WAIT", 0, raising=False)
    assert claude_code.queue_wait() == 0
