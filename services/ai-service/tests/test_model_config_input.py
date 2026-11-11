"""What an admin types wrong in the AI Models form is a 400 with the reason, not a server error: a CA field that holds
no PEM certificate (saved, tested or used to list the provider's models) and an edit to another config's name."""
import certifi
import pytest
from fastapi import HTTPException
from pydantic import ValidationError

from app.database import DatabaseService
from app.models.model_config import ModelConfigCreate, ModelConfigUpdate
from app.services.tls import ca_cert_problem

NOT_PEM = "CA certificate: not a certificate in PEM form (-----BEGIN CERTIFICATE----- … -----END CERTIFICATE-----)"
ONE_CA = open(certifi.where()).read().split("-----END CERTIFICATE-----")[0] + "-----END CERTIFICATE-----\n"


@pytest.mark.parametrize("text", ["a", "한국어 인증서", "-----BEGIN CERTIFICATE-----\nabc\n-----END CERTIFICATE-----\n"])
def test_text_that_is_no_certificate_is_named(text):
    assert ca_cert_problem(text) == NOT_PEM


@pytest.mark.parametrize("text", [None, "", "  \n", ONE_CA])
def test_no_ca_or_a_certificate_is_fine(text):
    assert ca_cert_problem(text) is None


def test_create_and_update_refuse_it():
    with pytest.raises(ValidationError) as exc:
        ModelConfigCreate(name="x", model="m", ca_cert="a")
    assert NOT_PEM in str(exc.value)
    with pytest.raises(ValidationError):
        ModelConfigUpdate(ca_cert="한국어")
    assert ModelConfigUpdate(ca_cert=ONE_CA).ca_cert == ONE_CA


async def test_connection_test_refuses_it_before_any_request(monkeypatch):
    from app import api_public

    async def no_request(*_a, **_kw):
        raise AssertionError("no request with an unusable CA")

    monkeypatch.setattr(api_public, "_test_openai_compatible", no_request)
    monkeypatch.setenv("OPENAI_API_KEY", "env-key")
    with pytest.raises(HTTPException) as exc:
        await api_public._test_model_connection({"provider": "openai", "model": "m", "api_key_env": "OPENAI_API_KEY", "ca_cert": "a"})
    assert exc.value.status_code == 400 and exc.value.detail == NOT_PEM


async def test_model_list_says_it_on_the_forms_line(monkeypatch):
    from app import api_public

    async def no_list(*_a, **_kw):
        raise AssertionError("no request with an unusable CA")

    monkeypatch.setattr(api_public, "_list_models", no_list)
    answer = await api_public._list_provider_models({"provider": "ollama", "base_url": "https://llm.example", "ca_cert": "a"})
    assert answer == {"models": [], "error": NOT_PEM}


async def test_an_edit_to_another_configs_name_is_refused(tmp_path):
    db = DatabaseService(f"sqlite+aiosqlite:///{tmp_path}/models.db")
    await db.init_db()
    try:
        first = await db.create_model_config({"name": "first", "provider": "openai", "model": "m"})
        second = await db.create_model_config({"name": "second", "provider": "openai", "model": "m"})
        with pytest.raises(ValueError, match="Model config name already exists"):
            await db.update_model_config(second.id, {"name": "first"})
        assert (await db.get_model_config(second.id)).name == "second"
        # its own name, or a free one, saves as before
        assert (await db.update_model_config(first.id, {"name": "first", "model": "m2"})).model == "m2"
        assert (await db.update_model_config(second.id, {"name": "third"})).name == "third"
    finally:
        await db.engine.dispose()


async def test_the_update_route_answers_it_as_400(monkeypatch):
    from types import SimpleNamespace

    from app import api as api_module
    from app.services import model_config_audit

    class Db:
        async def get_model_config(self, _id):
            return SimpleNamespace(name="second", extra_headers={})

        async def update_model_config(self, _id, _data):
            raise ValueError("Model config name already exists")

    async def get_db():
        return Db()

    recorded = []

    async def ready(_what):
        return None

    async def record(*args, **kwargs):
        recorded.append(kwargs.get("result"))

    monkeypatch.setattr("app.database.get_db_service", get_db)
    monkeypatch.setattr(model_config_audit, "ready_or_503", ready)
    monkeypatch.setattr(model_config_audit, "record", record)
    monkeypatch.setattr(model_config_audit, "view", lambda c: {})
    monkeypatch.setattr(api_module, "_check_model_config_policy", lambda data, current: None)

    class Admin:
        role = "admin"
        permissions = ("*",)

        def has_permission(self, perm):
            return True

    with pytest.raises(HTTPException) as exc:
        await api_module.update_model_config(2, None, payload=Admin(), request={"name": "first"})
    assert exc.value.status_code == 400 and exc.value.detail == "Model config name already exists"
    assert recorded == ["failure"]
