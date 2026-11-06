# 사용자 권한 / role 기반 tool 필터링. ai_service.py 에서 추출 (Phase 4.5.2).
#
# self.token / self.user_role / self._token_payload (instance attribute) 의존
# 이라 service 첫 인자 패턴으로 추출. 모든 tool 권한은 요청의 활성 클러스터
# (service.cluster_name, 없으면 DEFAULT_CLUSTER) 기준으로만 판단한다 — 다른
# 클러스터에서 받은 권한은 여기서 아무 효력이 없다.

from typing import Any, Dict, List, Optional, Tuple, TYPE_CHECKING

from app.security import DEFAULT_CLUSTER, decode_access_token
from app.services.ai import screen_permissions
from app.services.tool_whitelists import WRITE_TOOL_NAMES

if TYPE_CHECKING:
    from app.services.ai_service import AIService


def effective_cluster(service: "AIService") -> str:
    return getattr(service, "cluster_name", None) or DEFAULT_CLUSTER


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
        return service.token.has_permission_for_cluster("resource.*.create", effective_cluster(service))
    return service.user_role in {"write", "admin"}


def role_allows_admin(service: "AIService") -> bool:
    if service.token:
        return service.token.has_permission("*")
    return service.user_role == "admin"


def missing_permissions(token, cluster: str, tool: str, args: Any = None) -> List[str]:
    """What a screen asks for this call and the token does not hold in this cluster (screen_permissions)."""
    return [p for p in screen_permissions.app_permissions(tool, args) or [] if not token.has_permission_for_cluster(p, cluster)]


def token_may_call(token, cluster: str, tool: str, args: Any = None) -> bool:
    """The token holds the tool and what a screen asks for the call, both in this cluster. Without arguments, for a
    list: some call of the tool could pass. A tool that is not in the table is refused to everyone."""
    if not token.has_permission_for_cluster(f"ai.tool.{tool}", cluster):
        return False
    if args is None:
        return screen_permissions.may_be_called(lambda p: token.has_permission_for_cluster(p, cluster), tool)
    return screen_permissions.app_permissions(tool, args) is not None and not missing_permissions(token, cluster, tool, args)


def _refusal(tool: str, required: List[str], cluster: str) -> str:
    # The same words as tool-server's refusal.
    return f"forbidden: {tool} needs the permission {', '.join(required)} in cluster {cluster}; your role there does not hold it"


def app_permission_error(token, cluster: str, tool: str, args: Any = None) -> Optional[str]:
    """Why what a screen asks refuses this call, or None."""
    if screen_permissions.app_permissions(tool, args) is None:
        return f"forbidden: no permission is on record for {tool}, so it is not run"
    missing = missing_permissions(token, cluster, tool, args)
    return _refusal(tool, missing, cluster) if missing else None


# The legacy role mode has no permissions to read: its rules stay in is_tool_allowed, and these two stay with admin.
_ADMIN_ONLY_WITHOUT_A_TOKEN = frozenset({"resource.pod.exec", "resource.workload.rollback"})


def tool_refusal(service: "AIService", tool: str, args: Any = None) -> Optional[str]:
    """app_permission_error for the request's cluster and user."""
    cluster = effective_cluster(service)
    token = getattr(service, "token", None)
    if token is not None:
        return app_permission_error(token, cluster, tool, args)
    if getattr(service, "user_role", None) == "admin":
        return None
    required = [p for p in screen_permissions.app_permissions(tool, args) or [] if p in _ADMIN_ONLY_WITHOUT_A_TOKEN]
    return _refusal(tool, required, cluster) if required else None


# Verbs the write tools ask on a kind, with what the model can say about each.
_KIND_VERBS = (("create", "creating objects"), ("edit", "changing objects"), ("delete", "deleting objects"))


def unavailable_note(service: "AIService") -> Optional[str]:
    """What this role may not ask the chat for and why, so an answer can say it. Nothing for a role with everything."""
    token = getattr(service, "token", None)
    if token is None:
        return None
    cluster = effective_cluster(service)
    if not any(is_tool_allowed(service, name) for name in WRITE_TOOL_NAMES):
        return (f"This user's role in cluster {cluster} holds no write tools, so this chat cannot change anything there. "
                "If they ask for a change, say that their role does not allow it and that an admin can grant one.")
    def holds(permission: str) -> bool:
        return token.has_permission_for_cluster(permission, cluster)

    lacking =[f"{required} ({what})" for tool, args, what in (
        ("k8s_execute_command", {}, "running a command in a pod, k8s_execute_command"),
        ("k8s_rollout", {"action": "undo"}, "a rollback, k8s_rollout with undo"),
    ) if holds(f"ai.tool.{tool}") for required in missing_permissions(token, cluster, tool, args)]
    lacking += [f"resource.<kind>.{verb} on any kind ({what})" for verb, what in _KIND_VERBS
                if not screen_permissions.holds_verb_on_some_kind(holds, verb)
                and any(holds(f"ai.tool.{tool}") and rule[0] in ("resource_type", "manifest") and rule[1] == verb
                        for tool, rule in screen_permissions.TOOL_SCREEN_TABLE.items() if tool in WRITE_TOOL_NAMES)]
    if not lacking:
        return None
    return (f"This user's role in cluster {cluster} does not hold {' or '.join(lacking)}. "
            "If they ask for that, say that their role lacks the permission and that an admin can grant it.")


