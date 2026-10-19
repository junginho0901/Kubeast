"""model_errors.classify on the refusals the providers document (Claude API errors, OpenAI error codes,
Gemini API errors, the Claude Agent SDK's AssistantMessage.error and RateLimitEvent)."""
from datetime import datetime, timezone

import httpx
import openai

from app.services.ai.model_errors import AUTH, CREDIT, OTHER, RATE, UNAVAILABLE, classify
from app.services.anthropic_messages import AnthropicAPIError
from app.services.claude_code import ClaudeCodeError

REQ = httpx.Request("POST", "https://api.example.com/v1/chat/completions")


def oa(cls, status: int, body: dict):
    """An OpenAI SDK status error as the SDK raises it (body = the inner error object)."""
    return cls(body.get("message", ""), response=httpx.Response(status, request=REQ), body=body)


def test_openai_compatible_answers():
    quota = oa(openai.RateLimitError, 429, {"message": "You exceeded your current quota, please check your plan and billing details.",
                                            "type": "insufficient_quota", "code": "insufficient_quota"})
    assert classify(quota).kind == CREDIT
    # the code alone tells (a gateway that rewrites the message)
    assert classify(oa(openai.RateLimitError, 429, {"message": "Request failed", "code": "insufficient_quota"})).kind == CREDIT
    rate = oa(openai.RateLimitError, 429, {"message": "Rate limit reached for requests", "type": "requests", "code": "rate_limit_exceeded"})
    assert classify(rate).kind == RATE
    assert classify(oa(openai.RateLimitError, 429, {"message": "Your request rate increased too quickly", "code": "slow_down"})).kind == RATE
    assert classify(oa(openai.AuthenticationError, 401, {"message": "Incorrect API key provided: sk-...", "code": "invalid_api_key"})).kind == AUTH
    assert classify(oa(openai.PermissionDeniedError, 403, {"message": "Country, region, or territory not supported"})).kind == AUTH
    assert classify(oa(openai.InternalServerError, 503, {"message": "Model temporarily overloaded", "code": "server_is_overloaded"})).kind == UNAVAILABLE
    assert classify(openai.APITimeoutError(request=REQ)).kind == UNAVAILABLE
    assert classify(openai.APIConnectionError(request=REQ)).kind == UNAVAILABLE
    # Gemini through its OpenAI-compatible endpoint
    assert classify(oa(openai.APIStatusError, 402, {"message": "Your Prepay credit balance is depleted.", "status": "PAYMENT_REQUIRED"})).kind == CREDIT
    assert classify(oa(openai.RateLimitError, 429, {"message": "You have exceeded your daily quota.", "status": "RESOURCE_EXHAUSTED"})).kind == RATE
    assert classify(oa(openai.BadRequestError, 400, {"message": "FAILED_PRECONDITION: billing is not enabled for this project"})).kind == CREDIT
    assert classify(oa(openai.BadRequestError, 400, {"message": "Unsupported parameter: 'max_tokens'"})).kind == OTHER
    assert classify(oa(openai.NotFoundError, 404, {"message": "The model `gpt-9` does not exist", "code": "model_not_found"})).kind == OTHER


def test_anthropic_answers():
    assert classify(AnthropicAPIError(402, "billing_error", "There's an issue with your billing")).kind == CREDIT
    assert classify(AnthropicAPIError(400, "invalid_request_error", "Your credit balance is too low to access the Anthropic API.")).kind == CREDIT
    assert classify(AnthropicAPIError(400, "invalid_request_error", "You have reached your specified workspace API usage limits (spend limit).")).kind == CREDIT
    assert classify(AnthropicAPIError(429, "rate_limit_error", "Number of request tokens has exceeded your per-minute rate limit")).kind == RATE
    assert classify(AnthropicAPIError(429, "rate_limit_error", "You have reached your monthly spend cap")).kind == CREDIT
    assert classify(AnthropicAPIError(401, "authentication_error", "invalid x-api-key")).kind == AUTH
    assert classify(AnthropicAPIError(403, "permission_error", "Your API key does not have permission")).kind == AUTH
    for status, kind in ((500, "api_error"), (504, "timeout_error"), (529, "overloaded_error")):
        assert classify(AnthropicAPIError(status, kind, "x")).kind == UNAVAILABLE
    assert classify(AnthropicAPIError(None, "connection_error", "ConnectError")).kind == UNAVAILABLE
    assert classify(AnthropicAPIError(400, "invalid_request_error", "tool_choice: type \"any\" is not supported")).kind == OTHER


