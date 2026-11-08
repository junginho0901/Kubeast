"""clusters_list reads what the cluster picker reads; alert_investigate presses the alert window's "Investigate now".

The answers themselves are tool-server's (handlers_inbox_test.go). Here: who is offered them, in which chat, whether a
card stands in front of them, and what travels."""
import json
from types import SimpleNamespace
from unittest.mock import AsyncMock, MagicMock

import pytest

from app import mcp_server
from app.security import TokenPayload
from app.services import tool_whitelists
from app.services.ai import features, permissions, screen_permissions
from app.services.ai import tools as catalog
from app.services.ai.tool_dispatch import FEATURE_TOOL_ARGS, execute_function_with_context
from app.services.audit_target import tool_target
from app.services.tool_whitelists import READONLY_TOOL_NAMES, WRITE_TOOL_NAMES, readonly_tool_filter
from tests.test_tool_app_permissions import CLUSTER, SCREEN, WRITE_ROLE, _admin, _chat_call, _token, _ToolServer, mcp, rows  # noqa: F401

INVESTIGATE = "alert_investigate"
CLUSTERS = "clusters_list"
BUTTON = ("resource.alert.investigate", "resource.pod.read")
TOOL = f"ai.tool.{INVESTIGATE}"
OFFERED = [{"type": "function", "function": {"name": INVESTIGATE}}]


def _catalog():
    return catalog.get_tools_definition(SimpleNamespace(_filter_tools_by_role=lambda tools: tools))


def _definition(name):
    return next((t["function"] for t in _catalog() if t["function"]["name"] == name), None)


def _action_names():
    return getattr(tool_whitelists, "ACTION_TOOL_NAMES", frozenset())


def _action_tools():
    return getattr(mcp_server, "ACTION_TOOLS", {})


def test_the_cluster_list_is_a_read_tool():
    assert CLUSTERS in READONLY_TOOL_NAMES and _definition(CLUSTERS) is not None
    assert _definition(CLUSTERS)["parameters"]["properties"] == {}
    assert CLUSTERS in mcp_server.READ_TOOLS


def test_starting_an_investigation_is_in_no_read_only_list():
    assert _definition(INVESTIGATE) is not None
    assert INVESTIGATE in _action_names()
    assert INVESTIGATE not in READONLY_TOOL_NAMES and INVESTIGATE not in WRITE_TOOL_NAMES
    # The floating widget and an investigation itself take their tools through this filter.
    names = {t["function"]["name"] for t in readonly_tool_filter(_catalog())}
    assert INVESTIGATE not in names and CLUSTERS in names


def test_what_the_definition_offers_is_what_travels():
    declared = set(_definition(INVESTIGATE)["parameters"]["properties"]) - {"alert_labels"}
    strings, flags, ints = FEATURE_TOOL_ARGS[INVESTIGATE]
    assert declared == strings | flags | ints
    assert flags == {"status_only"} and "alert_id" in strings and "alertname" in strings
    assert FEATURE_TOOL_ARGS[CLUSTERS] == (set(), set(), set())


def test_the_table_says_what_the_button_asks():
    assert screen_permissions.app_permissions(INVESTIGATE, {"alert_id": "a1"}) == list(BUTTON)
    assert screen_permissions.app_permissions(CLUSTERS, {}) == []
    assert features.REQUIRED_PERMISSIONS.get(INVESTIGATE) == ("cluster", "resource.alert.investigate")
    assert CLUSTERS not in features.REQUIRED_PERMISSIONS
    assert INVESTIGATE in SCREEN["tools"] and CLUSTERS in SCREEN["tools"]


@pytest.mark.parametrize("perms,clusters,investigate", [
    (("ai.tool.*", "resource.*.read"), True, False),  # the Write role's tools, without the button's permission
    (tuple(SCREEN["read_role"]), True, False),  # the Read role
    (("ai.tool.*", *BUTTON), True, True),  # a Write grant given the button
    ((TOOL, *BUTTON), False, True),  # exactly the tool and the button
    ((f"ai.tool.{CLUSTERS}",), True, False),  # the list asks nothing more
    ((TOOL, "resource.alert.investigate"), False, False),  # the button's permission, but the alert cannot be read
    (BUTTON, False, False),  # the button without the tool
])
def test_who_may_call_them(perms, clusters, investigate):
    token = _token(perms)
    assert permissions.token_may_call(token, CLUSTER, CLUSTERS) is clusters
    assert permissions.token_may_call(token, CLUSTER, INVESTIGATE) is investigate
    assert permissions.token_may_call(token, CLUSTER, INVESTIGATE, {"alert_id": "a1"}) is investigate


def test_a_global_admin_may_call_them_and_another_clusters_grant_does_not_count():
    assert permissions.token_may_call(_admin(), CLUSTER, INVESTIGATE) is True
    assert permissions.token_may_call(_admin(), CLUSTER, CLUSTERS) is True
    elsewhere = TokenPayload(user_id="u1", role="member", matrix={"prod": (TOOL, *BUTTON)})
    assert permissions.token_may_call(elsewhere, CLUSTER, INVESTIGATE) is False


