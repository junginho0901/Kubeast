"""A model's own limits (options.max_tokens, options.tool_result_chars): read by the chat, the tool turn and the
investigations, checked on save, never sent to a provider as such; OpenAI's max_completion_tokens and the parameters
a reasoning model refuses (its 400 names them); and what each config is used for, by the server's own rules."""
import json
from types import SimpleNamespace

import httpx
import pytest
from pydantic import ValidationError

from app.models.model_config import ModelConfigCreate, ModelConfigUpdate
from app.services import model_config_service, provider_adapter
from app.services.ai import formatters, limits, tool_turn
from app.services.provider_adapter import ProviderAdapter

COMPLETION = {
    "id": "c1", "object": "chat.completion", "created": 0, "model": "m",
    "choices": [{"index": 0, "message": {"role": "assistant", "content": "ok"}, "finish_reason": "stop"}],
    "usage": {"prompt_tokens": 1, "completion_tokens": 1, "total_tokens": 2},
}
# OpenAI's answers to a reasoning model (o-series, GPT-5) sent max_tokens or a temperature
REFUSALS = {
    "max_tokens": {"message": "Unsupported parameter: 'max_tokens' is not supported with this model. Use 'max_completion_tokens' instead.",
                   "type": "invalid_request_error", "param": "max_tokens", "code": "unsupported_parameter"},
    "temperature": {"message": "Unsupported value: 'temperature' does not support 0.7 with this model. Only the default (1) value is supported.",
                    "type": "invalid_request_error", "param": "temperature", "code": "unsupported_value"},
}


def serve(monkeypatch, refuses=(), param_field=True):
    """The adapter's httpx client against a fake OpenAI endpoint; returns the request bodies it got. A model named
    reasoning-* refuses the parameters in `refuses` with OpenAI's 400 (without the param field when param_field is False)."""
    bodies = []

    def handler(request):
        body = json.loads(request.content)
        bodies.append(body)
        if body["model"].startswith("reasoning"):
            for p in refuses:
                if p in body:
                    err = dict(REFUSALS[p])
                    if not param_field:
                        err.pop("param")
                    return httpx.Response(400, json={"error": err})
        return httpx.Response(200, json=COMPLETION)

    class Fake(httpx.AsyncClient):
        def __init__(self, **_kw):
            super().__init__(transport=httpx.MockTransport(handler))

    monkeypatch.setattr(provider_adapter.httpx, "AsyncClient", Fake)
    provider_adapter._refused.clear()
    return bodies


MSG = [{"role": "user", "content": "hi"}]


def test_limits_read_the_models_options_or_the_default():
    assert limits.answer_tokens(SimpleNamespace(options={}), 4096) == 4096
    assert limits.answer_tokens(SimpleNamespace(options={"max_tokens": 1234}), 4096) == 1234
    assert limits.answer_tokens(SimpleNamespace(), 2048) == 2048
    assert limits.tool_result_chars(SimpleNamespace(options={})) == 6000
    assert limits.tool_result_chars(SimpleNamespace(options={"tool_result_chars": 1500})) == 1500
    # a row written before the check: read as empty, not sent as a wrong number
    for bad in ("4096", 0, -1, True, 4096.5, 2_000_000):
        assert limits.answer_tokens(SimpleNamespace(options={"max_tokens": bad}), 4096) == 4096
    for bad in (999, 200_001, "6000", False):
        assert limits.tool_result_chars(SimpleNamespace(options={"tool_result_chars": bad})) == 6000


def test_limits_are_checked_on_save():
    base = dict(name="n", provider="openai", model="gpt-5.5")
    ModelConfigCreate(**base, options={"max_tokens": 32000, "tool_result_chars": 20000, "temperature": 0.2})
    ModelConfigCreate(**base, options=None)
    ModelConfigUpdate(options={"max_tokens": None})
    for options in ({"max_tokens": 0}, {"max_tokens": "4096"}, {"max_tokens": True}, {"max_tokens": 1_000_001},
                    {"tool_result_chars": 999}, {"tool_result_chars": 200_001}, {"tool_result_chars": 1.5}):
        with pytest.raises(ValidationError, match=next(iter(options))):
            ModelConfigCreate(**base, options=options)
        with pytest.raises(ValidationError):
            ModelConfigUpdate(options=options)


