"""POST /api/v1/ai/model-configs/models (api_public.list_provider_models): the model dropdown's list from the
provider, with the connection test's key and base_url rules, and an empty list plus a reason when it cannot be had."""
import httpx
import pytest
from fastapi import HTTPException

from app import api_public


def serve(monkeypatch, handler):
    """Route the endpoint's httpx client to a fake provider; return the requests it made."""
    seen = []
    real = httpx.AsyncClient

    def wrapped(request):
        seen.append(request)
        return handler(request)

    monkeypatch.setattr(api_public.httpx, "AsyncClient", lambda **kw: real(transport=httpx.MockTransport(wrapped), timeout=kw.get("timeout")))
    return seen


@pytest.mark.asyncio
async def test_anthropic_lists_its_models_with_display_names(monkeypatch):
    monkeypatch.setenv("ANTHROPIC_API_KEY", "sk-ant-test")
    seen = serve(monkeypatch, lambda r: httpx.Response(200, json={"data": [
        {"id": "claude-haiku-5-5", "display_name": "Claude Haiku 5.5"}, {"id": "claude-sonnet-5-5", "display_name": "Claude Sonnet 5.5"}]}))
    out = await api_public.list_provider_models({"provider": "anthropic", "api_key_env": "ANTHROPIC_API_KEY", "base_url": ""})
    assert out == {"models": [{"name": "claude-haiku-5-5", "label": "Claude Haiku 5.5"}, {"name": "claude-sonnet-5-5", "label": "Claude Sonnet 5.5"}]}
    req = seen[0]
    assert str(req.url) == "https://api.anthropic.com/v1/models?limit=1000"
    assert req.headers["x-api-key"] == "sk-ant-test" and req.headers["anthropic-version"] == "2023-06-01"


@pytest.mark.asyncio
async def test_openai_compatible_lists_chat_models_only_sorted(monkeypatch):
    monkeypatch.setenv("OPENAI_API_KEY", "sk-test")
    seen = serve(monkeypatch, lambda r: httpx.Response(200, json={"data": [
        {"id": "gpt-5.5"}, {"id": "text-embedding-3-large"}, {"id": "gpt-4o-mini-tts"}, {"id": "whisper-1"}, {"id": "gpt-5-mini"}, {"id": "dall-e-3"}]}))
    out = await api_public.list_provider_models({"provider": "openai", "api_key_env": "OPENAI_API_KEY"})
    assert out == {"models": [{"name": "gpt-5-mini"}, {"name": "gpt-5.5"}]}
    assert str(seen[0].url) == "https://api.openai.com/v1/models" and seen[0].headers["authorization"] == "Bearer sk-test"


@pytest.mark.asyncio
async def test_gemini_and_ollama_use_their_openai_compatible_lists(monkeypatch):
    monkeypatch.setenv("GEMINI_API_KEY", "g-key")
    seen = serve(monkeypatch, lambda r: httpx.Response(200, json={"data": [{"id": "models/gemini-3.5-flash"}, {"id": "granite4.1:8b"}]}))
    gem = await api_public.list_provider_models({"provider": "gemini", "api_key_env": "GEMINI_API_KEY"})
    assert gem["models"][0] == {"name": "gemini-3.5-flash"}
    assert str(seen[0].url) == "https://generativelanguage.googleapis.com/v1beta/openai/models"
    # Ollama needs no key; the base gets /v1 like the connection test (a host the dev values allow)
    monkeypatch.setattr(api_public, "_validate_base_url", lambda url: None)
    await api_public.list_provider_models({"provider": "ollama", "base_url": "http://host.docker.internal:11434"})
    assert str(seen[1].url) == "http://host.docker.internal:11434/v1/models"


@pytest.mark.asyncio
async def test_no_list_gives_an_empty_answer_with_the_reason(monkeypatch):
    monkeypatch.delenv("ANTHROPIC_API_KEY", raising=False)
    out = await api_public.list_provider_models({"provider": "anthropic", "api_key_env": "ANTHROPIC_API_KEY"})
    assert out["models"] == [] and "ANTHROPIC_API_KEY is not set" in out["error"]

    monkeypatch.setenv("ANTHROPIC_API_KEY", "bad")
    serve(monkeypatch, lambda r: httpx.Response(401, json={"type": "error", "error": {"type": "authentication_error"}}))
    out = await api_public.list_provider_models({"provider": "anthropic", "api_key_env": "ANTHROPIC_API_KEY"})
    assert out == {"models": [], "error": "the provider answered 401"}

    monkeypatch.setenv("KUBEAST_AI_KEY_AZURE", "x")
    out = await api_public.list_provider_models({"provider": "azure", "api_key_env": "KUBEAST_AI_KEY_AZURE"})
    assert out["models"] == [] and "deployments" in out["error"]


@pytest.mark.asyncio
async def test_key_variable_and_base_url_follow_the_policy():
    with pytest.raises(HTTPException) as e:
        await api_public.list_provider_models({"provider": "openai", "api_key_env": "DATABASE_URL"})
    assert e.value.status_code == 400
    with pytest.raises(HTTPException) as e:
        await api_public.list_provider_models({"provider": "openai", "api_key_env": "OPENAI_API_KEY", "base_url": "http://169.254.169.254/v1"})
    assert e.value.status_code == 400
