"""What a list offers is what a call can do: tools/list, list_clusters and the chat's list answer as the call would,
and a screen's button with no other tool has one."""
from __future__ import annotations

from types import SimpleNamespace

import pytest
from mcp.server.auth.provider import AccessToken

from app import mcp_server
from app.security import TokenPayload
from app.services.ai import features, permissions, screen_permissions
from app.services.ai import tools as catalog
from app.services.ai.tool_dispatch import FEATURE_TOOL_ARGS
from app.services.audit_target import tool_target, write_tool_input
from app.services.tool_whitelists import READONLY_TOOL_NAMES, WRITE_TOOL_NAMES

CLUSTER = "self"
MANIFEST_CM = "apiVersion: v1\nkind: ConfigMap\nmetadata:\n  name: a\n"
MANIFEST_SECRET = "apiVersion: v1\nkind: Secret\nmetadata:\n  name: a\n"
BUTTONS = {"k8s_cordon_node": "resource.node.cordon", "k8s_cronjob_suspend": "resource.cronjob.suspend", "k8s_cronjob_trigger": "resource.cronjob.trigger"}
ALWAYS_THERE = {"list_clusters"}


def _token(matrix, **extra):
    return TokenPayload(user_id="u1", role="member", email="u1@example.com", permissions=tuple(matrix.get("*", ())), matrix=matrix, **extra)


async def _listed(monkeypatch, payload) -> set:
    access = AccessToken(token="t", client_id="session", scopes=[], subject=payload.user_id, claims=mcp_server._payload_to_claims(payload))
    monkeypatch.setattr(mcp_server, "get_access_token", lambda: access)
    return {tool.name for tool in await mcp_server.KubeastMCPServer(tool_server_url="http://tools").list_tools()}


# --- tools/list names the tools the token holds -------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_a_read_tool_the_role_does_not_hold_is_not_listed(monkeypatch):
    role = _token({CLUSTER: ("ai.mcp.use", "ai.tool.k8s_get_resources", "resource.*.read")})
    assert await _listed(monkeypatch, role) == ALWAYS_THERE | {"k8s_get_resources"}


@pytest.mark.asyncio
async def test_a_role_with_every_read_tool_keeps_the_list_it_had(monkeypatch):
    held = tuple(f"ai.tool.{name}" for name in READONLY_TOOL_NAMES)
    role = _token({CLUSTER: ("ai.mcp.use", "resource.*.read", "resource.helm.read", "resource.pod.logfile", *held)})
    assert await _listed(monkeypatch, role) == ALWAYS_THERE | set(READONLY_TOOL_NAMES)


@pytest.mark.asyncio
async def test_a_tool_is_listed_only_where_the_key_and_the_tool_are_held_together(monkeypatch):
    apart = _token({"a": ("ai.mcp.use",), "b": ("ai.tool.k8s_get_resources",)})
    assert await _listed(monkeypatch, apart) == ALWAYS_THERE
    without_the_read = _token({"a": ("ai.mcp.use",), "b": ("ai.mcp.use", "ai.tool.k8s_get_resources")})
    assert await _listed(monkeypatch, without_the_read) == ALWAYS_THERE
    together = _token({"a": ("ai.mcp.use",), "b": ("ai.mcp.use", "ai.tool.k8s_get_resources", "resource.objects.read")})
    assert await _listed(monkeypatch, together) == ALWAYS_THERE | {"k8s_get_resources"}


@pytest.mark.asyncio
async def test_every_listed_tool_can_be_called_somewhere(monkeypatch):
    roles = [
        _token({CLUSTER: ("ai.mcp.use", "ai.tool.*", "resource.*.read")}),
        _token({CLUSTER: ("ai.mcp.use", "ai.tool.get_pod_metrics", "ai.tool.hygiene")}),
        _token({"*": ("admin.audit.read",), CLUSTER: ("ai.mcp.use", "ai.tool.ai_usage", "ai.tool.access_review")}),
        _token({"a": ("ai.mcp.use", "ai.tool.alert_investigate", "resource.pod.read"), "b": ("ai.mcp.use", "ai.tool.alert_investigate", "resource.alert.investigate")}),
    ]
    for role in roles:
        clusters = [c for c in role.matrix if c != "*"]
        for name in (await _listed(monkeypatch, role)) - ALWAYS_THERE:
            assert any(permissions.token_may_call(role, c, name) for c in clusters), name


# --- every permission a tool asks counts, in one cluster --------------------------------------------------------------


