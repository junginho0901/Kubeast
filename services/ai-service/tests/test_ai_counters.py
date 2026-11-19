"""kubeast_ai_model_requests_total and kubeast_ai_investigations_total (docs/metrics.md, the chart's
KubeastAIModelUnreachable and KubeastAIInvestigationsFailing)."""
from types import SimpleNamespace

import httpx
import pytest

from app.services import claude_code, provider_adapter
from app.services.ai import model_errors, model_requests
from app.services.investigation import outcomes, store
from app.services.provider_adapter import ProviderAdapter

MSG = [{"role": "user", "content": "hi"}]
# The client before any test replaced it: a second serve() in one test must not build on the first one's Fake.
_REAL_CLIENT = httpx.AsyncClient
COMPLETION = {"id": "c", "object": "chat.completion", "created": 0, "model": "m",
              "choices": [{"index": 0, "message": {"role": "assistant", "content": "ok"}, "finish_reason": "stop"}]}


def sample(name, **labels):
    from prometheus_client import REGISTRY

    return REGISTRY.get_sample_value(name, {"service": "ai", **labels}) or 0.0


def requests_by_outcome():
    return {o: sample("kubeast_ai_model_requests_total", outcome=o) for o in model_requests.OUTCOMES}


def serve(monkeypatch, status=200, body=None):
    """The adapter's httpx client against a fake endpoint answering status with body."""
    def handler(request):
        return httpx.Response(status, json=body if body is not None else COMPLETION)

    class Fake(_REAL_CLIENT):
        def __init__(self, **_kw):
            super().__init__(transport=httpx.MockTransport(handler))

    monkeypatch.setattr(httpx, "AsyncClient", Fake)
    provider_adapter._refused.clear()
    provider_adapter._without_reasoning.clear()


def test_every_outcome_is_there_at_zero_from_the_start():
    for outcome in model_requests.OUTCOMES:
        assert sample("kubeast_ai_model_requests_total", outcome=outcome) is not None
    assert "busy" not in model_requests.OUTCOMES
    for outcome in ("done", "failed", "skipped"):
        from prometheus_client import REGISTRY

        assert REGISTRY.get_sample_value("kubeast_ai_investigations_total", {"service": "ai", "outcome": outcome}) is not None


@pytest.mark.asyncio
async def test_an_answered_call_counts_ok_and_a_refused_key_counts_auth(monkeypatch):
    before = requests_by_outcome()
    serve(monkeypatch)
    adapter = ProviderAdapter(provider="openai", model="m", api_key="k")
    await adapter.chat.completions.create(model="m", messages=MSG)
    serve(monkeypatch, 401, {"error": {"message": "Incorrect API key provided", "type": "invalid_request_error", "code": "invalid_api_key"}})
    adapter = ProviderAdapter(provider="openai", model="m", api_key="k")
    with pytest.raises(Exception):
        await adapter.chat.completions.create(model="m", messages=MSG)
    after = requests_by_outcome()
    assert after["ok"] == before["ok"] + 1 and after["auth"] == before["auth"] + 1
    assert sum(after.values()) == sum(before.values()) + 2


def test_a_busy_claude_code_run_sends_nothing_and_counts_nothing():
    before = requests_by_outcome()
    busy = claude_code.ClaudeCodeBusy()
    assert model_errors.classify(busy).kind == model_errors.BUSY
    model_requests.failed(busy)
    model_requests.failed(TimeoutError("timed out"))
    after = requests_by_outcome()
    assert after["unavailable"] == before["unavailable"] + 1
    assert sum(after.values()) == sum(before.values()) + 1


def investigations():
    return {o: sample("kubeast_ai_investigations_total", outcome=o) for o in ("done", "failed", "skipped")}


class FakeSession:
    """db.async_session(): each execute answers the next rowcount."""

    def __init__(self, rowcounts):
        self.rowcounts = list(rowcounts)

    async def __aenter__(self):
        return self

    async def __aexit__(self, *_exc):
        return False

    async def execute(self, _stmt):
        return SimpleNamespace(rowcount=self.rowcounts.pop(0) if self.rowcounts else 1)

    async def commit(self):
        pass


def fake_db(*rowcounts):
    return SimpleNamespace(async_session=lambda: FakeSession(rowcounts))


@pytest.mark.asyncio
@pytest.mark.parametrize("status", ["done", "failed"])
async def test_a_runs_end_stored_counts_its_status(status):
    before = investigations()
    await store.finish(fake_db(), "i1", status=status, error="")
    after = investigations()
    assert after[status] == before[status] + 1 and sum(after.values()) == sum(before.values()) + 1


@pytest.mark.asyncio
async def test_an_end_the_store_refused_counts_nothing():
    class Refusing(FakeSession):
        async def execute(self, _stmt):
            raise RuntimeError("invalid byte sequence")

    before = investigations()
    with pytest.raises(RuntimeError):
        await store.finish(SimpleNamespace(async_session=lambda: Refusing([])), "i1", status="done", error="")
    assert investigations() == before


@pytest.mark.asyncio
async def test_skipped_stale_and_stopped_twice_rows_count_and_a_requeue_does_not():
    before = investigations()
    await store.skip(fake_db(), "i1", "the hourly cap")
    assert await store.fail_stale_running(fake_db(2), store.utcnow()) == 2
    assert await store.requeue_or_fail(fake_db(0, 1), "i2") == "failed"  # went back once already: failed
    assert await store.requeue_or_fail(fake_db(1), "i3") == "queued"
    assert await store.requeue_or_fail(fake_db(0, 0), "i4") == ""  # ended meanwhile
    after = investigations()
    assert after["skipped"] == before["skipped"] + 1
    assert after["failed"] == before["failed"] + 3 and after["done"] == before["done"]


def test_ended_counts_only_the_three_outcomes():
    before = investigations()
    outcomes.ended(outcomes.SKIPPED)
    outcomes.ended("queued")
    outcomes.ended(outcomes.FAILED, 0)
    after = investigations()
    assert after["skipped"] == before["skipped"] + 1 and sum(after.values()) == sum(before.values()) + 1
