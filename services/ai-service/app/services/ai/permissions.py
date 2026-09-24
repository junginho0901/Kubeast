# 사용자 권한 / role 기반 tool 필터링. ai_service.py 에서 추출 (Phase 4.5.2).
#
# self.token / self.user_role / self._token_payload (instance attribute) 의존
# 이라 service 첫 인자 패턴으로 추출.

from typing import Dict, List, Optional, TYPE_CHECKING

from app.security import decode_access_token

if TYPE_CHECKING:
    from app.services.ai_service import AIService


def resolve_user_role(service: "AIService", authorization: Optional[str]) -> str:
    if not authorization:
        return "read"
    try:
        parts = authorization.split(" ", 1)
        token = parts[1].strip() if len(parts) == 2 else authorization.strip()
        payload = decode_access_token(token)
        service._token_payload = payload
        role = (payload.role or "").strip().lower()
        if role in {"admin", "read", "write"}:
            return role
    except Exception:
        pass
    return "read"


def role_allows_write(service: "AIService") -> bool:
    if service.token:
        return service.token.has_permission("resource.*.create")
    return service.user_role in {"write", "admin"}


def role_allows_admin(service: "AIService") -> bool:
    if service.token:
        return service.token.has_permission("*")
    return service.user_role == "admin"


def is_tool_allowed(service: "AIService", function_name: str) -> bool:
    if service.token:
        return service.token.has_permission(f"ai.tool.{function_name}")
    # Fallback to legacy role-based checks
    write_tools = {
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
    }
    admin_only_tools = {
        "k8s_execute_command",
    }

    if function_name in admin_only_tools:
        return service.user_role == "admin"
    if function_name in write_tools:
        return service.user_role in {"write", "admin"}
    return True


def filter_tools_by_role(service: "AIService", tools: List[Dict]) -> List[Dict]:
    filtered: List[Dict] = []
    for tool in tools:
        fn = (tool or {}).get("function", {})
        name = fn.get("name") if isinstance(fn, dict) else None
        if not isinstance(name, str) or not name:
            filtered.append(tool)
            continue
        if is_tool_allowed(service, name):
            filtered.append(tool)
    return filtered
