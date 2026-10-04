# /metrics on ai-service: the Prometheus text format with the shared
# kubeast_http_* names, the route label as a template, probes not counted.
from fastapi import APIRouter, FastAPI
from fastapi.testclient import TestClient

from app import metrics


def build(enabled: bool) -> FastAPI:
    app = FastAPI()

    @app.get("/health")
    async def health():
        return {"ok": True}

    # Like main.py: the API lives on a router included with a prefix (FastAPI
    # matches those lazily, so the template must come from the request
    # telemetry, prefix included).
    router = APIRouter()

    @router.get("/sessions/{session_id}/history")
    async def history(session_id: str):
        return {"session": session_id}

    app.include_router(router, prefix="/api/v1/ai")
    metrics.install(app, enabled)
    return app


def test_metrics_count_routes_by_template_not_path():
    client = TestClient(build(True))
    for sid in ("a", "b"):
        assert client.get(f"/api/v1/ai/sessions/{sid}/history").status_code == 200
    assert client.get("/health").status_code == 200
    assert client.get("/no-such-route").status_code == 404

    body = client.get("/metrics").text
    assert 'kubeast_http_requests_total{code="200",method="get",route="/api/v1/ai/sessions/{session_id}/history",service="ai"} 2.0' in body
    assert 'route="unmatched"' in body and 'code="404"' in body
    assert 'kubeast_http_request_duration_seconds_count{code="200",method="get",route="/api/v1/ai/sessions/{session_id}/history",service="ai"} 2.0' in body
    assert 'kubeast_http_requests_in_flight{service="ai"} 0.0' in body
    assert 'route="/health"' not in body and 'route="/metrics"' not in body
    assert 'route="/api/v1/ai/sessions/a/history"' not in body
    assert "process_cpu_seconds_total" in body


def test_metrics_disabled_is_404():
    client = TestClient(build(False))
    assert client.get("/health").status_code == 200
    assert client.get("/metrics").status_code == 404
