"""Six reads of what a screen computes (pod_rbac, logfiles, storage_summary, network_policy_effective,
limit_range_violations, alerts_inbox) and the namespace gate that tool-server keeps too.

The answers are tool-server's (handlers_screen_reads_test.go). Here: who is offered them, what travels, how the row
reads, and that this side refuses a limited grant exactly what tool-server refuses it."""
import json
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import AsyncMock, MagicMock

import pytest

from app import mcp_server
from app.security import TokenPayload
from app.services.ai import features, permissions, screen_permissions
from app.services.ai import tools as catalog
from app.services.ai.tool_dispatch import FEATURE_TOOL_ARGS, execute_function_with_context
from app.services.ai_service import AIService
from app.services.audit_target import tool_target
from app.services.tool_whitelists import READONLY_TOOL_NAMES, WRITE_TOOL_NAMES, readonly_tool_filter
from tests.test_tool_app_permissions import CLUSTER, SCREEN, WRITE_ROLE, _admin, _chat_call, _token, _ToolServer, mcp, rows  # noqa: F401

# tool → what its screen's route asks; [] = the route leaves it to the cluster's RBAC.
ASKS = {
    "pod_rbac": ["resource.objects.read"],
    "storage_summary": ["resource.objects.read"],
    "limit_range_violations": ["resource.objects.read"],
    "logfiles": ["resource.pod.logfile"],
    "network_policy_effective": ["resource.networkpolicy.read"],
    "alerts_inbox": ["resource.pod.read"],
}
TOOLS = sorted(ASKS)
GATE_CASES = json.loads((Path(__file__).parent / "fixtures" / "namespace_gate_cases.json").read_text())
THE_FIVE = ("k8s_explain", "issues", "cost", "gitops_status", "k8s_find_resource")


def _catalog():
    return catalog.get_tools_definition(SimpleNamespace(_filter_tools_by_role=lambda tools: tools))


def _definition(name):
    return next((t["function"] for t in _catalog() if t["function"]["name"] == name), None)


def _scoped(perms=("*",), namespaces=("shop", "web")):
    return TokenPayload(user_id="u1", role="member", email="s@example.com", matrix={CLUSTER: tuple(perms)}, namespaces={CLUSTER: tuple(namespaces)})


@pytest.mark.parametrize("tool", TOOLS)
def test_it_is_a_read_tool_in_every_list(tool):
    assert tool in READONLY_TOOL_NAMES and tool not in WRITE_TOOL_NAMES
    assert _definition(tool) is not None
    assert tool in {t["function"]["name"] for t in readonly_tool_filter(_catalog())}
    assert tool in mcp_server.READ_TOOLS and mcp_server.READ_TOOLS[tool].annotations.read_only_hint is True
    assert "cluster" in mcp_server.READ_TOOLS[tool].input_schema["required"]


@pytest.mark.parametrize("tool", TOOLS)
def test_what_the_definition_offers_is_what_travels(tool):
    definition = _definition(tool)
    assert definition is not None
    strings, flags, ints = FEATURE_TOOL_ARGS[tool]
    assert set(definition["parameters"]["properties"]) == strings | flags | ints


def test_nothing_in_the_inbox_tool_can_set_a_mark():
    definition = _definition("alerts_inbox")
    assert definition is not None
    assert not set(definition["parameters"]["properties"]) & {"acknowledged", "assignee", "note", "done"}


@pytest.mark.parametrize("tool", TOOLS)
def test_the_table_says_what_the_screen_asks(tool):
    assert screen_permissions.app_permissions(tool, {}) == ASKS[tool]
    assert tool in SCREEN["tools"]
    if ASKS[tool]:
        assert features.REQUIRED_PERMISSIONS.get(tool) == ("cluster", ASKS[tool][0])
    else:
        assert tool not in features.REQUIRED_PERMISSIONS


