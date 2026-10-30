# tool_dispatch 회귀 테스트 — execute_function_with_context 의 핵심 분기 검증.
#
# 큰 if-elif chain 이라 모든 분기를 다 cover 하기보단, **서로 다른 dispatch
# 경로** (권한 거부 / 캐시 히트 / write tool 위임 / read tool 위임 / k8s_service
# 직접 호출) 가 의도대로 작동하는지 확인. 각 분기의 정확한 인자 전달 / 호출
# 횟수까지 보장해야 silent failure 가 없다.

import json
from types import SimpleNamespace
from unittest.mock import AsyncMock, MagicMock

import pytest

from app.services.ai.tool_dispatch import execute_function_with_context


def _make_service(*, allowed: bool = True, role: str = "admin"):
    """Minimal AIService mock — execute_function_with_context 가 사용하는
    self.* 의존성만 stub. 모든 async method 는 AsyncMock 으로 호출 추적.
    """
    service = SimpleNamespace()
    service.user_role = role
    service._is_tool_allowed = MagicMock(return_value=allowed)
    service._coerce_limit = MagicMock(side_effect=lambda v: int(v) if v else 20)
    service._call_tool_server = AsyncMock(return_value='{"ok": true}')
    service._find_pods = AsyncMock(return_value=[])
    service._find_services = AsyncMock(return_value=[])
    service._locate_resource_for_yaml = AsyncMock(return_value=None)
    service._pick_log_container = AsyncMock(return_value=None)
    service._resolve_single = AsyncMock(return_value={})
    # k8s_service 의 모든 attribute 가 AsyncMock 처럼 동작하도록
    service.k8s_service = MagicMock()
    for attr in (
        "get_namespaces",
        "get_pod_metrics",
        "get_node_metrics",
        "get_cluster_overview",
    ):
        setattr(service.k8s_service, attr, AsyncMock(return_value=[]))
    return service


def _make_context(cache: dict | None = None):
    return SimpleNamespace(state={}, cache=cache if cache is not None else {})


@pytest.mark.asyncio
async def test_permission_denied_returns_error_json():
    """`_is_tool_allowed` False → 즉시 error JSON 반환, 다른 메서드 호출 X"""
    service = _make_service(allowed=False, role="read")
    ctx = _make_context()

    result = await execute_function_with_context(
        service, "k8s_delete_resource", {"name": "foo"}, ctx
    )

    parsed = json.loads(result)
    assert "error" in parsed
    assert "권한 없음" in parsed["error"]
    assert "read" in parsed["error"]
    # 권한 거부 시 실제 도구 호출은 일어나면 안 됨
    service._call_tool_server.assert_not_called()
    service.k8s_service.get_cluster_overview.assert_not_called()


@pytest.mark.asyncio
async def test_cache_hit_returns_cached_value_without_calling_tools():
    """캐시 히트 시 _call_tool_server / k8s_service 둘 다 호출 안 됨"""
    cached = '{"cached": "value"}'
    service = _make_service()
    ctx = _make_context(
        cache={f"get_cluster_overview_{json.dumps({}, sort_keys=True)}": cached}
    )

    result = await execute_function_with_context(
        service, "get_cluster_overview", {}, ctx
    )

    assert result == cached
    service._call_tool_server.assert_not_called()
    service.k8s_service.get_cluster_overview.assert_not_called()


@pytest.mark.asyncio
async def test_write_tool_routes_to_call_tool_server():
    """write tool (k8s_delete_resource 등) 은 _call_tool_server 로 위임"""
    service = _make_service()
    ctx = _make_context()

    args = {"resource_type": "pods", "resource_name": "x", "namespace": "default"}
    await execute_function_with_context(service, "k8s_delete_resource", args, ctx)

    service._call_tool_server.assert_awaited_once_with("k8s_delete_resource", args)


@pytest.mark.asyncio
async def test_read_tool_get_cluster_overview_routes_to_tool_server():
    """get_cluster_overview 도 _call_tool_server 로 위임 (분기 첫 케이스)"""
    service = _make_service()
    ctx = _make_context()

    await execute_function_with_context(service, "get_cluster_overview", {}, ctx)

    service._call_tool_server.assert_awaited_once_with("get_cluster_overview", {})


@pytest.mark.asyncio
async def test_names_no_tool_list_offers_are_unknown():
    """The old branches (get_pods, find_pods, get_namespaces …) were in no tool list the model or MCP gets and
    are gone: such a name answers Unknown function, without a cluster call."""
    service = _make_service()
    ctx = _make_context()
    for name in ("get_namespaces", "get_pods", "get_all_pods", "find_pods", "describe_pod", "get_pod_logs"):
        result = await execute_function_with_context(service, name, {"namespace": "default", "query": "web"}, ctx)
        assert json.loads(result) == {"error": f"Unknown function: {name}"}
    service._call_tool_server.assert_not_called()


@pytest.mark.asyncio
async def test_cache_miss_writes_to_cache():
    """첫 호출 후 결과가 ctx.cache 에 저장 (다음 호출에서 히트)"""
    service = _make_service()
    ctx = _make_context()

    await execute_function_with_context(service, "get_cluster_overview", {}, ctx)

    cache_key = f"get_cluster_overview_{json.dumps({}, sort_keys=True)}"
    assert cache_key in ctx.cache


@pytest.mark.asyncio
async def test_unknown_tool_returns_error_json():
    """등록 안 된 function_name → error JSON (silent failure 방지)"""
    service = _make_service()
    ctx = _make_context()

    result = await execute_function_with_context(
        service, "totally_unknown_tool_xyz", {}, ctx
    )

    parsed = json.loads(result)
    assert "error" in parsed


@pytest.mark.asyncio
async def test_events_tool_forwards_its_limit():
    """k8s_get_events lists the newest events: the model's limit goes to tool-server, a non-number does not"""
    service = _make_service()
    await execute_function_with_context(service, "k8s_get_events", {"namespace": "bulk", "limit": 50}, _make_context())
    service._call_tool_server.assert_awaited_with("k8s_get_events", {"namespace": "bulk", "limit": 50})
    await execute_function_with_context(service, "k8s_get_events", {"namespace": "bulk", "limit": "50"}, _make_context())
    service._call_tool_server.assert_awaited_with("k8s_get_events", {"namespace": "bulk"})
