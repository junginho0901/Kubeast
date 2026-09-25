"""Tool whitelist definitions for restricted AI contexts.

플로팅 AI 위젯처럼 쓰기 작업이 허용되지 않는 컨텍스트에서 AIService 의
전체 tool 목록 중 조회 전용만 통과시키기 위한 allowlist 와 filter 헬퍼.

allowlist 방식 — 신규 tool 이 추가돼도 명시적으로 여기 넣기 전까지는
자동 차단되어 의도치 않은 write 노출을 방지한다.
"""
from typing import Any, Dict, List


READONLY_TOOL_NAMES: frozenset[str] = frozenset(
    {
        "get_cluster_overview",
        "get_pod_metrics",
        "get_node_metrics",
        "k8s_get_resources",
        "k8s_get_resource_yaml",
        "k8s_get_pod_logs",
        "k8s_get_events",
        "k8s_get_available_api_resources",
        "k8s_get_cluster_configuration",
        "k8s_check_service_connectivity",
        "k8s_describe_resource",
    }
)


# Tools that change cluster state. They are never executed straight from the
# model's tool call: the stream records an approval request and the user
# approves or rejects it (H2, OWASP LLM06). Keep in sync with tool_dispatch.
WRITE_TOOL_NAMES: frozenset[str] = frozenset(
    {
        "k8s_apply_manifest",
        "k8s_create_resource",
        "k8s_delete_resource",
        "k8s_patch_resource",
        "k8s_annotate_resource",
        "k8s_remove_annotation",
        "k8s_label_resource",
        "k8s_remove_label",
        "k8s_scale",
        "k8s_rollout",
        "k8s_execute_command",
    }
)


def write_approval_required() -> bool:
    """AI_WRITE_APPROVAL (default on): write tools wait for the user's approval
    instead of running straight from the model's call. Off is for local dev only."""
    import os

    return os.getenv("AI_WRITE_APPROVAL", "true").strip().lower() != "false"


def readonly_tool_filter(tools: List[Dict[str, Any]]) -> List[Dict[str, Any]]:
    """AIService 의 전체 tool 목록에서 READONLY 만 통과시키는 필터.

    `AIService.session_chat_stream(..., tool_filter=readonly_tool_filter)` 로
    주입된다. 이름 기반 매칭이라 tool 스펙(arguments 등) 이 바뀌어도 영향 없음.
    """
    return [
        t for t in tools if t.get("function", {}).get("name") in READONLY_TOOL_NAMES
    ]