def test_truncation_takes_the_models_length():
    text = "x" * 9000
    assert formatters._truncate_tool_result_for_llm(text) == "x" * 6000 + "\n... (truncated for LLM) ..."
    assert formatters._truncate_tool_result_for_llm(text, 1500) == "x" * 1500 + "\n... (truncated for LLM) ..."
    assert formatters._truncate_tool_result_for_llm(text, 20000) == text


@pytest.mark.asyncio
async def test_kubeast_keys_never_reach_the_provider(monkeypatch):
    bodies = serve(monkeypatch)
    adapter = ProviderAdapter(provider="ollama", model="m", api_key="", base_url="http://ollama:11434/v1",
                              options={"tool_result_chars": 1500, "num_ctx": 8192, "max_tokens": 900})
    await adapter.chat.completions.create(model="m", messages=MSG)
    assert "tool_result_chars" not in bodies[0] and "tool_result_chars" not in json.dumps(bodies[0])
    assert bodies[0]["num_ctx"] == 8192 and bodies[0]["max_tokens"] == 900


@pytest.mark.asyncio
@pytest.mark.parametrize("provider,base", [("openai", None), ("azure", "https://res.openai.azure.com/openai/v1/")])
async def test_openai_and_azure_take_the_length_as_max_completion_tokens(monkeypatch, provider, base):
    bodies = serve(monkeypatch)
    adapter = ProviderAdapter(provider=provider, model="gpt-4o", api_key="k", base_url=base)
    await adapter.chat.completions.create(model="gpt-4o", messages=MSG, max_tokens=4096)
    assert bodies[0]["max_completion_tokens"] == 4096 and "max_tokens" not in bodies[0]


@pytest.mark.asyncio
async def test_other_openai_compatible_providers_keep_max_tokens(monkeypatch):
    bodies = serve(monkeypatch)
    adapter = ProviderAdapter(provider="custom", model="m", api_key="k", base_url="https://llm.internal/v1")
    await adapter.chat.completions.create(model="m", messages=MSG, max_tokens=4096)
    assert bodies[0]["max_tokens"] == 4096 and "max_completion_tokens" not in bodies[0]


@pytest.mark.asyncio
async def test_a_refused_parameter_is_left_out_and_remembered(monkeypatch):
    bodies = serve(monkeypatch, refuses=("temperature",))
    adapter = ProviderAdapter(provider="openai", model="reasoning-1", api_key="k")
    resp = await adapter.chat.completions.create(model="reasoning-1", messages=MSG, temperature=0.7, max_tokens=4096)
    assert resp.choices[0].message.content == "ok"
    assert [("temperature" in b) for b in bodies] == [True, False]
    assert bodies[1]["max_completion_tokens"] == 4096
    # the next call leaves it out at once; another model still gets it
    await adapter.chat.completions.create(model="reasoning-1", messages=MSG, temperature=0.2)
    await adapter.chat.completions.create(model="gpt-4o", messages=MSG, temperature=0.2)
    assert "temperature" not in bodies[2] and bodies[3]["temperature"] == 0.2


@pytest.mark.asyncio
async def test_a_gateway_that_refuses_max_tokens_gets_max_completion_tokens(monkeypatch):
    # an OpenAI-compatible gateway in front of a reasoning model, its message without the param field
    bodies = serve(monkeypatch, refuses=("max_tokens",), param_field=False)
    adapter = ProviderAdapter(provider="custom", model="reasoning-gw", api_key="k", base_url="https://gw.internal/v1")
    await adapter.chat.completions.create(model="reasoning-gw", messages=MSG, max_tokens=2048)
    assert len(bodies) == 2 and bodies[1]["max_completion_tokens"] == 2048 and "max_tokens" not in bodies[1]


@pytest.mark.asyncio
async def test_other_refusals_are_not_retried(monkeypatch):
    import openai

    bodies = []

    def handler(request):
        bodies.append(json.loads(request.content))
        return httpx.Response(400, json={"error": {"message": "Invalid 'messages'", "type": "invalid_request_error",
                                                  "param": "messages", "code": "invalid_value"}})

    class Fake(httpx.AsyncClient):
        def __init__(self, **_kw):
            super().__init__(transport=httpx.MockTransport(handler))

    monkeypatch.setattr(provider_adapter.httpx, "AsyncClient", Fake)
    adapter = ProviderAdapter(provider="openai", model="gpt-4o", api_key="k")
    with pytest.raises(openai.BadRequestError):
        await adapter.chat.completions.create(model="gpt-4o", messages=MSG, temperature=0.7)
    assert len(bodies) == 1


