"""kubeast_ai_model_requests_total and kubeast_ai_investigations_total (docs/metrics.md, the chart's
KubeastAIModelUnreachable and KubeastAIInvestigationsFailing)."""
from types import SimpleNamespace

import httpx
import pytest

from app.services import provider_adapter
from app.services.ai import model_errors, model_requests
from app.services.investigation import outcomes, runner
from app.services.provider_adapter import ProviderAdapter

MSG = [{"role": "user", "content": "hi"}]
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

    class Fake(httpx.AsyncClient):
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
    model_requests.failed(SimpleNamespace(busy=True))
    model_requests.failed(TimeoutError("timed out"))
    after = requests_by_outcome()
    assert after["unavailable"] == before["unavailable"] + 1
    assert sum(after.values()) == sum(before.values()) + 1
    assert model_errors.classify(SimpleNamespace(busy=True)).kind == model_errors.BUSY


def investigations():
    return {o: sample("kubeast_ai_investigations_total", outcome=o) for o in ("done", "failed", "skipped")}


@pytest.mark.asyncio
@pytest.mark.parametrize("fails,want", [(False, "done"), (True, "failed")])
async def test_a_run_counts_its_end(monkeypatch, fails, want):
    async def investigate(cfg, row, progress=None):
        if fails:
            raise runner.InvestigationError("no tools answered")
        return {"report": "r"}

    async def nothing(*_a, **_kw):
        return None

    monkeypatch.setattr(runner, "investigate", investigate)
    monkeypatch.setattr(runner.store, "finish", nothing)
    monkeypatch.setattr(runner, "link_for", nothing)
    monkeypatch.setattr(runner, "write_audit", nothing)
    before = investigations()
    row = SimpleNamespace(id="i1", fingerprint="f", namespace="", cluster="c", alertname="A", severity="warning")
    assert await runner.run_one(SimpleNamespace(timeout_seconds=60), None, row) == want
    after = investigations()
    assert after[want] == before[want] + 1 and sum(after.values()) == sum(before.values()) + 1


@pytest.mark.asyncio
async def test_rows_failed_as_stale_or_stopped_twice_count_failed_and_a_requeue_nothing(monkeypatch):
    async def stale(db, before):
        return 2

    answers = iter(["failed", "queued", ""])

    async def requeue(db, inv_id):
        return next(answers)

    monkeypatch.setattr(runner.store, "fail_stale_running", stale)
    monkeypatch.setattr(runner.store, "requeue_or_fail", requeue)
    before = investigations()
    assert await runner.fail_stale(SimpleNamespace(timeout_seconds=60), None) == 2
    for _ in range(3):
        await runner.requeue_on_stop(None, "i1")
    after = investigations()
    assert after["failed"] == before["failed"] + 3 and after["done"] == before["done"] and after["skipped"] == before["skipped"]


def test_ended_counts_only_the_three_outcomes():
    before = investigations()
    outcomes.ended(outcomes.SKIPPED)
    outcomes.ended("queued")
    outcomes.ended(outcomes.FAILED, 0)
    after = investigations()
    assert after["skipped"] == before["skipped"] + 1 and sum(after.values()) == sum(before.values()) + 1