@pytest.mark.parametrize("perms,allowed", [
    (("ai.tool.*",), set()),
    (("ai.tool.*", "resource.objects.read"), {"pod_rbac", "storage_summary", "limit_range_violations"}),
    (("ai.tool.*", "resource.pod.logfile"), {"logfiles"}),
    (("ai.tool.*", "resource.networkpolicy.read"), {"network_policy_effective"}),
    (("ai.tool.*", "resource.pod.read"), {"alerts_inbox"}),
    (tuple(SCREEN["read_role"]), set(TOOLS)),
    (tuple(SCREEN["write_role"]), set(TOOLS)),
    (("resource.pod.logfile", "resource.pod.read", "resource.networkpolicy.read"), set()),
])
def test_who_may_call_them(perms, allowed):
    token = _token(perms)
    assert {t for t in TOOLS if permissions.token_may_call(token, CLUSTER, t)} == allowed
    assert {t for t in TOOLS if permissions.token_may_call(token, CLUSTER, t, {"namespace": "shop"})} == allowed


def test_a_global_admin_may_call_them_and_another_clusters_grant_does_not_count():
    assert all(permissions.token_may_call(_admin(), CLUSTER, t) for t in TOOLS)
    elsewhere = TokenPayload(user_id="u1", role="member", matrix={"prod": ("ai.tool.*", "resource.pod.logfile", "resource.pod.read")})
    assert not any(permissions.token_may_call(elsewhere, CLUSTER, t) for t in TOOLS)


@pytest.mark.parametrize("feature,offered", [
    ({"logFiles": {"enabled": True}}, True),
    ({"logFiles": {"enabled": False}}, False),
    ({}, False),
    (None, False),  # k8s-service did not answer
])
def test_log_files_are_left_out_where_the_tab_is(feature, offered):
    assert ("logfiles" in features.gated_names(["logfiles"], feature, CLUSTER, _token(SCREEN["read_role"]))) is offered
    assert features.gated("logfiles") is True


@pytest.mark.parametrize("feature,manual,offered", [
    ({"alertInvestigation": {"enabled": True}}, "true", True),
    # The inbox stays on with manual investigations off.
    ({"alertInvestigation": {"enabled": True}}, "false", True),
    ({"alertInvestigation": {"enabled": False}}, "true", False),
    ({}, "true", False),
    (None, "true", False),
])
def test_the_inbox_is_left_out_where_its_screen_is_off(monkeypatch, feature, manual, offered):
    monkeypatch.setenv("ALERT_INVESTIGATION_MANUAL", manual)
    assert ("alerts_inbox" in features.gated_names(["alerts_inbox"], feature, CLUSTER, _token(SCREEN["read_role"]))) is offered


def test_the_tools_of_every_cluster_ask_no_feature():
    names = ["pod_rbac", "storage_summary", "network_policy_effective", "limit_range_violations"]
    assert features.gated_names(names, None, CLUSTER, _token(SCREEN["read_role"])) == names


def test_an_investigation_does_not_read_a_containers_files():
    # Its token is the Read tools, the lists and resource.pod.read, not the tab's permission.
    investigator = _token([*(f"ai.tool.{n}" for n in READONLY_TOOL_NAMES), "resource.objects.read", "resource.pod.read"])
    assert permissions.token_may_call(investigator, CLUSTER, "logfiles") is False
    assert features.gated_names(["logfiles"], {"logFiles": {"enabled": True}}, CLUSTER, investigator) == []
    assert permissions.token_may_call(investigator, CLUSTER, "alerts_inbox") is True


def _dispatch_service():
    return SimpleNamespace(user_role="admin", _is_tool_allowed=MagicMock(return_value=True), _call_tool_server=AsyncMock(return_value="{}"))


