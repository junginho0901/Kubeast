# /metrics on ai-service: the Prometheus text format with the shared
# kubeast_http_* names, the route label as a template, probes not counted.
import os

import pytest
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
    # prometheus_client's default collectors are served with ours; python_info is there on every system.
    assert "python_info{" in body


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


class _Pool:
    """A SQLAlchemy QueuePool's counts."""

    def __init__(self, out: int, idle: int):
        self.out, self.idle = out, idle

    def checkedout(self):
        return self.out

    def checkedin(self):
        return self.idle


def test_the_database_pool_is_shown_with_the_go_services_names(monkeypatch):
    from types import SimpleNamespace

    from app import database

    monkeypatch.setattr(database, "db_service", SimpleNamespace(engine=SimpleNamespace(pool=_Pool(3, 2)), pool_max=8))
    body = TestClient(build(True)).get("/metrics").text
    assert 'kubeast_db_pool_connections{service="ai",state="in_use"} 3.0' in body
    assert 'kubeast_db_pool_connections{service="ai",state="idle"} 2.0' in body
    assert 'kubeast_db_pool_max_connections{service="ai"} 8.0' in body
    assert 'state="opening"' not in body


def test_the_pool_max_is_the_engines_pool_size_and_overflow(monkeypatch):
    from app import database, db_session

    monkeypatch.delenv(db_session.POOL_MAX_ENV, raising=False)
    svc = database.DatabaseService("postgresql+asyncpg://kubeast:pw@db.example:5432/kubeast")
    assert svc.pool_max == svc.engine.pool.size() + svc.engine.pool._max_overflow == 15
    monkeypatch.setattr(database, "db_service", svc)
    body = TestClient(build(True)).get("/metrics").text
    assert 'kubeast_db_pool_connections{service="ai",state="in_use"} 0.0' in body
    assert 'kubeast_db_pool_max_connections{service="ai"} 15.0' in body


def test_no_pool_series_before_the_database_service_nor_for_sqlite(monkeypatch, tmp_path):
    from app import database

    monkeypatch.setattr(database, "db_service", None)
    assert "kubeast_db_pool_" not in TestClient(build(True)).get("/metrics").text
    monkeypatch.setattr(database, "db_service", database.DatabaseService(f"sqlite+aiosqlite:///{tmp_path / 'pool.db'}"))
    assert "kubeast_db_pool_" not in TestClient(build(True)).get("/metrics").text
