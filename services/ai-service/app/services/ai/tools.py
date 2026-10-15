# Kubernetes tool 정의 — Anthropic/OpenAI function-calling 형식의 정적 tool list.
#
# ai_service.py 의 _get_k8s_readonly_tool_definitions / _get_k8s_write_tool_definitions
# 에서 추출. 정적 데이터라 instance 의존 없음. AIService 는 import 해서 그대로
# 사용하거나 _filter_tools_by_role 로 user role 에 맞춰 걸러낸다.
#
# 변경 시 주의: tool 의 name 이 ai_service.py 의 _execute_function_with_context
# (tool dispatch) 의 if-elif chain 과 매칭되어야 함. name 변경 / 추가 / 삭제 시
# dispatch 도 함께 갱신.

from typing import Dict, List

K8S_READONLY_TOOLS: List[Dict] = [
    {
        "type": "function",
        "function": {
            "name": "k8s_get_resources",
            "description": (
                "Kubernetes 리소스를 조회합니다 (kubectl get). 출력 형식(wide/json) 요청 시 우선 사용. "
                "A named object that does not exist answers {\"status\":\"not_found\",\"namespace_exists\":…,\"similar\":[...]} — "
                "pick from similar or call k8s_find_resource once; do not retry the name in other namespaces. "
                "An unknown resource_type answers {\"status\":\"unknown_kind\",\"similar_kinds\":[...]}."
            ),
            "parameters": {
                "type": "object",
                "properties": {
                    "resource_type": {
                        "type": "string",
                        "description": "리소스 타입 (pods, deployments, services 등)",
                    },
                    "resource_name": {
                        "type": "string",
                        "description": "리소스 이름 (선택)",
                    },
                    "namespace": {
                        "type": "string",
                        "description": "네임스페이스 (선택)",
                    },
                    "all_namespaces": {
                        "type": "boolean",
                        "description": "모든 네임스페이스 조회",
                    },
                    "output": {
                        "type": "string",
                        "description": "출력 포맷 (json, wide). 기본값: wide",
                    },
                },
                "required": ["resource_type"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "k8s_get_resource_yaml",
            "description": "단일 리소스의 YAML을 조회합니다 (kubectl get -o yaml).",
            "parameters": {
                "type": "object",
                "properties": {
                    "resource_type": {"type": "string", "description": "리소스 타입"},
                    "resource_name": {"type": "string", "description": "리소스 이름"},
                    "namespace": {"type": "string", "description": "네임스페이스 (선택)"},
                },
                "required": ["resource_type", "resource_name"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "k8s_get_pod_logs",
            "description": (
                "Pod 로그를 조회합니다 (kubectl logs). Returns the last tail_lines lines of one container. "
                "For a crashed or restarting container set previous=true to read the log of the terminated run — "
                "that is where the crash reason is; the current log only shows the restart. "
                "since narrows to a time window (5m, 2h), all_containers reads every container with a [pod/container] prefix, "
                "and grep keeps only lines containing a text (case-insensitive) while scanning up to 2000 lines. "
                "A missing pod comes back as {\"status\":\"not_found\",\"similar\":[...]}; a pod with several containers and no "
                "container as {\"status\":\"container_required\",\"containers\":[...]}; previous=true without a restart as "
                "{\"status\":\"no_previous\"}. Act on those results instead of retrying the same name."
            ),
            "parameters": {
                "type": "object",
                "properties": {
                    "pod_name": {"type": "string", "description": "Pod 이름"},
                    "namespace": {"type": "string", "description": "네임스페이스 (기본: default)"},
                    "container": {"type": "string", "description": "컨테이너 이름 (선택)"},
                    "tail_lines": {"type": "integer", "description": "마지막 N줄 (기본: 50, 최대 2000)"},
                    "previous": {"type": "boolean", "description": "Read the previous (terminated) container's log — use for CrashLoopBackOff"},
                    "since": {"type": "string", "description": "Only lines newer than this relative duration, e.g. 5m, 2h, 1h30m (max 7d)"},
                    "all_containers": {"type": "boolean", "description": "Read every container of the pod, each line prefixed with [pod/container]"},
                    "grep": {"type": "string", "description": "Keep only lines containing this text (case-insensitive substring, not a regex)"},
                },
                "required": ["pod_name"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "k8s_get_events",
            "description": (
                "이벤트 조회 (kubectl get events). Returns events of one namespace, or of every namespace when none is given "
                "or all_namespaces=true. Narrow to one object with kind and name (the events of pod web-1: kind=Pod, name=web-1) "
                "or with field_selector (type=Warning, reason=BackOff, involvedObject.name=web-1); without a filter a busy "
                "namespace returns hundreds of events, so filter when you know the object."
            ),
            "parameters": {
                "type": "object",
                "properties": {
                    "namespace": {"type": "string", "description": "네임스페이스 (비우면 모든 네임스페이스)"},
                    "all_namespaces": {"type": "boolean", "description": "Every namespace, ignoring namespace"},
                    "kind": {"type": "string", "description": "Only events about objects of this kind (Pod, Deployment, Node …)"},
                    "name": {"type": "string", "description": "Only events about the object with this name"},
                    "field_selector": {
                        "type": "string",
                        "description": "Events field selector, comma-separated: type=Warning, reason=BackOff, involvedObject.kind/name/namespace, source, reportingComponent",
                    },
                },
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "k8s_get_available_api_resources",
            "description": "사용 가능한 API 리소스 목록 조회 (kubectl api-resources).",
            "parameters": {"type": "object", "properties": {}},
        },
    },
    {
        "type": "function",
        "function": {
            "name": "k8s_get_cluster_configuration",
            "description": "클러스터 구성 정보 조회 (kubectl config view -o json 유사).",
            "parameters": {"type": "object", "properties": {}},
        },
    },
    {
        "type": "function",
        "function": {
            "name": "k8s_check_service_connectivity",
            "description": "Service/Endpoint 연결성 확인 (서비스에 Ready 엔드포인트가 있는지 점검).",
            "parameters": {
                "type": "object",
                "properties": {
                    "service_name": {"type": "string", "description": "서비스 이름"},
                    "namespace": {"type": "string", "description": "네임스페이스 (선택)"},
                    "port": {"type": "string", "description": "서비스 포트(이름 또는 번호, 선택)"},
                },
                "required": ["service_name"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "k8s_describe_resource",
            "description": (
                "리소스 상세 조회 (kubectl describe) — conditions, events and container states of one object. "
                "A missing object answers {\"status\":\"not_found\",\"similar\":[...]}: use similar or k8s_find_resource instead of guessing namespaces."
            ),
            "parameters": {
                "type": "object",
                "properties": {
                    "resource_type": {"type": "string", "description": "리소스 타입"},
                    "resource_name": {"type": "string", "description": "리소스 이름"},
                    "namespace": {"type": "string", "description": "네임스페이스 (선택)"},
                },
                "required": ["resource_type", "resource_name"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "k8s_find_resource",
            "description": (
                "Find resources by a name fragment or a label across several kinds and namespaces in one call "
                "(web → pods, deployments and services whose name or labels contain 'web'; app=web → objects carrying that label). "
                "Use it when the user names something loosely, when another tool answered {\"status\":\"not_found\"} with an empty similar list, "
                "or to learn the namespace before calling describe/logs. Searches pods, deployments, statefulsets, daemonsets, services, "
                "ingresses, configmaps, jobs and cronjobs unless kinds is given; a namespace-scoped grant searches only its namespaces. "
                "Returns matches (kind, namespace, name), what was searched, and notes for kinds the cluster does not serve. "
                "Call it at most once per name: an empty result means the object is not in this cluster's searched kinds — say so and ask, do not keep guessing."
            ),
            "parameters": {
                "type": "object",
                "properties": {
                    "query": {"type": "string", "description": "Name fragment (2+ characters) or label key=value"},
                    "kinds": {"type": "array", "items": {"type": "string"}, "description": "Resource types to search (default: common workload kinds), at most 12"},
                    "namespace": {"type": "string", "description": "Limit the search to one namespace"},
                    "limit": {"type": "integer", "description": "Maximum matches (default 20, max 50)"},
                },
                "required": ["query"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "k8s_explain",
            "description": (
                "Explain a resource type or one of its fields from this cluster's API schema (kubectl explain): "
                "deployments, deployments.spec.strategy, pods.spec.containers.resources. Use it before writing or patching a manifest "
                "and whenever you are unsure which fields a kind — including a CRD — actually has, instead of guessing field names. "
                "api_version picks a version (apps/v1, autoscaling/v2); recursive=true lists every nested field (long). "
                "An unknown type answers {\"status\":\"unknown_kind\",\"similar_kinds\":[...]}, an unknown field {\"status\":\"unknown_field\"}."
            ),
            "parameters": {
                "type": "object",
                "properties": {
                    "resource": {"type": "string", "description": "Type with optional field path, e.g. deployments or deployments.spec.strategy"},
                    "api_version": {"type": "string", "description": "API version such as apps/v1 (optional)"},
                    "recursive": {"type": "boolean", "description": "List all nested fields"},
                },
                "required": ["resource"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "issues",
            "description": (
                "Kubeast's issue check for the cluster in one call: failing or pending pods (CrashLoopBackOff, ImagePullBackOff, OOMKilled, "
                "unschedulable), workloads below their desired replicas, failed Jobs, unhealthy nodes (pressure, NotReady), unbound PVCs and the "
                "Warning events of the last window — each with kind, namespace, name, severity (critical | warning | info), reason, message, count and last_seen, "
                "plus counts per severity. Call it FIRST when the user asks what is wrong, whether something is failing, or for a health check, and only then "
                "describe/logs on the objects it names. namespace narrows to one namespace, severity to one level, window_minutes changes the event window. "
                "An empty list means nothing is failing in that scope right now."
            ),
            "parameters": {
                "type": "object",
                "properties": {
                    "namespace": {"type": "string", "description": "Only issues in this namespace (default: every namespace the user may see)"},
                    "severity": {"type": "string", "description": "Only this severity: critical, warning or info"},
                    "window_minutes": {"type": "integer", "description": "How far back Warning events are read (default: server setting)"},
                },
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "prometheus_query",
            "description": (
                "Run a PromQL expression against the Prometheus Kubeast reads for this cluster (its own Prometheus Service, or the external store "
                "registered for it — Kubeast adds the cluster matcher). Instant by default; range=true returns points over since (default 1h; step "
                "automatic, at least 15s) for a trend. Use it for usage history, error rates and saturation: container_cpu_usage_seconds_total, "
                "container_memory_working_set_bytes, kube_pod_container_status_restarts_total, node_* from node-exporter. Results are capped at 100 series "
                "and 120 points each. {\"status\":\"unavailable\"} means no Prometheus reaches this cluster: use get_pod_metrics / get_node_metrics for "
                "current values and say that history is unavailable. The tool is only offered when the cluster has the Prometheus feature."
            ),
            "parameters": {
                "type": "object",
                "properties": {
                    "promql": {"type": "string", "description": "PromQL expression, e.g. sum(rate(container_cpu_usage_seconds_total{namespace=\"shop\"}[5m])) by (pod)"},
                    "range": {"type": "boolean", "description": "Return a series of points over since instead of one value"},
                    "since": {"type": "string", "description": "Range window, e.g. 30m, 6h, 2d (default 1h, max 7d)"},
                    "step": {"type": "integer", "description": "Seconds between points (default: window/120, at least 15)"},
                },
                "required": ["promql"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "logsearch",
            "description": (
                "Search the cluster's log store (Loki) through Kubeast — lines from pods that have restarted, been rescheduled or deleted, across many pods "
                "at once — filtered by text (case-insensitive substring; regex=true for a pattern), namespace, pod, container or workload (workload_kind + "
                "workload_name, e.g. Deployment web), within since (default 1h) and up to limit lines (default 100, max 200). Use it when k8s_get_pod_logs "
                "cannot help: the pod is gone, lines predate the last restart, or you need every pod of a workload. Returns lines with ts, namespace, pod, "
                "container and line. {\"status\":\"unavailable\"} = no log store for this cluster; {\"status\":\"forbidden\"} = the cluster does not let the user "
                "read pod logs there. A grant limited to namespaces must name one of them. Only offered when the cluster has log search."
            ),
            "parameters": {
                "type": "object",
                "properties": {
                    "namespace": {"type": "string", "description": "Namespace to search (empty = every namespace, for an unscoped grant)"},
                    "text": {"type": "string", "description": "Text the line must contain (case-insensitive), or a regex with regex=true"},
                    "regex": {"type": "boolean", "description": "Treat text as a regular expression"},
                    "pod": {"type": "string", "description": "Only this pod"},
                    "container": {"type": "string", "description": "Only this container"},
                    "workload_kind": {"type": "string", "description": "Only pods of this workload kind (Deployment, StatefulSet, DaemonSet, Job, CronJob)"},
                    "workload_name": {"type": "string", "description": "Only pods of this workload"},
                    "since": {"type": "string", "description": "Window, e.g. 15m, 2h, 1d (default 1h)"},
                    "limit": {"type": "integer", "description": "Maximum lines (default 100, max 200)"},
                },
            },
        },
    },
]

K8S_WRITE_TOOLS: List[Dict] = [
    {
        "type": "function",
        "function": {
            "name": "k8s_apply_manifest",
            "description": "매니페스트 적용 (kubectl apply -f -).",
            "parameters": {
                "type": "object",
                "properties": {
                    "yaml_content": {"type": "string", "description": "YAML 매니페스트 문자열"},
                    "resource_manifest": {
                        "type": "object",
                        "description": "매니페스트 JSON 객체 (선택)",
                    },
                },
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "k8s_create_resource",
            "description": "리소스 생성 (kubectl create -f -).",
            "parameters": {
                "type": "object",
                "properties": {
                    "yaml_content": {"type": "string", "description": "YAML 매니페스트 문자열"},
                    "resource_manifest": {
                        "type": "object",
                        "description": "매니페스트 JSON 객체 (선택)",
                    },
                },
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "k8s_delete_resource",
            "description": "리소스 삭제 (kubectl delete).",
            "parameters": {
                "type": "object",
                "properties": {
                    "resource_type": {"type": "string", "description": "리소스 타입"},
                    "resource_name": {"type": "string", "description": "리소스 이름 (all=true일 때 생략 가능)"},
                    "namespace": {"type": "string", "description": "네임스페이스 (선택)"},
                    "all": {"type": "boolean", "description": "모두 삭제"},
                    "force": {"type": "boolean", "description": "강제 삭제"},
                    "grace_period": {"type": "integer", "description": "grace period(초)"},
                    "wait": {"type": "boolean", "description": "삭제 완료 대기"},
                    "ignore_not_found": {"type": "boolean", "description": "없으면 무시"},
                },
                "required": ["resource_type"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "k8s_patch_resource",
            "description": "리소스 패치 (kubectl patch).",
            "parameters": {
                "type": "object",
                "properties": {
                    "resource_type": {"type": "string", "description": "리소스 타입"},
                    "resource_name": {"type": "string", "description": "리소스 이름"},
                    "namespace": {"type": "string", "description": "네임스페이스 (선택)"},
                    "patch": {"type": "object", "description": "패치 JSON 객체 또는 문자열"},
                    "patch_type": {
                        "type": "string",
                        "description": "패치 타입 (strategic, merge, json)",
                    },
                },
                "required": ["resource_type", "resource_name", "patch"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "k8s_annotate_resource",
            "description": "리소스 어노테이션 추가/수정 (kubectl annotate).",
            "parameters": {
                "type": "object",
                "properties": {
                    "resource_type": {"type": "string", "description": "리소스 타입"},
                    "resource_name": {"type": "string", "description": "리소스 이름"},
                    "namespace": {"type": "string", "description": "네임스페이스 (선택)"},
                    "annotations": {"type": "object", "description": "추가할 annotations"},
                    "overwrite": {"type": "boolean", "description": "기존 값 덮어쓰기"},
                },
                "required": ["resource_type", "resource_name", "annotations"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "k8s_remove_annotation",
            "description": "리소스 어노테이션 제거 (kubectl annotate key-).",
            "parameters": {
                "type": "object",
                "properties": {
                    "resource_type": {"type": "string", "description": "리소스 타입"},
                    "resource_name": {"type": "string", "description": "리소스 이름"},
                    "namespace": {"type": "string", "description": "네임스페이스 (선택)"},
                    "keys": {"type": "array", "items": {"type": "string"}, "description": "제거할 키 목록"},
                    "overwrite": {"type": "boolean", "description": "기존 값 덮어쓰기"},
                },
                "required": ["resource_type", "resource_name", "keys"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "k8s_label_resource",
            "description": "리소스 라벨 추가/수정 (kubectl label).",
            "parameters": {
                "type": "object",
                "properties": {
                    "resource_type": {"type": "string", "description": "리소스 타입"},
                    "resource_name": {"type": "string", "description": "리소스 이름"},
                    "namespace": {"type": "string", "description": "네임스페이스 (선택)"},
                    "labels": {"type": "object", "description": "추가할 labels"},
                    "overwrite": {"type": "boolean", "description": "기존 값 덮어쓰기"},
                },
                "required": ["resource_type", "resource_name", "labels"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "k8s_remove_label",
            "description": "리소스 라벨 제거 (kubectl label key-).",
            "parameters": {
                "type": "object",
                "properties": {
                    "resource_type": {"type": "string", "description": "리소스 타입"},
                    "resource_name": {"type": "string", "description": "리소스 이름"},
                    "namespace": {"type": "string", "description": "네임스페이스 (선택)"},
                    "keys": {"type": "array", "items": {"type": "string"}, "description": "제거할 키 목록"},
                    "overwrite": {"type": "boolean", "description": "기존 값 덮어쓰기"},
                },
                "required": ["resource_type", "resource_name", "keys"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "k8s_scale",
            "description": "리소스 스케일 조정 (kubectl scale).",
            "parameters": {
                "type": "object",
                "properties": {
                    "resource_type": {"type": "string", "description": "리소스 타입"},
                    "resource_name": {"type": "string", "description": "리소스 이름"},
                    "namespace": {"type": "string", "description": "네임스페이스 (선택)"},
                    "replicas": {"type": "integer", "description": "replica 수"},
                },
                "required": ["resource_type", "resource_name", "replicas"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "k8s_rollout",
            "description": "롤아웃 작업 (restart/undo/pause/resume/status).",
            "parameters": {
                "type": "object",
                "properties": {
                    "action": {"type": "string", "description": "restart/undo/pause/resume/status"},
                    "resource_type": {"type": "string", "description": "리소스 타입"},
                    "resource_name": {"type": "string", "description": "리소스 이름"},
                    "namespace": {"type": "string", "description": "네임스페이스 (선택)"},
                    "revision": {"type": "integer", "description": "undo revision"},
                    "timeout": {"type": "string", "description": "timeout (예: 60s)"},
                },
                "required": ["action", "resource_type", "resource_name"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "k8s_execute_command",
            "description": "Pod 내 명령 실행 (kubectl exec).",
            "parameters": {
                "type": "object",
                "properties": {
                    "pod_name": {"type": "string", "description": "Pod 이름"},
                    "namespace": {"type": "string", "description": "네임스페이스 (기본: default)"},
                    "container": {"type": "string", "description": "컨테이너 이름 (선택)"},
                    "command": {
                        "type": "array",
                        "items": {"type": "string"},
                        "description": "실행할 명령 배열 (예: [\"ls\", \"/\"])",
                    },
                },
                "required": ["pod_name", "command"],
            },
        },
    },
]


# Cluster-wide read tools (overview, kubectl top). Module-level so the MCP
# server (app/mcp_server.py) offers the same read tools the chat does.
CLUSTER_METRICS_TOOLS: List[Dict] = [
        {
            "type": "function",
            "function": {
                "name": "get_cluster_overview",
                "description": """Get a comprehensive overview of the entire Kubernetes cluster health.
                    
                    Returns:
                    - Total counts: namespaces, pods, services, deployments, PVCs, PVs
                    - Pod status breakdown (Running, Pending, Failed, etc.)
                    - Node count and cluster version
                    
                    Use this FIRST when user asks about cluster health or wants a general status check.""",
                "parameters": {"type": "object", "properties": {}}
            }
        },
        {
            "type": "function",
            "function": {
                "name": "get_pod_metrics",
                "description": """Get pod resource usage (CPU and memory) - equivalent to 'kubectl top pods'.
                    
                    Use this to:
                    - Check which pods are consuming the most resources
                    - Identify resource-heavy workloads
                    - Diagnose performance issues
                    - Monitor resource utilization""",
                "parameters": {
                    "type": "object",
                    "properties": {
                        "namespace": {"type": "string", "description": "Optional namespace filter. If not provided, shows all pods across all namespaces."}
                    }
                }
            }
        },
        {
            "type": "function",
            "function": {
                "name": "get_node_metrics",
                "description": """Get node resource usage (CPU and memory) - equivalent to 'kubectl top nodes'.
                    
                    Use this to:
                    - Check node resource utilization
                    - Identify nodes under heavy load
                    - Monitor cluster capacity
                    - Diagnose node-level performance issues""",
                "parameters": {"type": "object", "properties": {}}
            }
        }
]


def get_tools_definition(service) -> List[Dict]:
    """Tools 정의 반환 (상세한 설명 포함).

    ai_service.AIService._get_tools_definition 에서 추출. role 기반 필터링은
    service._filter_tools_by_role 에 위임 (해당 메서드는 self._role_allows_*
    프로퍼티에 의존하므로 AIService 에 잔존)."""
    tools = list(CLUSTER_METRICS_TOOLS)
    tools.extend(K8S_READONLY_TOOLS)
    tools.extend(K8S_WRITE_TOOLS)
    return service._filter_tools_by_role(tools)
