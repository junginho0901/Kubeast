"""M3: provider API keys are never stored — configs only name an env var."""
import pytest
from fastapi import HTTPException
from pydantic import ValidationError

from app.models.model_config import ModelConfigCreate, ModelConfigUpdate, ModelConfigResponse, API_KEY_NOT_STORED


def test_create_rejects_plaintext_api_key():
    with pytest.raises(ValidationError) as exc:
        ModelConfigCreate(name="x", model="gpt", api_key="sk-secret")
    assert API_KEY_NOT_STORED in str(exc.value)


def test_update_rejects_plaintext_api_key():
    with pytest.raises(ValidationError):
        ModelConfigUpdate(api_key="sk-secret")


def test_create_accepts_env_name_only():
    cfg = ModelConfigCreate(name="x", model="gpt", api_key_env="OPENAI_API_KEY")
    dumped = cfg.model_dump(exclude_unset=True)
    assert dumped["api_key_env"] == "OPENAI_API_KEY"
    assert "api_key" not in dumped


def test_response_has_no_stored_key_flag():
    assert "api_key_set" not in ModelConfigResponse.model_fields
    assert "api_key" not in ModelConfigResponse.model_fields


def test_resolve_api_key_reads_env_only(monkeypatch):
    from types import SimpleNamespace
    from app.services.model_config_service import _resolve_api_key

    monkeypatch.setenv("MY_LLM_KEY", "from-env")
    cfg = SimpleNamespace(api_key="leaked", api_key_env="MY_LLM_KEY", api_key_secret_key=None)
    assert _resolve_api_key(cfg) == "from-env"

    cfg = SimpleNamespace(api_key="leaked", api_key_env=None, api_key_secret_key=None)
    assert _resolve_api_key(cfg) is None


async def test_connection_test_resolves_api_key_env(monkeypatch):
    from app import api_public

    seen = {}

    async def fake_openai(api_key, model, base, tls_verify):
        seen["key"] = api_key
        return {"success": True, "message": "ok"}

    monkeypatch.setattr(api_public, "_test_openai_compatible", fake_openai)
    monkeypatch.setenv("OPENAI_API_KEY", "env-key")
    res = await api_public.test_model_connection({"provider": "openai", "model": "gpt-4o-mini", "api_key_env": "OPENAI_API_KEY"})
    assert res["success"] and seen["key"] == "env-key"


async def test_connection_test_unset_env_is_400(monkeypatch):
    from app import api_public

    monkeypatch.delenv("NOPE_KEY", raising=False)
    with pytest.raises(HTTPException) as exc:
        await api_public.test_model_connection({"provider": "openai", "model": "gpt-4o-mini", "api_key_env": "NOPE_KEY"})
    assert exc.value.status_code == 400
    assert "NOPE_KEY" in exc.value.detail


async def test_create_route_returns_400_for_plaintext_key():
    """The admin route maps the validation error to 400 instead of 500."""
    from app import api as api_module

    class Admin:
        role = "admin"
        permissions = ("*",)

        def has_permission(self, perm):
            return True

    with pytest.raises(HTTPException) as exc:
        await api_module.create_model_config(payload=Admin(), request={"name": "x", "model": "m", "api_key": "sk-1"})
    assert exc.value.status_code == 400
    assert "api_key is not stored" in exc.value.detail
