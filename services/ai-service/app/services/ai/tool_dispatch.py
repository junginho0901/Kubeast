# AI Chat session 의 tool dispatch — _execute_function_with_context 추출.
#
# ai_service.py 의 마지막 함수였던 거대한 if-elif chain (~414줄). 분할 패턴은
# prompts.py / tools.py / language.py 와 동일: instance method 본문을 모듈
# 함수로 옮기고, AIService 의 메서드는 wrapper 1줄로 위임. self 의존성
# (k8s_service, user_role, _call_tool_server, _is_tool_allowed, _find_pods,
# _find_services, _locate_resource_for_yaml, _pick_log_container,
# _resolve_single, _coerce_limit) 는 service 인자를 통해 접근.
# 모델·MCP 도구 목록(tools.py)에 없는 옛 이름(get_pods·find_pods 등)의 분기와 옛 _execute_function 은
# 부르는 곳이 없어 10-30 지움.
#
# Mixin / 상속 안 쓴 이유: §0 핵심 원칙 "행동 변화 0, 새 추상화 도입 금지".
# 모듈 함수 패턴이 Phase 0~2 의 모든 분할과 일관 (frontend hook / Go routes /
# api.ts 도메인 / prompts / tools / language 다 함수·상수 추출).
#
# 변경 시 주의: AI Chat session_chat_stream 의 tool 호출 dispatch 가 모두 이
# 함수를 거친다. if-elif chain 의 function_name 은 tools.py 의 K8S_READONLY_TOOLS
# / K8S_WRITE_TOOLS 의 name 과 매칭되어야 한다 (mismatch = silent failure).

from typing import TYPE_CHECKING, Dict

from app.services.ai import resolvers
from app.services.ai.debug_dump import dump, log, safe_error

if TYPE_CHECKING:
    from app.services.ai_service import AIService, ToolContext


def _flag(value) -> bool:
    """A boolean tool argument as the model may send it (True, "true", 1)."""
    if isinstance(value, str):
        return value.strip().lower() == "true"
    return bool(value)


# Feature tools (tool-server → k8s-service): the string, boolean and integer
# arguments each one declares. Anything else the model sends is dropped.
# Integer arguments that may be zero or negative (a system boot index: 0 current, -1 previous).
SIGNED_INT_ARGS = {"boot"}
# String arguments a model may send as a number (a port: 8080 or http).
NUMERIC_STRING_ARGS = {"port"}

FEATURE_TOOL_ARGS = {
    "issues": ({"namespace", "severity"}, set(), {"window_minutes"}),
    "prometheus_query": ({"promql", "since", "since_time", "until_time"}, {"range"}, {"step"}),
    "prometheus_metrics": ({"pattern"}, set(), {"limit"}),
    "prometheus_labels": ({"selector", "label", "since"}, set(), {"limit"}),
    "prometheus_rules": ({"rule", "rule_type"}, {"active_only"}, set()),
    "prometheus_targets": ({"health", "job"}, set(), set()),
    "logsearch": ({"namespace", "text", "pod", "container", "workload_kind", "workload_name", "since"}, {"regex"}, {"limit"}),
    "loki_query": ({"logql", "namespace", "since", "since_time", "until_time"}, set(), {"step", "limit"}),
    "loki_labels": ({"label", "namespace", "since"}, set(), set()),
    "loki_patterns": ({"selector", "namespace", "since", "since_time", "until_time"}, set(), set()),
    "traces_search": ({"traceql", "namespace", "since", "since_time", "until_time"}, set(), {"limit"}),
    "traces_get": ({"trace_id", "namespace"}, set(), set()),
    "traces_tags": ({"scope", "tag", "namespace", "since"}, set(), set()),
    "traces_metrics": ({"traceql", "namespace", "since", "since_time", "until_time"}, set(), {"step"}),
    "traces_compare": ({"traceql", "namespace", "since", "since_time", "until_time"}, set(), {"limit"}),
    "alerts_list": ({"state", "alertname"}, set(), set()),
    "hygiene": ({"severity", "check"}, set(), set()),
    "gitops_status": ({"namespace", "name", "project", "destination_namespace"}, {"only_problems"}, {"limit"}),
    "audit_search": ({"audit_action", "service", "actor_email", "target_id", "namespace", "result", "since_time", "until_time"}, {"all_clusters"}, {"limit", "offset"}),
    "nodes_stats_summary": ({"node", "rank_by"}, set(), {"top"}),
    "nodes_log": ({"node", "source", "pattern", "since_time", "until_time"}, set(), {"tail_lines", "boot"}),
    "policy_reports": ({"view", "namespace", "policy", "kind", "results", "severities", "search"}, set(), {"limit"}),
    "helm_read": ({"what", "namespace", "release", "status", "section"}, set(), {"revision", "from", "to"}),
    "cost": ({"window", "aggregate", "namespace"}, set(), set()),
    "optimization": ({"namespace"}, set(), {"window_hours"}),
    "can_i": ({"verb", "resource", "group", "namespace"}, set(), set()),
    "network_policy_check": ({"src", "dst", "port", "protocol"}, set(), set()),
    "network_flows": ({"namespace", "pod", "workload_kind", "workload_name", "verdict", "since"}, set(), {"limit"}),
    "network_drops": ({"namespace", "pod", "workload_kind", "workload_name", "since"}, set(), set()),
    "network_top_flows": ({"namespace", "pod", "workload_kind", "workload_name", "metric", "destination", "since"}, set(), set()),
    "resource_graph": ({"namespace"}, set(), set()),
    # Query tools (kubectl + jq / columns / count, filtered in tool-server).
    "k8s_jq_query": ({"resource_type", "jq", "namespace", "label_selector", "field_selector"}, set(), {"limit"}),
    "k8s_tabular_query": ({"resource_type", "columns", "namespace", "label_selector", "field_selector", "sort_by"}, set(), {"limit"}),
    "k8s_count": ({"resource_type", "group_by", "namespace", "label_selector", "field_selector"}, set(), set()),
}


