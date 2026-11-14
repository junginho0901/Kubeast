"""Masking is CPU work on text a caller sent, so the long inputs of a chat turn are masked off the event loop, and the answer
still comes in its order: the chat masks the floating snapshot after its one read of the history and before the model is
called, and [DONE] comes after the title is stored."""
import threading
from types import SimpleNamespace

import pytest

from app.models.floating_ai import PageContextPayload, VisibleDataLayer
from app.services import floating_ai_service, redact
from app.services.floating_ai_service import FloatingAIService


class _Chat:
    def __init__(self, order):
        self.order = order
        self.kw = None

    async def session_chat_stream(self, **kw):
        self.kw = kw
        self.order.append("answer starts")
        yield "first"
        yield "second"


@pytest.mark.asyncio
async def test_the_floating_chat_hands_the_snapshot_to_the_chat_unmasked_and_reads_nothing(monkeypatch):
    seen = {}

    def snapshot(ctx, cluster, numbers=None):
        seen.update(ctx=ctx, cluster=cluster, numbers=numbers)
        return "the snapshot"

    async def no_database():
        raise AssertionError("the floating chat reads nothing of its own")

    monkeypatch.setattr(floating_ai_service, "build_context_prompt", snapshot)
    monkeypatch.setattr("app.database.get_db_service", no_database)
    chat = _Chat([])
    page = object()
    events = [e async for e in FloatingAIService(chat).session_chat_stream("s1", "hello", page_context=page, cluster_name="c1")]
    assert events == ["first", "second"] and seen == {}  # masked by the chat, once it has read the history
    numbers = redact.Numbers()
    assert chat.kw["extra_context_block"](numbers) == "the snapshot"
    assert seen == {"ctx": page, "cluster": "c1", "numbers": numbers}


@pytest.mark.asyncio
async def test_the_chat_masks_the_snapshot_off_the_loop_after_its_one_history_read_and_before_the_model(monkeypatch):
    from tests.test_chat_turn_edges import stream, text_chunk
    from tests.test_planted_values import chat_rig

    order, loop_thread, seen = [], threading.get_ident(), {}

    def block(numbers):
        seen["thread"] = threading.get_ident()
        order.append("snapshot masked")
        return "the snapshot"

    service, calls, reads = chat_rig(monkeypatch, [SimpleNamespace(role="user", content="hello")], [stream([text_chunk("Hi.")])], order=order)
    events = [e async for e in service.session_chat_stream(session_id="s1", message="hello", extra_context_block=block)]
    assert order == ["history read", "snapshot masked", "model called"] and reads == ["s1"]
    assert seen["thread"] != loop_thread
    assert "the snapshot" in calls[0] and events[-1].strip() == "data: [DONE]"


@pytest.mark.asyncio
async def test_a_turn_without_a_snapshot_has_nothing_to_mask(monkeypatch):
    def snapshot(ctx, cluster, numbers=None):
        raise AssertionError("no snapshot to mask")

    monkeypatch.setattr(floating_ai_service, "build_context_prompt", snapshot)
    chat = _Chat([])
    assert [e async for e in FloatingAIService(chat).session_chat_stream("s1", "hello")] == ["first", "second"]
    assert chat.kw["extra_context_block"] is None


@pytest.mark.asyncio
async def test_the_snapshot_that_reaches_the_answer_is_masked():
    ctx = PageContextPayload(
        page_type="resource-list", page_title="Pods", path="/workloads/pods", snapshot_at="2026-11-07T00:00:00Z",
        base=VisibleDataLayer(source="base", summary="pods", data={"password": "fake-pass-1", "replicas": 3}),
    )
    chat = _Chat([])
    assert [e async for e in FloatingAIService(chat).session_chat_stream("s1", "hello", page_context=ctx)] == ["first", "second"]
    text = chat.kw["extra_context_block"](redact.Numbers())
    assert "fake-pass-1" not in text and '"replicas":3' in text
