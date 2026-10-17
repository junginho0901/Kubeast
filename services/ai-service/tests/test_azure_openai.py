"""Azure OpenAI is its v1 API only: the chat and the connection test reach <base>/chat/completions through the same
ProviderAdapter, with the key as the Bearer token and as api-key, and no api-version; deployment URLs are refused."""
import httpx
import pytest

from app import api_public
from app.services import model_config_policy, provider_adapter
from app.services.provider_adapter import ProviderAdapter

BASE = "https://res.openai.azure.com/openai/v1/"
COMPLETION = {
    "id": "c1", "object": "chat.completion", "created": 0, "model": "my-deployment",
    "choices": [{"index": 0, "message": {"role": "assistant", "content": "pong"}, "finish_reason": "stop"}],
}


def serve(monkeypatch):
    """Route the adapter's httpx client to a fake Azure endpoint; return the requests it made."""
    seen = []

    def handler(request):
        seen.append(request)
        return httpx.Response(200, json=COMPLETION)

    # a subclass, not a function: the OpenAI SDK checks isinstance(http_client, httpx.AsyncClient)
    class FakeAzure(httpx.AsyncClient):
        def __init__(self, **_kw):
            super().__init__(transport=httpx.MockTransport(handler))

    monkeypatch.setattr(provider_adapter.httpx, "AsyncClient", FakeAzure)
    return seen


def assert_v1_request(req, key):
    assert str(req.url) == "https://res.openai.azure.com/openai/v1/chat/completions"
    assert "api-version" not in str(req.url)
    assert req.headers["authorization"] == f"Bearer {key}"
    assert req.headers["api-key"] == key


@pytest.mark.asyncio
@pytest.mark.parametrize("provider", ["azure", "azureopenai"])
async def test_the_chat_calls_the_v1_endpoint_with_both_key_headers(monkeypatch, provider):
    seen = serve(monkeypatch)
    adapter = ProviderAdapter(provider=provider, model="my-deployment", api_key="az-key", base_url=BASE)
    resp = await adapter.chat.completions.create(model="my-deployment", messages=[{"role": "user", "content": "hi"}])
    assert resp.choices[0].message.content == "pong"
    assert_v1_request(seen[0], "az-key")


def test_without_an_endpoint_the_key_goes_nowhere():
    with pytest.raises(ValueError, match="openai/v1"):
        ProviderAdapter(provider="azure", model="my-deployment", api_key="az-key", base_url="")


@pytest.mark.asyncio
async def test_the_connection_test_takes_the_chat_path(monkeypatch):
    monkeypatch.setenv("KUBEAST_AI_KEY_AZURE", "az-key")
    monkeypatch.setattr(api_public, "_validate_base_url", lambda url: None)
    seen = serve(monkeypatch)
    out = await api_public.test_model_connection({
        "provider": "azure", "model": "my-deployment", "base_url": BASE, "api_key_env": "KUBEAST_AI_KEY_AZURE",
    })
    assert out == {"success": True, "model": "my-deployment", "message": "Connection successful"}
    assert len(seen) == 1
    assert_v1_request(seen[0], "az-key")


@pytest.mark.parametrize("base_url", [
    "https://res.openai.azure.com/openai/deployments/gpt4o",
    "https://res.openai.azure.com/openai/deployments/gpt4o/chat/completions?api-version=2024-06-01",
    "https://res.openai.azure.com/openai/v1/?api-version=2024-10-21",
])
def test_deployment_urls_and_api_versions_are_refused_with_the_v1_form(base_url):
    with pytest.raises(model_config_policy.PolicyError) as e:
        model_config_policy.check_provider_fields("azure", ("KUBEAST_AI_KEY_AZURE",), base_url)
    assert "https://<resource>.openai.azure.com/openai/v1/" in str(e.value)


@pytest.mark.parametrize("provider", ["azure", "azureopenai"])
def test_an_empty_endpoint_is_refused(provider):
    with pytest.raises(model_config_policy.PolicyError, match="v1 endpoint"):
        model_config_policy.check_provider_fields(provider, ("KUBEAST_AI_KEY_AZURE",), "")


@pytest.mark.parametrize("base_url", [
    BASE,
    "https://res.services.ai.azure.com/openai/v1",
    "https://apim.example.com/aoai/openai/v1/",  # an API Management gateway in front
])
def test_a_v1_endpoint_or_a_gateway_passes(base_url):
    model_config_policy.check_provider_fields("azure", ("KUBEAST_AI_KEY_AZURE",), base_url)


def test_other_providers_keep_their_rules():
    model_config_policy.check_provider_fields("openai", ("OPENAI_API_KEY",), "")
    model_config_policy.check_provider_fields("custom", ("KUBEAST_AI_KEY_1",), "https://gw.example.com/openai/deployments/x")
