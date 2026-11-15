"""OpenAI's GPT-6 Sol and Luna take function tools in Chat Completions only with reasoning_effort "none"
(developers.openai.com/api/docs/guides/latest-model): provider_adapter sends it on every call to OpenAI and Azure for
those names, and to any endpoint whose 400 said tools need it (another deployment name, a gateway's alias), leaves it
out when the endpoint refuses it, keeps one the options or the call set, and sends nothing new to other models. The
connection test sends a tool and the config's options, so a model passes it only as it chats."""
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
    """GPT-6 Luna as OpenAI describes it: function tools in Chat Completions at "none" only, medium by default, and
    no temperature at an effort other than "none"."""
    effort = body.get("reasoning_effort", "medium")
    if body.get("tools") and effort != "none":
        return bad_request(f"Function tools with reasoning_effort are not supported for {body['model']} in "
                           "/v1/chat/completions. Please use /v1/responses or set reasoning_effort to 'none'.",
                           param="reasoning_effort")
    if "temperature" in body and effort != "none":
        return bad_request("Unsupported value: 'temperature' does not support 0.7 with this model. Only the default (1) "
                           "value is supported.", param="temperature", code="unsupported_value")
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
    provider_adapter._without_reasoning.clear()
    return bodies


@pytest.mark.asyncio
@pytest.mark.parametrize("provider,base,model", [
    ("openai", None, "gpt-6-luna"), ("openai", None, "gpt-6-sol"), ("openai", None, "gpt-6-luna-2027-03-01"),
    ("azure", AZURE, "gpt-6-luna")])
async def test_every_gpt6_sol_or_luna_call_asks_for_no_reasoning_and_keeps_its_temperature(
        monkeypatch, provider, base, model):
    bodies = serve(monkeypatch, luna)
    adapter = ProviderAdapter(provider=provider, model=model, api_key="k", base_url=base)
    # a history summary first (no tools, a short length), then a chat turn with tools
    resp = await adapter.chat.completions.create(model=model, messages=MSG, temperature=0.3, max_tokens=250)
    assert resp.choices[0].message.content == "ok"
    await adapter.chat.completions.create(model=model, messages=MSG, tools=TOOLS, tool_choice="auto",
                                          temperature=0.7, max_tokens=4096)
    await adapter.chat.completions.create(model=model, messages=MSG, tools=[], max_tokens=4096)
    assert len(bodies) == 3
    assert [b["reasoning_effort"] for b in bodies] == ["none", "none", "none"]
    assert [b.get("temperature") for b in bodies] == [0.3, 0.7, None]
    assert bodies[0]["max_completion_tokens"] == 250


@pytest.mark.asyncio
@pytest.mark.parametrize("provider,base,model", [
    ("openai", None, "gpt-4o-mini"), ("openai", None, "gpt-5.5"), ("openai", None, "gpt-6.1-sol"),
    ("openai", None, "gpt-6-astra"), ("openai", None, "gpt-6-lunar"), ("azure", AZURE, "my-deployment")])
async def test_other_models_calls_are_sent_as_before_in_one_request(monkeypatch, provider, base, model):
    bodies = serve(monkeypatch, no_reasoning)
    adapter = ProviderAdapter(provider=provider, model=model, api_key="k", base_url=base)
    await adapter.chat.completions.create(model=model, messages=MSG, tools=TOOLS, max_tokens=4096)
    await adapter.chat.completions.create(model=model, messages=MSG, temperature=0.3, max_tokens=250)
    assert len(bodies) == 2 and not any("reasoning_effort" in b for b in bodies)
    assert bodies[0]["tools"] == TOOLS and bodies[1]["temperature"] == 0.3


@pytest.mark.asyncio
@pytest.mark.parametrize("provider,base,model", [
    ("azure", AZURE, "prod-chat"), ("custom", "https://gw.internal/v1", "gpt-6-luna"),
    ("openai", "https://litellm.internal/v1", "team-default")],
    ids=["azure-deployment-name", "custom-gateway", "gateway-alias"])
async def test_a_tools_refusal_at_the_default_effort_gets_the_call_again_at_none_and_none_after(
        monkeypatch, provider, base, model):
    bodies = serve(monkeypatch, luna)
    adapter = ProviderAdapter(provider=provider, model=model, api_key="k", base_url=base)
    resp = await adapter.chat.completions.create(model=model, messages=MSG, tools=TOOLS, temperature=0.7)
    assert resp.choices[0].message.content == "ok"
    assert [b.get("reasoning_effort") for b in bodies] == [None, "none"]
    # remembered for this endpoint and model: the next calls, a summary too, go at "none" in one request
    await adapter.chat.completions.create(model=model, messages=MSG, tools=TOOLS, temperature=0.7)
    await adapter.chat.completions.create(model=model, messages=MSG, temperature=0.3)
    assert len(bodies) == 4 and [b["reasoning_effort"] for b in bodies[2:]] == ["none", "none"]
    assert bodies[3]["temperature"] == 0.3
    other = ProviderAdapter(provider=provider, model="another", api_key="k", base_url=base)
    await other.chat.completions.create(model="another", messages=MSG, temperature=0.3)
    assert "reasoning_effort" not in bodies[4]


