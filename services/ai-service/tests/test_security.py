"""Tests for JWT permission parsing (per-cluster matrix, step 06)."""
from app.security import _flatten_permissions, TokenPayload


def test_flatten_matrix_unions_all_clusters():
    raw = {"*": ["admin.x"], "prod": ["resource.pod.read", "menu.workloads"]}
    assert set(_flatten_permissions(raw)) == {
        "admin.x",
        "resource.pod.read",
        "menu.workloads",
    }


def test_flatten_superuser():
    assert _flatten_permissions({"*": ["*"]}) == ("*",)


def test_flatten_legacy_array_still_accepted():
    assert _flatten_permissions(["resource.pod.read"]) == ("resource.pod.read",)


def test_flatten_empty_and_none():
    assert _flatten_permissions({}) == ()
    assert _flatten_permissions(None) == ()


def test_has_permission_after_flatten():
    # admin matrix flattens to ("*",) → grants everything
    admin = TokenPayload(user_id="a", role="admin", permissions=("*",))
    assert admin.has_permission("ai.tool.list_pods")
    assert admin.has_permission("admin.ai_models.update")

    # a non-admin with only prod resource perms (no admin.*)
    user = TokenPayload(
        user_id="u",
        role="read",
        permissions=("resource.pod.read", "ai.tool.list_pods"),
    )
    assert user.has_permission("ai.tool.list_pods")
    assert not user.has_permission("admin.ai_models.update")
