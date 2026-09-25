"""Tool gating is decided on the request's active cluster only (C1)."""
from types import SimpleNamespace

from app.security import TokenPayload
from app.services.ai import permissions


def _service(matrix, cluster):
    token = TokenPayload(user_id="u", role="read", permissions=matrix.get("*", ()), matrix=matrix)
    return SimpleNamespace(token=token, user_role="read", cluster_name=cluster)


def test_write_tool_allowed_only_on_granted_cluster():
    matrix = {"alpha": ["ai.tool.*", "resource.*.create"], "prod": ["resource.*.read"]}
    assert permissions.is_tool_allowed(_service(matrix, "alpha"), "k8s_delete_resource")
    assert not permissions.is_tool_allowed(_service(matrix, "prod"), "k8s_delete_resource")
    assert not permissions.is_tool_allowed(_service(matrix, "prod"), "k8s_get_resources")
    assert permissions.role_allows_write(_service(matrix, "alpha"))
    assert not permissions.role_allows_write(_service(matrix, "prod"))


def test_tool_list_is_filtered_per_cluster():
    matrix = {"alpha": ["ai.tool.*"], "prod": []}
    tools = [
        {"type": "function", "function": {"name": "k8s_get_resources"}},
        {"type": "function", "function": {"name": "k8s_delete_resource"}},
    ]
    assert len(permissions.filter_tools_by_role(_service(matrix, "alpha"), tools)) == 2
    assert permissions.filter_tools_by_role(_service(matrix, "prod"), tools) == []


def test_scope_tool_args_overrides_model_supplied_cluster():
    args, discarded = permissions.scope_tool_args({"resource_type": "pods", "cluster": "prod"}, "alpha")
    assert args["cluster"] == "alpha" and discarded == "prod"
    args, discarded = permissions.scope_tool_args({"resource_type": "pods"}, "alpha")
    assert args["cluster"] == "alpha" and discarded is None
    args, discarded = permissions.scope_tool_args(None, "default")
    assert args == {"cluster": "default"} and discarded is None