@pytest.mark.parametrize("matrix,offered", [
    ({CLUSTER: ("ai.mcp.use", "ai.tool.alert_investigate", "resource.alert.investigate")}, False),
    ({CLUSTER: ("ai.mcp.use", "ai.tool.alert_investigate", "resource.pod.read")}, False),
    ({"a": ("ai.mcp.use", "ai.tool.alert_investigate", "resource.alert.investigate"), "b": ("ai.mcp.use", "ai.tool.alert_investigate", "resource.pod.read")}, False),
    ({CLUSTER: ("ai.mcp.use", "ai.tool.alert_investigate", "resource.alert.investigate", "resource.pod.read")}, True),
], ids=["without the read", "without the button", "each in another cluster", "both"])
@pytest.mark.asyncio
async def test_a_tool_asking_two_permissions_is_listed_with_both(monkeypatch, matrix, offered):
    role = _token(matrix)
    assert ("alert_investigate" in await _listed(monkeypatch, role)) is offered
    assert features.permitted_anywhere("alert_investigate", role) is offered


def test_the_chat_list_counts_both_permissions_too():
    without = _token({CLUSTER: ("ai.tool.*", "resource.alert.investigate")})
    both = _token({CLUSTER: ("ai.tool.*", "resource.alert.investigate", "resource.pod.read")})
    assert features.permitted("alert_investigate", without, CLUSTER) is False
    assert features.permitted("alert_investigate", both, CLUSTER) is True


# --- k8s_diff: the list asks what the call asks ----------------------------------------------------------------------


@pytest.mark.parametrize("perm,offered", [("resource.configmap.edit", True), ("resource.*.edit", True), ("resource.*.read", False), ("resource.configmap.create", False)])
@pytest.mark.asyncio
async def test_the_write_preview_is_listed_for_an_edit_on_any_kind(monkeypatch, perm, offered):
    role = _token({CLUSTER: ("ai.mcp.use", "ai.tool.k8s_diff", perm)})
    assert ("k8s_diff" in await _listed(monkeypatch, role)) is offered
    assert features.permitted("k8s_diff", role, CLUSTER) is offered
    assert features.gated_names(["k8s_diff"], {}, CLUSTER, role) == (["k8s_diff"] if offered else [])


def test_the_write_preview_still_asks_the_kind_of_the_manifest_it_previews():
    role = _token({CLUSTER: ("ai.tool.k8s_diff", "resource.configmap.edit")})
    assert permissions.token_may_call(role, CLUSTER, "k8s_diff", {"yaml_content": MANIFEST_CM}) is True
    assert permissions.token_may_call(role, CLUSTER, "k8s_diff", {"yaml_content": MANIFEST_SECRET}) is False


# --- Kubeast's own records and a grant limited to namespaces --------------------------------------------------------


RECORD_TOOLS = {
    "audit_search": "admin.audit.read", "access_review": "admin.review.read", "ai_usage": "admin.audit.read", "access_requests": "admin.users.update",
    "audit_integrity": "admin.audit.read", "investigations": "admin.investigations.read", "ai_models": "admin.ai_models.*", "session_recordings": "admin.sessions.read",
}
LIMITED = {CLUSTER: ("shop",)}


@pytest.mark.parametrize("tool,permission", sorted(RECORD_TOOLS.items()))
def test_an_all_cluster_holder_reads_kubeasts_records_from_a_cluster_it_holds_in_part(tool, permission):
    holder = _token({"*": (permission,), CLUSTER: ("ai.tool.*",)}, namespaces=LIMITED)
    assert permissions.namespace_scope_error(holder, CLUSTER, tool, {}) is None
    on_this_one = _token({CLUSTER: ("ai.tool.*", permission)}, namespaces=LIMITED)
    assert "spans the cluster" in permissions.namespace_scope_error(on_this_one, CLUSTER, tool, {})
    another = _token({"*": ("admin.nothing.read",), CLUSTER: ("ai.tool.*",)}, namespaces=LIMITED)
    assert "spans the cluster" in permissions.namespace_scope_error(another, CLUSTER, tool, {})


@pytest.mark.parametrize("tool", ["hygiene", "hygiene_history", "nodes_log", "nodes_stats_summary", "prometheus_query", "alerts_list", "get_node_metrics"])
def test_what_reads_the_cluster_itself_stays_closed_to_a_limited_grant(tool):
    everything = _token({"*": ("*",), CLUSTER: ("ai.tool.*",)}, namespaces=LIMITED)
    assert "spans the cluster" in permissions.namespace_scope_error(everything, CLUSTER, tool, {})


# --- A screen's button, through its own tool -------------------------------------------------------------------------