@pytest.mark.asyncio
async def test_another_refusal_of_tools_is_not_sent_again_at_none(monkeypatch):
    bodies = serve(monkeypatch, no_tools)
    adapter = ProviderAdapter(provider="azure", model="prod-chat", api_key="k", base_url=AZURE)
    with pytest.raises(openai.BadRequestError, match="does not support tools"):
        await adapter.chat.completions.create(model="prod-chat", messages=MSG, tools=TOOLS)
    assert len(bodies) == 1 and "reasoning_effort" not in bodies[0]


@pytest.mark.asyncio
@pytest.mark.parametrize("provider,base,refuse", [
    ("openai", None, no_reasoning), ("openai", None, no_none), ("azure", AZURE, azure_unknown)],
    ids=["parameter-refused", "value-refused", "azure-unrecognized"])
async def test_a_refusal_of_it_gets_the_call_again_without_it_once_and_no_more(monkeypatch, provider, base, refuse):
    # a deployment or a gateway behind the name that does not take it
    bodies = serve(monkeypatch, refuse)
    adapter = ProviderAdapter(provider=provider, model="gpt-6-luna", api_key="k", base_url=base)
    resp = await adapter.chat.completions.create(model="gpt-6-luna", messages=MSG, tools=TOOLS, max_tokens=4096)
    assert resp.choices[0].message.content == "ok"
    assert [b.get("reasoning_effort") for b in bodies] == ["none", None]
    assert bodies[1]["tools"] == TOOLS and bodies[1]["max_completion_tokens"] == 4096
    await adapter.chat.completions.create(model="gpt-6-luna", messages=MSG, tools=TOOLS)
    assert len(bodies) == 3 and "reasoning_effort" not in bodies[2]


@pytest.mark.asyncio
async def test_a_reasoning_effort_the_options_or_the_call_set_is_sent_as_given(monkeypatch):
    bodies = serve(monkeypatch)
    adapter = ProviderAdapter(provider="openai", model="gpt-6-luna", api_key="k", options={"reasoning_effort": "low"})
    await adapter.chat.completions.create(model="gpt-6-luna", messages=MSG, tools=TOOLS)
    plain = ProviderAdapter(provider="openai", model="gpt-6-luna", api_key="k")
    await plain.chat.completions.create(model="gpt-6-luna", messages=MSG, tools=TOOLS, reasoning_effort="high")
    other = ProviderAdapter(provider="openai", model="gpt-5.5", api_key="k", options={"reasoning_effort": "none"})
    await other.chat.completions.create(model="gpt-5.5", messages=MSG, tools=TOOLS)
    assert [b["reasoning_effort"] for b in bodies] == ["low", "high", "none"]


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
async def test_the_connection_test_of_another_model_sends_the_tool_without_reasoning_effort(monkeypatch):
    bodies = serve(monkeypatch, no_reasoning)
    out = await api_public._test_model_connection({"provider": "openai", "model": "gpt-4o-mini", "api_key": "sk-test-1"})
    assert out["success"] is True and len(bodies) == 1
    assert [t["function"]["name"] for t in bodies[0]["tools"]] == ["noop"] and "reasoning_effort" not in bodies[0]


AZURE_TEST = {"provider": "azure", "model": "prod-chat", "base_url": AZURE, "api_key_env": "KUBEAST_AI_KEY_AZURE"}


@pytest.fixture
def azure_key(monkeypatch):
    monkeypatch.setenv("KUBEAST_AI_KEY_AZURE", "sk-test-1")
    monkeypatch.setattr(api_public, "_validate_base_url", lambda url: None)


@pytest.mark.asyncio
@pytest.mark.parametrize("request_body", [
    dict(AZURE_TEST, options={"reasoning_effort": "none", "temperature": 0.2, "max_tokens": 8000,
                              "tool_result_chars": 9000}),
    {"provider": "custom", "model": "gpt-6-luna", "base_url": "https://gw.internal/v1", "api_key": "sk-test-1",
     "options": {"reasoning_effort": "none", "temperature": 0.2}},
], ids=["azure", "custom"])
async def test_the_connection_test_sends_the_configs_options_as_the_chat_does(monkeypatch, azure_key, request_body):
    bodies = serve(monkeypatch, luna)
    out = await api_public._test_model_connection(request_body)
    assert out["success"] is True and len(bodies) == 1
    body = bodies[0]
    assert body["reasoning_effort"] == "none" and body["temperature"] == 0.2 and body["tools"]
    # the test's own length stays; the Kubeast limit never goes to the provider
    assert (body.get("max_completion_tokens") or body.get("max_tokens")) == 5 and "tool_result_chars" not in body


@pytest.mark.asyncio
async def test_a_deployment_of_another_name_passes_the_connection_test_as_it_chats(monkeypatch, azure_key):
    bodies = serve(monkeypatch, luna)
    out = await api_public._test_model_connection(dict(AZURE_TEST))
    assert out["success"] is True and [b.get("reasoning_effort") for b in bodies] == [None, "none"]


@pytest.mark.asyncio
@pytest.mark.parametrize("options", [["reasoning_effort"], "none", 3])
async def test_connection_test_options_that_are_no_object_are_refused(monkeypatch, azure_key, options):
    from fastapi import HTTPException

    bodies = serve(monkeypatch)
    with pytest.raises(HTTPException) as e:
        await api_public._test_model_connection(dict(AZURE_TEST, options=options))
    assert e.value.status_code == 400 and "options" in str(e.value.detail) and bodies == []


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