@pytest.mark.asyncio
async def test_the_openai_connection_test_passes_on_a_reasoning_model(monkeypatch):
    from app import api_public

    bodies = serve(monkeypatch, refuses=("max_tokens", "temperature"))
    monkeypatch.setattr(api_public.httpx, "AsyncClient", provider_adapter.httpx.AsyncClient)
    res = await api_public._test_openai_compatible("k", "reasoning-5", "https://api.openai.com/v1", True, provider="openai")
    assert res["success"] and bodies[-1]["max_completion_tokens"] == 5 and "max_tokens" not in bodies[-1]


@pytest.mark.asyncio
async def test_the_tool_turn_asks_for_the_models_answer_length():
    seen = []

    class Completions:
        async def create(self, **kw):
            seen.append(kw)
            msg = SimpleNamespace(content="done", tool_calls=None)
            return SimpleNamespace(choices=[SimpleNamespace(message=msg)], usage=None)

    for options, expected in (({}, 2048), ({"max_tokens": 777}, 777)):
        service = SimpleNamespace(provider="openai", model="m", options=options,
                                  client=SimpleNamespace(chat=SimpleNamespace(completions=Completions())))
        await tool_turn.run_tool_turn(service, list(MSG), [], None, max_steps=2, final_message="end",
                                      remaining=lambda: 60.0)
        assert seen[-1]["max_tokens"] == expected


class FakeDB:
    def __init__(self, configs):
        self.configs = configs

    async def get_active_model_config(self):
        on = [c for c in self.configs if c.enabled]
        on.sort(key=lambda c: (not c.is_default, c.tier == "economy", -c.updated))
        return on[0] if on else None

    async def get_economy_model_config(self):
        on = sorted((c for c in self.configs if c.enabled and c.tier == "economy"), key=lambda c: -c.updated)
        return on[0] if on else None

    async def get_model_config(self, config_id):
        return next((c for c in self.configs if c.id == config_id), None)


def cfg(id, *, tier="default", default=False, enabled=True, updated=0, key_env="OPENAI_API_KEY"):
    return SimpleNamespace(id=id, name=f"m{id}", tier=tier, is_default=default, enabled=enabled, updated=updated,
                           provider="openai", model="gpt-4o", base_url=None, api_key_env=key_env, api_key_secret_key=None,
                           extra_headers={}, tls_verify=True, ca_cert=None, options=None)


@pytest.mark.asyncio
async def test_used_for_follows_the_servers_rules(monkeypatch):
    from app.services.investigation import store as inv_store

    monkeypatch.setenv("OPENAI_API_KEY", "sk-test")
    monkeypatch.delenv("ALERT_INVESTIGATION_ENABLED", raising=False)
    # no default: the newest default-tier config is the chat's; the economy one runs the floating chat and summaries
    db = FakeDB([cfg(1, updated=1), cfg(2, updated=2), cfg(3, tier="economy", updated=3)])
    assert await model_config_service.usage(db) == {2: ["chat"], 3: ["floating", "summary"]}
    # an economy config that cannot be used (its key variable is not set): the active one runs everything
    monkeypatch.delenv("KUBEAST_AI_KEY_ECO", raising=False)
    db = FakeDB([cfg(1, default=True), cfg(3, tier="economy", key_env="KUBEAST_AI_KEY_ECO")])
    monkeypatch.setattr(model_config_service.settings, "OPENAI_API_KEY", "")
    assert await model_config_service.usage(db) == {1: ["chat", "floating", "summary"]}
    # investigations on: the named config, else the active one
    monkeypatch.setenv("ALERT_INVESTIGATION_ENABLED", "true")
    db = FakeDB([cfg(1, default=True), cfg(4, updated=9)])
    assert (await model_config_service.usage(db))[1] == ["chat", "floating", "summary", "investigation"]
    monkeypatch.setenv("ALERT_INVESTIGATION_MODEL", "m4")

    async def named(_db, name):
        return 4 if name == "m4" else None

    monkeypatch.setattr(inv_store, "model_config_id", named)
    assert await model_config_service.usage(db) == {1: ["chat", "floating", "summary"], 4: ["investigation"]}
    monkeypatch.setenv("ALERT_INVESTIGATION_MODEL", "missing")
    assert await model_config_service.usage(db) == {1: ["chat", "floating", "summary"]}
