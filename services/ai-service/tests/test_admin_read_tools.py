"""The Admin reads of what spans Kubeast (Access review, AI Usage, Access requests, the audit log's integrity line) and a
cluster's hygiene sign-offs: offered to whoever holds what the screen asks and to nobody else, on every list, read only,
and outside the Read role's seed and the floating chat's and the investigator's tools."""
from types import SimpleNamespace
from unittest.mock import AsyncMock, MagicMock

import pytest

from app import mcp_server
from app.security import TokenPayload
from app.services.ai import features, permissions, screen_permissions
from app.services.ai.prompts import SYSTEM_MESSAGE
from app.services.ai.tool_dispatch import FEATURE_TOOL_ARGS, execute_function_with_context
from app.services.ai.tools import ADMIN_READ_TOOLS
from app.services.tool_whitelists import READONLY_TOOL_NAMES, WRITE_TOOL_NAMES

SCREEN_PERMISSION = {
    "access_review": "admin.review.read",
    "ai_usage": "admin.audit.read",
    "access_requests": "admin.users.update",
    "audit_integrity": "admin.audit.read",
    "hygiene_history": "admin.hygiene.read",
}
CLUSTER = "alpha"


def _tool(name):
    return next((t["function"] for t in ADMIN_READ_TOOLS if t["function"]["name"] == name), None)


def _holder(permission):
    # A role's global permissions: the token's "*" entry, which is also its permissions.
    held = ("ai.tool.*", permission)
    return TokenPayload(user_id="u", role="member", permissions=held, matrix={"*": held, CLUSTER: ("resource.*.read",)})


def _reader():
    return TokenPayload(user_id="u", role="member", matrix={CLUSTER: ("ai.tool.*", "ai.mcp.use", "resource.*.read")})


def _service():
    service = SimpleNamespace()
    service.user_role = "admin"
    service._is_tool_allowed = MagicMock(return_value=True)
    service._call_tool_server = AsyncMock(return_value='{"ok": true}')
    service.k8s_service = MagicMock()
    return service


@pytest.mark.parametrize("name", sorted(SCREEN_PERMISSION))
def test_it_is_an_admin_read_and_not_in_the_read_seed(name):
    assert _tool(name) is not None, name
    assert name in mcp_server.READ_TOOLS
    assert name not in READONLY_TOOL_NAMES
    assert name not in WRITE_TOOL_NAMES
    assert mcp_server.READ_TOOLS[name].annotations.read_only_hint is True


@pytest.mark.parametrize("name,permission", sorted(SCREEN_PERMISSION.items()))
def test_it_is_offered_only_with_what_the_screen_asks(name, permission):
    assert features.REQUIRED_PERMISSIONS.get(name) == ("global", permission)
    assert screen_permissions.fixed_permissions().get(name) == permission

    holder, reader = _holder(permission), _reader()
    assert features.gated_names([name], {}, CLUSTER, holder) == [name]
    assert features.gated_names([name], {}, CLUSTER, reader) == []
    assert features.permitted_anywhere(name, holder) is True
    assert features.permitted_anywhere(name, reader) is False
    # A grant on one cluster is not the screen's global permission.
    on_a_cluster = TokenPayload(user_id="u", role="member", matrix={CLUSTER: ("ai.tool.*", permission)})
    assert features.permitted_anywhere(name, on_a_cluster) is False


@pytest.mark.parametrize("name,permission", sorted(SCREEN_PERMISSION.items()))
def test_a_call_asks_what_the_screen_asks(name, permission):
    assert permissions.token_may_call(_holder(permission), CLUSTER, name, {}) is True
    assert permissions.token_may_call(_reader(), CLUSTER, name, {}) is False
    reason = permissions.app_permission_error(_reader(), CLUSTER, name, {})
    assert reason and permission in reason and name in reason


def test_holding_one_screens_permission_does_not_open_the_others():
    holder = _holder("admin.review.read")
    offered = [name for name in SCREEN_PERMISSION if features.permitted_anywhere(name, holder)]
    assert offered == ["access_review"]
    audit = _holder("admin.audit.read")
    assert sorted(n for n in SCREEN_PERMISSION if features.permitted_anywhere(n, audit)) == ["ai_usage", "audit_integrity"]


@pytest.mark.parametrize("name", sorted(SCREEN_PERMISSION))
def test_a_grant_limited_to_namespaces_is_refused(name):
    scoped = TokenPayload(user_id="u", role="member", matrix={CLUSTER: ("ai.tool.*",)}, namespaces={CLUSTER: ("shop",)})
    reason = permissions.namespace_scope_error(scoped, CLUSTER, name, {})
    assert reason and "spans the cluster" in reason


@pytest.mark.asyncio
@pytest.mark.parametrize("name,given,sent", [
    ("access_review", {"review_section": "cluster_roles", "search": "prod", "limit": 10, "offset": 20, "bogus": 1},
     {"review_section": "cluster_roles", "search": "prod", "limit": 10, "offset": 20}),
    ("access_review", {"review_id": "r1", "since_time": "7d"}, {"review_id": "r1", "since_time": "7d"}),
    ("ai_usage", {"usage_group": "model", "since_time": "30d", "until_time": "2026-11-01T00:00:00Z", "limit": 5, "offset": 5, "bogus": 1},
     {"usage_group": "model", "since_time": "30d", "until_time": "2026-11-01T00:00:00Z", "limit": 5, "offset": 5}),
    ("access_requests", {"status": "decided", "search": "bob", "limit": 25, "offset": 25, "id": "rq1", "note": "ok"},
     {"status": "decided", "search": "bob", "limit": 25, "offset": 25}),
    ("audit_integrity", {"bogus": 1}, {}),
    ("hygiene_history", {"review_id": "h1", "severity": "critical", "check": "pss-level", "bogus": 1},
     {"review_id": "h1", "severity": "critical", "check": "pss-level"}),
    ("hygiene_history", {"limit": 10}, {"limit": 10}),
])
async def test_only_the_declared_arguments_travel(name, given, sent):
    service = _service()
    await execute_function_with_context(service, name, given, SimpleNamespace(state={}, cache={}))
    service._call_tool_server.assert_awaited_once_with(name, sent)


@pytest.mark.parametrize("name", sorted(SCREEN_PERMISSION))
def test_its_schema_declares_what_the_dispatch_passes(name):
    strings, flags, numbers = FEATURE_TOOL_ARGS[name]
    assert set(_tool(name)["parameters"].get("properties", {})) == set(strings) | set(flags) | set(numbers)
    # The MCP schema is closed: a model cannot send what the tool does not take.
    schema = mcp_server.READ_TOOLS[name].input_schema
    assert schema["additionalProperties"] is False and schema["required"] == ["cluster"]


def test_the_descriptions_say_what_stays_on_the_screens_and_what_is_not_given():
    assert "Approving or rejecting" in _tool("access_requests")["description"]
    assert "does not check the chain" in _tool("audit_integrity")["description"]
    review = _tool("access_review")["description"]
    assert "key_prefix" in review and "never" in review
    assert "Kubeast-wide" in review and "Kubeast-wide" in _tool("ai_usage")["description"]
    # Tool names the prompt gives the model, with the rule that deciding a request is a person's on the screen.
    for name in SCREEN_PERMISSION:
        assert name in SYSTEM_MESSAGE, name
    assert "승인·거절" in SYSTEM_MESSAGE
