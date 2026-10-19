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

    # chart makes it a range query; chart, title and unit stay in ai-service (the chart is drawn from the result).
    service._call_tool_server.reset_mock()
    await execute_function_with_context(service, "prometheus_query", {"promql": "up", "chart": "true", "title": "t", "unit": "bytes"}, _ctx())
    service._call_tool_server.assert_awaited_once_with("prometheus_query", {"promql": "up", "range": True})

    # The discovery tools and the absolute window pass their own arguments, nothing else.
    for tool, given, sent in [
        ("prometheus_query", {"promql": "up", "since_time": "2d", "until_time": "2026-10-19T00:00:00Z", "namespace": "x"},
         {"promql": "up", "since_time": "2d", "until_time": "2026-10-19T00:00:00Z"}),
        ("prometheus_metrics", {"pattern": " memory ", "limit": "20", "promql": "x"}, {"pattern": "memory", "limit": 20}),
        ("prometheus_labels", {"selector": 'up{job="k"}', "label": "pod", "since": "6h", "limit": 50, "bogus": 1},
         {"selector": 'up{job="k"}', "label": "pod", "since": "6h", "limit": 50}),
        ("prometheus_rules", {"rule": "Crash", "rule_type": "alert", "active_only": "true", "limit": 3},
         {"rule": "Crash", "rule_type": "alert", "active_only": True}),
        ("prometheus_targets", {"health": "down", "job": "kubelet", "cluster": "y"}, {"health": "down", "job": "kubelet"}),
        ("loki_query", {"logql": ' sum(count_over_time({app="web"}[5m])) ', "namespace": "shop", "since_time": "2d", "step": "60", "limit": 20, "promql": "x"},
         {"logql": 'sum(count_over_time({app="web"}[5m]))', "namespace": "shop", "since_time": "2d", "step": 60, "limit": 20}),
        ("loki_labels", {"label": "k8s_pod_name", "namespace": "shop", "since": "6h", "limit": 5}, {"label": "k8s_pod_name", "namespace": "shop", "since": "6h"}),
        ("loki_patterns", {"selector": '{app="web"}', "since": "3h", "logql": "x"}, {"selector": '{app="web"}', "since": "3h"}),
        ("traces_search", {"traceql": ' { status = error } ', "namespace": "shop", "limit": "5", "logql": "x"}, {"traceql": "{ status = error }", "namespace": "shop", "limit": 5}),
        ("traces_get", {"trace_id": "4bf92f3577b34da6", "since": "1h"}, {"trace_id": "4bf92f3577b34da6"}),
        ("traces_tags", {"scope": "span", "tag": "span.http.route", "limit": 3}, {"scope": "span", "tag": "span.http.route"}),
        ("traces_metrics", {"traceql": "{} | rate()", "since_time": "2d", "step": "60", "chart": True}, {"traceql": "{} | rate()", "since_time": "2d", "step": 60}),
        ("traces_compare", {"traceql": "{ kind = server }", "limit": 50}, {"traceql": "{ kind = server }", "limit": 50}),
        ("alerts_list", {"state": "all", "alertname": "KubePodCrashLooping", "alert_labels": {"severity": "critical", "n": 3, "x": {"y": 1}}, "namespace": "shop"},
         {"state": "all", "alertname": "KubePodCrashLooping", "alert_labels": {"severity": "critical", "n": "3"}}),
    ]:
        service._call_tool_server.reset_mock()
        await execute_function_with_context(service, tool, given, _ctx())
        service._call_tool_server.assert_awaited_once_with(tool, sent)

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
async def test_second_batch_feature_tools_pass_declared_arguments_only():
    service = _service()
    await execute_function_with_context(
        service, "helm_read", {"what": "diff", "namespace": "kubeast", "release": "kubeast", "from": "5", "to": 6, "section": "values", "cluster": "x", "values": {"a": 1}}, _ctx(),
    )
    service._call_tool_server.assert_awaited_once_with(
        "helm_read", {"what": "diff", "namespace": "kubeast", "release": "kubeast", "section": "values", "from": 5, "to": 6},
    )
    for name, args, expected in [
        ("policy_reports", {"view": "results", "results": "fail,warn", "limit": 50, "force_refresh": True}, {"view": "results", "results": "fail,warn", "limit": 50}),
        ("cost", {"window": "7d", "aggregate": "controller", "namespace": " shop "}, {"window": "7d", "aggregate": "controller", "namespace": "shop"}),
        ("optimization", {"namespace": "shop", "window_hours": 48}, {"namespace": "shop", "window_hours": 48}),
        ("can_i", {"verb": "delete", "resource": "pods", "namespace": "shop", "group": ""}, {"verb": "delete", "resource": "pods", "namespace": "shop"}),
        ("resource_graph", {"namespace": "shop", "depth": 3}, {"namespace": "shop"}),
        ("hygiene", {"severity": "critical", "check": "pss-level"}, {"severity": "critical", "check": "pss-level"}),
    ]:
        service._call_tool_server.reset_mock()
        await execute_function_with_context(service, name, args, _ctx())
        service._call_tool_server.assert_awaited_once_with(name, expected)


