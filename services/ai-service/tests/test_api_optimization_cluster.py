"""/suggest-optimization and its stream build the service for the cluster named in
X-Cluster-Name (the same header the chat streams send), so the observations come
from the selected cluster instead of the default one."""
import pytest
from fastapi.testclient import TestClient

from main import app
from app import api as api_module
from app.security import require_auth


class _StubService:
    async def suggest_optimization(self, namespace):
        return [f"ok:{namespace}"]

    async def suggest_optimization_stream(self, namespace):
        yield "event: done\ndata: {}\n\n"


@pytest.fixture
def builder_calls(monkeypatch):
    calls = []

    async def fake_build(authorization, cluster_name=None):
        calls.append({"authorization": authorization, "cluster_name": cluster_name})
        return _StubService()

    monkeypatch.setattr(api_module, "_build_ai_service", fake_build)
    app.dependency_overrides[require_auth] = lambda: None
    yield calls
    app.dependency_overrides.pop(require_auth, None)


def test_stream_builds_service_for_header_cluster(builder_calls):
    r = TestClient(app).get(
        "/api/v1/ai/suggest-optimization/stream?namespace=web",
        headers={"Authorization": "Bearer tok", "X-Cluster-Name": "test2"},
    )
    assert r.status_code == 200
    assert builder_calls[-1] == {"authorization": "Bearer tok", "cluster_name": "test2"}


def test_post_builds_service_for_header_cluster_and_none_without_it(builder_calls):
    client = TestClient(app)
    r = client.post(
        "/api/v1/ai/suggest-optimization?namespace=web",
        headers={"Authorization": "Bearer tok", "X-Cluster-Name": "self"},
    )
    assert r.status_code == 200
    assert r.json() == {"suggestions": ["ok:web"]}
    assert builder_calls[-1]["cluster_name"] == "self"

    r = client.post("/api/v1/ai/suggest-optimization?namespace=web", headers={"Authorization": "Bearer tok"})
    assert r.status_code == 200
    assert builder_calls[-1]["cluster_name"] is None