def may_request_approval(service: "AIService", offered_tools: List[Dict], function_name: str) -> bool:
    """A write tool gets an approval card only if the model was offered it in
    this turn (a read-only widget offers none) and the user may run it. The
    model naming a tool it was not given is not a request the user should see."""
    offered = {t.get("function", {}).get("name") for t in (offered_tools or [])}
    return function_name in offered and is_tool_allowed(service, function_name)


def is_tool_allowed(service: "AIService", function_name: str) -> bool:
    if service.token:
        return token_may_call(service.token, effective_cluster(service), function_name)
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


def _without_undo(tool: Dict, reason: str) -> Dict:
    """k8s_rollout stays for restart and status; a copy says undo is not for this role (the catalog is shared)."""
    fn = dict(tool["function"])
    fn["description"] = f"Rollout actions: restart, pause, resume, status. Not undo: {reason}"
    parameters = fn.get("parameters")
    if isinstance(parameters, dict) and isinstance(parameters.get("properties"), dict) and "action" in parameters["properties"]:
        action = {**parameters["properties"]["action"], "description": "restart/pause/resume/status"}
        fn["parameters"] = {**parameters, "properties": {**parameters["properties"], "action": action}}
    return {**tool, "function": fn}


def filter_tools_by_role(service: "AIService", tools: List[Dict]) -> List[Dict]:
    filtered: List[Dict] = []
    for tool in tools:
        fn = (tool or {}).get("function", {})
        name = fn.get("name") if isinstance(fn, dict) else None
        if not isinstance(name, str) or not name:
            filtered.append(tool)
            continue
        if is_tool_allowed(service, name):
            refusal = tool_refusal(service, name, {"action": "undo"}) if name == "k8s_rollout" else None
            filtered.append(_without_undo(tool, refusal) if refusal else tool)
    return filtered


def scope_tool_args(function_args: Dict, cluster: str) -> Tuple[Dict, Optional[str]]:
    """Pin a tool call to the request's active cluster.

    The model never chooses the target cluster: whatever it put in `cluster`
    is replaced by the active one. Returns the scoped args and the discarded
    value (if any) so the caller can log the attempt.
    """
    args = dict(function_args or {})
    supplied = args.get("cluster")
    args["cluster"] = cluster
    if isinstance(supplied, str) and supplied and supplied != cluster:
        return args, supplied
    return args, None


# Tools without a namespace argument: refused outright for a caller whose grant
# on the cluster is limited to namespaces (the same list tool-server keeps).
CLUSTER_WIDE_TOOLS = frozenset({
    "k8s_get_available_api_resources", "k8s_get_cluster_configuration",
    "k8s_apply_manifest", "k8s_create_resource", "get_cluster_overview", "get_node_metrics",
    "prometheus_query", "prometheus_metrics", "prometheus_labels", "prometheus_rules", "prometheus_targets", "alerts_list",
    "hygiene", "k8s_diff", "audit_search", "nodes_stats_summary", "nodes_log",
})


def namespace_scope_error(token, cluster: str, function_name: str, args: Dict) -> Optional[str]:
    """Why a namespace-scoped grant refuses this call, or None. Mirrors
    tool-server's namespaceGate so the model gets the reason before the call
    leaves ai-service; tool-server refuses again on its own."""
    scope = token.namespaces.get(cluster, ()) if token else ()
    if not scope:
        return None
    listed = ", ".join(scope)
    if function_name in CLUSTER_WIDE_TOOLS:
        return f"forbidden: {function_name} spans the cluster; your grant on {cluster} is limited to namespaces {listed}"
    # The handlers read this flag before the namespace, so an own namespace beside it says nothing.
    all_namespaces = (args or {}).get("all_namespaces")
    if all_namespaces.strip().lower() == "true" if isinstance(all_namespaces, str) else bool(all_namespaces):
        return f"forbidden: all_namespaces spans the cluster; your grant on {cluster} is limited to namespaces {listed}"
    ns = str((args or {}).get("namespace") or "").strip()
    if not ns:
        return f"forbidden: namespace is required; your grant on {cluster} is limited to namespaces {listed}"
    if not token.allowed_in(cluster, ns):
        return f"forbidden: namespace {ns!r} is outside your grant on {cluster} ({listed})"
    return None
