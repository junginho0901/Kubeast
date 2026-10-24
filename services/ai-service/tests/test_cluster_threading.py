"""step 14: the active cluster must thread into tool calls.

Run where app.config.settings loads (CI / the deployed pod), e.g.:
    kubectl exec deploy/ai-service -n kubeast -- python -m pytest tests/test_cluster_threading.py -q
"""
import pytest

from app.services.ai_service import AIService
from app.services.k8s_client import K8sServiceClient


def _bare_service(cluster_name):
    """An AIService without the heavy LLM init — just the cluster field."""
    svc = AIService.__new__(AIService)
    svc.cluster_name = cluster_name
    return svc


@pytest.mark.asyncio
async def test_call_tool_server_threads_active_cluster():
    svc = _bare_service("prod")
    captured = {}

    class FakeToolServer:
        async def call_tool(self, name, args, headers=None):
            captured["name"] = name
            captured["args"] = args
            return "ok"

    svc.tool_server = FakeToolServer()

    await svc._call_tool_server("k8s_get_pods", {"namespace": "default"})
    assert captured["args"]["cluster"] == "prod"
    # the original args must not be mutated
    assert "cluster" not in {"namespace": "default"}


@pytest.mark.asyncio
async def test_model_supplied_cluster_is_overridden():
    # C1: the model never picks the target cluster — the active one always wins.
    svc = _bare_service("prod")
    captured = {}

    class FakeToolServer:
        async def call_tool(self, name, args, headers=None):
            captured["args"] = args
            return "ok"

    svc.tool_server = FakeToolServer()

    await svc._call_tool_server("x", {"cluster": "dev"})
    assert captured["args"]["cluster"] == "prod"


@pytest.mark.asyncio
async def test_default_cluster_when_none_selected():
    svc = _bare_service(None)
    captured = {}

    class FakeToolServer:
        async def call_tool(self, name, args, headers=None):
            captured["args"] = args
            return "ok"

    svc.tool_server = FakeToolServer()

    await svc._call_tool_server("x", {"namespace": "ns"})
    assert captured["args"]["cluster"] == "default"


def test_k8s_client_sets_cluster_query_param():
    client = K8sServiceClient(cluster_name="prod")
    assert client.client.params.get("cluster") == "prod"

    no_cluster = K8sServiceClient()
    assert "cluster" not in no_cluster.client.params


@pytest.mark.asyncio
async def test_a_scope_refusal_is_a_forbidden_result_not_a_call():
    # The model gets the reason; the call's audit row reads failure (streaming.tool_outcome), not success.
    import json
    from types import SimpleNamespace

    from app.services.ai.streaming import tool_outcome

    svc = _bare_service("prod")
    svc._token_payload = SimpleNamespace(namespaces={"prod": ("web",)}, allowed_in=lambda cluster, ns: ns == "web")
    calls = []

    class FakeToolServer:
        async def call_tool(self, name, args, headers=None):
            calls.append(name)
            return "ok"

    svc.tool_server = FakeToolServer()
    out = await svc._call_tool_server("k8s_get_resources", {"namespace": "db"})
    assert calls == []
    assert json.loads(out) == {"status": "forbidden", "message": "forbidden: namespace 'db' is outside your grant on prod (web)"}
    assert tool_outcome(out) == ("failure", "forbidden", "forbidden")
    assert await svc._call_tool_server("k8s_get_resources", {"namespace": "web"}) == "ok"
