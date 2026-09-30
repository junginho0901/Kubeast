"""H12: a request never sees another request's user or cluster.

The cached AIService only holds the LLM client; api._build_ai_service hands
each request a shallow copy carrying that request's token, role, cluster and
service clients. The HTTP connection pools are shared, the headers are not.
"""
import asyncio
import copy
from types import SimpleNamespace

import pytest

from app.services.ai_service import AIService
from app.services.http_shared import ScopedClient, shared_client
from app.services.k8s_client import K8sServiceClient
from app.services.tool_server_client import ToolServerClient


def _bare_service():
    svc = AIService.__new__(AIService)
    svc.client = object()  # stands in for the LLM client
    svc.model = "m"
    svc.provider = "openai"
    svc._provider_name = "openai"
    svc.tool_contexts = {}
    svc._token_payload = None
    svc.update_authorization(None, cluster_name=None)
    return svc


def test_copy_keeps_llm_client_and_separates_user_fields():
    shared = _bare_service()
    a = copy.copy(shared)
    a.update_authorization("Bearer token-a", cluster_name="cluster-a")
    b = copy.copy(shared)
    b.update_authorization("Bearer token-b", cluster_name="cluster-b")

    assert a.client is shared.client and b.client is shared.client
    assert a.tool_contexts is shared.tool_contexts
    assert a.cluster_name == "cluster-a" and b.cluster_name == "cluster-b"
    assert shared.cluster_name is None
    assert a.tool_server.client.headers["Authorization"] == "Bearer token-a"
    assert b.tool_server.client.headers["Authorization"] == "Bearer token-b"
    assert "Authorization" not in shared.tool_server.client.headers
    assert a.k8s_service.client.params["cluster"] == "cluster-a"
    assert b.k8s_service.client.params["cluster"] == "cluster-b"


@pytest.mark.asyncio
async def test_build_ai_service_returns_request_scoped_views(monkeypatch):
    from app import api

    built = []

    class FakeAIService(AIService):
        def __init__(self, **kwargs):  # no LLM client construction
            self.client = object()
            self.model = kwargs.get("model")
            self.provider = kwargs.get("provider")
            self._provider_name = self.provider
            self.tool_contexts = {}
            self._token_payload = None
            self.update_authorization(None, cluster_name=None)
            built.append(self)

    resolved = SimpleNamespace(provider="openai", model="m", base_url=None, api_key="k", extra_headers=None,
                               tls_verify=True, ca_cert=None, options=None)

    async def fake_resolve():
        return resolved

    import app.services.model_config_service as mcs
    import app.services.ai_service as ai_service_module
    monkeypatch.setattr(mcs, "resolve_model_config", fake_resolve)
    monkeypatch.setattr(ai_service_module, "AIService", FakeAIService)
    api._cached_ai_service = None
    api._cached_ai_config_hash = ""

    async def first():
        svc = await api._build_ai_service("Bearer token-a", cluster_name="cluster-a")
        await asyncio.sleep(0.05)  # "streaming" while the next request arrives
        return svc

    async def second():
        await asyncio.sleep(0.01)
        return await api._build_ai_service("Bearer token-b", cluster_name="cluster-b")

    a, b = await asyncio.gather(first(), second())

    assert len(built) == 1, "the LLM client is built once"
    assert a is not b and a is not built[0] and b is not built[0]
    assert a.client is b.client is built[0].client
    assert a.cluster_name == "cluster-a" and a.tool_server.client.headers["Authorization"] == "Bearer token-a"
    assert b.cluster_name == "cluster-b" and b.tool_server.client.headers["Authorization"] == "Bearer token-b"
    assert built[0].cluster_name is None and "Authorization" not in built[0].tool_server.client.headers


def test_service_clients_share_one_pool_per_upstream():
    k1 = K8sServiceClient(authorization="Bearer a", cluster_name="x")
    k2 = K8sServiceClient(authorization="Bearer b", cluster_name="y")
    assert isinstance(k1.client, ScopedClient)
    assert k1.client.pool is k2.client.pool
    assert k1.client.headers != k2.client.headers and k1.client.params != k2.client.params

    t1 = ToolServerClient(authorization="Bearer a")
    t2 = ToolServerClient(authorization="Bearer b")
    assert t1.client.pool is t2.client.pool
    assert t1.client.pool is not k1.client.pool
    assert shared_client(k1.client.base_url, k1.client.timeout) is k1.client.pool


@pytest.mark.asyncio
async def test_scoped_client_merges_headers_and_params():
    import httpx

    seen = {}

    async def handler(request: httpx.Request) -> httpx.Response:
        seen["auth"] = request.headers.get("authorization")
        seen["extra"] = request.headers.get("x-kubeast-approval-id")
        seen["url"] = str(request.url)
        return httpx.Response(200, json={"ok": True})

    scoped = ScopedClient("http://upstream", timeout=5.0, headers={"Authorization": "Bearer a"}, params={"cluster": "c"})
    from app.services import http_shared
    http_shared._pools[("http://upstream", 5.0)] = httpx.AsyncClient(
        base_url="http://upstream", transport=httpx.MockTransport(handler))
    try:
        r = await scoped.post("/tools/call", json={"n": 1}, headers={"X-Kubeast-Approval-Id": "ap-1"}, params={"q": "1"})
        assert r.status_code == 200
        assert seen["auth"] == "Bearer a" and seen["extra"] == "ap-1"
        assert "cluster=c" in seen["url"] and "q=1" in seen["url"]
    finally:
        await http_shared.close_shared_clients()
