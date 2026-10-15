# Dispatch of the arguments the log, event, find and explain tools gained: the
# chat passes them through to tool-server untouched, and a pod the resolver
# cannot place is left to tool-server (which answers not_found with similar
# names) instead of failing in ai-service.

import json
from types import SimpleNamespace
from unittest.mock import AsyncMock, MagicMock

import pytest

from app.services.ai import resolvers
from app.services.ai.tool_dispatch import execute_function_with_context


def _service():
    service = SimpleNamespace()
    service.user_role = "admin"
    service._is_tool_allowed = MagicMock(return_value=True)
    service._call_tool_server = AsyncMock(return_value='{"ok": true}')
    service.k8s_service = MagicMock()
    return service


def _ctx():
    return SimpleNamespace(state={}, cache={})


@pytest.mark.asyncio
async def test_pod_logs_passes_flags_and_skips_container_pick_for_all_containers():
    service = _service()
    args = {"pod_name": "web-1", "namespace": "shop", "previous": True, "since": "10m", "all_containers": "true", "grep": "error", "tail_lines": 20}
    await execute_function_with_context(service, "k8s_get_pod_logs", args, _ctx())
    service._call_tool_server.assert_awaited_once_with(
        "k8s_get_pod_logs",
        {"namespace": "shop", "pod_name": "web-1", "tail_lines": 20, "container": None, "previous": True, "all_containers": True, "since": "10m", "grep": "error"},
    )
    # all_containers: no container was picked (that needs a k8s-service call).
    service.k8s_service.get_pods.assert_not_called()


@pytest.mark.asyncio
async def test_pod_logs_plain_call_unchanged():
    service = _service()
    await execute_function_with_context(service, "k8s_get_pod_logs", {"pod_name": "web-1", "namespace": "shop", "container": "app"}, _ctx())
    service._call_tool_server.assert_awaited_once_with(
        "k8s_get_pod_logs", {"namespace": "shop", "pod_name": "web-1", "tail_lines": 50, "container": "app"},
    )


@pytest.mark.asyncio
async def test_pod_logs_unplaced_pod_goes_to_tool_server(monkeypatch):
    """No namespace and the resolver finds nothing: tool-server gets the call
    and answers not_found with the similar names — no error from ai-service."""
    service = _service()
    monkeypatch.setattr(resolvers, "_find_pods", AsyncMock(return_value=[]))
    service._call_tool_server = AsyncMock(return_value=json.dumps({"status": "not_found", "similar": [{"namespace": "shop", "name": "web-7d9f8c6b5-x2k9p"}]}))
    result = await execute_function_with_context(service, "k8s_get_pod_logs", {"pod_name": "web"}, _ctx())
    service._call_tool_server.assert_awaited_once_with(
        "k8s_get_pod_logs", {"namespace": None, "pod_name": "web", "tail_lines": 50, "container": None},
    )
    assert json.loads(result)["status"] == "not_found"


@pytest.mark.asyncio
async def test_pod_logs_multi_container_answers_container_required(monkeypatch):
    service = _service()
    monkeypatch.setattr(resolvers, "_pick_log_container", AsyncMock(return_value=(None, ["app", "sidecar"])))
    result = await execute_function_with_context(service, "k8s_get_pod_logs", {"pod_name": "web-1", "namespace": "shop"}, _ctx())
    body = json.loads(result)
    assert body["status"] == "container_required" and body["containers"] == ["app", "sidecar"]
    service._call_tool_server.assert_not_called()


@pytest.mark.asyncio
async def test_events_passes_selectors():
    service = _service()
    await execute_function_with_context(
        service, "k8s_get_events", {"namespace": "shop", "kind": "Pod", "name": "web-1", "field_selector": "type=Warning", "all_namespaces": False}, _ctx(),
    )
    service._call_tool_server.assert_awaited_once_with(
        "k8s_get_events", {"namespace": "shop", "kind": "Pod", "name": "web-1", "field_selector": "type=Warning"},
    )
    service._call_tool_server.reset_mock()
    await execute_function_with_context(service, "k8s_get_events", {"all_namespaces": True}, _ctx())
    service._call_tool_server.assert_awaited_once_with("k8s_get_events", {"namespace": None, "all_namespaces": True})


@pytest.mark.asyncio
async def test_find_resource_and_explain_pass_through():
    service = _service()
    await execute_function_with_context(
        service, "k8s_find_resource", {"query": " web ", "kinds": ["pods", "", "deployments"], "namespace": "shop", "limit": 500}, _ctx(),
    )
    service._call_tool_server.assert_awaited_once_with(
        "k8s_find_resource", {"query": "web", "kinds": ["pods", "deployments"], "namespace": "shop", "limit": 50},
    )
    service._call_tool_server.reset_mock()
    await execute_function_with_context(service, "k8s_find_resource", {"query": "app=web"}, _ctx())
    service._call_tool_server.assert_awaited_once_with("k8s_find_resource", {"query": "app=web"})

    service._call_tool_server.reset_mock()
    await execute_function_with_context(
        service, "k8s_explain", {"resource": "deployments.spec.strategy", "api_version": "apps/v1", "recursive": "true"}, _ctx(),
    )
    service._call_tool_server.assert_awaited_once_with(
        "k8s_explain", {"resource": "deployments.spec.strategy", "api_version": "apps/v1", "recursive": True},
    )


@pytest.mark.asyncio
async def test_feature_tools_pass_declared_arguments_only():
    service = _service()
    await execute_function_with_context(
        service, "prometheus_query", {"promql": " up ", "range": "true", "since": "2h", "step": "30", "cluster": "x", "bogus": 1}, _ctx(),
    )
    service._call_tool_server.assert_awaited_once_with("prometheus_query", {"promql": "up", "since": "2h", "range": True, "step": 30})

    service._call_tool_server.reset_mock()
    await execute_function_with_context(
        service, "logsearch", {"namespace": "shop", "text": "error", "regex": False, "workload_kind": "Deployment", "workload_name": "web", "limit": 50}, _ctx(),
    )
    service._call_tool_server.assert_awaited_once_with(
        "logsearch", {"namespace": "shop", "text": "error", "workload_kind": "Deployment", "workload_name": "web", "limit": 50},
    )

    service._call_tool_server.reset_mock()
    await execute_function_with_context(service, "issues", {"severity": "critical", "window_minutes": 90}, _ctx())
    service._call_tool_server.assert_awaited_once_with("issues", {"severity": "critical", "window_minutes": 90})

    service._call_tool_server.reset_mock()
    await execute_function_with_context(service, "issues", {}, _ctx())
    service._call_tool_server.assert_awaited_once_with("issues", {})


@pytest.mark.asyncio
async def test_new_read_tools_are_cached_like_the_others():
    service = _service()
    ctx = _ctx()
    await execute_function_with_context(service, "k8s_explain", {"resource": "pods"}, ctx)
    await execute_function_with_context(service, "k8s_explain", {"resource": "pods"}, ctx)
    assert service._call_tool_server.await_count == 1
