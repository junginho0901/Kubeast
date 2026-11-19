"""kubeast_ai_model_requests_total: each request ai-service sends a model provider, by outcome.

outcome is ``ok`` when the provider answered (the call returned; a stream that fails later is still ``ok``), else the
refusal kind model_errors.classify reads from the failure: credit, rate, auth, unavailable, address or other. A Claude
Code run that waited for its slot and never started (busy) sent nothing and is not counted. The OpenAI-compatible and
Anthropic clients are counted at ProviderAdapter's chat.completions.create, the Claude subscription at each Claude
Code run (claude_code._run). No provider, model, user or cluster label: the series are made at import, so an
install that never reached its model shows ok at 0 (KubeastAIModelUnreachable).
"""
from __future__ import annotations

from typing import Any

from prometheus_client import Counter

from app.metrics import SERVICE
from app.services.ai import model_errors

OK = "ok"
OUTCOMES = (OK, model_errors.CREDIT, model_errors.RATE, model_errors.AUTH, model_errors.UNAVAILABLE,
            model_errors.ADDRESS, model_errors.OTHER)

MODEL_REQUESTS = Counter(
    "kubeast_ai_model_requests_total",
    "Requests ai-service sent a model provider, by outcome: ok, or the refusal kind (credit, rate, auth, unavailable, "
    "address, other).",
    ["service", "outcome"],
)
for _outcome in OUTCOMES:
    MODEL_REQUESTS.labels(SERVICE, _outcome)


def answered() -> None:
    MODEL_REQUESTS.labels(SERVICE, OK).inc()


def failed(err: BaseException) -> None:
    kind = model_errors.classify(err).kind
    if kind == model_errors.BUSY:
        return
    MODEL_REQUESTS.labels(SERVICE, kind).inc()


class CountedCompletions:
    """chat.completions whose create counts each call: ok when it returns, the refusal kind when it raises."""

    def __init__(self, inner: Any):
        self._inner = inner

    async def create(self, **kwargs: Any):
        try:
            out = await self._inner.create(**kwargs)
        except Exception as e:
            failed(e)
            raise
        answered()
        return out

    def __getattr__(self, name):
        return getattr(self._inner, name)


class CountedChat:
    """A client's chat with its completions counted (CountedCompletions); the rest is the client's own."""

    def __init__(self, inner: Any):
        self._inner = inner
        self.completions = CountedCompletions(inner.completions)

    def __getattr__(self, name):
        return getattr(self._inner, name)
