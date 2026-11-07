"""Values in the k8s-service client's paths stay one path segment: a name never reaches another route."""
from types import SimpleNamespace

import httpx
import pytest

from app.services import http_shared
from app.services.ai import resolvers
from app.services.k8s_client import K8S_SERVICE_URL, K8sServiceClient


@pytest.fixture
def k8s(monkeypatch):
    client = K8sServiceClient(authorization="Bearer not-a-real-token", cluster_name="c1")
    client.seen = []

    def answer(request: httpx.Request) -> httpx.Response:
        client.seen.append(request.url.raw_path.decode())
        return httpx.Response(200, json={})

    pool = httpx.AsyncClient(base_url=K8S_SERVICE_URL, transport=httpx.MockTransport(answer))
    monkeypatch.setitem(http_shared._pools, (K8S_SERVICE_URL, 30.0), pool)
    return client


CALLS = {
    "get_pods": (lambda c, v: c.get_pods(v), "/namespaces/{v}/pods"),
    "get_services": (lambda c, v: c.get_services(v), "/namespaces/{v}/services"),
}


def _path(raw: str) -> str:
    return raw.split("?")[0]


@pytest.mark.parametrize("method", CALLS)
@pytest.mark.parametrize("namespace", ["shop", "kube-system", "a.b"])
async def test_ordinary_names_keep_the_path_they_always_had(k8s, method, namespace):
    call, template = CALLS[method]
    await call(k8s, namespace)
    assert [_path(p) for p in k8s.seen] == ["/api/v1" + template.format(v=namespace)]
    assert "cluster=c1" in k8s.seen[0]


@pytest.mark.parametrize("method", CALLS)
@pytest.mark.parametrize("value, encoded", [
    ("a/b/c?", "a%2Fb%2Fc%3F"),
    ("a?x=1", "a%3Fx%3D1"),
    ("a#b", "a%23b"),
    ("a b", "a%20b"),
    ("a%2Fb", "a%252Fb"),
    ("a\\b", "a%5Cb"),
])
async def test_a_value_with_path_characters_stays_one_segment(k8s, method, value, encoded):
    call, template = CALLS[method]
    await call(k8s, value)
    assert [_path(p) for p in k8s.seen] == ["/api/v1" + template.format(v=encoded)]
    assert "cluster=c1" in k8s.seen[0]


@pytest.mark.parametrize("method", CALLS)
@pytest.mark.parametrize("value", [".", ".."])
async def test_a_dot_segment_is_no_name_and_sends_nothing(k8s, method, value):
    call, _ = CALLS[method]
    with pytest.raises(ValueError):
        await call(k8s, value)
    assert k8s.seen == []


async def test_a_dot_segment_answers_the_log_container_lookup_like_a_namespace_with_no_such_pod(k8s):
    assert await resolvers._pick_log_container(SimpleNamespace(k8s_service=k8s), "..", "web") == (None, None)
    assert k8s.seen == []
