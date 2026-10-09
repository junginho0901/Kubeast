"""A request without X-Cluster-Name runs against the cluster k8s-service
resolves (its registry default), not a cluster that happens to be called
"default": permissions, tool calls and audit rows all name that one."""
from types import SimpleNamespace

import httpx
import pytest
from fastapi import HTTPException

from app.services.ai.permissions import effective_cluster, scope_tool_args
from app.services.ai_service import AIService
from app.services.k8s_client import K8sServiceClient


@pytest.fixture
def builder(monkeypatch):
    from app import api

    class FakeAIService(AIService):
        def __init__(self, **kwargs):  # no LLM client construction
            self.client = object()
            self.model = kwargs.get("model")
            self.provider = kwargs.get("provider")
            self._provider_name = self.provider
            self.tool_contexts = {}
            self._token_payload = None
            self.update_authorization(None, cluster_name=None)

    resolved = SimpleNamespace(provider="openai", model="m", base_url=None, api_key="k", extra_headers=None,
                               tls_verify=True, ca_cert=None, options=None)

    async def fake_resolve():
        return resolved

    import app.services.ai_service as ai_service_module
    import app.services.model_config_service as mcs
    monkeypatch.setattr(mcs, "resolve_model_config", fake_resolve)
    monkeypatch.setattr(ai_service_module, "AIService", FakeAIService)
    api._cached_ai_service = None
    api._cached_ai_config_hash = ""
    return api


@pytest.mark.asyncio
async def test_missing_cluster_takes_the_resolved_default(builder, monkeypatch):
    async def current(self):
        return "self"

    monkeypatch.setattr(K8sServiceClient, "get_current_cluster", current)
    svc = await builder._build_ai_service("Bearer t")

    assert svc.cluster_name == "self"
    assert effective_cluster(svc) == "self"
    assert scope_tool_args({"namespace": "kube-system"}, effective_cluster(svc))[0]["cluster"] == "self"
    assert svc.k8s_service.client.params["cluster"] == "self"


@pytest.mark.asyncio
async def test_named_cluster_is_not_looked_up(builder, monkeypatch):
    async def current(self):
        raise AssertionError("a named cluster needs no lookup")

    monkeypatch.setattr(K8sServiceClient, "get_current_cluster", current)
    svc = await builder._build_ai_service("Bearer t", cluster_name="alpha")
    assert svc.cluster_name == "alpha"


@pytest.mark.asyncio
async def test_no_access_to_the_default_is_refused(builder, monkeypatch):
    async def current(self):
        request = httpx.Request("GET", "http://k8s-service:8002/api/v1/current")
        response = httpx.Response(403, json={"detail": "forbidden: no access to cluster self"}, request=request)
        raise httpx.HTTPStatusError("403", request=request, response=response)

    monkeypatch.setattr(K8sServiceClient, "get_current_cluster", current)
    with pytest.raises(HTTPException) as exc:
        await builder._build_ai_service("Bearer t")
    assert exc.value.status_code == 403
    assert "no access to cluster self" in exc.value.detail
