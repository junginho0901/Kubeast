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
    assert "spans the cluster" in namespace_scope_error(scoped, "c", "get_node_metrics", {})
    for tool in ("prometheus_query", "alerts_list", "audit_search", "access_review", "ai_usage", "access_requests", "audit_integrity", "hygiene_history", "investigations", "ai_models", "session_recordings"):
        assert "spans the cluster" in namespace_scope_error(scoped, "c", tool, {"namespace": "web"}), tool
    assert namespace_scope_error(None, "c", "get_node_metrics", {}) is None


def test_a_tool_k8s_service_narrows_needs_no_namespace_and_stays_in_the_grant():
    scoped = TokenPayload(user_id="u", role="member", matrix={"c": ("ai.tool.*",)}, namespaces={"c": ("api", "web")})
    for tool in ("timeline", "gpu", "get_cluster_overview"):
        assert namespace_scope_error(scoped, "c", tool, {}) is None, tool
        assert namespace_scope_error(scoped, "c", tool, {"namespace": "web"}) is None, tool
        assert "outside your grant" in namespace_scope_error(scoped, "c", tool, {"namespace": "db"}), tool
        reason = namespace_scope_error(scoped, "c", tool, {"all_namespaces": True})
        assert reason is not None and "spans the cluster" in reason, tool


def test_all_namespaces_stays_inside_the_grant():
    scoped = TokenPayload(user_id="u", role="member", matrix={"c": ("ai.tool.*",)}, namespaces={"c": ("api", "web")})
    whole = TokenPayload(user_id="u", role="member", matrix={"c": ("ai.tool.*",)})
    for tool in ("k8s_get_resources", "k8s_get_events"):
        for flag in (True, "true", "TRUE", 1):
            reason = namespace_scope_error(scoped, "c", tool, {"namespace": "web", "all_namespaces": flag})
            assert reason is not None and "spans the cluster" in reason, (tool, flag, reason)
            assert namespace_scope_error(scoped, "c", tool, {"all_namespaces": flag}) is not None, (tool, flag)
        for flag in (False, "false", None):
            assert namespace_scope_error(scoped, "c", tool, {"namespace": "web", "all_namespaces": flag}) is None, (tool, flag)
    assert namespace_scope_error(scoped, "other", "k8s_get_resources", {"all_namespaces": True}) is None
    assert namespace_scope_error(whole, "c", "k8s_get_resources", {"namespace": "web", "all_namespaces": True}) is None
