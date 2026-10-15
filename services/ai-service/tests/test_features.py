# Feature gate: prometheus_query and logsearch are offered only where the
# cluster serves them; the other tools pass untouched; an unreachable
# k8s-service keeps the gated tools out; features are cached per cluster.

from types import SimpleNamespace
from unittest.mock import AsyncMock

import pytest

from app.services.ai import features
from app.services.ai.tools import K8S_READONLY_TOOLS


def _tools(*names):
    return [{"type": "function", "function": {"name": n, "parameters": {}}} for n in names]


def _names(tools):
    return [t["function"]["name"] for t in tools]


@pytest.fixture(autouse=True)
def _clear_cache():
    features.clear_cache()
    yield
    features.clear_cache()


def test_gated_names_by_feature_and_cluster():
    feats = {"prometheus": {"enabled": True}, "logSearch": {"enabled": True, "clusters": ["self"]}}
    names = ["k8s_get_resources", "issues", "prometheus_query", "logsearch"]
    assert features.gated_names(names, feats, "self") == names
    assert features.gated_names(names, feats, "other") == ["k8s_get_resources", "issues", "prometheus_query"]
    assert features.gated_names(names, {"prometheus": {"enabled": False}, "logSearch": {"enabled": False}}, "self") == ["k8s_get_resources", "issues"]
    # k8s-service did not answer: the gated tools stay out, the rest stay in.
    assert features.gated_names(names, None, "self") == ["k8s_get_resources", "issues"]
    # The gate knows every feature tool the whitelist carries.
    gated = {t["function"]["name"] for t in K8S_READONLY_TOOLS if t["function"]["name"] in features.GATES}
    assert gated == {"prometheus_query", "logsearch", "cost", "policy_reports"}
    feats = {"cost": {"enabled": True}, "policyReports": {"enabled": False}}
    assert features.gated_names(["cost", "policy_reports", "helm_read"], feats, "self") == ["cost", "helm_read"]


class _Token:
    """A token with the given cluster permissions and optional global ones."""

    def __init__(self, cluster_perms, global_perms=()):
        self.cluster_perms = set(cluster_perms)
        self.global_perms = set(global_perms)

    def has_permission(self, perm):
        return "*" in self.global_perms or perm in self.global_perms

    def has_permission_for_cluster(self, perm, cluster):
        return self.has_permission(perm) or perm in self.cluster_perms


def test_permission_gate_follows_what_k8s_service_asks_for():
    feats = {"prometheus": {"enabled": True}, "logSearch": {"enabled": True, "clusters": ["self"]}, "cost": {"enabled": True}, "policyReports": {"enabled": True}}
    names = ["issues", "hygiene", "policy_reports", "helm_read", "cost", "can_i"]
    # No token (legacy role mode): nothing is hidden by permission.
    assert features.gated_names(names, feats, "self") == names
    reader = _Token({"resource.helm.read", "resource.policyreport.read", "resource.cost.read"})
    assert features.gated_names(names, feats, "self", reader) == ["issues", "policy_reports", "helm_read", "cost", "can_i"]
    bare = _Token({"ai.tool.*"})
    assert features.gated_names(names, feats, "self", bare) == ["issues", "can_i"]
    admin = _Token(set(), {"*"})
    assert features.gated_names(names, feats, "self", admin) == names
    hygiene_only = _Token(set(), {"admin.hygiene.read"})
    assert "hygiene" in features.gated_names(names, feats, "self", hygiene_only)
    assert "helm_read" not in features.gated_names(names, feats, "self", hygiene_only)
    # filter_tools applies the same rule to tool definitions, in order.
    tools = _tools("hygiene", "k8s_get_pod_logs", "cost")
    assert _names(features.filter_tools(tools, feats, "self", reader)) == ["k8s_get_pod_logs", "cost"]


@pytest.mark.asyncio
async def test_gate_tools_skips_the_features_call_when_no_permitted_feature_tool_remains():
    k8s = SimpleNamespace(get_features=AsyncMock(return_value={}))
    service = SimpleNamespace(cluster_name="c1", k8s_service=k8s, token=_Token({"ai.tool.*"}))
    out = await features.gate_tools(_tools("issues", "cost", "hygiene", "helm_read"), service)
    assert _names(out) == ["issues"]
    k8s.get_features.assert_not_called()


def test_filter_tools_keeps_order_and_ungated_tools():
    tools = _tools("get_cluster_overview", "prometheus_query", "k8s_get_pod_logs", "logsearch", "issues")
    out = features.filter_tools(tools, {"prometheus": {"enabled": True}, "logSearch": {"enabled": False}}, "self")
    assert _names(out) == ["get_cluster_overview", "prometheus_query", "k8s_get_pod_logs", "issues"]
    assert _names(features.filter_tools(tools, None, "self")) == ["get_cluster_overview", "k8s_get_pod_logs", "issues"]


@pytest.mark.asyncio
async def test_gate_tools_fetches_once_per_cluster_and_caches():
    k8s = SimpleNamespace(get_features=AsyncMock(return_value={"prometheus": {"enabled": True}, "logSearch": {"enabled": True, "clusters": ["c1"]}}))
    service = SimpleNamespace(cluster_name="c1", k8s_service=k8s)
    tools = _tools("issues", "prometheus_query", "logsearch")
    assert _names(await features.gate_tools(tools, service)) == ["issues", "prometheus_query", "logsearch"]
    assert _names(await features.gate_tools(tools, service)) == ["issues", "prometheus_query", "logsearch"]
    assert k8s.get_features.await_count == 1

    other = SimpleNamespace(cluster_name="c2", k8s_service=SimpleNamespace(get_features=AsyncMock(return_value={"prometheus": {"enabled": True}, "logSearch": {"enabled": True, "clusters": ["c1"]}})))
    assert _names(await features.gate_tools(tools, other)) == ["issues", "prometheus_query"]


@pytest.mark.asyncio
async def test_gate_tools_without_feature_tools_does_not_call_k8s():
    k8s = SimpleNamespace(get_features=AsyncMock(return_value={}))
    service = SimpleNamespace(cluster_name="c1", k8s_service=k8s)
    tools = _tools("k8s_get_resources", "issues")
    assert _names(await features.gate_tools(tools, service)) == ["k8s_get_resources", "issues"]
    k8s.get_features.assert_not_called()


@pytest.mark.asyncio
async def test_gate_tools_when_k8s_service_fails_drops_feature_tools():
    k8s = SimpleNamespace(get_features=AsyncMock(side_effect=Exception("connection refused")))
    service = SimpleNamespace(cluster_name="c1", k8s_service=k8s)
    out = await features.gate_tools(_tools("issues", "prometheus_query", "logsearch", "k8s_get_events"), service)
    assert _names(out) == ["issues", "k8s_get_events"]
    # A failure is not cached: the next build asks again.
    assert k8s.get_features.await_count == 1
    await features.gate_tools(_tools("prometheus_query"), service)
    assert k8s.get_features.await_count == 2
