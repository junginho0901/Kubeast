"""JWT permission matrix: global ("*") vs per-cluster checks, no cross-cluster union (C1)."""
import pytest

from app.security import DEFAULT_CLUSTER, TokenPayload, _parse_permission_matrix


def _payload(matrix, role="read"):
    return TokenPayload(user_id="u", role=role, permissions=matrix.get("*", ()), matrix=matrix)


def test_parse_matrix_keeps_clusters_separate():
    raw = {"*": ["admin.x"], "prod": ["resource.pod.read", "menu.workloads"]}
    assert _parse_permission_matrix(raw) == {
        "*": ("admin.x",),
        "prod": ("resource.pod.read", "menu.workloads"),
    }


def test_parse_matrix_rejects_legacy_and_bad_shapes():
    assert _parse_permission_matrix(["resource.pod.read"]) is None
    assert _parse_permission_matrix(None) is None
    assert _parse_permission_matrix("x") is None
    assert _parse_permission_matrix({}) == {}


def test_global_admin_reaches_every_cluster():
    admin = _payload({"*": ["*"]}, role="admin")
    assert admin.has_permission("admin.ai_models.update")
    assert admin.has_permission_for_cluster("ai.tool.k8s_delete_resource", "prod")
    assert admin.has_permission_for_cluster("ai.tool.k8s_delete_resource", None)


def test_cluster_grant_does_not_leak_to_other_clusters():
    user = _payload({"alpha": ["ai.tool.*", "resource.*.create"], "prod": ["resource.*.read"]})
    assert user.has_permission_for_cluster("ai.tool.k8s_delete_resource", "alpha")
    assert not user.has_permission_for_cluster("ai.tool.k8s_delete_resource", "prod")
    assert not user.has_permission_for_cluster("ai.tool.k8s_get_resources", "prod")
    # no global entry → global checks fail
    assert not user.has_permission("ai.tool.k8s_delete_resource")
    assert not user.has_permission("admin.ai_models.update")


def test_empty_cluster_means_default_only():
    user = _payload({"default": ["ai.tool.k8s_get_resources"], "alpha": ["ai.tool.*"]})
    assert user.has_permission_for_cluster("ai.tool.k8s_get_resources", None)
    assert user.has_permission_for_cluster("ai.tool.k8s_get_resources", "")
    assert not user.has_permission_for_cluster("ai.tool.k8s_delete_resource", None)
    assert DEFAULT_CLUSTER == "default"


def test_wildcard_segments_match_like_go_and_frontend():
    # Same table as pkg/auth permissions_test.go / frontend permissions.test.ts
    from app.security import _perm_matches

    assert _perm_matches("*", "resource.pod.delete")
    assert _perm_matches("resource.*.read", "resource.pod.read")
    assert _perm_matches("resource.*.create", "resource.namespace.create")
    assert not _perm_matches("resource.*.read", "resource.pod.logs")
    assert not _perm_matches("resource.*.read", "resource.pod.read.extra")
    assert _perm_matches("ai.tool.*", "ai.tool.k8s_scale")
    assert not _perm_matches("ai.tool.*", "ai.tool")
    assert _perm_matches("resource.*", "resource.pod.read")
    assert not _perm_matches("admin.users.read", "admin.users.write")


def test_star_cluster_id_is_not_a_wildcard_lookup():
    user = _payload({"alpha": ["*"]})
    assert not user.has_permission_for_cluster("ai.tool.x", "*")