@pytest.mark.asyncio
@pytest.mark.parametrize("tool,sent,travels", [
    ("pod_rbac", {"namespace": " shop ", "pod_name": "web-1", "cluster": "prod", "made_up": "x"}, {"namespace": "shop", "pod_name": "web-1"}),
    ("pod_rbac", {"namespace": "shop", "pod_name": "web-1", "include_authenticated": True}, {"namespace": "shop", "pod_name": "web-1", "include_authenticated": True}),
    ("logfiles", {"namespace": "shop", "pod_name": "web-1", "container": "app", "path": "/var/log/app/app.log", "lines": 7, "follow": True},
     {"namespace": "shop", "pod_name": "web-1", "container": "app", "path": "/var/log/app/app.log", "lines": 7}),
    ("storage_summary", {"namespace": "shop", "made_up": 1}, {"namespace": "shop"}),
    ("network_policy_effective", {"namespace": "shop", "workload_kind": "Deployment", "workload_name": "web"}, {"namespace": "shop", "workload_kind": "Deployment", "workload_name": "web"}),
    ("limit_range_violations", {"namespace": "shop", "name": "limits"}, {"namespace": "shop", "name": "limits"}),
    ("alerts_inbox", {"status": "firing", "alert_severity": "page", "mine": "true", "open_only": True, "search": "load", "limit": 20, "offset": 40, "note": "x", "done": True},
     {"status": "firing", "alert_severity": "page", "mine": True, "open_only": True, "search": "load", "limit": 20, "offset": 40}),
    ("alerts_inbox", {"alert_id": "a1", "mine": False}, {"alert_id": "a1"}),
    ("alerts_inbox", {"alert_id": "a1", "with_report": "true"}, {"alert_id": "a1", "with_report": True}),
])
async def test_only_the_declared_arguments_travel(tool, sent, travels):
    service = _dispatch_service()
    await execute_function_with_context(service, tool, sent, SimpleNamespace(state={}, cache={}))
    service._call_tool_server.assert_awaited_once_with(tool, travels)


def test_every_call_of_the_two_gates_is_decided_alike():
    wrong = []
    cluster = GATE_CASES["cluster"]
    token = TokenPayload(user_id="u1", role="member", matrix={cluster: ("*",)}, namespaces={cluster: tuple(GATE_CASES["namespaces"])})
    for case in GATE_CASES["cases"]:
        reason = permissions.namespace_scope_error(token, cluster, case["tool"], case["args"])
        if (reason is None) != (case["refused"] == "") or (reason is not None and case["refused"] not in reason):
            wrong.append((case["tool"], case["args"], reason, case["refused"]))
    assert wrong == []
    assert len(GATE_CASES["cases"]) > 300


@pytest.mark.parametrize("tool", THE_FIVE)
def test_a_limited_grant_may_call_them_without_naming_a_namespace(tool):
    assert permissions.namespace_scope_error(_scoped(), CLUSTER, tool, {}) is None


@pytest.mark.parametrize("tool", ("issues", "cost", "gitops_status", "k8s_find_resource", "storage_summary"))
def test_a_limited_grant_still_cannot_name_what_is_outside_it(tool):
    token = _scoped()
    assert "outside your grant" in permissions.namespace_scope_error(token, CLUSTER, tool, {"namespace": "db"})
    assert "all_namespaces spans the cluster" in permissions.namespace_scope_error(token, CLUSTER, tool, {"all_namespaces": True})
    assert permissions.namespace_scope_error(token, CLUSTER, tool, {"namespace": "web"}) is None


def test_the_other_tools_keep_their_refusals():
    token = _scoped()
    assert "namespace is required" in permissions.namespace_scope_error(token, CLUSTER, "k8s_get_resources", {})
    assert "namespace is required" in permissions.namespace_scope_error(token, CLUSTER, "pod_rbac", {})
    assert "namespace is required" in permissions.namespace_scope_error(token, CLUSTER, "logfiles", {"pod_name": "web"})
    assert "spans the cluster" in permissions.namespace_scope_error(token, CLUSTER, "alerts_inbox", {"namespace": "shop"})
    assert "spans the cluster" in permissions.namespace_scope_error(token, CLUSTER, "prometheus_query", {})


