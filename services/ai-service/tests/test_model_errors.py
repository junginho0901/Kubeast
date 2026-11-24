"""model_errors.classify on the refusals the providers document (Claude API errors, OpenAI error codes,
Gemini API errors, the Claude Agent SDK's AssistantMessage.error and RateLimitEvent)."""
from datetime import datetime, timezone

import httpx
import openai
import pytest

from app.services.ai.model_errors import AUTH, CREDIT, OTHER, RATE, UNAVAILABLE, classify, refused_form
from app.services.anthropic_messages import AnthropicAPIError
from app.services.claude_code import ClaudeCodeError

REQ = httpx.Request("POST", "https://api.example.com/v1/chat/completions")


def oa(cls, status: int, body: dict):
    """An OpenAI SDK status error as the SDK raises it (body = the inner error object)."""
    return cls(body.get("message", ""), response=httpx.Response(status, request=REQ), body=body)


@pytest.mark.parametrize("message", [
    "litellm.UnsupportedParamsError: Bedrock doesn't support tool calling without `tools=` param specified. Pass `tools=` param "
    "OR set `litellm.modify_params = True`",
    "Requests which include `tool_use` or `tool_result` blocks must define tools",
    "Unsupported parameter: 'stream_options'", "unknown parameter", "",
])
@pytest.mark.parametrize("cls,status", [(openai.BadRequestError, 400), (openai.UnprocessableEntityError, 422)])
def test_a_request_refused_for_what_it_holds(cls, status, message):
    assert refused_form(oa(cls, status, {"message": message, "code": "400"}))


@pytest.mark.parametrize("message,code", [
    ("This model's maximum context length is 128000 tokens. However, your messages resulted in 140000 tokens.", "context_length_exceeded"),
    ("Request refused", "context_length_exceeded"),
    ("Input tokens exceed the configured limit of 272000 tokens. Please reduce the length of the messages.", None),
    ("Invalid 'messages[3].content': string too long.", "string_above_max_length"),
    ("prompt is too long: 210000 tokens > 200000 maximum", None),
    ("input length and `max_tokens` exceed context limit: 199000 + 4096 > 200000", None),
    ("The input token count (1200000) exceeds the maximum number of tokens allowed (1048576).", "INVALID_ARGUMENT"),
    ("The decoder prompt (length 9000) is longer than the maximum model length of 8192.", None),
    ("the request exceeds the available context size, try increasing it", "exceed_context_size_error"),
    ("litellm.ContextWindowExceededError: Input is too long for requested model.", None),
    ("Prompt contains 140000 tokens and 0 draft tokens, too large for model with 131072 maximum context length", None),
    ("`inputs` tokens + `max_new_tokens` must be <= 8192. Given: 9000 `inputs` tokens", None),
])
def test_a_request_refused_for_its_size_is_not_about_what_it_holds(message, code):
    assert not refused_form(oa(openai.BadRequestError, 400, {"message": message, "code": code}))


def test_other_refusals_are_not_about_what_the_request_holds():
    for err in (oa(openai.AuthenticationError, 401, {"message": "Incorrect API key provided"}),
                oa(openai.PermissionDeniedError, 403, {"message": "no"}), oa(openai.NotFoundError, 404, {"message": "no such model"}),
                oa(openai.APIStatusError, 413, {"message": "no"}), oa(openai.RateLimitError, 429, {"message": "slow down"}),
                oa(openai.InternalServerError, 500, {"message": "no"}), openai.APITimeoutError(request=REQ),
                oa(openai.BadRequestError, 400, {"message": "Your credit balance is too low to access the API"}),
                oa(openai.BadRequestError, 400, {"message": "no", "code": "invalid_api_key"}), RuntimeError("400 unknown parameter")):
        assert not refused_form(err), err


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
