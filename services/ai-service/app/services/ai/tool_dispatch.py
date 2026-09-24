# AI Chat session 의 tool dispatch — _execute_function_with_context 추출.
#
# ai_service.py 의 마지막 함수였던 거대한 if-elif chain (~414줄). 분할 패턴은
# prompts.py / tools.py / language.py 와 동일: instance method 본문을 모듈
# 함수로 옮기고, AIService 의 메서드는 wrapper 1줄로 위임. self 의존성 11개
# (k8s_service, user_role, _call_tool_server, _is_tool_allowed, _find_pods,
# _find_services, _find_deployments, _locate_resource_for_yaml, _pick_log_container,
# _resolve_single, _coerce_limit) 는 service 인자를 통해 접근.
#
# Mixin / 상속 안 쓴 이유: §0 핵심 원칙 "행동 변화 0, 새 추상화 도입 금지".
# 모듈 함수 패턴이 Phase 0~2 의 모든 분할과 일관 (frontend hook / Go routes /
# api.ts 도메인 / prompts / tools / language 다 함수·상수 추출).
#
# 변경 시 주의: AI Chat session_chat_stream 의 tool 호출 dispatch 가 모두 이
# 함수를 거친다. if-elif chain 의 function_name 은 tools.py 의 K8S_READONLY_TOOLS
# / K8S_WRITE_TOOLS 의 name 과 매칭되어야 한다 (mismatch = silent failure).

from typing import TYPE_CHECKING, Dict

