# /metrics on ai-service: the Prometheus text format with the shared
# kubeast_http_* names, the route label as a template, probes not counted.
import os
import re
from pathlib import Path

import pytest
from fastapi import APIRouter, FastAPI
from fastapi.testclient import TestClient

from app import metrics

ROOT = Path(__file__).resolve().parents[3]


def chart_probe_paths(port: int) -> set[str]:
    """The paths the chart's kubelet probes ask on this port: httpGet blocks and the probe helpers' dict arguments."""
    text = (ROOT / "helm/kubeast/templates/deployments.yaml").read_text()
    found = {path for path, num in re.findall(r"httpGet:\s*\n\s*path:\s*(\S+)\s*\n\s*port:\s*(\d+)", text) if int(num) == port}
    for args in re.findall(r'include "kubeast\.\w+" \(dict ([^)]*)\)', text):
        path, num = re.search(r'"path" "([^"]+)"', args), re.search(r'"port" (\d+)', args)
        if path and num and int(num.group(1)) == port:
            found.add(path.group(1))
    return found


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

    # app.api_public's probe route, under the same prefix.
    @router.get("/health")
    async def ai_health():
        return {"status": "healthy"}

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
    # prometheus_client's default collectors are served with ours; python_info is there on every system.
    assert "python_info{" in body


# The kubelet asks these every few seconds: counted, they would fill the denominator of KubeastHighErrorRate and KubeastSlowRequests.
def test_the_charts_probe_paths_are_not_counted():
    paths = chart_probe_paths(8001)
    assert "/api/v1/ai/health" in paths
    assert paths <= metrics.SKIP, f"probe paths the middleware counts: {sorted(paths - metrics.SKIP)}"

    client = TestClient(build(True))
    for path in sorted(paths):
        assert client.get(path).status_code == 200
    body = client.get("/metrics").text
    for path in paths:
        assert f'route="{path}"' not in body


# prometheus_client's process collector reads /proc: Linux, as the image runs, has it and macOS does not.
@pytest.mark.skipif(not os.path.exists("/proc/self/stat"), reason="prometheus_client's process collector reads /proc/self/stat, which this system does not have")
def test_metrics_serve_the_process_collector_where_proc_exists():
    body = TestClient(build(True)).get("/metrics").text
    assert "process_cpu_seconds_total" in body
    assert "process_resident_memory_bytes" in body


def test_metrics_disabled_is_404():
    client = TestClient(build(False))
    assert client.get("/health").status_code == 200
    assert client.get("/metrics").status_code == 404