@pytest.mark.asyncio
async def test_query_and_diff_tools_pass_declared_arguments_only():
    service = _service()
    await execute_function_with_context(
        service, "k8s_jq_query", {"resource_type": "pods", "jq": ".items[].metadata.name", "namespace": "shop", "label_selector": "app=web", "limit": 10, "output": "json"}, _ctx(),
    )
    service._call_tool_server.assert_awaited_once_with(
        "k8s_jq_query", {"resource_type": "pods", "jq": ".items[].metadata.name", "namespace": "shop", "label_selector": "app=web", "limit": 10},
    )
    service._call_tool_server.reset_mock()
    await execute_function_with_context(service, "k8s_count", {"resource_type": "pods", "group_by": ".status.phase"}, _ctx())
    service._call_tool_server.assert_awaited_once_with("k8s_count", {"resource_type": "pods", "group_by": ".status.phase"})
    service._call_tool_server.reset_mock()
    await execute_function_with_context(service, "k8s_tabular_query", {"resource_type": "nodes", "columns": "NAME:.metadata.name", "sort_by": ".metadata.name", "limit": 5}, _ctx())
    service._call_tool_server.assert_awaited_once_with("k8s_tabular_query", {"resource_type": "nodes", "columns": "NAME:.metadata.name", "sort_by": ".metadata.name", "limit": 5})

    service._call_tool_server.reset_mock()
    manifest = "apiVersion: v1\nkind: ConfigMap\nmetadata:\n  name: a\n"
    await execute_function_with_context(service, "k8s_diff", {"yaml_content": manifest, "namespace": " shop ", "dry_run": True}, _ctx())
    service._call_tool_server.assert_awaited_once_with("k8s_diff", {"yaml_content": manifest, "namespace": "shop"})
    service._call_tool_server.reset_mock()
    await execute_function_with_context(service, "k8s_diff", {"resource_manifest": {"kind": "ConfigMap"}}, _ctx())
    service._call_tool_server.assert_awaited_once_with("k8s_diff", {"resource_manifest": {"kind": "ConfigMap"}})


@pytest.mark.asyncio
async def test_gitops_and_admin_tools_pass_declared_arguments_only():
    service = _service()
    await execute_function_with_context(
        service, "gitops_status", {"namespace": "argocd", "project": "shop", "only_problems": True, "limit": 20, "bogus": 1}, _ctx(),
    )
    service._call_tool_server.assert_awaited_once_with("gitops_status", {"namespace": "argocd", "project": "shop", "only_problems": True, "limit": 20})
    service._call_tool_server.reset_mock()
    await execute_function_with_context(
        service, "audit_search", {"audit_action": "k8s.pod.delete", "since_time": "24h", "result": "failure", "all_clusters": True, "limit": 10, "offset": 20}, _ctx(),
    )
    service._call_tool_server.assert_awaited_once_with(
        "audit_search", {"audit_action": "k8s.pod.delete", "since_time": "24h", "result": "failure", "all_clusters": True, "limit": 10, "offset": 20},
    )
    service._call_tool_server.reset_mock()
    await execute_function_with_context(service, "nodes_stats_summary", {"node": "n1", "rank_by": "cpu", "top": 5}, _ctx())
    service._call_tool_server.assert_awaited_once_with("nodes_stats_summary", {"node": "n1", "rank_by": "cpu", "top": 5})
    service._call_tool_server.reset_mock()
    await execute_function_with_context(service, "nodes_log", {"node": "n1", "source": "kubelet", "pattern": "error", "tail_lines": 100, "boot": -1}, _ctx())
    service._call_tool_server.assert_awaited_once_with("nodes_log", {"node": "n1", "source": "kubelet", "pattern": "error", "tail_lines": 100, "boot": -1})


@pytest.mark.asyncio
async def test_new_read_tools_are_cached_like_the_others():
    service = _service()
    ctx = _ctx()
    await execute_function_with_context(service, "k8s_explain", {"resource": "pods"}, ctx)
    await execute_function_with_context(service, "k8s_explain", {"resource": "pods"}, ctx)
    assert service._call_tool_server.await_count == 1