if TYPE_CHECKING:
    from app.services.ai_service import AIService, ToolContext


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
        print(f"[DEBUG] Executing {function_name} with context, state keys: {list(tool_context.state.keys())}")
        if not service._is_tool_allowed(function_name):
            return json.dumps(
                {"error": f"권한 없음: '{function_name}'는 {service.user_role} 역할에서 사용할 수 없습니다."},
                ensure_ascii=False,
            )
        
        # 캐시 확인
        cache_key = f"{function_name}_{json.dumps(function_args, sort_keys=True)}"
        if cache_key in tool_context.cache:
            print(f"[DEBUG] Cache hit for {cache_key}")
            return tool_context.cache[cache_key]

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
            "k8s_execute_command",
        }
        if function_name in write_tools:
            return await service._call_tool_server(function_name, function_args)

        # 함수 실행
        if function_name == "get_cluster_overview":
            result = await service._call_tool_server(function_name, function_args)
        
        elif function_name == "get_namespaces":
            namespaces = await service.k8s_service.get_namespaces()
            result = json.dumps(namespaces, ensure_ascii=False)
            tool_context.state["last_namespaces"] = [ns["name"] for ns in namespaces]
        
        elif function_name == "get_all_pods":
            pods = await service.k8s_service.get_all_pods()
            result = json.dumps(pods, ensure_ascii=False)
            tool_context.state["last_all_pods_count"] = len(pods)

        elif function_name == "find_pods":
            query_raw = str(function_args.get("query", "")).strip()
            if not query_raw:
                raise Exception("find_pods requires non-empty 'query'")
            namespace = function_args.get("namespace")
            limit_int = service._coerce_limit(function_args.get("limit", 20))
            matches = await resolvers._find_pods(service, 
                query_raw,
                namespace=namespace if isinstance(namespace, str) else None,
                limit=limit_int,
            )
            result = json.dumps(matches, ensure_ascii=False)
            tool_context.state["last_pod_search_query"] = query_raw
            tool_context.state["last_pod_search_count"] = len(matches)

        elif function_name == "find_services":
            query_raw = str(function_args.get("query", "")).strip()
            if not query_raw:
                raise Exception("find_services requires non-empty 'query'")
            namespace = function_args.get("namespace")
            limit_int = service._coerce_limit(function_args.get("limit", 20))
            matches = await resolvers._find_services(service, 
                query_raw,
                namespace=namespace if isinstance(namespace, str) else None,
                limit=limit_int,
            )
            result = json.dumps(matches, ensure_ascii=False)

        elif function_name == "find_deployments":
            query_raw = str(function_args.get("query", "")).strip()
            if not query_raw:
                raise Exception("find_deployments requires non-empty 'query'")
            namespace = function_args.get("namespace")
            limit_int = service._coerce_limit(function_args.get("limit", 20))
            matches = await resolvers._find_deployments(service, 
                query_raw,
                namespace=namespace if isinstance(namespace, str) else None,
                limit=limit_int,
            )
            result = json.dumps(matches, ensure_ascii=False)
        
        elif function_name == "get_pods":
            pods = await service.k8s_service.get_pods(function_args["namespace"])
            result = json.dumps(pods, ensure_ascii=False)
            tool_context.state["last_namespace"] = function_args["namespace"]
            tool_context.state["last_pods"] = [{"name": pod["name"], "status": pod["status"]} for pod in pods]
        
        elif function_name == "describe_pod":
            namespace = function_args.get("namespace")
            name = function_args["name"]
            if not isinstance(namespace, str) or not namespace.strip():
                matches = await resolvers._find_pods(service, str(name), namespace=None, limit=20)
                chosen = await resolvers._resolve_single(service, "pods", str(name), matches)
                namespace = str(chosen.get("namespace", ""))
                name = str(chosen.get("name", name))

            result_data = await service.k8s_service.describe_pod(namespace, name)
            result = json.dumps(result_data, ensure_ascii=False)
            tool_context.state["last_described_pod"] = function_args["name"]
        
        elif function_name == "get_pod_logs":
            namespace = function_args.get("namespace")
            pod_name = function_args["pod_name"]
            tail_lines = function_args.get("tail_lines", 100)
            requested_container = function_args.get("container")

            if not isinstance(namespace, str) or not namespace.strip():
                matches = await resolvers._find_pods(service, str(pod_name), namespace=None, limit=20)
                chosen = await resolvers._resolve_single(service, "pods", str(pod_name), matches)
                namespace = str(chosen.get("namespace", ""))
                pod_name = str(chosen.get("name", pod_name))

            chosen_container, all_containers = await resolvers._pick_log_container(service, 
                namespace,
                pod_name,
                explicit_container=requested_container,
            )

            # 여러 컨테이너가 있는데 어떤 것을 쓸지 결정하지 못한 경우
            if chosen_container is None and all_containers:
                return json.dumps(
                    {
                        "error": (
                            f"Pod '{pod_name}' in namespace '{namespace}' has multiple containers "
                            f"({', '.join(all_containers)}). "
                            "로그를 조회할 컨테이너를 'container' 인자로 명시해주세요."
                        )
                    },
                    ensure_ascii=False,
                )

            logs = await service.k8s_service.get_pod_logs(
                namespace,
                pod_name,
                tail_lines=tail_lines,
                container=chosen_container,
            )
            result = logs
            tool_context.state["last_log_pod"] = pod_name
        
        elif function_name == "get_deployments":
            deployments = await service.k8s_service.get_deployments(function_args["namespace"])
            result = json.dumps(deployments, ensure_ascii=False)
        
        elif function_name == "describe_deployment":
            namespace = function_args.get("namespace")
            name = function_args["name"]
            if not isinstance(namespace, str) or not namespace.strip():
                matches = await resolvers._find_deployments(service, str(name), namespace=None, limit=20)
                chosen = await resolvers._resolve_single(service, "deployments", str(name), matches)
                namespace = str(chosen.get("namespace", ""))
                name = str(chosen.get("name", name))

            result_data = await service.k8s_service.describe_deployment(namespace, name)
            result = json.dumps(result_data, ensure_ascii=False)
        
        elif function_name == "get_services":
            services = await service.k8s_service.get_services(function_args["namespace"])
            result = json.dumps(services, ensure_ascii=False)
        
        elif function_name == "describe_service":
            namespace = function_args.get("namespace")
            name = function_args["name"]
            if not isinstance(namespace, str) or not namespace.strip():
                matches = await resolvers._find_services(service, str(name), namespace=None, limit=20)
                chosen = await resolvers._resolve_single(service, "services", str(name), matches)
                namespace = str(chosen.get("namespace", ""))
                name = str(chosen.get("name", name))

            result_data = await service.k8s_service.describe_service(namespace, name)
            result = json.dumps(result_data, ensure_ascii=False)
        
        elif function_name == "get_events":
            events = await service.k8s_service.get_events(function_args["namespace"])
            result = json.dumps([{
                "type": event["type"],
                "reason": event["reason"],
                "message": event["message"],
                "count": event["count"]
            } for event in events], ensure_ascii=False)

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
            tail_lines = service._coerce_limit(function_args.get("tail_lines", 50), default=50, max_value=2000)
            requested_container = function_args.get("container")

            if not isinstance(namespace, str) or not namespace.strip():
                matches = await resolvers._find_pods(service, str(pod_name), namespace=None, limit=20)
                chosen = await resolvers._resolve_single(service, "pods", str(pod_name), matches)
                namespace = str(chosen.get("namespace", ""))
                pod_name = str(chosen.get("name", pod_name))

            chosen_container, all_containers = await resolvers._pick_log_container(service, 
                namespace,
                pod_name,
                explicit_container=requested_container,
            )

            if chosen_container is None and all_containers:
                result = json.dumps(
                    {
                        "error": (
                            f"Pod '{pod_name}' in namespace '{namespace}' has multiple containers "
                            f"({', '.join(all_containers)}). "
                            "로그를 조회할 컨테이너를 'container' 인자로 명시해주세요."
                        )
                    },
                    ensure_ascii=False,
                )
            else:
                result = await service._call_tool_server(
                    function_name,
                    {
                        "namespace": namespace,
                        "pod_name": pod_name,
                        "tail_lines": tail_lines,
                        "container": chosen_container,
                    },
                )
                tool_context.state["last_log_pod"] = pod_name

        elif function_name == "k8s_get_events":
            namespace = function_args.get("namespace")
            ns = namespace if isinstance(namespace, str) and namespace.strip() else None
            result = await service._call_tool_server(function_name, {"namespace": ns})

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

        elif function_name == "k8s_generate_resource":
            result = json.dumps(
                {"error": "YAML 생성은 비활성화되었습니다."},
                ensure_ascii=False,
            )
        
        elif function_name == "get_node_list":
            nodes = await service.k8s_service.get_node_list()
            result = json.dumps(nodes, ensure_ascii=False)
        
        elif function_name == "describe_node":
            result_data = await service.k8s_service.describe_node(function_args["name"])
            result = json.dumps(result_data, ensure_ascii=False)
        
        elif function_name == "get_pvcs":
            namespace = function_args.get("namespace")
            pvcs = await service.k8s_service.get_pvcs(namespace) if namespace else await service.k8s_service.get_pvcs()
            result = json.dumps(pvcs, ensure_ascii=False)
        
        elif function_name == "get_pvs":
            pvs = await service.k8s_service.get_pvs()
            result = json.dumps(pvs, ensure_ascii=False)
        
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
        
        print(f"[DEBUG] Function result cached: {cache_key}")
        return result
    
    except Exception as e:
        error_msg = f"Error in {function_name}: {str(e)}"
        print(f"[DEBUG] {error_msg}")
        return json.dumps({"error": error_msg}, ensure_ascii=False)