async def execute_function_with_context(
    service: "AIService",
    function_name: str,
    function_args: Dict,
    tool_context: "ToolContext",
) -> str:
    """Function 실행 (Tool Context 포함). ai_service.py 의
    _execute_function_with_context 본문 그대로 — `self.*` → `service.*` 치환만."""
    """Function 실행 (Tool Context 포함)"""
    import json
    
    try:
        log.debug("[DEBUG] Executing %s with context, state keys: %s", function_name, list(tool_context.state.keys()))
        if not service._is_tool_allowed(function_name):
            return json.dumps(
                {"error": f"권한 없음: '{function_name}'는 {service.user_role} 역할에서 사용할 수 없습니다."},
                ensure_ascii=False,
            )
        
        # 캐시 확인
        cache_key = f"{function_name}_{json.dumps(function_args, sort_keys=True)}"
        if cache_key in tool_context.cache:
            log.debug("[DEBUG] Cache hit for %s", cache_key)
            return tool_context.cache[cache_key]

        from app.services.tool_whitelists import WRITE_TOOL_NAMES

        if function_name in WRITE_TOOL_NAMES:
            return await service._call_tool_server(function_name, function_args)

        # 함수 실행
        if function_name == "get_cluster_overview":
            result = await service._call_tool_server(function_name, function_args)
        
        elif function_name == "k8s_get_resources":
            resource_type = function_args.get("resource_type", "")
            resource_name = function_args.get("resource_name")
            namespace = function_args.get("namespace")
            all_namespaces_raw = function_args.get("all_namespaces", False)
            output = function_args.get("output", "wide")

            if isinstance(all_namespaces_raw, str):
                all_namespaces = all_namespaces_raw.strip().lower() == "true"
            else:
                all_namespaces = bool(all_namespaces_raw)
            if not isinstance(namespace, str) or not namespace.strip():
                all_namespaces = True
            if isinstance(output, str) and output.strip().lower() == "yaml":
                output = "json"

            tool_args = {
                "resource_type": resource_type,
                "resource_name": resource_name,
                "namespace": namespace if isinstance(namespace, str) else None,
                "all_namespaces": all_namespaces,
                "output": output if isinstance(output, str) else "wide",
            }
            if function_args.get("offset") is not None:
                tool_args["offset"] = resolvers._coerce_limit(service, function_args.get("offset"), default=0, max_value=1_000_000)
            result = await service._call_tool_server(function_name, tool_args)

        elif function_name == "k8s_get_resource_yaml":
            namespace = function_args.get("namespace")
            resource_type = function_args.get("resource_type", "")
            resource_name = function_args.get("resource_name", "")

            # Support "pods/foo" style resource_name if resource_type is missing.
            if isinstance(resource_name, str) and "/" in resource_name:
                prefix, name = resource_name.split("/", 1)
                if prefix and name and not (isinstance(resource_type, str) and resource_type.strip()):
                    resource_type = prefix
                    resource_name = name

            resource_type = str(resource_type or "").strip()
            resource_name = str(resource_name or "").strip()
            ns = namespace if isinstance(namespace, str) and namespace.strip() else None

            if not resource_name:
                raise Exception("resource_name is required for k8s_get_resource_yaml")

            resolved = None
            if not resource_type or ns is None:
                resolved = await resolvers._locate_resource_for_yaml(service, 
                    resource_name=resource_name,
                    namespace=ns,
                    preferred_type=resource_type or None,
                )
                resource_type = str(resolved.get("resource_type") or resource_type)
                resource_name = str(resolved.get("resource_name") or resource_name)
                ns = resolved.get("namespace") or ns

            try:
                result = await service._call_tool_server(
                    function_name,
                    {
                        "resource_type": resource_type,
                        "resource_name": resource_name,
                        "namespace": ns,
                    },
                )
            except Exception:
                if resolved is None:
                    resolved = await resolvers._locate_resource_for_yaml(service, 
                        resource_name=resource_name,
                        namespace=ns,
                        preferred_type=resource_type or None,
                    )
                    resource_type = str(resolved.get("resource_type") or resource_type)
                    resource_name = str(resolved.get("resource_name") or resource_name)
                    ns = resolved.get("namespace") or ns
                    result = await service._call_tool_server(
                        function_name,
                        {
                            "resource_type": resource_type,
                            "resource_name": resource_name,
                            "namespace": ns,
                        },
                    )
                else:
                    raise

        elif function_name == "k8s_describe_resource":
            namespace = function_args.get("namespace")
            result = await service._call_tool_server(
                function_name,
                {
                    "resource_type": function_args.get("resource_type", ""),
                    "resource_name": function_args.get("resource_name", ""),
                    "namespace": namespace if isinstance(namespace, str) else None,
                },
            )

        elif function_name == "k8s_get_pod_logs":
            namespace = function_args.get("namespace")
            pod_name = function_args.get("pod_name", "")
            if isinstance(pod_name, str) and "/" in pod_name:
                pod_name = pod_name.split("/")[-1]
            tail_lines = resolvers._coerce_limit(service, function_args.get("tail_lines", 50), default=50, max_value=2000)
            requested_container = function_args.get("container")
            every_container = _flag(function_args.get("all_containers"))

            if not isinstance(namespace, str) or not namespace.strip():
                matches = await resolvers._find_pods(service, str(pod_name), namespace=None, limit=20)
                if matches:
                    chosen = await resolvers._resolve_single(service, "pods", str(pod_name), matches)
                    namespace = str(chosen.get("namespace", ""))
                    pod_name = str(chosen.get("name", pod_name))
                else:
                    # Nothing matched here: tool-server answers not_found with
                    # the similar names across the namespaces the user may see.
                    namespace = ""

            chosen_container, all_containers = None, None
            if namespace and not every_container:
                chosen_container, all_containers = await resolvers._pick_log_container(service,
                    namespace,
                    pod_name,
                    explicit_container=requested_container,
                )

            if chosen_container is None and all_containers:
                result = json.dumps(
                    {
                        "status": "container_required",
                        "pod": pod_name,
                        "namespace": namespace,
                        "containers": all_containers,
                        "hint": "The pod has several containers. Call again with container=<one of containers>, or all_containers=true.",
                    },
                    ensure_ascii=False,
                )
            else:
                tool_args = {
                    "namespace": namespace or None,
                    "pod_name": pod_name,
                    "tail_lines": tail_lines,
                    "container": chosen_container,
                }
                for key in ("previous", "all_containers"):
                    if _flag(function_args.get(key)):
                        tool_args[key] = True
                for key in ("since", "grep"):
                    value = function_args.get(key)
                    if isinstance(value, str) and value.strip():
                        tool_args[key] = value.strip()
                result = await service._call_tool_server(function_name, tool_args)
                tool_context.state["last_log_pod"] = pod_name

        elif function_name == "k8s_get_events":
            namespace = function_args.get("namespace")
            ns = namespace if isinstance(namespace, str) and namespace.strip() else None
            tool_args = {"namespace": ns}
            if _flag(function_args.get("all_namespaces")):
                tool_args["all_namespaces"] = True
            for key in ("kind", "name", "field_selector"):
                value = function_args.get(key)
                if isinstance(value, str) and value.strip():
                    tool_args[key] = value.strip()
            limit = function_args.get("limit")
            if isinstance(limit, int) and not isinstance(limit, bool) and limit > 0:
                tool_args["limit"] = limit
            result = await service._call_tool_server(function_name, tool_args)

        elif function_name == "k8s_find_resource":
            tool_args = {"query": str(function_args.get("query", "")).strip()}
            kinds = function_args.get("kinds")
            if isinstance(kinds, list) and kinds:
                tool_args["kinds"] = [str(k).strip() for k in kinds if str(k).strip()]
            elif isinstance(kinds, str) and kinds.strip():
                tool_args["kinds"] = kinds.strip()
            namespace = function_args.get("namespace")
            if isinstance(namespace, str) and namespace.strip():
                tool_args["namespace"] = namespace.strip()
            if function_args.get("limit") is not None:
                tool_args["limit"] = resolvers._coerce_limit(service, function_args.get("limit"), default=20, max_value=50)
            result = await service._call_tool_server(function_name, tool_args)

        elif function_name == "k8s_explain":
            tool_args = {"resource": str(function_args.get("resource", "")).strip()}
            api_version = function_args.get("api_version")
            if isinstance(api_version, str) and api_version.strip():
                tool_args["api_version"] = api_version.strip()
            if _flag(function_args.get("recursive")):
                tool_args["recursive"] = True
            result = await service._call_tool_server(function_name, tool_args)

        elif function_name == "k8s_diff":
            # A write preview: the manifest travels like apply's, nothing is applied.
            tool_args = {}
            for key in ("yaml_content", "manifest", "namespace"):
                value = function_args.get(key)
                if isinstance(value, str) and value.strip():
                    tool_args[key] = value.strip() if key == "namespace" else value
            if isinstance(function_args.get("resource_manifest"), (dict, str)):
                tool_args["resource_manifest"] = function_args["resource_manifest"]
            result = await service._call_tool_server(function_name, tool_args)

        elif function_name in FEATURE_TOOL_ARGS:
            # Feature tools: tool-server calls k8s-service as the user; only the
            # declared arguments travel, booleans and integers normalised.
            spec = FEATURE_TOOL_ARGS[function_name]
            tool_args = {}
            for key in spec[0]:
                value = function_args.get(key)
                if isinstance(value, str) and value.strip():
                    tool_args[key] = value.strip()
                elif key in NUMERIC_STRING_ARGS and isinstance(value, (int, float)) and not isinstance(value, bool):
                    tool_args[key] = str(int(value))
            for key in spec[1]:
                if _flag(function_args.get(key)):
                    tool_args[key] = True
            for key in spec[2]:
                if function_args.get(key) is None:
                    continue
                if key in SIGNED_INT_ARGS:
                    try:
                        tool_args[key] = int(function_args.get(key))  # type: ignore[arg-type]
                    except (TypeError, ValueError):
                        pass
                    continue
                tool_args[key] = resolvers._coerce_limit(service, function_args.get(key), default=0, max_value=1_000_000)
            if function_name == "prometheus_query" and _flag(function_args.get("chart")):
                tool_args["range"] = True  # a graph needs points; chart/title/unit stay here (app/services/ai/charts.py)
            labels = function_args.get("alert_labels")
            if function_name == "alerts_list" and isinstance(labels, dict):
                tool_args["alert_labels"] = {str(k): str(v) for k, v in list(labels.items())[:10] if isinstance(v, (str, int, float))}
            result = await service._call_tool_server(function_name, tool_args)

        elif function_name == "k8s_get_available_api_resources":
            result = await service._call_tool_server(function_name, {})

        elif function_name == "k8s_get_cluster_configuration":
            result = await service._call_tool_server(function_name, {})

        elif function_name == "k8s_check_service_connectivity":
            namespace = function_args.get("namespace")
            service_name = function_args.get("service_name") or function_args.get("name") or function_args.get("service")
            port = function_args.get("port")

            if not service_name:
                raise Exception("service_name is required")

            if not isinstance(namespace, str) or not namespace.strip():
                matches = await resolvers._find_services(service, str(service_name), namespace=None, limit=20)
                chosen = await resolvers._resolve_single(service, "services", str(service_name), matches)
                namespace = str(chosen.get("namespace", ""))
                service_name = str(chosen.get("name", service_name))

            result = await service._call_tool_server(
                function_name,
                {
                    "namespace": str(namespace),
                    "service_name": str(service_name),
                    "port": str(port) if port is not None else None,
                },
            )

        elif function_name == "get_pod_metrics":
            namespace = function_args.get("namespace")
            result = await service._call_tool_server(
                function_name,
                {"namespace": namespace} if namespace else {},
            )
        
        elif function_name == "get_node_metrics":
            result = await service._call_tool_server(function_name, {})
        
        else:
            return json.dumps({"error": f"Unknown function: {function_name}"})
        
        # 캐시에 저장 (5분 TTL)
        tool_context.cache[cache_key] = result
        
        log.debug("[DEBUG] Function result cached: %s", cache_key)
        return result
    
    except Exception as e:
        error_msg = f"Error in {function_name}: {str(e)}"
        log.warning("%s", safe_error(error_msg))
        return json.dumps({"error": error_msg}, ensure_ascii=False)
