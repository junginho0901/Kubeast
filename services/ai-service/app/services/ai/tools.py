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
                "inhibition). The rule behind an alert (expression, threshold) is prometheus_rules. unavailable = no alert store here."
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
                },
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
                "rows — each with namespace, kind, name, policy, rule, result, severity, message — filtered by namespace, policy, kind, "
                "results (e.g. fail,warn), severities (e.g. high,critical) or a search text, up to limit rows (max 200). Use it for "
                "\"which workloads violate policy X\", \"what fails in namespace Y\" or a compliance overview. {\"status\":\"unavailable\"} means the "
                "cluster has no PolicyReport source. Only offered where the policy reports feature is on and the user may read them."
            ),
            "parameters": {
                "type": "object",
                "properties": {
                    "view": {"type": "string", "description": "summary (default) or results"},
                    "namespace": {"type": "string", "description": "Only this namespace"},
                    "policy": {"type": "string", "description": "results: only this policy"},
                    "kind": {"type": "string", "description": "results: only objects of this kind (Pod, Deployment …)"},
                    "results": {"type": "string", "description": "results: comma-separated result kinds to keep: pass,fail,warn,error,skip (default all)"},
                    "severities": {"type": "string", "description": "results: comma-separated severities to keep, e.g. critical,high"},
                    "search": {"type": "string", "description": "results: text to match in object name, policy or message"},
                    "limit": {"type": "integer", "description": "results: maximum rows (default 100, max 200)"},
                },
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "helm_read",
            "description": (
                "Read Helm releases — never change them (upgrades, rollbacks and uninstalls go through helm_execute and the approval card). "
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
                "the cluster's currency, plus the hours the cost covers. namespace narrows to one namespace. Use it for \"what does namespace X cost\", "
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
                "non-core API (apps, batch, networking.k8s.io); namespace for a namespaced check (empty = cluster scope). Returns allowed true/false. "
                "Use it before suggesting an action the user may not be allowed to do, or to explain a 403."
            ),
            "parameters": {
                "type": "object",
                "properties": {
                    "verb": {"type": "string", "description": "Kubernetes verb, e.g. delete"},
                    "resource": {"type": "string", "description": "Plural resource type, e.g. pods"},
                    "group": {"type": "string", "description": "API group, e.g. apps (empty for core)"},
                    "namespace": {"type": "string", "description": "Namespace (empty = cluster scope)"},
                },
                "required": ["verb", "resource"],
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

# Read tools for Admin only: offered when the token holds the permission k8s-service asks for
# (app/services/ai/features.py REQUIRED_PERMISSIONS). Not part of the Read role's seed.
ADMIN_READ_TOOLS: List[Dict] = [
    {
        "type": "function",
        "function": {
            "name": "hygiene",
            "description": (
                "The cluster hygiene report (Admin → Cluster hygiene; permission admin.hygiene.read): Pod Security Standards level per namespace, "
                "containers running as root or privileged, images by mutable tag (latest), TLS certificates about to expire, deprecated APIs and "
                "other upgrade-readiness checks against the next Kubernetes minor, with counts per severity, the list of checks and the findings "
                "(check, severity, kind, namespace, name, message, exempt). Filter with severity (critical, warning, info) or check (one check's id). "
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
    tools.extend(ADMIN_READ_TOOLS)
    tools.extend(WRITE_PREVIEW_TOOLS)
    tools.extend(K8S_WRITE_TOOLS)
    return service._filter_tools_by_role(tools)
