"""An install with no model stored and no key or address in the chart's ai.* values sends nothing to a provider: the
chat, /ai/config and an investigation are refused with "No AI model is set up yet" instead of a request to OpenAI that
carries the question and a placeholder key. A key or an address in those values still runs as before."""
from types import SimpleNamespace

import pytest
from fastapi import HTTPException
from fastapi.testclient import TestClient

from app import api
from app.services import model_config_service as mcs


@pytest.fixture
def no_stored_model(monkeypatch):
    async def get_active():
        return None

    async def database():
        return SimpleNamespace(get_active_model_config=get_active)

    monkeypatch.setattr(mcs, "get_db_service", database)
    monkeypatch.setattr(mcs.settings, "OPENAI_API_KEY", "")
    monkeypatch.setattr(mcs.settings, "OPENAI_BASE_URL", "")
    mcs.invalidate_model_config_cache()
    yield
    mcs.invalidate_model_config_cache()


async def test_the_chat_says_no_model_is_set_up(no_stored_model):
    with pytest.raises(HTTPException) as caught:
        await api._build_ai_service("Bearer a-token", cluster_name="self")
    assert caught.value.status_code == 503
    assert caught.value.detail == "No AI model is set up yet: an administrator adds one in Admin → AI Models."


def test_the_model_name_read_says_so_too(no_stored_model):
    from app.security import require_auth
    from main import app

    app.dependency_overrides[require_auth] = lambda: None
    try:
        r = TestClient(app).get("/api/v1/ai/config")
    finally:
        app.dependency_overrides.pop(require_auth, None)
    assert r.status_code == 503
    assert r.json()["detail"].startswith("No AI model is set up yet")


async def test_an_investigation_is_refused_with_the_same_reason(no_stored_model):
    with pytest.raises(mcs.NoModelConfigured, match="No AI model is set up yet"):
        await mcs.resolve_model_config()


async def test_a_key_in_the_chart_values_still_runs_on_them(no_stored_model, monkeypatch):
    monkeypatch.setattr(mcs.settings, "OPENAI_API_KEY", "sk-" + "k" * 40)
    resolved = await api._active_model_config()
    assert resolved.provider == "openai" and resolved.api_key.startswith("sk-")


async def test_an_address_in_the_chart_values_still_runs_without_a_key(no_stored_model, monkeypatch):
    monkeypatch.setattr(mcs.settings, "OPENAI_BASE_URL", "http://ollama.ollama.svc:11434/v1")
    resolved = await api._active_model_config()
    assert resolved.base_url == "http://ollama.ollama.svc:11434/v1" and resolved.api_key == ""
