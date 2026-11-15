"""OpenAI's GPT-6 Sol and Luna take function tools in Chat Completions only with reasoning_effort "none"
(developers.openai.com/api/docs/guides/latest-model): provider_adapter sends it with tools to OpenAI and Azure, leaves it
out for a model that refuses it, keeps one the options or the call set, and sends nothing new to other providers or
without tools. The connection test sends a tool, so a model that refuses tools fails it as it would fail the chat."""
import json

import httpx
import openai
import pytest

from app import api_public
from app.services import provider_adapter
from app.services.provider_adapter import ProviderAdapter

COMPLETION = {
    "id": "c1", "object": "chat.completion", "created": 0, "model": "m",
    "choices": [{"index": 0, "message": {"role": "assistant", "content": "ok"}, "finish_reason": "stop"}],
    "usage": {"prompt_tokens": 1, "completion_tokens": 1, "total_tokens": 2},
}
MSG = [{"role": "user", "content": "hi"}]
TOOLS = [{"type": "function", "function": {"name": "k8s_get_resources", "parameters": {"type": "object", "properties": {}}}}]
AZURE = "https://res.openai.azure.com/openai/v1/"


def bad_request(message, param=None, code=None):
    err = {"message": message, "type": "invalid_request_error", "param": param, "code": code}
    return httpx.Response(400, json={"error": err})


def luna(body):
    """GPT-6 Luna as its model page describes it: function tools in Chat Completions at "none" only, medium by default."""
    if body.get("tools") and body.get("reasoning_effort", "medium") != "none":
        return bad_request(f"Function tools with reasoning_effort are not supported for {body['model']} in "
                           "/v1/chat/completions. Please use /v1/responses or set reasoning_effort to 'none'.",
                           param="reasoning_effort")
    return None


def no_reasoning(body):
    """A model with no reasoning effort (gpt-4o-mini) refusing the parameter by name."""
    if "reasoning_effort" in body:
        return bad_request("Unsupported parameter: 'reasoning_effort' is not supported with this model.",
                           param="reasoning_effort", code="unsupported_parameter")
    return None


def no_none(body):
    """A reasoning model without the value "none" (gpt-5, the o-series)."""
    if body.get("reasoning_effort") == "none":
        return bad_request("Unsupported value: 'reasoning_effort' does not support 'none' with this model. Supported "
                           "values are: 'low', 'medium', and 'high'.", param="reasoning_effort", code="unsupported_value")
    return None


def azure_unknown(body):
    """Azure's answer to a parameter its deployment does not take: the name in the message, no param field."""
    if "reasoning_effort" in body:
        return bad_request("Unrecognized request argument supplied: reasoning_effort")
    return None


def no_tools(body):
    if body.get("tools"):
        return bad_request(f"{body['model']} does not support tools", param="tools")
    return None


def serve(monkeypatch, refuse=lambda body: None):
    """The adapter's httpx client against a fake endpoint; returns the request bodies it got."""
    bodies = []

    def handler(request):
        body = json.loads(request.content)
        bodies.append(body)
        return refuse(body) or httpx.Response(200, json=COMPLETION)

    class Fake(httpx.AsyncClient):
        def __init__(self, **_kw):
            super().__init__(transport=httpx.MockTransport(handler))

    monkeypatch.setattr(httpx, "AsyncClient", Fake)
    provider_adapter._refused.clear()
    return bodies


@pytest.mark.asyncio
@pytest.mark.parametrize("provider,base", [("openai", None), ("azure", AZURE)])
async def test_a_tool_call_asks_for_no_reasoning_and_a_call_without_tools_is_as_it_was(monkeypatch, provider, base):
    bodies = serve(monkeypatch, luna)
    adapter = ProviderAdapter(provider=provider, model="gpt-6-luna", api_key="k", base_url=base)
    resp = await adapter.chat.completions.create(model="gpt-6-luna", messages=MSG, tools=TOOLS, tool_choice="auto",
                                                 temperature=0.7, max_tokens=4096)
    assert resp.choices[0].message.content == "ok"
    assert len(bodies) == 1 and bodies[0]["reasoning_effort"] == "none" and bodies[0]["temperature"] == 0.7
    await adapter.chat.completions.create(model="gpt-6-luna", messages=MSG, max_tokens=4096)
    await adapter.chat.completions.create(model="gpt-6-luna", messages=MSG, tools=[], max_tokens=4096)
    assert ["reasoning_effort" in b for b in bodies[1:]] == [False, False]


