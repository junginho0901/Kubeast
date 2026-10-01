"""Route-level auth for the AI service (C3): no unauthenticated model-config paths."""
from fastapi.testclient import TestClient

from main import app


client = TestClient(app)


def test_health_is_public_and_minimal():
    res = client.get("/api/v1/ai/health")
    assert res.status_code == 200
    assert res.json() == {"status": "healthy"}


def test_model_config_setup_route_is_gone():
    res = client.post("/api/v1/ai/model-configs/setup", json={"name": "x", "model": "y"})
    assert res.status_code in (404, 405)


def test_model_config_test_requires_token():
    res = client.post("/api/v1/ai/model-configs/test", json={"provider": "ollama", "model": "x"})
    assert res.status_code == 401


def test_base_url_validation_blocks_metadata_and_bad_schemes(monkeypatch):
    from fastapi import HTTPException
    from app.api_public import _validate_base_url
    from app.services import model_config_policy

    for bad in ("http://169.254.169.254/latest", "ftp://host/v1", "http://user:pw@host/v1", "http://metadata.google.internal/",
                "http://127.0.0.1:11434/v1", "http://10.0.0.5:8080/v1"):
        try:
            _validate_base_url(bad)
        except HTTPException as e:
            assert e.status_code == 400
        else:
            raise AssertionError(f"{bad} should be rejected")

    # Private hosts pass only when the operator listed them.
    monkeypatch.setenv("AI_BASE_URL_ALLOWED_HOSTS", "host.docker.internal")
    _validate_base_url("http://host.docker.internal:11434/v1")
    # Public endpoints pass (resolution stubbed: the test box may be offline).
    monkeypatch.setattr(model_config_policy.socket, "getaddrinfo", lambda host, port: [(None, None, None, None, ("104.18.6.192", 0))])
    _validate_base_url("https://api.openai.com/v1")
