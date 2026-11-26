"""The connection test, the model list and the chat reach one host for a config; a provider ai-service cannot call is
refused on save, and one already stored is listed but refused when used or tested, with nothing sent."""
import re
from datetime import datetime, timezone
from pathlib import Path
from types import SimpleNamespace

import httpx
import pytest
from fastapi import HTTPException

from app import api, api_public
from app.services import claude_code, model_config_audit, model_config_policy, model_config_service, provider_adapter

ROOT = Path(__file__).resolve().parents[3]
KEY_ENV = "KUBEAST_AI_KEY_ROUTE"
BASE = "https://llm.example.test/v1"
AZURE = "https://res.openai.azure.com/openai/v1/"
COMPLETION = {
    "id": "c1", "object": "chat.completion", "created": 0, "model": "m",
    "choices": [{"index": 0, "message": {"role": "assistant", "content": "ok"}, "finish_reason": "stop"}],
    "usage": {"prompt_tokens": 1, "completion_tokens": 1, "total_tokens": 2},
}
MSG = [{"role": "user", "content": "ping"}]


class Admin:
    role = "admin"
    permissions = ("*",)

    def has_permission(self, perm):
        return True


def row(**over):
    now = datetime.now(timezone.utc)
    values = dict(id=1, name="route", provider="openai", model="m", base_url=None, api_key_env=KEY_ENV,
                  api_key_secret_name=None, api_key_secret_key=None, extra_headers={}, tls_verify=True, ca_cert=None,
                  options=None, enabled=True, is_default=False, tier="default", created_at=now, updated_at=now)
    values.update(over)
    return SimpleNamespace(**values)


@pytest.fixture
def hosts(monkeypatch):
    """The host of every request a model client makes, in order, answered by a fake endpoint: nothing leaves."""
    seen = []

    def handler(request):
        seen.append(request.url.host)
        return httpx.Response(200, json=COMPLETION)

    class Fake(httpx.AsyncClient):
        def __init__(self, **_kw):
            super().__init__(transport=httpx.MockTransport(handler))

    monkeypatch.setattr(httpx, "AsyncClient", Fake)
    monkeypatch.setattr(model_config_policy, "check_base_url", lambda url, resolve=None: None)
    monkeypatch.setenv(KEY_ENV, "sk-test-route")
    provider_adapter._refused.clear()
    provider_adapter._without_reasoning.clear()
    return seen


def _sent(seen, before):
    return seen[before] if len(seen) > before else None


async def connection_test_host(seen, provider, base_url):
    """The host the connection test sends to, or None when it refuses and sends nothing."""
    body = {"provider": provider, "model": "m", "api_key_env": KEY_ENV, **({"base_url": base_url} if base_url else {})}
    before = len(seen)
    try:
        await api_public._test_model_connection(body)
    except HTTPException as e:
        assert e.status_code == 400
        assert len(seen) == before
        return None
    return _sent(seen, before)


async def list_host(seen, provider, base_url):
    """The host the model list asks, or None when it sends nothing."""
    body = {"provider": provider, "api_key_env": KEY_ENV, **({"base_url": base_url} if base_url else {})}
    before = len(seen)
    try:
        await api_public._list_provider_models(body)
    except HTTPException as e:
        assert e.status_code == 400
    return _sent(seen, before)


async def chat_host(seen, provider, base_url):
    """The host the chat sends to for a stored config, or None when the config is refused as it is resolved."""
    before = len(seen)
    try:
        service = api._new_ai_service(model_config_service._build_resolved(row(provider=provider, base_url=base_url)))
    except ValueError:
        assert len(seen) == before
        return None
    try:
        await service.client.chat.completions.create(model="m", messages=MSG, max_tokens=5)
    except Exception:
        pass  # the fake answer is no Anthropic body; the request has gone out all the same
    return _sent(seen, before)


@pytest.mark.parametrize("provider,base_url,host", [
    ("openai", None, "api.openai.com"),
    ("anthropic", None, "api.anthropic.com"),
    ("gemini", None, "generativelanguage.googleapis.com"),
    ("google", None, "generativelanguage.googleapis.com"),
    ("ollama", None, "localhost"),
    ("azure", None, None),
    ("custom", None, None),
    ("groq", None, None),
    ("deepseek", None, None),
    ("vllm", None, None),
    ("openai", BASE, "llm.example.test"),
    ("anthropic", "https://llm.example.test", "llm.example.test"),
    ("gemini", BASE, "llm.example.test"),
    ("ollama", "http://llm.example.test:11434", "llm.example.test"),
    ("azure", AZURE, "res.openai.azure.com"),
    ("azureopenai", AZURE, "res.openai.azure.com"),
    ("custom", BASE, "llm.example.test"),
    ("groq", BASE, None),
    ("vllm", BASE, None),
])
async def test_the_connection_test_the_model_list_and_the_chat_reach_one_host(hosts, provider, base_url, host):
    tested = await connection_test_host(hosts, provider, base_url)
    chatted = await chat_host(hosts, provider, base_url)
    listed = await list_host(hosts, provider, base_url)
    assert (tested, chatted) == (host, host)
    assert listed in (host, None)


@pytest.mark.parametrize("provider", ["custom", "groq", "vllm", "VLLM "])
def test_no_provider_falls_through_to_openais_address(provider):
    with pytest.raises(model_config_policy.PolicyError, match=r"^provider "):
        model_config_policy.default_base_url(provider)