@pytest.mark.asyncio
@pytest.mark.parametrize("tool", THE_FIVE)
async def test_in_the_chat_the_call_reaches_tool_server(tool):
    tool_server = SimpleNamespace(call_tool=AsyncMock(return_value="answer"))
    service = SimpleNamespace(token=_scoped(), cluster_name=CLUSTER, tool_server=tool_server)
    assert await AIService._call_tool_server(service, tool, {}) == "answer"
    tool_server.call_tool.assert_awaited_once()


@pytest.mark.asyncio
async def test_in_the_chat_a_namespace_outside_the_grant_never_leaves():
    tool_server = SimpleNamespace(call_tool=AsyncMock(return_value="answer"))
    service = SimpleNamespace(token=_scoped(), cluster_name=CLUSTER, tool_server=tool_server)
    answer = json.loads(await AIService._call_tool_server(service, "issues", {"namespace": "db"}))
    assert answer["status"] == "forbidden" and "outside your grant" in answer["message"]
    tool_server.call_tool.assert_not_awaited()


@pytest.mark.asyncio
@pytest.mark.parametrize("tool,args", [
    ("k8s_explain", {"resource": "pods"}), ("issues", {}), ("cost", {}), ("gitops_status", {}), ("k8s_find_resource", {"query": "web"}),
])
async def test_over_mcp_the_call_reaches_tool_server(mcp, tool, args):  # noqa: F811
    res = await mcp.call(_scoped(("ai.mcp.use", "ai.tool.*", "resource.objects.read", "resource.cost.read")), tool, args)
    assert res.is_error is not True and [n for n, _ in _ToolServer.calls] == [tool]
    assert mcp.audit[-1].get("result") != "failure"


@pytest.mark.asyncio
async def test_over_mcp_a_namespace_outside_the_grant_never_leaves(mcp):  # noqa: F811
    res = await mcp.call(_scoped(("ai.mcp.use", "ai.tool.*", "resource.objects.read")), "issues", {"namespace": "db"})
    assert res.is_error is True and "outside your grant" in res.content[0].text and _ToolServer.calls == []
    assert mcp.audit[-1]["error"] == "forbidden: namespace scope"


@pytest.mark.parametrize("tool,args,target", [
    ("pod_rbac", {"namespace": "shop", "pod_name": "web-1"}, ("tool", "web-1", "shop")),
    ("logfiles", {"namespace": "shop", "pod_name": "web-1", "path": "/var/log/app/app.log"}, ("tool", "web-1", "shop")),
    ("limit_range_violations", {"namespace": "shop", "name": "limits"}, ("tool", "limits", "shop")),
    ("alerts_inbox", {"alert_id": "a1"}, ("alert", "a1", None)),
    ("alerts_inbox", {}, ("tool", "alerts_inbox", None)),
])
def test_the_row_names_what_was_read(tool, args, target):
    assert tool_target(tool, args)[:3] == target


@pytest.mark.asyncio
async def test_over_mcp_the_tabs_permission_decides_and_the_row_says_why(mcp):  # noqa: F811
    res = await mcp.call(_token(("ai.mcp.use", "ai.tool.logfiles")), "logfiles", {"namespace": "shop", "pod_name": "web-1"})
    assert res.is_error is True and "resource.pod.logfile" in res.content[0].text and _ToolServer.calls == []
    assert "resource.pod.logfile" in mcp.audit[-1]["error"]
    res = await mcp.call(_token(("ai.mcp.use", "ai.tool.logfiles", "resource.pod.logfile")), "logfiles", {"namespace": "shop", "pod_name": "web-1"})
    assert res.is_error is not True and [n for n, _ in _ToolServer.calls] == ["logfiles"]


@pytest.mark.asyncio
async def test_in_the_chat_it_is_an_ordinary_read_with_no_card(rows):  # noqa: F811
    got = await _chat_call(_token(("ai.tool.*", "resource.pod.logfile")), "logfiles", {"namespace": "shop", "pod_name": "web-1"},
                           offered=[{"type": "function", "function": {"name": "logfiles"}}])
    assert [n for n, _ in got.service.executed] == ["logfiles"]
    assert got.db.approvals == [] and not any('"approval_required"' in e for e in got.events)
