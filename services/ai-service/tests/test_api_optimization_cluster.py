"""/suggest-optimization/stream builds the service for the cluster named in
X-Cluster-Name (the same header the chat streams send), so the observations come
from the selected cluster instead of the default one."""
import pytest
from fastapi.testclient import TestClient

from main import app
from app import api as api_module
from app.security import require_auth


stream_calls: list[dict] = []


class _StubService:
    async def suggest_optimization_stream(self, namespace, audit_actor=None, audit_http=None):
        stream_calls.append({"namespace": namespace, "audit_actor": audit_actor, "audit_http": audit_http})
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
    # The audit meta of the request reaches the stream (ai.chat.complete, phase optimization).
    assert stream_calls[-1]["namespace"] == "web"
    assert stream_calls[-1]["audit_http"]["path"] == "/api/v1/ai/suggest-optimization/stream"
    assert stream_calls[-1]["audit_actor"] == {}  # "tok" is not a valid token: no actor, no audit row


def test_stream_without_header_builds_service_for_the_default_cluster(builder_calls):
    r = TestClient(app).get(
        "/api/v1/ai/suggest-optimization/stream?namespace=web",
        headers={"Authorization": "Bearer tok"},
    )
    assert r.status_code == 200
    assert builder_calls[-1]["cluster_name"] is None