@pytest.mark.asyncio
@pytest.mark.parametrize("provider,base,refuse", [
    ("openai", None, no_reasoning), ("openai", None, no_none), ("azure", AZURE, azure_unknown)],
    ids=["no-reasoning-model", "no-none-value", "azure-unrecognized"])
async def test_a_model_that_refuses_it_gets_the_call_again_without_it_and_no_more(monkeypatch, provider, base, refuse):
    bodies = serve(monkeypatch, refuse)
    adapter = ProviderAdapter(provider=provider, model="m", api_key="k", base_url=base)
    resp = await adapter.chat.completions.create(model="m", messages=MSG, tools=TOOLS, max_tokens=4096)
    assert resp.choices[0].message.content == "ok"
    assert [b.get("reasoning_effort") for b in bodies] == ["none", None]
    assert bodies[1]["tools"] == TOOLS and bodies[1]["max_completion_tokens"] == 4096
    await adapter.chat.completions.create(model="m", messages=MSG, tools=TOOLS)
    assert len(bodies) == 3 and "reasoning_effort" not in bodies[2]


@pytest.mark.asyncio
async def test_a_reasoning_effort_the_options_or_the_call_set_is_sent_as_given(monkeypatch):
    bodies = serve(monkeypatch)
    adapter = ProviderAdapter(provider="openai", model="gpt-6-luna", api_key="k", options={"reasoning_effort": "low"})
    await adapter.chat.completions.create(model="gpt-6-luna", messages=MSG, tools=TOOLS)
    plain = ProviderAdapter(provider="openai", model="gpt-6-luna", api_key="k")
    await plain.chat.completions.create(model="gpt-6-luna", messages=MSG, tools=TOOLS, reasoning_effort="high")
    assert [b["reasoning_effort"] for b in bodies] == ["low", "high"]


@pytest.mark.asyncio
async def test_a_refusal_of_the_options_own_value_is_not_hidden(monkeypatch):
    bodies = serve(monkeypatch, luna)
    adapter = ProviderAdapter(provider="openai", model="gpt-6-luna", api_key="k", options={"reasoning_effort": "medium"})
    with pytest.raises(openai.BadRequestError, match="Function tools with reasoning_effort"):
        await adapter.chat.completions.create(model="gpt-6-luna", messages=MSG, tools=TOOLS)
    assert len(bodies) == 1 and bodies[0]["reasoning_effort"] == "medium"


@pytest.mark.asyncio
@pytest.mark.parametrize("provider,base", [
    ("custom", "https://llm.internal/v1"), ("groq", "https://api.groq.com/openai/v1"), ("ollama", "http://ollama:11434/v1")])
async def test_other_providers_get_no_reasoning_effort(monkeypatch, provider, base):
    bodies = serve(monkeypatch)
    adapter = ProviderAdapter(provider=provider, model="m", api_key="k", base_url=base)
    await adapter.chat.completions.create(model="m", messages=MSG, tools=TOOLS, max_tokens=4096)
    assert "reasoning_effort" not in bodies[0] and bodies[0]["max_tokens"] == 4096


@pytest.mark.asyncio
async def test_the_connection_test_sends_a_tool_and_passes_a_model_that_takes_it_as_the_chat_sends_it(monkeypatch):
    bodies = serve(monkeypatch, luna)
    out = await api_public._test_model_connection({"provider": "openai", "model": "gpt-6-luna", "api_key": "sk-test-1"})
    assert out["success"] is True and len(bodies) == 1
    body = bodies[0]
    assert [t["function"]["name"] for t in body["tools"]] == ["noop"] and "tool_choice" not in body
    assert body["reasoning_effort"] == "none" and body["max_completion_tokens"] == 5


@pytest.mark.asyncio
@pytest.mark.parametrize("request_body", [
    {"provider": "openai", "model": "m", "api_key": "sk-test-1"},
    {"provider": "groq", "model": "m", "api_key": "sk-test-1"},
    {"provider": "azure", "model": "m", "base_url": AZURE, "api_key_env": "KUBEAST_AI_KEY_AZURE"},
], ids=["openai", "openai-compatible", "azure"])
async def test_a_model_that_refuses_tools_fails_the_connection_test_with_the_providers_message(monkeypatch, request_body):
    monkeypatch.setenv("KUBEAST_AI_KEY_AZURE", "sk-test-1")
    monkeypatch.setattr(api_public, "_validate_base_url", lambda url: None)
    bodies = serve(monkeypatch, no_tools)
    out = await api_public._test_model_connection(request_body)
    assert out == {"success": False, "message": "HTTP 400: m does not support tools"}
    assert bodies and all(b["tools"] for b in bodies)