@pytest.mark.parametrize("feature,manual,offered", [
    ({"alertInvestigation": {"enabled": True}}, "true", True),
    ({"alertInvestigation": {"enabled": True}}, "false", False),
    ({"alertInvestigation": {"enabled": False}}, "true", False),
    ({}, "true", False),
    (None, "true", False),  # k8s-service did not answer
])
def test_the_tool_is_left_out_where_the_button_cannot_work(monkeypatch, feature, manual, offered):
    monkeypatch.setenv("ALERT_INVESTIGATION_MANUAL", manual)
    token = _token((TOOL, *BUTTON))
    assert (INVESTIGATE in features.gated_names([INVESTIGATE], feature, CLUSTER, token)) is offered
    assert features.gated(INVESTIGATE) is True


def test_a_holder_of_nothing_is_not_offered_it_even_with_the_feature_on(monkeypatch):
    monkeypatch.setenv("ALERT_INVESTIGATION_MANUAL", "true")
    token = _token(("ai.tool.*", "resource.*.read"))
    assert features.gated_names([INVESTIGATE], {"alertInvestigation": {"enabled": True}}, CLUSTER, token) == []
    assert features.permitted_anywhere(INVESTIGATE, token) is False
    assert features.permitted_anywhere(INVESTIGATE, _token((TOOL, *BUTTON))) is True


def _dispatch_service():
    return SimpleNamespace(user_role="admin", _is_tool_allowed=MagicMock(return_value=True), _call_tool_server=AsyncMock(return_value='{"started": true}'))


@pytest.mark.asyncio
async def test_only_the_declared_arguments_travel():
    service = _dispatch_service()
    await execute_function_with_context(service, INVESTIGATE, {
        "alertname": " HighLoad ", "namespace": "shop", "alert_labels": {"pod": "web-1", "bad": {"x": 1}}, "status_only": "true",
        "cluster": "prod", "made_up": "x",
    }, SimpleNamespace(state={}, cache={}))
    service._call_tool_server.assert_awaited_once_with(INVESTIGATE, {"alertname": "HighLoad", "namespace": "shop", "alert_labels": {"pod": "web-1"}, "status_only": True})

    service = _dispatch_service()
    await execute_function_with_context(service, INVESTIGATE, {"alert_id": "a1", "status_only": False}, SimpleNamespace(state={}, cache={}))
    service._call_tool_server.assert_awaited_once_with(INVESTIGATE, {"alert_id": "a1"})

    service = _dispatch_service()
    await execute_function_with_context(service, CLUSTERS, {"namespace": "shop"}, SimpleNamespace(state={}, cache={}))
    service._call_tool_server.assert_awaited_once_with(CLUSTERS, {})


@pytest.mark.asyncio
async def test_in_the_chat_it_runs_like_the_button_with_no_card(rows):  # noqa: F811
    got = await _chat_call(_token((TOOL, *BUTTON)), INVESTIGATE, {"alert_id": "a1"}, offered=OFFERED)
    assert got.service.executed == [(INVESTIGATE, {"alert_id": "a1"})]
    assert got.db.approvals == [] and not any('"approval_required"' in e for e in got.events)
    row = next(r for r in rows if r["action"] == "ai.tool.call")
    assert (row["target_type"], row["target_id"], row["result"]) == ("alert", "a1", "success")
    assert not [r for r in rows if r["action"] == "ai.tool.approval_requested"]


@pytest.mark.asyncio
async def test_a_chat_that_was_not_offered_it_does_not_start_one(rows):  # noqa: F811
    got = await _chat_call(_token((TOOL, *BUTTON)), INVESTIGATE, {"alert_id": "a1"}, offered=[{"type": "function", "function": {"name": "k8s_get_resources"}}])
    assert got.service.executed == []
    assert json.loads(got.llm_text)["status"] == "not_permitted"
    row = next(r for r in rows if r["action"] == "ai.tool.call")
    assert row["result"] == "failure" and row["after"]["status"] == "not_permitted"


@pytest.mark.asyncio
async def test_without_the_buttons_permission_the_chat_is_told_what_is_missing(rows):  # noqa: F811
    got = await _chat_call(_token(("ai.tool.*", "resource.*.read")), INVESTIGATE, {"alert_id": "a1"}, offered=OFFERED)
    assert got.service.executed == []
    answer = json.loads(got.llm_text)
    assert answer["status"] == "not_permitted" and "resource.alert.investigate" in answer["message"]
    assert "resource.pod.read" not in answer["message"]


def test_a_refusal_of_the_route_reads_as_a_failure_in_the_row():
    from app.services.ai.streaming import tool_outcome

    for status in ("forbidden", "rate_limited", "audit_unavailable"):
        assert tool_outcome(json.dumps({"status": status, "code": "x"}))[0] == "failure"


