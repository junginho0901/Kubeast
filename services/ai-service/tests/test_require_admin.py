"""Model-config administration follows the permission in the token, never the
account's role name. Real tokens, through the real routes."""
import time

import jwt
import pytest
from cryptography.hazmat.primitives.asymmetric import rsa
from fastapi.testclient import TestClient

from app import security
from main import app

_KEY = rsa.generate_private_key(public_exponent=65537, key_size=2048)


class _JWKClient:
    def get_signing_key_from_jwt(self, _token):
        return type("Key", (), {"key": _KEY.public_key()})


def _token(role, permissions, **claims):
    now = int(time.time())
    return jwt.encode(
        {"sub": "u", "email": "u@example.com", "role": role, "permissions": permissions, "tv": 0,
         "iss": security.JWT_ISSUER, "aud": security.JWT_AUDIENCE, "iat": now, "exp": now + 300, **claims},
        _KEY,
        algorithm="RS256",
    )


class _DB:
    async def list_model_configs(self, enabled_only=False):
        return []


@pytest.fixture
def client(monkeypatch):
    monkeypatch.setattr(security, "_jwk_client", _JWKClient())
    monkeypatch.setattr(security, "AUTH_TOKEN_VERSION_URL", "")

    async def db():
        return _DB()

    async def usage(_db):
        return {}

    monkeypatch.setattr("app.database.get_db_service", db)
    monkeypatch.setattr("app.services.model_config_service.usage", usage)
    return TestClient(app)


# One route behind each of the two gates: _require_admin in app/api.py and
# require_admin on app/api_public.py's admin router.
ROUTES = ["/api/v1/ai/model-configs", "/api/v1/ai/model-configs/providers"]


@pytest.mark.parametrize("route", ROUTES)
@pytest.mark.parametrize(
    "role, permissions, claims",
    [
        pytest.param("ADMIN", {"c": ["resource.*.read"]}, {}, id="a custom role named in capitals, with a cluster grant"),
        pytest.param("admin", {}, {}, id="the name alone, with no permissions"),
        pytest.param(" Admin ", {"c": ["*"]}, {}, id="the name with spaces, Admin on one cluster"),
        pytest.param("Admin", {"*": ["admin.audit.read"]}, {}, id="the name with another global permission"),
        pytest.param("Admin", {"c": ["resource.*.read"]}, {"akid": "k"}, id="a token from a global admin's API key"),
        pytest.param("Member", {"c": ["*"]}, {}, id="Admin on one cluster"),
    ],
)
def test_model_configs_refuse_a_token_without_the_permission(client, route, role, permissions, claims):
    res = client.get(route, headers={"Authorization": f"Bearer {_token(role, permissions, **claims)}"})
    assert res.status_code == 403, res.text


@pytest.mark.parametrize("route", ROUTES)
@pytest.mark.parametrize(
    "role, permissions",
    [
        pytest.param("Admin", {"*": ["*"]}, id="a global admin"),
        pytest.param("Admin", {"*": ["*"], "c": "*"}, id="a global admin with a grant, as auth-service compacts it"),
        pytest.param("Member", {"*": ["admin.ai_models.*"]}, id="a role holding the permission"),
        pytest.param("Member", {"*": ["admin.*"]}, id="a role holding every admin permission"),
    ],
)
def test_model_configs_answer_a_token_with_the_permission(client, route, role, permissions):
    res = client.get(route, headers={"Authorization": f"Bearer {_token(role, permissions)}"})
    assert res.status_code == 200, res.text
