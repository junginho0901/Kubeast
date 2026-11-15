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
                "An unknown resource_type answers {\"status\":\"unknown_kind\",\"similar_kinds\":[...]}. "
                "Pods without resource_name, when more than 25: the counts over all of them (total, by phase, status, "
                "namespace, node) and 25 pods in order of need — errors and warnings first — with next_offset to read on."
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
                    "offset": {
                        "type": "integer",
                        "description": "Pods only: where the next 25 start, the next_offset of the last answer",
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
                "이벤트 조회. Returns the newest events (newest first, limit, default 200) of one namespace, or of every "
                "namespace when none is given or all_namespaces=true. Narrow to one object with kind and name (the events of "
                "pod web-1: kind=Pod, name=web-1) or with field_selector (type=Warning, reason=BackOff, involvedObject.name=web-1). "
                "When more events match than are listed the answer is {events, total, shown, note}."
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
                    "limit": {"type": "integer", "description": "The newest events to list (default 200, at most 1000)"},
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
                "Warning events of the last window — each with kind, namespace, name, severity (critical | warning | info), reason, message, last_seen and "
                "its numbers, each its own: restarts (a pod's), failed (a Job's failed pods), events (how many times its newest Warning event happened), "
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
                "registered for it — Kubeast adds the cluster matcher). Instant by default; range=true returns points over since (default 1h, at most "
                "168h), or over since_time–until_time for a fixed window; step is automatic (at least 15s). Do not guess metric or label names: find "
                "them first with prometheus_metrics and prometheus_labels. Aggregate when many series may match (sum by (namespace), topk(10, …)): "
                "results are capped at 100 series and 120 points each, and a result marked truncated must not be answered from — narrow it and query "
                "again. {\"status\":\"unavailable\"} means no Prometheus reaches this cluster: use get_pod_metrics / get_node_metrics for current "
                "values and say that history is unavailable. The tool is only offered when the cluster has the Prometheus feature. To show the "
                "user a trend, set chart=true with a short title and the unit: the user sees that range result as a graph under your answer — "
                "at most 2 graphs per answer, aggregated to a few series (topk) first."
            ),
            "parameters": {
                "type": "object",
                "properties": {
                    "promql": {"type": "string", "description": "PromQL expression, e.g. sum(rate(container_cpu_usage_seconds_total{namespace=\"shop\"}[5m])) by (pod)"},
                    "range": {"type": "boolean", "description": "Return a series of points over since instead of one value"},
                    "since": {"type": "string", "description": "Range window back from now, e.g. 30m, 6h, 48h (default 1h, max 168h)"},
                    "since_time": {"type": "string", "description": "Start of a fixed window: 2d, 24h or an RFC3339 time (makes it a range query)"},
                    "until_time": {"type": "string", "description": "End of that window, an RFC3339 time (default now)"},
                    "step": {"type": "integer", "description": "Seconds between points (default: window/120, at least 15)"},
                    "chart": {"type": "boolean", "description": "Also show this range result to the user as a graph under your answer (makes it a range query)"},
                    "title": {"type": "string", "description": "Short title of that graph, in the user's language"},
                    "unit": {"type": "string", "description": "Unit of the values for the graph: bytes, percent, cores, seconds, count or rate"},
                },
                "required": ["promql"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "prometheus_metrics",
            "description": (
                "Find metric names in this cluster's Prometheus (seen in the last hour) whose name contains pattern, with type and help text when "
                "the store keeps them. Call it before writing PromQL for a metric you have not seen in a result — it is the quickest way to learn "
                "what exists. Node metrics are node_* (node-exporter) or system_* (OpenTelemetry hostmetrics, node in the k8s_node_name label): "
                "check which one is there. Returns total and up to limit names; truncated means narrow the pattern."
            ),
            "parameters": {
                "type": "object",
                "properties": {
                    "pattern": {"type": "string", "description": "Part of the metric name, case-insensitive, e.g. memory, http_requests, restarts"},
                    "limit": {"type": "integer", "description": "Names to return (default 50, max 200)"},
                },
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "prometheus_labels",
            "description": (
                "List the label names on the series a selector matches, or the values of one label (label=namespace, pod, job, …), within since "
                "(default 1h). Use it to learn how series are labelled before filtering — e.g. which namespaces or pods report "
                "container_memory_working_set_bytes. selector is a plain series selector such as up{job=\"kubelet\"}, not an expression."
            ),
            "parameters": {
                "type": "object",
                "properties": {
                    "selector": {"type": "string", "description": "Series selector, e.g. container_cpu_usage_seconds_total{namespace=\"shop\"} (empty = every series)"},
                    "label": {"type": "string", "description": "Return this label's values instead of the label names"},
                    "since": {"type": "string", "description": "Window back from now, e.g. 1h, 24h (default 1h, max 168h)"},
                    "limit": {"type": "integer", "description": "Maximum names or values (default and max 200)"},
                },
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "prometheus_rules",
            "description": (
                "List the alerting and recording rules of this cluster's Prometheus with their expression, for duration, labels, annotations, state "
                "(firing, pending, inactive) and active alerts. When investigating an alert, call this first with rule=<alert name> and check the same "
                "expression with prometheus_query. On a store shared by several clusters the rules may cover every cluster, but the alerts and states "
                "shown are this cluster's. unavailable = the store serves no rules."
            ),
            "parameters": {
                "type": "object",
                "properties": {
                    "rule": {"type": "string", "description": "Part of the rule name, case-insensitive, e.g. KubePodCrashLooping"},
                    "rule_type": {"type": "string", "description": "alert or record (default both)"},
                    "active_only": {"type": "boolean", "description": "Only rules that are firing or pending"},
                },
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "alerts_list",
            "description": (
                "This cluster's alerts in its alert store (Alertmanager, or Grafana alerting): name, severity, state (firing, silenced, "
                "inhibited), since when, summary, labels and receivers, firing first; the silences on silenced alerts (who, why, until when); "
                "counts by state and by name. Default state firing; state=all or silenced answers 'why did no alert come' (a silence or an "
                "inhibition). The rule behind an alert (expression, threshold) is prometheus_rules. An empty store does not mean nothing fires: "
                "Prometheus rules can fire without reaching it, so check prometheus_rules active_only=true before saying so. unavailable = no alert store here. "
                "silences=true answers the Alerts page's Silences tab instead of the alerts: every active and pending silence on this cluster's alerts, one that "
                "matches no alert now too (state, scope: cluster, all or pattern; matchers, createdBy, comment, startsAt, endsAt), with this_cluster and other_scopes counts."
            ),
            "parameters": {
                "type": "object",
                "properties": {
                    "state": {"type": "string", "description": "firing (default), silenced, inhibited or all"},
                    "alertname": {"type": "string", "description": "Exact alert name, e.g. KubePodCrashLooping"},
                    "alert_labels": {
                        "type": "object",
                        "description": "Exact label values to match, e.g. {\"severity\": \"critical\", \"namespace\": \"shop\"}",
                        "additionalProperties": {"type": "string"},
                    },
                    "silences": {"type": "boolean", "description": "true: list the silences of the Silences tab; state, alertname and alert_labels do not apply"},
                },
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "clusters_list",
            "description": (
                "The clusters this user can see in Kubeast and their connection status, as the cluster picker lists them: id, display_name, mode, "
                "is_self_cluster, health_status (the last connection check, at last_healthcheck_at: k8s-service probes each cluster every 60 seconds "
                "unless multicluster.healthcheckIntervalSec changes or stops it, giving healthy or disconnected, and a person's Test in Admin → Clusters "
                "also writes it, giving unreachable when it fails; unknown = never checked), current (the cluster this conversation reads) and namespaces "
                "when the grant there is limited to them. Someone with admin.clusters.list gets every registered cluster, with reachable and the "
                "API server, Prometheus and log store settings of Admin → Clusters. Never a kubeconfig or credential. Use it for \"which cluster "
                "is not connected\" and \"which clusters do I have\"; every other tool reads the current cluster only."
            ),
            "parameters": {"type": "object", "properties": {}},
        },
    },
    {
        "type": "function",
        "function": {
            "name": "alerts_inbox",
            "description": (
                "The Alerts inbox: every alert Alertmanager sent to Kubeast for this cluster, firing or resolved, with who acknowledged it, who it is "
                "assigned to and whether it is done, and its investigation. Without alert_id a page of the list with counts by status; with alert_id "
                "one alert as its window opens, which adds the note (and who wrote it), annotations, receiver and investigate_now, and with_report the "
                "investigation's report as investigation_report, which is recorded as ai.investigation.view (report_error says why there is none). Use it "
                "for \"who is on this alert\", \"what is unassigned\", \"what did someone note\", \"what did the investigation find\"; alerts_list reads the "
                "alert store and has none of these marks. Reading only: changing a mark stays on the screen. For whoever reads the whole cluster "
                "(resource.pod.read, no namespace limit)."
            ),
            "parameters": {
                "type": "object",
                "properties": {
                    "alert_id": {"type": "string", "description": "One alert's id from the list, for its window with the note"},
                    "with_report": {"type": "boolean", "description": "With alert_id: also read the report of its investigation"},
                    "status": {"type": "string", "description": "firing, stale (no word from Alertmanager for a while) or resolved"},
                    "alert_severity": {"type": "string", "description": "The severity the alert carries; the answer's severities lists them"},
                    "mine": {"type": "boolean", "description": "Only alerts assigned to the signed-in user"},
                    "open_only": {"type": "boolean", "description": "Only alerts not marked done"},
                    "search": {"type": "string", "description": "Text in the alert name, namespace, assignee, labels or annotations"},
                    "limit": {"type": "integer", "description": "Rows per page (default 50, at most 200)"},
                    "offset": {"type": "integer", "description": "Rows to skip, for the next page; total says how many there are"},
                },
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "pod_rbac",
            "description": (
                "What a pod may do in the cluster: its service account, each RoleBinding in its namespace and ClusterRoleBinding that applies to the "
                "account (by name or through a group it belongs to), and what each role allows (resolved_role.rules). can_i asks about the signed-in "
                "user, not the pod. What the cluster refused the caller is named in errors, not left empty. secrets are names only."
            ),
            "parameters": {
                "type": "object",
                "properties": {
                    "namespace": {"type": "string", "description": "The pod's namespace"},
                    "pod_name": {"type": "string", "description": "The pod's name"},
                    "include_authenticated": {
                        "type": "boolean",
                        "description": "Also the bindings of system:authenticated, which every signed-in subject has; off by default as on the screen",
                    },
                },
                "required": ["namespace", "pod_name"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "logfiles",
            "description": (
                "Log files inside a container, for an app that writes its logs to files instead of stdout, as a pod's Log files tab reads them "
                "(permission resource.pod.logfile). Without path it lists the files the configured patterns cover; with path it reads the last lines "
                "of one file and records the read in the audit log. Only covered paths can be read. Use k8s_get_pod_logs for stdout. "
                "code on a refusal: path (not covered), namespace (not enabled there), no_file, tool_missing (no tail or ls in the image), unreadable."
            ),
            "parameters": {
                "type": "object",
                "properties": {
                    "namespace": {"type": "string", "description": "The pod's namespace"},
                    "pod_name": {"type": "string", "description": "The pod's name"},
                    "container": {"type": "string", "description": "The container; the pod's default when not given"},
                    "path": {"type": "string", "description": "Absolute path of one file from the list; leave out to list"},
                    "lines": {"type": "integer", "description": "How many of the last lines to read (default 50, at most 2000)"},
                },
                "required": ["namespace", "pod_name"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "storage_summary",
            "description": (
                "What the Storage window computes: every PVC with its usage (used, capacity, percent and days until full, where Prometheus has them) "
                "and every PV, counted by status with what needs a person first (Pending, Lost, Failed, Released), and the claim-to-volume topology. "
                "namespace narrows the claims and the volumes claimed from it. Use it for \"any storage problems\" and \"which volume is nearly "
                "full\". There is no total capacity here. A list the user may not read is named in pvs_error or topology_error; the rest stands."
            ),
            "parameters": {
                "type": "object",
                "properties": {
                    "namespace": {"type": "string", "description": "Only this namespace; all the user may read when not given"},
                },
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "network_policy_effective",
            "description": (
                "The NetworkPolicies that select a pod or a workload's pods, per direction (ingress, egress), with what their rules allow, as a "
                "drawer's Network Policies section shows them. Use it for \"what limits this pod\"; network_policy_check decides one connection. "
                "isolated false: nothing limits that direction. unevaluated lists other policy kinds (Cilium, Calico) that can change the answer."
            ),
            "parameters": {
                "type": "object",
                "properties": {
                    "namespace": {"type": "string", "description": "The namespace"},
                    "pod": {"type": "string", "description": "A pod; or give workload_kind and workload_name"},
                    "workload_kind": {"type": "string", "description": "Deployment, StatefulSet, DaemonSet, ReplicaSet, Job or CronJob"},
                    "workload_name": {"type": "string", "description": "The workload's name"},
                },
                "required": ["namespace"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "limit_range_violations",
            "description": (
                "The containers outside a LimitRange's bounds, one row per field (field, actual, limit), as its window's Violating Pods lists them: "
                "pods made before the LimitRange existed can be out of bounds. Name the LimitRange; k8s_get_resources lists them."
            ),
            "parameters": {
                "type": "object",
                "properties": {
                    "namespace": {"type": "string", "description": "The LimitRange's namespace"},
                    "name": {"type": "string", "description": "The LimitRange's name"},
                },
                "required": ["namespace", "name"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "prometheus_targets",
            "description": (
                "Scrape targets of this cluster's Prometheus and whether the last scrape worked (health up/down, last error), the down ones first. "
                "Use it when a metric is missing or a graph is empty: a down target explains it. On a shared store or one without a targets API the "
                "health comes from the up series."
            ),
            "parameters": {
                "type": "object",
                "properties": {
                    "health": {"type": "string", "description": "Only targets with this health: up, down or unknown"},
                    "job": {"type": "string", "description": "Only jobs whose name contains this, case-insensitive"},
                },
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
                    "since": {"type": "string", "description": "Window, e.g. 15m, 2h, 24h (default 1h)"},
                    "limit": {"type": "integer", "description": "Maximum lines (default 100, max 200)"},
                },
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "loki_query",
            "description": (
                "LogQL on the cluster's log store. A log query ({…} with line filters |= \"x\", |~ \"re\", parsers | json, | logfmt and label "
                "filters | level=\"error\") returns the newest lines (limit, default 100, max 200); a metric query returns one series per label "
                "set, e.g. sum by (k8s_pod_name) (count_over_time({k8s_namespace_name=\"shop\"} |= \"error\" [5m])) for errors per pod over time, "
                "rate(...) for lines per second, topk(5, ...) to keep the largest. Kubeast adds the cluster and namespace matchers to every selector "
                "(effective_query shows what ran). Find label names and values with loki_labels first instead of guessing; a pod name you do not have "
                "in full is a regex (k8s_pod_name=~\"web-.*\"), and a full name works for pods that no longer exist. Start with a short window. "
                "To show the user a metric query's trend, set chart=true with a short title and unit (same rules as prometheus_query's graph). "
                "For simple text search in known pods, logsearch is enough. {\"status\":\"unavailable\"} = no log store for this cluster; "
                "{\"status\":\"forbidden\"} = the cluster does not let the user read pod logs there; a cut result says truncated — do not answer "
                "from it. A grant limited to namespaces must name one of them. Only offered when the cluster has log search."
            ),
            "parameters": {
                "type": "object",
                "properties": {
                    "logql": {"type": "string", "description": "The LogQL query"},
                    "namespace": {"type": "string", "description": "Namespace the query is limited to (empty = every namespace, for an unscoped grant)"},
                    "since": {"type": "string", "description": "Window back from now, e.g. 15m, 2h, 24h (default 1h)"},
                    "since_time": {"type": "string", "description": "Start of a fixed window: RFC3339 time, or 24h / 2d back from now"},
                    "until_time": {"type": "string", "description": "End of a fixed window, RFC3339 (default now)"},
                    "step": {"type": "integer", "description": "Metric query: seconds between points (default: the window / 120, at least 15)"},
                    "limit": {"type": "integer", "description": "Log query: maximum lines (default 100, max 200)"},
                    "chart": {"type": "boolean", "description": "Metric query: also show the series to the user as a graph under your answer"},
                    "title": {"type": "string", "description": "Short title of that graph, in the user's language"},
                    "unit": {"type": "string", "description": "Unit of the values for the graph: count, rate, bytes, seconds or percent"},
                },
                "required": ["logql"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "loki_labels",
            "description": (
                "Label names on the cluster's log streams, or the values of one label (label=…), within since (default 1h) — only the streams "
                "of this cluster and of namespace when given. Call it before writing LogQL so the matchers use names and values that exist "
                "(stores fed by OpenTelemetry use k8s_namespace_name, k8s_pod_name, k8s_container_name, service_name). Only offered when the "
                "cluster has log search."
            ),
            "parameters": {
                "type": "object",
                "properties": {
                    "label": {"type": "string", "description": "List this label's values (empty = list the label names)"},
                    "namespace": {"type": "string", "description": "Only this namespace's streams (empty = every namespace, for an unscoped grant)"},
                    "since": {"type": "string", "description": "Window, e.g. 1h, 6h, 24h (default 1h)"},
                },
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "loki_patterns",
            "description": (
                "Log patterns of the streams a selector picks (Loki's pattern ingester): each line shape with its variable parts as <_>, how many "
                "lines had it, and when it was first and last seen — the kinds of errors at a glance, most frequent first (top 20; Loki lists a pattern only once 30 lines in the window have it). selector is a "
                "stream selector only, e.g. {k8s_container_name=\"api\"}; Kubeast adds the cluster and namespace matchers. To read the lines of "
                "one pattern, run loki_query with a line filter on its fixed text. {\"status\":\"unavailable\"} = this store keeps no patterns: "
                "count with loki_query instead. Only offered when the cluster has log search."
            ),
            "parameters": {
                "type": "object",
                "properties": {
                    "selector": {"type": "string", "description": "Stream selector, e.g. {k8s_pod_name=~\"web-.*\"}"},
                    "namespace": {"type": "string", "description": "Namespace the selector is limited to (empty = every namespace, for an unscoped grant)"},
                    "since": {"type": "string", "description": "Window, e.g. 1h, 3h (default 1h; the ingester keeps recent lines only)"},
                    "since_time": {"type": "string", "description": "Start of a fixed window: RFC3339 time, or 24h / 2d back from now"},
                    "until_time": {"type": "string", "description": "End of a fixed window, RFC3339 (default now)"},
                },
                "required": ["selector"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "traces_search",
            "description": (
                "TraceQL search on the cluster's trace store (Tempo): the newest matching traces (limit, max 20) with the spans that matched. "
                "TraceQL: spanset filters { … } joined by && || and structural operators (>> descendant, > child, ~ sibling), conditions on "
                "resource.<attr> (resource.service.name, resource.k8s.namespace.name, resource.k8s.pod.name), span.<attr> (span.http.route, "
                "span.http.response.status_code, span.db.system) and intrinsics (name, status = error, kind = server, duration > 500ms), "
                "e.g. { resource.service.name = \"cart\" && status = error } or { span.http.route = \"/checkout\" && duration > 2s } >> "
                "{ span.db.system = \"postgresql\" }. Find attribute names and values with traces_tags first instead of guessing. For \"slow\" "
                "requests do not guess a threshold: get the distribution with traces_compare (or a search without a duration filter) first. "
                "Kubeast adds the cluster and namespace to every { } (effective_query shows what ran); queries reading the parent span (parent.), "
                "the root span (rootName, rootServiceName, trace:rootService) or the whole trace's duration (traceDuration, trace:duration) are "
                "refused — they can sit outside your scope. {\"status\":\"unavailable\"} = no trace store for this cluster. A grant limited to "
                "namespaces must name one of them. Only offered where the cluster has a trace store."
            ),
            "parameters": {
                "type": "object",
                "properties": {
                    "traceql": {"type": "string", "description": "The TraceQL query"},
                    "namespace": {"type": "string", "description": "Namespace the query is limited to (empty = every namespace, for an unscoped grant)"},
                    "since": {"type": "string", "description": "Window back from now, e.g. 15m, 2h, 24h (default 1h)"},
                    "since_time": {"type": "string", "description": "Start of a fixed window: RFC3339 time, or 24h / 2d back from now"},
                    "until_time": {"type": "string", "description": "End of a fixed window, RFC3339 (default now)"},
                    "limit": {"type": "integer", "description": "Maximum traces (default and max 20)"},
                },
                "required": ["traceql"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "traces_get",
            "description": (
                "One trace by its ID (up to 32 hex digits, e.g. from traces_search or a log line's trace ID): its spans in your cluster and "
                "namespace — service, name, kind, start, duration, status and attributes — errors first, then by start (max 100). Spans of the "
                "trace in another cluster or namespace are not shown (hidden counts them). Use it to see where a slow or failed request spent "
                "its time. Only offered where the cluster has a trace store."
            ),
            "parameters": {
                "type": "object",
                "properties": {
                    "trace_id": {"type": "string", "description": "The trace ID"},
                    "namespace": {"type": "string", "description": "Namespace the spans are limited to (empty = every namespace, for an unscoped grant)"},
                },
                "required": ["trace_id"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "traces_tags",
            "description": (
                "Span attribute names on the cluster's traces grouped by scope (resource, span, intrinsic …; scope= to keep one), or the values "
                "of one attribute (tag=resource.service.name, tag=span.http.route), within since (default 1h) — only your cluster's and "
                "namespace's spans. Call it before writing TraceQL so names and values exist. Only offered where the cluster has a trace store."
            ),
            "parameters": {
                "type": "object",
                "properties": {
                    "scope": {"type": "string", "description": "resource, span, intrinsic, event, link or instrumentation (empty = all)"},
                    "tag": {"type": "string", "description": "List this attribute's values, with its scope (resource.service.name)"},
                    "namespace": {"type": "string", "description": "Only this namespace's spans (empty = every namespace, for an unscoped grant)"},
                    "since": {"type": "string", "description": "Window, e.g. 1h, 6h, 24h (default 1h)"},
                },
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "traces_metrics",
            "description": (
                "TraceQL metrics over time, one series per group: a filter then a function — rate() (spans per second), count_over_time(), "
                "quantile_over_time(duration, .95), avg_over_time(duration) — with by (…), e.g. { resource.service.name = \"cart\" && "
                "status = error } | rate() by (span.http.route) for errors per route, or { kind = server } | quantile_over_time(duration, .95) "
                "by (resource.service.name) for p95 latency per service. Same scope rules as traces_search. To show the trend to the user, set "
                "chart=true with a short title and unit (rate, seconds, count). Only offered where the cluster has a trace store."
            ),
            "parameters": {
                "type": "object",
                "properties": {
                    "traceql": {"type": "string", "description": "The TraceQL metrics query"},
                    "namespace": {"type": "string", "description": "Namespace the query is limited to (empty = every namespace, for an unscoped grant)"},
                    "since": {"type": "string", "description": "Window back from now, e.g. 30m, 6h (default 1h)"},
                    "since_time": {"type": "string", "description": "Start of a fixed window: RFC3339 time, or 24h / 2d back from now"},
                    "until_time": {"type": "string", "description": "End of a fixed window, RFC3339 (default now)"},
                    "step": {"type": "integer", "description": "Seconds between points (default: the window / 120, at least 15)"},
                    "chart": {"type": "boolean", "description": "Also show the series to the user as a graph under your answer"},
                    "title": {"type": "string", "description": "Short title of that graph, in the user's language"},
                    "unit": {"type": "string", "description": "Unit of the values for the graph: rate, seconds, count or percent"},
                },
                "required": ["traceql"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "traces_compare",
            "description": (
                "How long matching requests take: over the newest matching traces (limit, default 50), the p50 / p90 / min / max of each "
                "trace's slowest matched span and the fastest, typical and slowest samples with their trace IDs — the baseline to set a "
                "\"slow\" threshold and the traces to open with traces_get. traceql picks the spans, e.g. { resource.service.name = "
                "\"cart\" && kind = server }. Same scope rules as traces_search. Only offered where the cluster has a trace store."
            ),
            "parameters": {
                "type": "object",
                "properties": {
                    "traceql": {"type": "string", "description": "The TraceQL filter for the spans to compare"},
                    "namespace": {"type": "string", "description": "Namespace the query is limited to (empty = every namespace, for an unscoped grant)"},
                    "since": {"type": "string", "description": "Window back from now, e.g. 30m, 6h (default 1h)"},
                    "since_time": {"type": "string", "description": "Start of a fixed window: RFC3339 time, or 24h / 2d back from now"},
                    "until_time": {"type": "string", "description": "End of a fixed window, RFC3339 (default now)"},
                    "limit": {"type": "integer", "description": "Traces to sample (default 50)"},
                },
                "required": ["traceql"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "policy_reports",
            "description": (
                "Policy results from PolicyReport / ClusterPolicyReport (wgpolicyk8s.io — Kyverno, Trivy Operator and others write them). "
                "view=summary (default) gives totals per policy and per namespace (pass, fail, warn, error, skip); view=results lists the "
                "rows — each with namespace, kind, name, policy, rule, result, severity, message, source — filtered by namespace, policy, the engine "
                "that wrote it (policy_source), kind, results (e.g. fail,warn), severities (e.g. high,critical) or a search text, one page at a time: "
                "total counts every match, next_offset is where the next page starts, truncated means the cluster held more reports than one read "
                "takes. cluster_reports_error says why rows the ClusterPolicyReports hold may be missing from either view (the cluster refused them, "
                "a grant limited to namespaces, or too many to read): the counts are then not the whole, so say so. "
                "Two engines can name a policy alike; source tells them apart. Use it for "
                "\"which workloads violate policy X\", \"what fails in namespace Y\" or a compliance overview. {\"status\":\"unavailable\"} means the "
                "cluster has no PolicyReport source. Only offered where the policy reports feature is on and the user may read them."
            ),
            "parameters": {
                "type": "object",
                "properties": {
                    "view": {"type": "string", "description": "summary (default) or results"},
                    "namespace": {"type": "string", "description": "Only this namespace"},
                    "policy": {"type": "string", "description": "results: only this policy"},
                    "policy_source": {"type": "string", "description": "results: only this engine, as a row's source says (kyverno, Trivy …)"},
                    "kind": {"type": "string", "description": "results: only objects of this kind (Pod, Deployment …)"},
                    "results": {"type": "string", "description": "results: comma-separated result kinds to keep: pass,fail,warn,error,skip (default fail,warn,error)"},
                    "severities": {"type": "string", "description": "results: comma-separated severities to keep, e.g. critical,high"},
                    "search": {"type": "string", "description": "results: text to match in object name, policy or message"},
                    "sort": {"type": "string", "description": "results: result, policy, namespace or name (default worst first)"},
                    "dir": {"type": "string", "description": "results: asc (default) or desc"},
                    "offset": {"type": "integer", "description": "results: rows to skip, next_offset of the page before"},
                    "limit": {"type": "integer", "description": "results: rows in the page (default 100, max 200)"},
                },
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "helm_read",
            "description": (
                "Read Helm releases — never change them (no tool upgrades, rolls back or uninstalls a release: the person does that on the Helm screen). "
                "what=list (default; optional namespace, status) lists releases with chart, version, revision, status and updated time. "
                "For one release (namespace + release): what=get (summary, description, notes, values up to 32 KB), what=values / manifest / notes / hooks "
                "(that section as text), what=history (every revision with status and description), what=resources (the objects the release owns), "
                "what=images (container images), what=revision with revision=N and section (that revision's values or manifest), "
                "what=diff with from=N and to=M and section (manifest by default) — the unified diff between two revisions. Text is cut at 64 KB; "
                "secret values are redacted. A missing release answers {\"status\":\"not_found\"}: list first instead of guessing. "
                "Use it for \"what changed in the last upgrade\", \"which image does release X run\", \"what values is X deployed with\"."
            ),
            "parameters": {
                "type": "object",
                "properties": {
                    "what": {"type": "string", "description": "list, get, values, manifest, notes, hooks, history, resources, images, revision or diff"},
                    "namespace": {"type": "string", "description": "Release namespace (list: optional filter)"},
                    "release": {"type": "string", "description": "Release name (everything but list)"},
                    "status": {"type": "string", "description": "list: only releases in this status, e.g. deployed, failed"},
                    "revision": {"type": "integer", "description": "revision: the revision number"},
                    "from": {"type": "integer", "description": "diff: older revision"},
                    "to": {"type": "integer", "description": "diff: newer revision"},
                    "section": {"type": "string", "description": "revision/diff: manifest, values, notes or hooks"},
                },
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "cost",
            "description": (
                "Cost allocation from the cluster's OpenCost: per namespace (aggregate=namespace, default) or per workload (aggregate=controller) over a "
                "window (1h, 6h, 12h, 24h — default —, 48h, 7d, 14d, 30d), each row with cpu_cost, ram_cost, gpu_cost, pv_cost, network_cost and the total in "
                "the cluster's currency, plus the hours the cost covers; totals add up the rows answered. namespace narrows the rows and the totals to one namespace. Use it for \"what does namespace X cost\", "
                "\"the most expensive workloads this week\". {\"status\":\"unavailable\"} means no OpenCost is reachable; then use optimization "
                "(requests vs usage) for sizing without prices. Only offered where the cost feature is on and the user may read costs."
            ),
            "parameters": {
                "type": "object",
                "properties": {
                    "window": {"type": "string", "description": "1h, 6h, 12h, 24h (default), 48h, 7d, 14d or 30d"},
                    "aggregate": {"type": "string", "description": "namespace (default) or controller (per workload)"},
                    "namespace": {"type": "string", "description": "Only this namespace"},
                },
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "optimization",
            "description": (
                "Requests versus actual usage per container of one namespace, with a recommendation: rows carry kind, name, container, pods, "
                "cpu_request_m, cpu_usage_m, cpu_recommend_m, mem_request_bytes, mem_usage_bytes, mem_recommend_bytes and flags (over-provisioned, "
                "no requests, near limit …), plus totals and — with OpenCost — the monthly cost and saving. Usage comes from Prometheus or "
                "metrics-server over window_hours (default from settings). Use it for \"is namespace X over-provisioned\", \"what should the requests "
                "of deployment Y be\". Rows with a recommendation come first."
            ),
            "parameters": {
                "type": "object",
                "properties": {
                    "namespace": {"type": "string", "description": "The namespace to analyse"},
                    "window_hours": {"type": "integer", "description": "Usage window in hours (default: server setting, max 720)"},
                },
                "required": ["namespace"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "can_i",
            "description": (
                "Ask the cluster whether the signed-in user may do verb on resource (SelfSubjectAccessReview as that user — their RBAC, not "
                "Kubeast's). verb: get, list, watch, create, update, patch, delete …; resource: the plural type (pods, deployments, secrets); group for a "
                "non-core API (apps, batch, networking.k8s.io); namespace for a namespaced check (empty = cluster scope); name for one object, since an "
                "RBAC rule with resourceNames allows that object and not the kind, as a drawer's Delete button asks. Returns allowed true/false. "
                "Use it before suggesting an action the user may not be allowed to do, or to explain a 403."
            ),
            "parameters": {
                "type": "object",
                "properties": {
                    "verb": {"type": "string", "description": "Kubernetes verb, e.g. delete"},
                    "resource": {"type": "string", "description": "Plural resource type, e.g. pods"},
                    "group": {"type": "string", "description": "API group, e.g. apps (empty for core)"},
                    "namespace": {"type": "string", "description": "Namespace (empty = cluster scope)"},
                    "name": {"type": "string", "description": "One object's name (empty = the kind as a whole)"},
                },
                "required": ["verb", "resource"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "network_policy_check",
            "description": (
                "Whether Kubernetes NetworkPolicy allows a connection from src to dst, and the policy and rule that decide (read as the signed-in "
                "user). src and dst are <kind>/<namespace>/<name> — pod, deployment, statefulset, daemonset, replicaset, job, cronjob; dst may also "
                "be service/<namespace>/<name> — or an IP address. port is the destination port (a Service port for a Service, a number or a "
                "container port name); leave it out to check every port the destination declares. Each check says egress (from src) and ingress "
                "(into dst): isolated or not, allowed_by rules, and misses with the reason (peer, port, named_port, no_rules). result unknown means "
                "the plugin decides (pod_ip_block, host_network) or namespace labels could not be read (namespace_labels_unknown); notes dns_egress_denied = the source cannot resolve a Service name. Use it for "
                "\"why can't A reach B\", \"who may connect to this pod\", before blaming DNS or the app."
            ),
            "parameters": {
                "type": "object",
                "properties": {
                    "src": {"type": "string", "description": "Source: <kind>/<namespace>/<name> or an IP address, e.g. deployment/shop/frontend"},
                    "dst": {"type": "string", "description": "Destination: <kind>/<namespace>/<name> (service allowed) or an IP address, e.g. service/shop/db"},
                    "port": {"type": "string", "description": "Destination port number or name (empty = every declared port)"},
                    "protocol": {"type": "string", "enum": ["TCP", "UDP", "SCTP"], "description": "Protocol (default TCP)"},
                },
                "required": ["src", "dst"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "network_flows",
            "description": (
                "Recent network flows from the cluster's Hubble Relay (Cilium, or Retina's Hubble) or Calico's Whisker, read as the signed-in "
                "user: the flows with the namespace, a pod (pod) or a workload (workload_kind + workload_name) on either side. groups fold one "
                "connection's flows: source, destination, port, protocol, verdict (FORWARDED, DROPPED …), drop_reason (POLICY_DENIED = a network "
                "policy blocked it), policies that allowed or denied it when the plugin reports them, count and last time. The result's provider "
                "says which: on calico the counts are packets and a pod is named with the other pods of its ReplicaSet or Job (<generateName>*). "
                "verdict filters (e.g. DROPPED), since is a window up to the server's maximum (default 15m). Use it for \"is anything being "
                "blocked\", \"who talks to this pod\"; for a drop, call network_policy_check with the same ends and port to name the NetworkPolicy rule."
            ),
            "parameters": {
                "type": "object",
                "properties": {
                    "namespace": {"type": "string", "description": "Namespace of the pod or workload"},
                    "pod": {"type": "string", "description": "Pod name (or use workload_kind + workload_name)"},
                    "workload_kind": {"type": "string", "description": "Deployment, StatefulSet, DaemonSet, ReplicaSet, Job or CronJob"},
                    "workload_name": {"type": "string", "description": "Workload name"},
                    "verdict": {"type": "string", "description": "Verdicts to keep, comma-separated, e.g. DROPPED"},
                    "since": {"type": "string", "description": "Window, e.g. 15m (default from settings)"},
                    "limit": {"type": "integer", "description": "Most recent flows to read (capped by the server)"},
                },
                "required": ["namespace"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "network_drops",
            "description": (
                "Network drops counted by the Hubble agents (Cilium, or Retina's Hubble), read from the cluster's Prometheus "
                "(hubble_drop_total) as the signed-in user, for the namespace, a pod (pod) or a workload (workload_kind + workload_name): "
                "incoming (the target is the destination) and outgoing totals over since (1m to 24h, default 1h), the drop reasons "
                "(POLICY_DENIED = a network policy dropped it) and the peers they came from or went to. Use it for \"is anything being "
                "dropped\", \"how much and since when\"; for POLICY_DENIED, call network_policy_check with that peer to name the rule, and "
                "network_flows for the connections themselves. available false says why (no Prometheus, no Hubble drop metric, no workload labels)."
            ),
            "parameters": {
                "type": "object",
                "properties": {
                    "namespace": {"type": "string", "description": "Namespace of the pod or workload"},
                    "pod": {"type": "string", "description": "Pod name (or use workload_kind + workload_name)"},
                    "workload_kind": {"type": "string", "description": "Deployment, StatefulSet, DaemonSet, ReplicaSet, Job or CronJob"},
                    "workload_name": {"type": "string", "description": "Workload name"},
                    "since": {"type": "string", "description": "Range, e.g. 1h, 6h or 24h (default 1h)"},
                },
                "required": ["namespace"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "network_top_flows",
            "description": (
                "Top contributors from the cluster's Amazon CloudWatch Network Flow Monitor (EKS Container Network Observability), read "
                "with Kubeast's AWS identity for a user who may list the namespace's pods: the rows with the namespace, a pod (pod) or a "
                "workload (workload_kind + workload_name) at either end, largest first, ranked by metric — data_transferred (bytes, "
                "default), retransmissions or timeouts (retransmission timeouts) — over since (1m to the server's maximum, default 1h). "
                "destination picks the EKS console's view: cluster (within the cluster, INTRA_AZ and INTER_AZ, default), aws (Amazon S3 "
                "and DynamoDB) or external (internet or on-premises). Each row has local (where the agent measured) and remote: pod, "
                "workload, Service, IP, zone, port, value, category. Use it for \"who does this talk to the most\", \"where do "
                "retransmissions come from\", \"how much crosses zones\"; a connection measured at both ends is listed once."
            ),
            "parameters": {
                "type": "object",
                "properties": {
                    "namespace": {"type": "string", "description": "Namespace of the pod or workload"},
                    "pod": {"type": "string", "description": "Pod name (or use workload_kind + workload_name)"},
                    "workload_kind": {"type": "string", "description": "Deployment, StatefulSet, DaemonSet, ReplicaSet, Job or CronJob"},
                    "workload_name": {"type": "string", "description": "Workload name"},
                    "metric": {"type": "string", "enum": ["data_transferred", "retransmissions", "timeouts"], "description": "What to rank by (default data_transferred)"},
                    "destination": {"type": "string", "enum": ["cluster", "aws", "external"], "description": "Which flows: within the cluster (default), to AWS services, or outside AWS"},
                    "since": {"type": "string", "description": "Range, e.g. 15m, 1h or 2h (default 1h)"},
                },
                "required": ["namespace"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "resource_graph",
            "description": (
                "The objects of one namespace and the edges between them — owner (Deployment → ReplicaSet → Pod), selector (Service → Pod), "
                "volume and config references (Pod → ConfigMap/Secret/PVC), Ingress → Service — as nodes and edges plus counts by kind. "
                "Use it to answer \"what depends on Service X\", \"which pods does this ConfigMap feed\", \"what would break if I delete Y\". "
                "Large namespaces are cut at 200 nodes and 400 edges; narrow with k8s_get_resources when the answer needs one object's neighbours."
            ),
            "parameters": {
                "type": "object",
                "properties": {
                    "namespace": {"type": "string", "description": "The namespace to map"},
                },
                "required": ["namespace"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "timeline",
            "description": (
                "Change history, as the Timeline screen shows it: events and rollout revisions (each Deployment's ReplicaSets, each StatefulSet's and DaemonSet's "
                "ControllerRevisions) of one namespace, one object or every namespace the user reads. Use it for \"what changed before this broke?\", then read one object with k8s_describe_resource. "
                "summary counts every event of the window; events holds the newest (events_shown of events_matching, said in events_note when cut), so do not count from the rows. "
                "rollouts_total is null with rollouts_note when the rollouts could not be read: not counted, not zero. With until_time or a kind without a name, narrowed.events_matching is null when the "
                "list stopped before reaching them: not counted, not zero. Events typically live about an hour in the cluster."
            ),
            "parameters": {
                "type": "object",
                "properties": {
                    "namespace": {"type": "string", "description": "One namespace; empty for every namespace the user reads"},
                    "since_time": {"type": "string", "description": "Start: 24h, 7d or an RFC3339 time (default 24h before the end). Rounded out to a whole hour back from now"},
                    "until_time": {"type": "string", "description": "End as an RFC3339 time (default now)"},
                    "event_type": {"type": "string", "enum": ["Normal", "Warning"], "description": "Only events of this type, the newest of that type; the counts stay of every event"},
                    "kind": {"type": "string", "description": "An object's kind (Deployment, Pod …). With name, that object's history; alone, that kind among the rows read"},
                    "name": {"type": "string", "description": "An object's name; needs kind and namespace (a Node's events are in namespace default)"},
                    "limit": {"type": "integer", "description": "The newest events to list (default 200, at most 500, the screen's)"},
                },
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "gpu",
            "description": (
                "GPUs and DRA, as the GPU screens show them: capacity, allocatable, in use (kubectl describe node's Allocated resources), free and waiting, in total, per company (NVIDIA, AMD, Intel) "
                "and per node; each pod's request and status; device plugins, MIG and time-slicing; DeviceClasses and ResourceClaimTemplates; utilization, memory and temperature from DCGM where the "
                "cluster's Prometheus has it. free is allocatable minus in use on each node, whatever the node's status. Use the counts here instead of adding up rows. A number a source could not give is null and the source is named in \"refused\" (the user's grant does not "
                "reach it), \"not_read\" or \"not_served\", and utilization says why: it is not counted, not zero. ResourceClaims and ResourceSlices are k8s_get_resources."
            ),
            "parameters": {"type": "object", "properties": {}},
        },
    },
    {
        "type": "function",
        "function": {
            "name": "k8s_jq_query",
            "description": (
                "kubectl get -o json for a resource type, filtered by a jq expression — the way to read a large list without pulling it "
                "all into the conversation. The expression receives the list object, so start from .items[]: "
                ".items[] | select(.status.phase != \"Running\") | .metadata.name, or .items[] | {name: .metadata.name, image: .spec.containers[0].image}. "
                "Narrow with namespace (or every namespace), label_selector and field_selector so the server does the filtering. "
                "Returns total_items_processed, matches_found and results (at most limit, default 50, max 200; 256 KB). The program runs here with "
                "no environment or file access and a 5 s limit; a syntax or runtime error comes back as a bad request to fix. "
                "Prefer this over k8s_get_resources whenever you only need a few fields of many objects."
            ),
            "parameters": {
                "type": "object",
                "properties": {
                    "resource_type": {"type": "string", "description": "Resource type (pods, deployments, nodes, events …)"},
                    "jq": {"type": "string", "description": "jq expression applied to the list object, e.g. .items[] | select(.status.phase == \"Pending\") | .metadata.name"},
                    "namespace": {"type": "string", "description": "One namespace (empty = every namespace)"},
                    "label_selector": {"type": "string", "description": "Server-side label selector, e.g. app=web,tier!=db"},
                    "field_selector": {"type": "string", "description": "Server-side field selector, e.g. status.phase!=Running or spec.nodeName=node-1"},
                    "limit": {"type": "integer", "description": "Maximum results (default 50, max 200)"},
                },
                "required": ["resource_type", "jq"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "k8s_tabular_query",
            "description": (
                "kubectl get as a table with exactly the columns you name — HEADER:.json.path pairs separated by commas, e.g. "
                "NAME:.metadata.name,NODE:.spec.nodeName,RESTARTS:.status.containerStatuses[0].restartCount — optionally sorted by a field "
                "(sort_by=.metadata.creationTimestamp) and capped at limit rows (default 100, max 200). Cheaper than -o wide or json when you need "
                "a few fields of many objects, and the first line says how many rows there were in total. Default columns: NAMESPACE and NAME."
            ),
            "parameters": {
                "type": "object",
                "properties": {
                    "resource_type": {"type": "string", "description": "Resource type (pods, nodes, deployments …)"},
                    "columns": {"type": "string", "description": "HEADER:.path pairs, comma-separated (default NAMESPACE:.metadata.namespace,NAME:.metadata.name)"},
                    "namespace": {"type": "string", "description": "One namespace (empty = every namespace)"},
                    "label_selector": {"type": "string", "description": "Server-side label selector"},
                    "field_selector": {"type": "string", "description": "Server-side field selector"},
                    "sort_by": {"type": "string", "description": "Field path to sort by, e.g. .metadata.creationTimestamp"},
                    "limit": {"type": "integer", "description": "Maximum rows (default 100, max 200)"},
                },
                "required": ["resource_type"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "k8s_count",
            "description": (
                "How many objects of a type match, optionally grouped by one field: group_by=.status.phase (pods per phase), "
                ".metadata.namespace (per namespace), .spec.nodeName (pods per node), .status.conditions[0].type. One call answers "
                "\"how many pods are Pending\", \"which node runs the most pods\", \"deployments per namespace\" without listing anything. "
                "Narrow with namespace, label_selector and field_selector. Groups are sorted by count, at most 100."
            ),
            "parameters": {
                "type": "object",
                "properties": {
                    "resource_type": {"type": "string", "description": "Resource type (pods, deployments, nodes …)"},
                    "group_by": {"type": "string", "description": "Field path to group by, e.g. .status.phase"},
                    "namespace": {"type": "string", "description": "One namespace (empty = every namespace)"},
                    "label_selector": {"type": "string", "description": "Server-side label selector"},
                    "field_selector": {"type": "string", "description": "Server-side field selector"},
                },
                "required": ["resource_type"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "gitops_status",
            "description": (
                "Argo CD Application status in this cluster, read as the user: per application the sync status (Synced, OutOfSync, Unknown) "
                "and revision, the health (Healthy, Progressing, Degraded, Suspended, Missing, Unknown) with its message, the last operation "
                "(phase, message, times), error conditions, automated-sync settings and the resources that are out of sync or unhealthy "
                "(at most 10), plus counts by sync and health status. Filter with namespace (the Application's own namespace, usually argocd), "
                "name (needs namespace), project, destination_namespace, and only_problems=true to skip Synced+Healthy applications; problems "
                "are listed first, at most limit (default 50, max 100). Use it for \"is the deploy in sync\", \"why is the app Degraded\", "
                "\"what did the last sync fail on\". {\"status\":\"unavailable\"} means this cluster has no Argo CD (no applications.argoproj.io): "
                "Applications live where Argo CD runs — when Argo CD is central, call it on the management cluster."
            ),
            "parameters": {
                "type": "object",
                "properties": {
                    "namespace": {"type": "string", "description": "The Application's own namespace (usually argocd); empty = every namespace"},
                    "name": {"type": "string", "description": "One Application (needs namespace)"},
                    "project": {"type": "string", "description": "Only this Argo CD project"},
                    "destination_namespace": {"type": "string", "description": "Only applications deploying into this namespace"},
                    "only_problems": {"type": "boolean", "description": "Skip applications that are Synced and Healthy"},
                    "limit": {"type": "integer", "description": "Applications to return (default 50, max 100)"},
                },
            },
        },
    },
]

# Preview of a write, for users who may write: the server dry-runs the apply (the same RBAC as
# the write, so Read users are not offered it — features.py REQUIRED_PERMISSIONS), nothing is
# applied, no approval card. Not part of the Read role's seed.
WRITE_PREVIEW_TOOLS: List[Dict] = [
    {
        "type": "function",
        "function": {
            "name": "k8s_diff",
            "description": (
                "Preview what applying a manifest would change, without applying it: the API server dry-runs the apply (defaults, "
                "validation and admission all run) and the result is diffed against the live object as JSON, ignoring server-owned fields "
                "and status. Returns status created | changed | unchanged, lines_added, lines_removed and the unified diff. One object per call. "
                "Use it before k8s_apply_manifest or k8s_patch_resource so the user sees exactly what will change, and to check a manifest "
                "the user wrote. {\"status\":\"forbidden\"} means the user lacks the write permission (a dry run needs the same RBAC as the write)."
            ),
            "parameters": {
                "type": "object",
                "properties": {
                    "yaml_content": {"type": "string", "description": "The manifest (YAML or JSON), one object"},
                    "resource_manifest": {"type": "object", "description": "The manifest as a JSON object (alternative to yaml_content)"},
                    "namespace": {"type": "string", "description": "Namespace when the manifest has none"},
                },
            },
        },
    },
]

# Starts something in Kubeast; the cluster does not change, so no approval card (tool_whitelists.ACTION_TOOL_NAMES).
# Offered when the token holds what the screen's button asks. Not part of the Read role's seed.
ACTION_TOOLS: List[Dict] = [
    {
        "type": "function",
        "function": {
            "name": "alert_investigate",
            "description": (
                "Start Kubeast's formal investigation of one alert in the Alerts inbox, the same as the alert window's \"Investigate now\" "
                "button (permission resource.alert.investigate, and reading the whole cluster): it runs in the background as kubeast:investigator "
                "with read-only tools, its report is stored in Alerts and Admin → Investigations, and it costs model tokens, counted in the "
                "day's budget of asked-for investigations. Call it only when the user asks to start an investigation; for a quick look use the "
                "read tools yourself. Name the alert with alert_id, or with alertname and, when several match, namespace or alert_labels; "
                "{\"status\":\"ambiguous\"} lists the matches, so ask the user which one. Answers started, investigation (id, status), "
                "report_link (give it to the user), alert_link and investigate_now (the window's state: allowed, reason, until, budget, used). "
                "Nothing new starts while this firing's investigation is queued, running or done; a finished one answers its report, which you "
                "summarize. status_only=true starts nothing and reads how it went: use that to look again, because a call without it starts a "
                "new run after a failed or skipped one. Refusals keep the button's reason: forbidden (code forbidden, manual_off), rate_limited "
                "(code manual_budget, provider_paused, with until). not_found = not in the inbox; unavailable = investigations are off."
            ),
            "parameters": {
                "type": "object",
                "properties": {
                    "alert_id": {"type": "string", "description": "The alert's id in the Alerts inbox, from an earlier answer of this tool"},
                    "alertname": {"type": "string", "description": "Exact alert name, e.g. KubePodCrashLooping"},
                    "namespace": {"type": "string", "description": "The alert's namespace label, to tell alerts of one name apart"},
                    "alert_labels": {
                        "type": "object",
                        "description": "Exact label values to tell alerts of one name apart, e.g. {\"pod\": \"web-1\"}",
                        "additionalProperties": {"type": "string"},
                    },
                    "status_only": {"type": "boolean", "description": "Read how the investigation went; start nothing"},
                },
            },
        },
    },
]

# Read tools for Admin only: offered when the token holds the permission k8s-service asks for
# (app/services/ai/features.py REQUIRED_PERMISSIONS). Not part of the Read role's seed.
ADMIN_READ_TOOLS: List[Dict] = [
    {
        "type": "function",
        "function": {
            "name": "hygiene",
            "description": (
                "The cluster hygiene report (Cluster → Cluster Hygiene; permission resource.hygiene.scan on the cluster, which an Admin grant holds, or admin.hygiene.read): Pod Security Standards level per namespace, "
                "containers running as root or privileged, images by mutable tag (latest), TLS certificates about to expire, deprecated APIs and "
                "other upgrade-readiness checks against the next Kubernetes minor, with counts per severity, the list of checks and the findings "
                "(check, severity, kind, namespace, name, message, exempt). The upgrade checks' ids start with upgrade. and server_version and "
                "target_version say what they judge against. Filter with severity (critical, warning, info) or check (one check's id). "
                "Use it for \"is this cluster ready for the upgrade\", \"what breaks Pod Security\", a periodic review. The report also says when it "
                "was last signed off and whether a review is due. {\"status\":\"unavailable\"} means the report is off (features.hygiene.enabled)."
            ),
            "parameters": {
                "type": "object",
                "properties": {
                    "severity": {"type": "string", "description": "Only findings of this severity: critical, warning or info"},
                    "check": {"type": "string", "description": "Only findings of this check id (from the report's checks list)"},
                },
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "audit_search",
            "description": (
                "Kubeast's own audit log (Admin → Audit; permission admin.audit.read): who did what, when, with which result. Filters: "
                "audit_action (the exact action, e.g. k8s.pod.delete, helm.release.rollback, ai.tool.execute, auth.login), service (auth, k8s, "
                "helm, ai, admin), actor_email, target_id (the object or user the action targeted), namespace, result (success or failure), "
                "since_time (a window such as 24h or 7d, at most 90d, or an RFC3339 time), until_time (RFC3339), limit (default 50, max 200) and offset; "
                "the current cluster unless all_clusters=true (Kubeast-wide actions — auth.*, admin.*, user and role changes — carry no cluster, "
                "so pass all_clusters=true for those). Each entry carries at, service, action, actor, target, cluster, namespace, "
                "result, error and the before/after details cut to 500 characters. Use it for \"who deleted this\", \"what changed yesterday\", "
                "\"which AI tool calls failed\". The read itself is recorded as admin.audit.read."
            ),
            "parameters": {
                "type": "object",
                "properties": {
                    "audit_action": {"type": "string", "description": "Exact audit action, e.g. k8s.pod.delete"},
                    "service": {"type": "string", "description": "auth, k8s, helm, ai or admin"},
                    "actor_email": {"type": "string", "description": "Who acted"},
                    "target_id": {"type": "string", "description": "What was acted on (object name, user id)"},
                    "namespace": {"type": "string", "description": "Kubernetes namespace the action targeted"},
                    "result": {"type": "string", "description": "success or failure"},
                    "since_time": {"type": "string", "description": "Window such as 24h or 7d (max 90d), or an RFC3339 time"},
                    "until_time": {"type": "string", "description": "RFC3339 end time"},
                    "limit": {"type": "integer", "description": "Entries to return (default 50, max 200)"},
                    "offset": {"type": "integer", "description": "Skip this many entries (paging)"},
                    "all_clusters": {"type": "boolean", "description": "Every cluster instead of the current one"},
                },
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "nodes_stats_summary",
            "description": (
                "The kubelet Summary API of a node through the API server proxy (Admin; permission admin.nodes.read, cluster RBAC nodes/proxy): "
                "cpu cores used, memory working set / available / rss in MiB, root and image filesystem usage, network bytes and errors, "
                "pressure stall information (PSI) for cpu, memory and io, swap, process count and the kubelet/runtime/pods system containers. "
                "With node=<name> it adds the node's pods ranked by rank_by (memory, cpu or ephemeral_storage; top at most 20, default 10); "
                "without node it reads every node (at most 20) at node level. Use it for \"what is eating memory on this node\", \"is the node "
                "under pressure\", \"which pod fills ephemeral storage\". {\"status\":\"unavailable\"} means the API server could not reach the kubelet."
            ),
            "parameters": {
                "type": "object",
                "properties": {
                    "node": {"type": "string", "description": "Node name; empty = every node at node level"},
                    "top": {"type": "integer", "description": "Pods to list for the node (default 10, max 20)"},
                    "rank_by": {"type": "string", "description": "memory (default), cpu or ephemeral_storage"},
                },
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "nodes_log",
            "description": (
                "Node-level logs through the kubelet log query (Admin; permission admin.nodes.read, cluster RBAC nodes/proxy): source is a "
                "service unit such as kubelet or containerd, or a file path under the node's log root such as /var/log/kubelet.log; narrow with "
                "pattern (a regular expression), tail_lines (default 200, max 1000), since_time (24h, 7d or RFC3339), until_time (RFC3339) and boot (0 current, "
                "-1 previous). Returns the raw lines (at most 64 KB). Use it when a node is NotReady, pods on one node fail to start, or the "
                "kubelet reports image or volume errors. {\"status\":\"unavailable\"} means the kubelet does not answer log queries "
                "(enableSystemLogQuery off — the reason says what to turn on); then fall back to k8s_get_events and nodes_stats_summary."
            ),
            "parameters": {
                "type": "object",
                "properties": {
                    "node": {"type": "string", "description": "Node name"},
                    "source": {"type": "string", "description": "Service unit (kubelet, containerd) or a log file path; default kubelet"},
                    "pattern": {"type": "string", "description": "Regular expression the lines must match"},
                    "tail_lines": {"type": "integer", "description": "Last N lines (default 200, max 1000)"},
                    "since_time": {"type": "string", "description": "Window such as 1h, or an RFC3339 time"},
                    "until_time": {"type": "string", "description": "RFC3339 end time"},
                    "boot": {"type": "integer", "description": "System boot: 0 current, -1 previous"},
                },
                "required": ["node"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "access_review",
            "description": (
                "Who has what in Kubeast (Admin → Access review; permission admin.review.read). Kubeast-wide: the same answer from any cluster. "
                "review_section: summary (default: the cards, when the last review was and when the next is due, each tab's count), users (accounts, "
                "global role, last sign-in, flags such as dormant or never_logged_in), cluster_roles (who holds which role on which cluster, the "
                "namespaces it is limited to, temporary grants and when they end), api_keys (owner, name, key_prefix, clusters, role ceiling, expiry, "
                "last use), access_requests (temporary grants requested since the last review), roles (each role's permissions and how many hold it), "
                "history (past sign-offs). search looks in what the screen's search box looks in, for example a cluster name in cluster_roles. "
                "review_id opens a past sign-off's stored report. Rows come a page at a time: total, returned, next_offset; pass offset for the next page "
                "(limit default 25, max 200). since_time widens the requests' window of the live report. A key's value and password hashes are never "
                "in the answer: key_prefix is only the first characters a list shows. {\"status\":\"unavailable\"} means the report is off "
                "(auth.accessReview.enabled). The read is recorded as admin.review.read; signing off stays on the screen."
            ),
            "parameters": {
                "type": "object",
                "properties": {
                    "review_section": {"type": "string", "enum": ["summary", "users", "cluster_roles", "api_keys", "access_requests", "roles", "history"], "description": "Which part of the report (default summary)"},
                    "review_id": {"type": "string", "description": "Id of a past sign-off (from review_section=history): read its stored report"},
                    "search": {"type": "string", "description": "Text to find in a section's rows"},
                    "since_time": {"type": "string", "description": "Start of the requests' window, live report only: a window such as 30d (max 90d) or an RFC3339 time"},
                    "limit": {"type": "integer", "description": "Rows to return (default 25, max 200)"},
                    "offset": {"type": "integer", "description": "Skip this many rows (paging)"},
                },
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "ai_usage",
            "description": (
                "Who used the AI how much (Admin → AI Usage; permission admin.audit.read). Kubeast-wide: the same answer from any cluster. usage_group "
                "adds up by user (default), model or cluster, most tokens first, with chat and Optimization (source chat) and alert investigations "
                "(source investigation) in rows of their own: requests, failures, prompt, cached, completion and total tokens, tool calls, average "
                "duration, last use. totals counts every group, also those past the listing limit, which cuts names per source; use totals for "
                "\"how many tokens in all\", never the rows added up. partial_tokens means some requests recorded no token count. since_time (a window "
                "such as 7d, at most 90d, or an RFC3339 time; default the last 30 days) and until_time (RFC3339) set the period. Rows come a page at a "
                "time: total, returned, next_offset (limit default 25, max 200). The read is recorded as admin.audit.read."
            ),
            "parameters": {
                "type": "object",
                "properties": {
                    "usage_group": {"type": "string", "enum": ["user", "model", "cluster"], "description": "Add up by user (default), model or cluster"},
                    "since_time": {"type": "string", "description": "Window such as 7d (max 90d), or an RFC3339 time; default the last 30 days"},
                    "until_time": {"type": "string", "description": "RFC3339 end time; default now"},
                    "limit": {"type": "integer", "description": "Rows to return (default 25, max 200)"},
                    "offset": {"type": "integer", "description": "Skip this many rows (paging)"},
                },
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "access_requests",
            "description": (
                "Requests for a temporary higher role on a cluster (Admin → Access requests; permission admin.users.update). Kubeast-wide: the same answer "
                "from any cluster. status: pending (default, those waiting for a decision), decided (every request no longer pending), or one of approved, "
                "rejected, cancelled, expired. search looks in the requester, cluster, role, reason and decider. Each row has who asked, the cluster, the "
                "role, how long, the reason and the decision. total counts every match; next_offset gives the next page (limit default 25, max 200). "
                "enabled false means requests are off on this installation. Read only: Approving or rejecting is done by a person on the screen; no tool does it."
            ),
            "parameters": {
                "type": "object",
                "properties": {
                    "status": {"type": "string", "enum": ["pending", "decided", "approved", "rejected", "cancelled", "expired"], "description": "Which requests (default pending)"},
                    "search": {"type": "string", "description": "Text in the requester, cluster, role, reason or decider"},
                    "limit": {"type": "integer", "description": "Rows to return (default 25, max 200)"},
                    "offset": {"type": "integer", "description": "Skip this many rows (paging)"},
                },
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "audit_integrity",
            "description": (
                "The audit log's hash chain as Admin → Audit Logs shows it (permission admin.audit.read). Kubeast-wide: the same answer from any cluster. "
                "How far the rows are sealed (sealed_through_seq), how many are not yet (unsealed_rows), and the last digest anchored outside the database "
                "(last_anchor, null when none yet). enabled false means the chain is off. This does not check the chain, so it cannot say that no row was "
                "changed: the Verify button on that screen recomputes it. Say so when asked whether the log is intact."
            ),
            "parameters": {"type": "object", "properties": {}},
        },
    },
    {
        "type": "function",
        "function": {
            "name": "hygiene_history",
            "description": (
                "This cluster's hygiene sign-offs (Cluster → Cluster Hygiene → Past sign-offs; permission resource.hygiene.scan on the cluster or admin.hygiene.read), newest first: who "
                "signed, when, the note and the counts per severity. They come a page at a time, as on the tab: total, returned, next_offset; pass offset for the next page "
                "(limit default and max 100). review_id opens the report one stored, with severity and check filtering its findings as "
                "in hygiene. The list also says enabled and interval_days, how often a sign-off is due. The hygiene tool answers the report as it is now. "
                "{\"status\":\"unavailable\"} means the report is off (features.hygiene.enabled)."
            ),
            "parameters": {
                "type": "object",
                "properties": {
                    "review_id": {"type": "string", "description": "Id of a sign-off: read the report it stored"},
                    "severity": {"type": "string", "description": "With review_id: only findings of this severity (critical, warning or info)"},
                    "check": {"type": "string", "description": "With review_id: only findings of this check id"},
                    "limit": {"type": "integer", "description": "Sign-offs to return (default and max 100)"},
                    "offset": {"type": "integer", "description": "Skip this many sign-offs (paging)"},
                },
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "investigations",
            "description": (
                "The reports the alert investigator wrote (Admin → Investigations; permission admin.investigations.read), newest first and of every cluster unless "
                "cluster_id names one: alert, severity, namespace, status (queued, running, done, failed, skipped), skip_reason, times, repeat_count, requested_by, model, "
                "tokens, tool_call_count. investigation_id opens one report with its text, error, the tool calls it made, labels and annotations, which is recorded as "
                "ai.investigation.view because a report can quote pod logs. Reports stay listed after features.alertInvestigation is turned off. Reading only: "
                "alert_investigate starts one. {\"status\":\"audit_unavailable\"} means nothing was read because the audit log cannot take the record."
            ),
            "parameters": {
                "type": "object",
                "properties": {
                    "investigation_id": {"type": "string", "description": "A report's id from the list, to open it"},
                    "status": {"type": "string", "description": "Only this status: queued, running, done, failed or skipped"},
                    "cluster_id": {"type": "string", "description": "Only this cluster's, an id from clusters_list"},
                    "limit": {"type": "integer", "description": "Rows per page (default 25, at most 200)"},
                    "offset": {"type": "integer", "description": "Rows to skip, for the next page; total says how many there are"},
                },
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "ai_models",
            "description": (
                "The models set up for the AI (Admin → AI Models; permission admin.ai_models.*): name, provider, model, enabled, is_default, tier, used_for (what runs on it now: "
                "chat, floating, summary, investigation), and its limits max_tokens and tool_result_chars. null limit = the call's default: 4096 tokens for a chat answer, 2048 for an "
                "investigation step, 6000 characters of a tool result. key_env_set says only whether a key variable is named: false is the card's \"No key env\" warning, null a provider that asks for "
                "no key. active names the model the chat runs on and providers what this install cannot run, with why. "
                "It never answers an API key, the name of the variable holding one, a header, a certificate or an address, which stay on the screen, as do adding, changing and testing a model."
            ),
            "parameters": {
                "type": "object",
                "properties": {
                    "enabled_only": {"type": "boolean", "description": "Only the models that are switched on (default every model)"},
                },
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "session_recordings",
            "description": (
                "That a terminal session was recorded and its details (Admin → Session recordings; permission admin.sessions.read), newest first and of every cluster unless "
                "cluster_id names one: kind (exec or node-shell), user_email, cluster, namespace, target, container, started_at, ended_at, kept_bytes (the size the screen shows: what is kept of it), "
                "bytes (what was recorded), uploaded_bytes, parts, status (recording, uploading, uploaded, interrupted), truncated and last_error. enabled says whether terminals are recorded now. Its details, never what the terminal "
                "showed: that opens only on the screen, where each view is audited. Rows come a page at a time, as on the screen: total (every match), returned, next_offset."
            ),
            "parameters": {
                "type": "object",
                "properties": {
                    "recording_id": {"type": "string", "description": "A recording's id from the list, for its details alone"},
                    "actor_email": {"type": "string", "description": "Part of the mail address of the person who opened the terminal"},
                    "recording_kind": {"type": "string", "enum": ["exec", "node-shell"], "description": "Pod exec or node shell"},
                    "cluster_id": {"type": "string", "description": "Only this cluster's, an id from clusters_list"},
                    "limit": {"type": "integer", "description": "Rows per page (default 25, at most 200)"},
                    "offset": {"type": "integer", "description": "Rows to skip, for the next page"},
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
    {
        "type": "function",
        "function": {
            "name": "k8s_cordon_node",
            "description": (
                "Cordon a node so nothing new is scheduled on it, or uncordon it: the Cordon button of the Node window (permission resource.node.cordon). "
                "It evicts nothing; draining stays on the screen."
            ),
            "parameters": {
                "type": "object",
                "properties": {
                    "resource_name": {"type": "string", "description": "Node name"},
                    "uncordon": {"type": "boolean", "description": "true lets the node take pods again (default false: cordon)"},
                },
                "required": ["resource_name"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "k8s_cronjob_suspend",
            "description": "Suspend a CronJob or let it run again: the Suspend button of the CronJob window (permission resource.cronjob.suspend). Jobs already running go on.",
            "parameters": {
                "type": "object",
                "properties": {
                    "resource_name": {"type": "string", "description": "CronJob name"},
                    "namespace": {"type": "string", "description": "Namespace of the CronJob"},
                    "suspend": {"type": "boolean", "description": "true suspends it, false lets it run again"},
                },
                "required": ["resource_name", "namespace", "suspend"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "k8s_cronjob_trigger",
            "description": "Run a CronJob now as a new Job, whatever its schedule says: the Run now button of the CronJob window (permission resource.cronjob.trigger). Answers the Job's name.",
            "parameters": {
                "type": "object",
                "properties": {
                    "resource_name": {"type": "string", "description": "CronJob name"},
                    "namespace": {"type": "string", "description": "Namespace of the CronJob"},
                },
                "required": ["resource_name", "namespace"],
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
                "description": """Get a comprehensive overview of the Kubernetes cluster health: the numbers of the Dashboard's cards.

                    Returns:
                    - Total counts: namespaces, pods, services, deployments, PVCs, PVs
                    - Pod status breakdown (Running, Pending, Failed, etc.)
                    - Node count and cluster version
                    A count the user's identity in the cluster may not list is null and its resource is named in
                    "refused": it is not counted, not zero.
                    For a grant limited to namespaces "scoped" is true and the counts are of the grant's "namespaces" only;
                    nodes and PVs, which belong to no namespace, are null and named in "not_counted".
                    {"status":"forbidden"}: the identity may not list namespaces, so no overview is shown, as on the Dashboard.

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
    tools.extend(ADMIN_READ_TOOLS)
    tools.extend(WRITE_PREVIEW_TOOLS)
    tools.extend(ACTION_TOOLS)
    tools.extend(K8S_WRITE_TOOLS)
    return service._filter_tools_by_role(tools)
