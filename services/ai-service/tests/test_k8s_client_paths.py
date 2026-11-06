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
    "get_pods": (lambda c, v, n: c.get_pods(v), "/namespaces/{v}/pods"),
    "describe_pod": (lambda c, v, n: c.describe_pod(v, n), "/namespaces/{v}/pods/{n}/describe"),
    "get_pod_logs": (lambda c, v, n: c.get_pod_logs(v, n), "/namespaces/{v}/pods/{n}/logs"),
    "get_deployments": (lambda c, v, n: c.get_deployments(v), "/namespaces/{v}/deployments"),
    "describe_deployment": (lambda c, v, n: c.describe_deployment(v, n), "/namespaces/{v}/deployments/{n}/describe"),
    "get_services": (lambda c, v, n: c.get_services(v), "/namespaces/{v}/services"),
    "describe_service": (lambda c, v, n: c.describe_service(v, n), "/namespaces/{v}/services/{n}/describe"),
    "check_service_connectivity": (lambda c, v, n: c.check_service_connectivity(v, n), "/namespaces/{v}/services/{n}/connectivity"),
    "get_events": (lambda c, v, n: c.get_events(v), "/namespaces/{v}/events"),
    "describe_node": (lambda c, v, n: c.describe_node(v), "/nodes/{v}/describe"),
}


def _path(raw: str) -> str:
    return raw.split("?")[0]


@pytest.mark.parametrize("method", CALLS)
@pytest.mark.parametrize("namespace, name", [("shop", "web-7d9f"), ("kube-system", "coredns.v1-2_x"), ("a.b", "ip-10-0-0-1.ec2.internal")])
async def test_ordinary_names_keep_the_path_they_always_had(k8s, method, namespace, name):
    call, template = CALLS[method]
    await call(k8s, namespace, name)
    assert [_path(p) for p in k8s.seen] == ["/api/v1" + template.format(v=namespace, n=name)]
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
    await call(k8s, value, "web")
    assert [_path(p) for p in k8s.seen] == ["/api/v1" + template.format(v=encoded, n="web")]
    assert "cluster=c1" in k8s.seen[0]


@pytest.mark.parametrize("method", [m for m, (_, t) in CALLS.items() if "{n}" in t])
async def test_a_second_value_with_path_characters_stays_one_segment(k8s, method):
    call, template = CALLS[method]
    await call(k8s, "shop", "a/../b?")
    assert [_path(p) for p in k8s.seen] == ["/api/v1" + template.format(v="shop", n="a%2F..%2Fb%3F")]


@pytest.mark.parametrize("method", CALLS)
@pytest.mark.parametrize("value", [".", ".."])
async def test_a_dot_segment_is_no_name_and_sends_nothing(k8s, method, value):
    call, _ = CALLS[method]
    with pytest.raises(ValueError):
        await call(k8s, value, "web")
    assert k8s.seen == []


async def test_get_events_without_a_namespace_keeps_its_own_route(k8s):
    await k8s.get_events(None)
    assert [_path(p) for p in k8s.seen] == ["/api/v1/events"]


async def test_a_dot_segment_answers_the_log_container_lookup_like_a_namespace_with_no_such_pod(k8s):
    assert await resolvers._pick_log_container(SimpleNamespace(k8s_service=k8s), "..", "web") == (None, None)
    assert k8s.seen == []
