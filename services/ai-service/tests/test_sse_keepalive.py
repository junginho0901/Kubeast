"""A quiet answer stream (the model thinking, a tool running) sends a comment line every period, so nginx and a load
balancer in front (60 s idle) do not cut it; what the answer itself sends, saves and records stays as it was."""
import asyncio

import pytest
from fastapi.testclient import TestClient

from main import app
from app import api as api_module
from app.security import require_auth
from app.services import sse_keepalive

KEEPALIVE = ": keepalive\n\n"
QUIET = 0.3


class _QuietModel:
    """Answers as the chat and Optimization streams do, quiet for a while between the parts."""

    async def _answer(self):
        yield 'data: {"content": "Two "}\n\n'
        await asyncio.sleep(QUIET)
        yield 'data: {"content": "clusters."}\n\n'
        yield "data: [DONE]\n\n"

    def session_chat_stream(self, *args, **kwargs):
        return self._answer()

    def suggest_optimization_stream(self, *args, **kwargs):
        return self._answer()


@pytest.fixture
def quiet_model(monkeypatch):
    async def build(*args, **kwargs):
        return _QuietModel()

    async def owned(*args, **kwargs):
        return None

    monkeypatch.setattr(api_module, "_build_ai_service", build)
    monkeypatch.setattr(api_module, "_authorize_session_access", owned)
    monkeypatch.setattr(sse_keepalive, "KEEPALIVE_SECONDS", 0.05)
    app.dependency_overrides[require_auth] = lambda: None
    yield
    app.dependency_overrides.pop(require_auth, None)


def _call(route: str):
    client = TestClient(app)
    headers = {"Authorization": "Bearer tok"}
    if route == "chat":
        return client.post("/api/v1/ai/sessions/s1/chat", json={"message": "how many?"}, headers=headers)
    if route == "floating":
        return client.post("/api/v1/ai/sessions/s1/floating-chat", json={"message": "how many?"}, headers=headers)
    return client.get("/api/v1/ai/suggest-optimization/stream?namespace=web", headers=headers)


@pytest.mark.parametrize("route", ["chat", "floating", "optimization"])
def test_a_quiet_answer_says_it_is_alive_between_its_parts(quiet_model, route):
    r = _call(route)
    assert r.status_code == 200
    body = r.text
    first, second = body.index("Two "), body.index("clusters.")
    between = body[first:second]
    assert between.count(KEEPALIVE) >= 3, f"keepalive comments while the model was quiet: {between!r}"
    # The answer's own events are what the generator sent, in order, and nothing else.
    events = [e for e in body.split("\n\n") if e and not e.startswith(":")]
    assert events == ['data: {"content": "Two "}', 'data: {"content": "clusters."}', "data: [DONE]"]
    assert KEEPALIVE not in body[body.index("[DONE]"):]


async def test_a_flowing_answer_has_no_keepalive():
    async def answer():
        for i in range(20):
            yield f"data: {i}\n\n"
            await asyncio.sleep(0.01)

    got = [chunk async for chunk in sse_keepalive.with_keepalive(answer(), period=0.1)]
    assert got == [f"data: {i}\n\n" for i in range(20)]


async def test_an_answer_goes_on_only_when_the_client_asks_for_the_next_part():
    steps = []

    async def answer():
        for i in range(3):
            steps.append(i)
            yield f"data: {i}\n\n"

    stream = sse_keepalive.with_keepalive(answer(), period=1.0)
    assert await stream.__anext__() == "data: 0\n\n"
    await asyncio.sleep(0.1)
    assert steps == [0], "the answer ran ahead of the client"
    await stream.aclose()


async def test_an_answer_the_client_left_while_the_model_was_quiet_runs_its_own_cancellation():
    events = []

    async def answer():
        try:
            yield "data: a\n\n"
            await asyncio.sleep(10)
            yield "data: b\n\n"
        except (asyncio.CancelledError, GeneratorExit) as e:
            events.append(type(e).__name__)
            raise

    stream = sse_keepalive.with_keepalive(answer(), period=0.05)
    assert await stream.__anext__() == "data: a\n\n"
    try:
        second = await asyncio.wait_for(stream.__anext__(), 2)
    except asyncio.TimeoutError:
        second = None
    assert second == KEEPALIVE
    await stream.aclose()
    for _ in range(50):
        if events:
            break
        await asyncio.sleep(0.01)
    assert events == ["CancelledError"]


async def test_an_answer_the_client_left_between_parts_is_closed():
    events = []

    async def answer():
        try:
            yield "data: a\n\n"
            yield "data: b\n\n"
        except (asyncio.CancelledError, GeneratorExit) as e:
            events.append(type(e).__name__)
            raise

    stream = sse_keepalive.with_keepalive(answer(), period=1.0)
    assert await stream.__anext__() == "data: a\n\n"
    await stream.aclose()
    for _ in range(50):
        if events:
            break
        await asyncio.sleep(0.01)
    assert events == ["GeneratorExit"]


async def test_an_answer_that_fails_fails_the_stream_with_its_error():
    async def answer():
        yield "data: a\n\n"
        raise RuntimeError("model gone")

    stream = sse_keepalive.with_keepalive(answer(), period=1.0)
    assert await stream.__anext__() == "data: a\n\n"
    with pytest.raises(RuntimeError, match="model gone"):
        await stream.__anext__()