async def _execute_function(service, function_name: str, function_args: dict):
    """Function calling 실행"""
    import json
    
    try:
        print(f"[DEBUG] Executing function: {function_name} with args: {function_args}")
        if not service._is_tool_allowed(function_name):
            return json.dumps(
                {"error": f"권한 없음: '{function_name}'는 {service.user_role} 역할에서 사용할 수 없습니다."},
                ensure_ascii=False,
            )
        
        if function_name == "get_namespaces":
            namespaces = await service.k8s_service.get_namespaces()
            result = json.dumps(namespaces, ensure_ascii=False)
            print(f"[DEBUG] get_namespaces result: {result[:200]}")
            return result

        elif function_name == "find_pods":
            query_raw = str(function_args.get("query", "")).strip()
            if not query_raw:
                raise Exception("find_pods requires non-empty 'query'")
            limit_int = service._coerce_limit(function_args.get("limit", 20))
            namespace = function_args.get("namespace")
            matches = await resolvers._find_pods(self, query_raw, namespace=namespace if isinstance(namespace, str) else None, limit=limit_int)
            return json.dumps(matches, ensure_ascii=False)

        elif function_name == "find_services":
            query_raw = str(function_args.get("query", "")).strip()
            if not query_raw:
                raise Exception("find_services requires non-empty 'query'")
            limit_int = service._coerce_limit(function_args.get("limit", 20))
            namespace = function_args.get("namespace")
            matches = await resolvers._find_services(self, query_raw, namespace=namespace if isinstance(namespace, str) else None, limit=limit_int)
            return json.dumps(matches, ensure_ascii=False)

        elif function_name == "find_deployments":
            query_raw = str(function_args.get("query", "")).strip()
            if not query_raw:
                raise Exception("find_deployments requires non-empty 'query'")
            limit_int = service._coerce_limit(function_args.get("limit", 20))
            namespace = function_args.get("namespace")
            matches = await resolvers._find_deployments(self, query_raw, namespace=namespace if isinstance(namespace, str) else None, limit=limit_int)
            return json.dumps(matches, ensure_ascii=False)
        
        elif function_name == "get_pods":
            pods = await service.k8s_service.get_pods(function_args["namespace"])
            result = json.dumps(pods, ensure_ascii=False)
            print(f"[DEBUG] get_pods result: {result[:200]}")
            return result
        
        elif function_name == "get_deployments":
            deployments = await service.k8s_service.get_deployments(function_args["namespace"])
            return json.dumps(deployments, ensure_ascii=False)
        
        elif function_name == "get_services":
            services = await service.k8s_service.get_services(function_args["namespace"])
            return json.dumps(services, ensure_ascii=False)
        
        elif function_name == "get_pod_logs":
            namespace = function_args.get("namespace")
            pod_name = function_args["pod_name"]
            tail_lines = function_args.get("tail_lines", 50)
            requested_container = function_args.get("container")

            if not isinstance(namespace, str) or not namespace.strip():
                matches = await resolvers._find_pods(self, str(pod_name), namespace=None, limit=20)
                chosen = await resolvers._resolve_single(self, "pods", str(pod_name), matches)
                namespace = str(chosen.get("namespace", ""))
                pod_name = str(chosen.get("name", pod_name))

            chosen_container, all_containers = await resolvers._pick_log_container(self, 
                namespace,
                pod_name,
                explicit_container=requested_container,
            )

            # 여러 컨테이너가 있는데 어떤 것을 쓸지 결정하지 못한 경우
            if chosen_container is None and all_containers:
                raise Exception(
                    f"Pod '{pod_name}' in namespace '{namespace}' has multiple containers "
                    f"({', '.join(all_containers)}). 'container' 인자를 사용해 로그를 볼 컨테이너를 명시해주세요."
                )

            logs = await service.k8s_service.get_pod_logs(
                namespace,
                pod_name,
                tail_lines=tail_lines,
                container=chosen_container,
            )
            return logs
        
        elif function_name == "get_cluster_overview":
            return await service._call_tool_server(function_name, function_args)
        
        elif function_name == "describe_pod":
            namespace = function_args.get("namespace")
            name = function_args["name"]
            if not isinstance(namespace, str) or not namespace.strip():
                matches = await resolvers._find_pods(self, str(name), namespace=None, limit=20)
                chosen = await resolvers._resolve_single(self, "pods", str(name), matches)
                namespace = str(chosen.get("namespace", ""))
                name = str(chosen.get("name", name))
            result = await service.k8s_service.describe_pod(namespace, name)
            return json.dumps(result, ensure_ascii=False)
        
        elif function_name == "describe_deployment":
            namespace = function_args.get("namespace")
            name = function_args["name"]
            if not isinstance(namespace, str) or not namespace.strip():
                matches = await resolvers._find_deployments(self, str(name), namespace=None, limit=20)
                chosen = await resolvers._resolve_single(self, "deployments", str(name), matches)
                namespace = str(chosen.get("namespace", ""))
                name = str(chosen.get("name", name))
            result = await service.k8s_service.describe_deployment(namespace, name)
            return json.dumps(result, ensure_ascii=False)
        
        elif function_name == "describe_service":
            namespace = function_args.get("namespace")
            name = function_args["name"]
            if not isinstance(namespace, str) or not namespace.strip():
                matches = await resolvers._find_services(self, str(name), namespace=None, limit=20)
                chosen = await resolvers._resolve_single(self, "services", str(name), matches)
                namespace = str(chosen.get("namespace", ""))
                name = str(chosen.get("name", name))
            result = await service.k8s_service.describe_service(namespace, name)
            return json.dumps(result, ensure_ascii=False)
        
        elif function_name == "get_events":
            events = await service.k8s_service.get_events(function_args["namespace"])
            return json.dumps(events, ensure_ascii=False)

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
            return await service._call_tool_server(function_name, tool_args)

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
                resolved = await resolvers._locate_resource_for_yaml(self, 
                    resource_name=resource_name,
                    namespace=ns,
                    preferred_type=resource_type or None,
                )
                resource_type = str(resolved.get("resource_type") or resource_type)
                resource_name = str(resolved.get("resource_name") or resource_name)
                ns = resolved.get("namespace") or ns

            try:
                return await service._call_tool_server(
                    function_name,
                    {
                        "resource_type": resource_type,
                        "resource_name": resource_name,
                        "namespace": ns,
                    },
                )
            except Exception:
                if resolved is None:
                    resolved = await resolvers._locate_resource_for_yaml(self, 
                        resource_name=resource_name,
                        namespace=ns,
                        preferred_type=resource_type or None,
                    )
                    resource_type = str(resolved.get("resource_type") or resource_type)
                    resource_name = str(resolved.get("resource_name") or resource_name)
                    ns = resolved.get("namespace") or ns
                    return await service._call_tool_server(
                        function_name,
                        {
                            "resource_type": resource_type,
                            "resource_name": resource_name,
                            "namespace": ns,
                        },
                    )
                raise

        elif function_name == "k8s_describe_resource":
            namespace = function_args.get("namespace")
            return await service._call_tool_server(
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
            tail_lines = service._coerce_limit(function_args.get("tail_lines", 50), default=50, max_value=2000)
            requested_container = function_args.get("container")

            if not isinstance(namespace, str) or not namespace.strip():
                matches = await resolvers._find_pods(self, str(pod_name), namespace=None, limit=20)
                chosen = await resolvers._resolve_single(self, "pods", str(pod_name), matches)
                namespace = str(chosen.get("namespace", ""))
                pod_name = str(chosen.get("name", pod_name))

            chosen_container, all_containers = await resolvers._pick_log_container(self, 
                namespace,
                pod_name,
                explicit_container=requested_container,
            )

            if chosen_container is None and all_containers:
                raise Exception(
                    f"Pod '{pod_name}' in namespace '{namespace}' has multiple containers "
                    f"({', '.join(all_containers)}). 'container' 인자를 사용해 로그를 볼 컨테이너를 명시해주세요."
                )

            return await service._call_tool_server(
                function_name,
                {
                    "namespace": namespace,
                    "pod_name": pod_name,
                    "tail_lines": tail_lines,
                    "container": chosen_container,
                },
            )

        elif function_name == "k8s_get_events":
            namespace = function_args.get("namespace")
            ns = namespace if isinstance(namespace, str) and namespace.strip() else None
            return await service._call_tool_server(function_name, {"namespace": ns})

        elif function_name == "k8s_get_available_api_resources":
            return await service._call_tool_server(function_name, {})

        elif function_name == "k8s_get_cluster_configuration":
            return await service._call_tool_server(function_name, {})

        elif function_name == "k8s_generate_resource":
            return json.dumps(
                {"error": "YAML 생성은 비활성화되었습니다."},
                ensure_ascii=False,
            )
        
        elif function_name == "get_pod_metrics":
            namespace = function_args.get("namespace")
            return await service._call_tool_server(
                function_name,
                {"namespace": namespace} if namespace else {},
            )

        elif function_name == "get_node_metrics":
            return await service._call_tool_server(function_name, {})

        elif function_name == "get_node_list":
            nodes = await service.k8s_service.get_node_list()
            return json.dumps(nodes, ensure_ascii=False)
        
        elif function_name == "describe_node":
            result = await service.k8s_service.describe_node(function_args["name"])
            return json.dumps(result, ensure_ascii=False)
        
        elif function_name == "get_pvcs":
            namespace = function_args.get("namespace")
            pvcs = await service.k8s_service.get_pvcs(namespace) if namespace else await service.k8s_service.get_pvcs()
            return json.dumps(pvcs, ensure_ascii=False)
        
        elif function_name == "get_pvs":
            pvs = await service.k8s_service.get_pvs()
            return json.dumps(pvs, ensure_ascii=False)
        
        else:
            return json.dumps({"error": f"Unknown function: {function_name}"})
    
    except Exception as e:
        error_msg = f"Error in {function_name}: {str(e)}"
        print(f"[DEBUG] {error_msg}")
        return json.dumps({"error": error_msg}, ensure_ascii=False)
