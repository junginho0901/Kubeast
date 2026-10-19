from app.security import TokenPayload
from app.services.ai.permissions import namespace_scope_error


def test_namespace_scope_error_mirrors_tool_server():
    scoped = TokenPayload(user_id="u", role="member", matrix={"c": ("ai.tool.*",)}, namespaces={"c": ("api", "web")})
    whole = TokenPayload(user_id="u", role="member", matrix={"c": ("ai.tool.*",)})
    assert namespace_scope_error(whole, "c", "k8s_get_resources", {}) is None
    assert namespace_scope_error(scoped, "other", "k8s_get_resources", {}) is None
    assert namespace_scope_error(scoped, "c", "k8s_get_resources", {"namespace": "web"}) is None
    assert "outside your grant" in namespace_scope_error(scoped, "c", "k8s_get_resources", {"namespace": "db"})
    assert "namespace is required" in namespace_scope_error(scoped, "c", "k8s_get_resources", {})
    assert "spans the cluster" in namespace_scope_error(scoped, "c", "get_cluster_overview", {})
    for tool in ("prometheus_query", "alerts_list", "audit_search"):
        assert "spans the cluster" in namespace_scope_error(scoped, "c", tool, {"namespace": "web"}), tool
    assert namespace_scope_error(None, "c", "get_cluster_overview", {}) is None