def test_subscription_answers():
    assert classify(ClaudeCodeError("Claude Code: billing", subscription_error="billing_error")).kind == CREDIT
    assert classify(ClaudeCodeError("Claude Code: token", subscription_error="authentication_failed")).kind == AUTH
    assert classify(ClaudeCodeError("Claude Code: busy", subscription_error="server_error")).kind == UNAVAILABLE
    window = classify(ClaudeCodeError("Claude Code (HTTP 429): limit", subscription_error="rate_limit", resets_at=1792407600))
    assert window.kind == RATE and window.retry_at == datetime(2026, 10, 19, 11, 0, tzinfo=timezone.utc) and window.blocks
    assert window.key == "modelUsageWindow"
    text_only = classify(ClaudeCodeError("Claude Code failed: Claude AI usage limit reached|1792407600"))
    assert text_only.kind == RATE and text_only.retry_at is not None
    # a plain rate limit passes by itself: no pause; credit and the key do not
    assert not classify(ClaudeCodeError("x", subscription_error="rate_limit")).blocks
    assert classify(ClaudeCodeError("x", subscription_error="billing_error")).blocks
    assert classify(ClaudeCodeError("x", subscription_error="authentication_failed")).blocks
    assert classify(ClaudeCodeError("Claude Code failed: exit 2")).kind == OTHER


def test_wrapped_errors_without_a_status():
    assert classify(RuntimeError("Error code: 401 - Incorrect API key provided")).kind == AUTH
    assert classify(RuntimeError("Error code: 429 - Rate limit reached")).kind == RATE
    assert classify(RuntimeError("upstream 503 Service Unavailable")).kind == UNAVAILABLE
    assert classify(TimeoutError()).kind == UNAVAILABLE
    assert classify(ValueError("no choices in the answer")).kind == OTHER


async def test_the_anthropic_adapter_raises_what_classify_reads(monkeypatch):
    """The Claude API's documented answers through the real adapter (the e2e stand-in needs no key, this provider does)."""
    import pytest

    from app.services import anthropic_messages as am

    async def no_sleep(*_a):
        return None

    monkeypatch.setattr(am.asyncio, "sleep", no_sleep)
    for status, body, kind in (
        (402, {"type": "error", "error": {"type": "billing_error", "message": "There's an issue with your billing or payment information."}}, CREDIT),
        (400, {"type": "error", "error": {"type": "invalid_request_error", "message": "Your credit balance is too low to access the Anthropic API."}}, CREDIT),
        (401, {"type": "error", "error": {"type": "authentication_error", "message": "invalid x-api-key"}}, AUTH),
        (429, {"type": "error", "error": {"type": "rate_limit_error", "message": "Number of requests has exceeded your per-minute rate limit"}}, RATE),
        (529, {"type": "error", "error": {"type": "overloaded_error", "message": "Overloaded"}}, UNAVAILABLE),
    ):
        http = httpx.AsyncClient(transport=httpx.MockTransport(lambda request, s=status, b=body: httpx.Response(s, json=b)))
        client = am.AnthropicMessagesClient(model="claude-haiku-5-5", api_key="sk-ant-test", http_client=http)
        with pytest.raises(am.AnthropicAPIError) as err:
            await client.chat.completions.create(messages=[{"role": "user", "content": "hi"}])
        assert classify(err.value).kind == kind, (status, err.value)
