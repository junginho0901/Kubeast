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


def test_base_url_validation_blocks_metadata_and_bad_schemes():
    from fastapi import HTTPException
    from app.api_public import _validate_base_url

    for bad in ("http://169.254.169.254/latest", "ftp://host/v1", "http://user:pw@host/v1", "http://metadata.google.internal/"):
        try:
            _validate_base_url(bad)
        except HTTPException as e:
            assert e.status_code == 400
        else:
            raise AssertionError(f"{bad} should be rejected")

    _validate_base_url("http://host.docker.internal:11434/v1")
    _validate_base_url("https://api.openai.com/v1")
