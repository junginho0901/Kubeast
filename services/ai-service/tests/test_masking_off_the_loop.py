"""Masking is CPU work on text a caller sent, so the long inputs of a chat turn are masked off the event loop, and the answer
still comes in its order: nothing of it leaves before the snapshot is masked, and [DONE] comes after the title is stored."""
import threading

import pytest

from app.models.floating_ai import PageContextPayload, VisibleDataLayer
from app.services import floating_ai_service
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
async def test_the_floating_snapshot_is_masked_off_the_loop_before_the_answer_starts(monkeypatch):
    order = []
    loop_thread = threading.get_ident()
    seen = {}

    def snapshot(ctx, cluster):
        seen["thread"] = threading.get_ident()
        seen["cluster"] = cluster
        order.append("snapshot masked")
        return "the snapshot"

    monkeypatch.setattr(floating_ai_service, "build_context_prompt", snapshot)
    chat = _Chat(order)
    events = [e async for e in FloatingAIService(chat).session_chat_stream("s1", "hello", page_context=object(), cluster_name="c1")]
    assert seen["thread"] != loop_thread and seen["cluster"] == "c1"
    assert order == ["snapshot masked", "answer starts"]
    assert events == ["first", "second"]
    assert chat.kw["extra_context_block"] == "the snapshot"


@pytest.mark.asyncio
async def test_a_turn_without_a_snapshot_has_nothing_to_mask(monkeypatch):
    def snapshot(ctx, cluster):
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
    assert "fake-pass-1" not in chat.kw["extra_context_block"] and '"replicas":3' in chat.kw["extra_context_block"]