def _write_tool(name):
    return next((t["function"] for t in catalog.K8S_WRITE_TOOLS if t["function"]["name"] == name), None)


@pytest.mark.parametrize("tool,permission", sorted(BUTTONS.items()))
def test_a_button_has_a_write_tool_that_asks_what_it_asks(tool, permission):
    assert _write_tool(tool) is not None
    assert tool in WRITE_TOOL_NAMES and tool not in READONLY_TOOL_NAMES
    assert tool in mcp_server.WRITE_TOOLS
    assert mcp_server.WRITE_TOOLS[tool].annotations.read_only_hint is False
    assert mcp_server.WRITE_TOOLS[tool].annotations.destructive_hint is False
    assert screen_permissions.app_permissions(tool, {"resource_name": "x"}) == [permission]


@pytest.mark.parametrize("tool,permission", sorted(BUTTONS.items()))
def test_a_role_holding_only_the_button_can_ask_for_it(tool, permission):
    role = _token({CLUSTER: (f"ai.tool.{tool}", permission)})
    assert permissions.token_may_call(role, CLUSTER, tool, {"resource_name": "x", "namespace": "shop"}) is True
    service = SimpleNamespace(token=role, user_role="read", cluster_name=CLUSTER)
    offered = {t["function"]["name"] for t in permissions.filter_tools_by_role(service, catalog.K8S_WRITE_TOOLS)}
    assert offered == {tool}
    without = _token({CLUSTER: (f"ai.tool.{tool}", "resource.*.edit", "resource.*.create")})
    assert permissions.token_may_call(without, CLUSTER, tool, {"resource_name": "x", "namespace": "shop"}) is False
    assert permission in permissions.app_permission_error(without, CLUSTER, tool, {"resource_name": "x", "namespace": "shop"})


def test_the_built_in_roles_get_the_buttons_their_screens_have():
    write = _token({CLUSTER: ("ai.tool.*", "resource.*.edit", "resource.cronjob.suspend", "resource.cronjob.trigger")})
    service = SimpleNamespace(token=write, user_role="read", cluster_name=CLUSTER)
    offered = {t["function"]["name"] for t in permissions.filter_tools_by_role(service, catalog.K8S_WRITE_TOOLS)}
    assert {"k8s_cronjob_suspend", "k8s_cronjob_trigger"} <= offered and "k8s_cordon_node" not in offered


def test_a_node_spans_the_cluster_and_a_cronjob_stays_in_its_namespace():
    scoped = _token({CLUSTER: ("ai.tool.*",)}, namespaces=LIMITED)
    assert "spans the cluster" in permissions.namespace_scope_error(scoped, CLUSTER, "k8s_cordon_node", {"resource_name": "n1"})
    for tool in ("k8s_cronjob_suspend", "k8s_cronjob_trigger"):
        assert permissions.namespace_scope_error(scoped, CLUSTER, tool, {"resource_name": "x", "namespace": "shop"}) is None
        assert "outside your grant" in permissions.namespace_scope_error(scoped, CLUSTER, tool, {"resource_name": "x", "namespace": "other"})


def test_the_audit_row_names_the_object_and_which_way_it_went():
    node = tool_target("k8s_cordon_node", {"resource_name": "n1", "uncordon": True})
    assert (node.type, node.id, node.namespace) == ("node", "n1", None)
    job = tool_target("k8s_cronjob_trigger", {"resource_name": "nightly", "namespace": "shop"})
    assert (job.type, job.id, job.namespace) == ("cronjob", "nightly", "shop")
    assert write_tool_input("k8s_cordon_node", {"resource_name": "n1", "uncordon": True})["uncordon"] is True
    assert write_tool_input("k8s_cronjob_suspend", {"resource_name": "x", "namespace": "shop", "suspend": False})["suspend"] is False


def test_the_model_is_told_when_to_use_them():
    from app.services.ai.prompts import SYSTEM_MESSAGE

    for tool in BUTTONS:
        assert tool in SYSTEM_MESSAGE, tool


# --- Arguments of the admin records ----------------------------------------------------------------------------------


def _admin_read(name):
    return next(t["function"] for t in catalog.ADMIN_READ_TOOLS if t["function"]["name"] == name)


def test_ai_models_takes_the_routes_enabled_only():
    assert "enabled_only" in _admin_read("ai_models")["parameters"]["properties"]
    assert "enabled_only" in FEATURE_TOOL_ARGS["ai_models"][1]


def test_session_recordings_says_what_its_size_field_is():
    assert "kept_bytes" in _admin_read("session_recordings")["description"]
