"""A default model that cannot run as stored — no key in ai-service, provider fields refused — is refused with the
reason, in the chat and on /ai/config, as a refused address is, not as a bare 500 the screen can only call "HTTP 500"."""
from types import SimpleNamespace

import pytest
from fastapi import HTTPException
from fastapi.testclient import TestClient

from app import api
from app.services import model_config_service as mcs

TOKEN = "sk-ant-oat01-" + "t" * 40


def _row(**over):
    row = dict(id=1, provider="anthropic", model="claude-haiku-5-5", base_url=None, api_key_env="ANTHROPIC_API_KEY",
               api_key_secret_key=None, extra_headers={}, tls_verify=True, ca_cert=None, options=None)
    row.update(over)
    return SimpleNamespace(**row)


@pytest.fixture
def active(monkeypatch):
    holder = {}

    async def get_active():
        return holder["row"]

    async def database():
        return SimpleNamespace(get_active_model_config=get_active)

    monkeypatch.setattr(mcs, "get_db_service", database)
    monkeypatch.setattr(mcs.settings, "OPENAI_API_KEY", "")
    monkeypatch.delenv("ANTHROPIC_API_KEY", raising=False)
    mcs.invalidate_model_config_cache()
    yield holder
    mcs.invalidate_model_config_cache()


async def test_a_default_model_with_no_key_in_ai_service_tells_the_chat_why(active):
    active["row"] = _row()
    with pytest.raises(HTTPException) as caught:
        await api._build_ai_service("Bearer a-token", cluster_name="self")
    assert caught.value.status_code == 503
    assert "API key is missing" in caught.value.detail and "provider=anthropic" in caught.value.detail
    assert "Admin → AI Models" in caught.value.detail


async def test_a_default_model_whose_provider_fields_are_refused_tells_the_chat_why_without_the_value(active, monkeypatch):
    monkeypatch.setenv("CLAUDE_CODE_OAUTH_TOKEN", TOKEN)
    active["row"] = _row(api_key_env="CLAUDE_CODE_OAUTH_TOKEN")
    with pytest.raises(HTTPException) as caught:
        await api._build_ai_service("Bearer a-token", cluster_name="self")
    assert caught.value.status_code == 503
    assert "not allowed" in caught.value.detail and "only provider claude-code uses it" in caught.value.detail
    assert TOKEN not in caught.value.detail


def test_the_model_name_read_says_why_too(active):
    from app.security import require_auth
    from main import app

    active["row"] = _row()
    app.dependency_overrides[require_auth] = lambda: None
    try:
        r = TestClient(app).get("/api/v1/ai/config")
    finally:
        app.dependency_overrides.pop(require_auth, None)
    assert r.status_code == 503
    assert "API key is missing" in r.json()["detail"]


async def test_the_same_model_with_its_key_runs(active, monkeypatch):
    monkeypatch.setenv("ANTHROPIC_API_KEY", "sk-ant-api03-" + "k" * 40)
    active["row"] = _row()
    resolved = await api._active_model_config()
    assert resolved.provider == "anthropic" and resolved.model == "claude-haiku-5-5"