def test_a_grant_limited_to_namespaces():
    scoped = TokenPayload(user_id="u1", role="member", matrix={CLUSTER: ("*",)}, namespaces={CLUSTER: ("shop",)})
    # The picker works for such a grant, so the list does.
    assert permissions.namespace_scope_error(scoped, CLUSTER, CLUSTERS, {}) is None
    # The inbox answers it 404: the tool says why.
    reason = permissions.namespace_scope_error(scoped, CLUSTER, INVESTIGATE, {"alert_id": "a1", "namespace": "shop"})
    assert reason and "spans the cluster" in reason


def test_the_row_names_the_alert():
    assert tool_target(INVESTIGATE, {"alert_id": "a1", "alertname": "HighLoad"})[:2] == ("alert", "a1")
    assert tool_target(INVESTIGATE, {"alertname": "HighLoad", "namespace": "shop"}) == ("alert", "HighLoad", "shop", None)
    assert tool_target(CLUSTERS, {})[:2] == ("tool", CLUSTERS)


def test_mcp_says_it_is_no_read_but_changes_nothing_destructive():
    tool = _action_tools().get(INVESTIGATE)
    assert tool is not None and INVESTIGATE not in mcp_server.READ_TOOLS and INVESTIGATE not in mcp_server.WRITE_TOOLS
    assert tool.annotations.read_only_hint is False and tool.annotations.destructive_hint is False and tool.annotations.idempotent_hint is True
    assert "cluster" in tool.input_schema["required"]
    assert mcp_server.READ_TOOLS[CLUSTERS].annotations.read_only_hint is True


@pytest.mark.asyncio
async def test_over_mcp_it_goes_through_tool_server_with_the_buttons_permissions(mcp):  # noqa: F811
    res = await mcp.call(_token(("ai.mcp.use", TOOL, *BUTTON)), INVESTIGATE, {"alert_id": "a1"})
    assert res.is_error is not True and _ToolServer.calls == [(INVESTIGATE, {"cluster": CLUSTER, "alert_id": "a1"})]
    row = mcp.audit[-1]
    assert (row["action"], row["target_type"], row["target_id"], row["after"]["write"]) == ("ai.mcp.call", "alert", "a1", False)


@pytest.mark.asyncio
async def test_over_mcp_it_does_not_wait_for_the_write_switch(mcp, monkeypatch):  # noqa: F811
    monkeypatch.setenv("MCP_WRITE_TOOLS", "false")
    res = await mcp.call(_token(("ai.mcp.use", TOOL, *BUTTON)), INVESTIGATE, {"alert_id": "a1"})
    assert res.is_error is not True and [n for n, _ in _ToolServer.calls] == [INVESTIGATE]


@pytest.mark.asyncio
async def test_over_mcp_without_the_permission_nothing_runs_and_the_row_says_why(mcp):  # noqa: F811
    res = await mcp.call(_token(("ai.mcp.use", "ai.tool.*", "resource.*.read")), INVESTIGATE, {"alert_id": "a1"})
    assert res.is_error is True and "resource.alert.investigate" in res.content[0].text and _ToolServer.calls == []
    row = mcp.audit[-1]
    assert row["result"] == "failure" and "resource.alert.investigate" in row["error"]


@pytest.mark.asyncio
async def test_over_mcp_the_cluster_list_works_for_a_limited_grant(mcp):  # noqa: F811
    scoped = TokenPayload(user_id="u1", role="member", email="s@example.com", matrix={CLUSTER: ("ai.mcp.use", f"ai.tool.{CLUSTERS}")}, namespaces={CLUSTER: ("shop",)})
    res = await mcp.call(scoped, CLUSTERS, {})
    assert res.is_error is not True and [n for n, _ in _ToolServer.calls] == [CLUSTERS]


@pytest.mark.asyncio
async def test_mcp_lists_it_for_a_holder_only(mcp, monkeypatch):  # noqa: F811
    async def names(token):
        access = SimpleNamespace(token="jwt", subject=token.user_id, claims=mcp_server._payload_to_claims(token))
        monkeypatch.setattr(mcp_server, "get_access_token", lambda: access)
        return {t.name for t in await mcp_server.KubeastMCPServer(tool_server_url="http://tools").list_tools()}

    holder = await names(_token(("ai.mcp.use", TOOL, f"ai.tool.{CLUSTERS}", *BUTTON)))
    assert INVESTIGATE in holder and CLUSTERS in holder
    writer = await names(_token(("ai.mcp.use", *WRITE_ROLE)))
    assert INVESTIGATE not in writer and CLUSTERS in writer
    assert INVESTIGATE in mcp_server._tools_allowed_in(_token(("ai.mcp.use", TOOL, *BUTTON)), CLUSTER)
    assert INVESTIGATE not in mcp_server._tools_allowed_in(_token(("ai.mcp.use", *WRITE_ROLE)), CLUSTER)