def route_doubles(monkeypatch, stored=None):
    """The create and update routes on a stand-in database and audit store: (audit rows, writes)."""
    recorded, written = [], []

    class Db:
        async def get_model_config(self, _id):
            return stored

        async def create_model_config(self, data):
            written.append(data)
            return row(**data)

        async def update_model_config(self, _id, data):
            written.append(data)
            return row(**{**vars(stored), **data})

    async def get_db():
        return Db()

    async def ready(_what):
        return None

    async def record(action, *_args, **kwargs):
        recorded.append((action, kwargs.get("result", "success"), kwargs.get("error")))

    monkeypatch.setattr("app.database.get_db_service", get_db)
    monkeypatch.setattr(model_config_audit, "ready_or_503", ready)
    monkeypatch.setattr(model_config_audit, "record", record)
    monkeypatch.setattr(model_config_audit, "view", lambda c: {})
    monkeypatch.setattr(model_config_policy, "check_base_url", lambda url, resolve=None: None)
    monkeypatch.setattr(claude_code, "unavailable_reason", lambda: None)
    return recorded, written


@pytest.mark.parametrize("body", [
    {"provider": "groq"},
    {"provider": "vllm", "base_url": BASE},
    {"provider": "Fireworks"},
    {"provider": "custom"},
    {"provider": "custom", "base_url": "  "},
], ids=["groq", "vllm-with-base-url", "fireworks", "custom-without-base-url", "custom-blank-base-url"])
async def test_create_refuses_a_provider_ai_service_cannot_call(monkeypatch, body):
    recorded, written = route_doubles(monkeypatch)
    with pytest.raises(HTTPException) as exc:
        await api.create_model_config(None, payload=Admin(), request={"name": "r", "model": "m", **body})
    assert exc.value.status_code == 400 and exc.value.detail.startswith("provider ")
    assert written == []
    assert recorded == [("ai.model_config.create", "failure", exc.value.detail)]


@pytest.mark.parametrize("body", [
    {"provider": "openai"}, {"provider": "anthropic"}, {"provider": "gemini"}, {"provider": "google"},
    {"provider": "ollama"}, {"provider": "azure", "base_url": AZURE}, {"provider": "azureopenai", "base_url": AZURE},
    {"provider": "custom", "base_url": BASE}, {"provider": "claude-code"}, {"provider": "OpenAI"}, {},
], ids=lambda b: b.get("provider", "none"))
async def test_create_takes_every_provider_ai_service_calls(monkeypatch, body):
    recorded, written = route_doubles(monkeypatch)
    out = await api.create_model_config(None, payload=Admin(), request={"name": "r", "model": "m", **body})
    assert len(written) == 1 and out.name == "r"
    assert recorded == [("ai.model_config.create", "success", None)]


async def test_an_update_to_such_a_provider_is_refused_and_recorded(monkeypatch):
    recorded, written = route_doubles(monkeypatch, stored=row())
    with pytest.raises(HTTPException) as exc:
        await api.update_model_config(1, None, payload=Admin(), request={"provider": "groq"})
    assert exc.value.status_code == 400 and exc.value.detail.startswith("provider must be one of ")
    assert written == []
    assert recorded == [("ai.model_config.update", "failure", exc.value.detail)]


async def test_a_config_stored_with_such_a_provider_is_saved_again_only_with_a_provider_ai_service_calls(monkeypatch):
    stored = row(provider="vllm", base_url=BASE)
    recorded, written = route_doubles(monkeypatch, stored=stored)
    with pytest.raises(HTTPException) as exc:
        await api.update_model_config(1, None, payload=Admin(), request={"enabled": False})
    assert exc.value.status_code == 400 and exc.value.detail.startswith("provider must be one of ")
    assert written == []
    out = await api.update_model_config(1, None, payload=Admin(), request={"provider": "custom"})
    assert out.provider == "custom" and written == [{"provider": "custom"}]
    assert [r[1] for r in recorded] == ["failure", "success"]


async def test_a_config_stored_with_such_a_provider_is_listed_and_refused_when_used(monkeypatch, hosts):
    stored = row(provider="vllm", base_url=BASE, is_default=True)

    class Db:
        async def list_model_configs(self, enabled_only=False):
            return [stored]

        async def get_active_model_config(self):
            return stored

    async def get_db():
        return Db()

    async def no_usage(_db):
        return {}

    monkeypatch.setattr("app.database.get_db_service", get_db)
    monkeypatch.setattr(model_config_service, "get_db_service", get_db)
    monkeypatch.setattr(model_config_service, "usage", no_usage)
    model_config_service.invalidate_model_config_cache()
    try:
        listed = await api.list_model_configs(enabled_only=False, payload=Admin())
        assert [(c.name, c.provider) for c in listed] == [("route", "vllm")]
        with pytest.raises(HTTPException) as exc:
            await api._active_model_config()
        assert exc.value.status_code == 503
        assert 'active model config is not allowed: provider must be one of ' in exc.value.detail
        assert hosts == []
    finally:
        model_config_service.invalidate_model_config_cache()


def test_ai_service_takes_the_providers_the_screen_offers_and_the_crd_takes():
    """Held to frontend/src and the chart: the screen's ids, the CRD's spec.provider enum and google, Gemini's other name."""
    catalog = (ROOT / "frontend" / "src" / "constants" / "modelCatalog.ts").read_text(encoding="utf-8")
    screen = set(re.findall(r"^    id: '([a-z-]+)',$", catalog.split("export const PROVIDER_CATALOG", 1)[1], re.M))
    crd = (ROOT / "helm" / "kubeast" / "templates" / "model-config-crd.yaml").read_text(encoding="utf-8")
    enum = re.search(r"\n\s+provider:\n(?:\s+(?:type|default): \S+\n)*\s+enum: \[([^\]]+)\]", crd)
    assert screen and enum
    crd_values = {p.strip() for p in enum.group(1).split(",")}
    assert model_config_policy.PROVIDERS == screen | crd_values | {"google"}
