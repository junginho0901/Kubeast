**English** | [한국어](ko/metrics.md)

# Console metrics (`/metrics`)

Kubeast exposes **its own** state in the Prometheus text format.
These are not the target clusters' metrics. For those, `features.prometheus` is the feature where Kubeast *reads* Prometheus.

Each of the five backend services serves it as `GET /metrics` on its service port:

- auth 8004
- ai 8001
- k8s 8002
- session 8003
- tool-server 8086

The gateway does not proxy this path, so it is not visible from outside, and only scrapers inside the cluster reach it.
With `networkPolicy.enabled`, open it with `metrics.networkPolicy.from`.
With `METRICS_ENABLED=false` (chart `metrics.enabled`), it returns 404.

## Metrics

| Name | Type | Labels | Meaning |
|---|---|---|---|
| `kubeast_http_requests_total` | counter | `service`, `method`, `route`, `code` | HTTP requests handled. `route` is the router's **pattern** (`/api/v1/namespaces/{namespace}/pods/{name}`), not the actual path (fixed cardinality). `/metrics` and the probe paths are not counted: `/health`, `/`, `/livez`, `/readyz` and ai-service's `/api/v1/ai/health`, which the kubelet asks every few seconds and would otherwise fill the denominator of `KubeastHighErrorRate` and `KubeastSlowRequests` |
| `kubeast_http_request_duration_seconds` | histogram | same | Request handling time (default buckets). For ai-service streaming responses, the time until the headers |
| `kubeast_http_requests_in_flight` | gauge | `service` | Requests being handled |
| `kubeast_audit_store_up` | gauge 0/1 | `service` | Whether the audit store takes rows (k8s-service: `audit.Guarded.Ready`, 2 s cache). At 0, writes, Secret reveals, exec and AI write tools are refused with 503 |
| `kubeast_audit_write_failures_total` | counter | `service` | Audit rows that could not be stored since start |
| `kubeast_ws_subscriptions` | gauge | `service` | Live watches in k8s-service, counted against `multicluster.wsMaxSubscriptions`: the live lists' WebSocket subscriptions and the Helm releases streams' Secret watches. Terminals and followed logs are the next two rows after the watches' waits |
| `kubeast_ws_watch_place_wait_seconds` | histogram | `service`, `places` | How long a watch in k8s-service waited for one of its places before it started, summed over clusters (buckets 1 ms to 60 s; a few microseconds when one was free). `places` is `start` (one of its cluster's places for starting a watch, `multicluster.wsWatchStartConcurrency`; the Helm releases streams' Secret watches take them too) or `opening` (one of the server's places for the objects a watch from no version opens with, `multicluster.wsWatchOpeningConcurrency`). A watch that stopped waiting counts the time it waited |
| `kubeast_ws_watches_waiting_for_place` | gauge | `service`, `places` | Watches waiting for one of those places now. A wait past 10 s is told to the page, whose list does not follow meanwhile |
| `kubeast_ws_watch_memory_waits_total` | counter | `service` | New watches told to wait because k8s-service was short of memory (the memory held against the collector's limit past 80 % of it; the limit frame with `limit_scope` `memory`, which the page asks again after). The log says so at most once every 10 s, with how many were told and the memory held |
| `kubeast_terminals_open` | gauge | `service` | Open terminals (pod exec, node shell) in k8s-service |
| `kubeast_followed_logs_open` | gauge | `service` | Open followed logs (a container's output, a log file) in k8s-service |
| `kubeast_stream_server_cap_refusals_total` | counter | `service`, `kind` | Terminals (`kind="terminal"`) and followed logs (`followed_log`) k8s-service refused at its own cap since start (`multicluster.maxStreamsPerServer`, every account's together, which the sum of the two rows above follows); each also leaves a failed audit row. One refused at its account's cap counts in the next row instead |
| `kubeast_stream_cap_refusals_total` | counter | `service`, `kind` | Terminals (`kind="terminal"`) and followed logs (`followed_log`) k8s-service refused at their account's cap since start (`multicluster.maxTerminalsPerAccount`, `maxFollowedLogsPerAccount`); each also leaves a failed audit row. A followed log's refusal is a 200, so request metrics do not show it |
| `kubeast_k8s_client_rate_wait_seconds` | histogram | `service`, `limiter`, `passed_over` | How long a request from k8s-service to a cluster's API server waited for the client's rate before it was sent, 0 when it went at once, summed over clusters (buckets 1 ms to 60 s). `limiter` is `user` (the clients' rate, `multicluster.clientQPS` and `clientBurst`) or `review` (the access checks' own rate, only with `multicluster.reviewQPS` set). `passed_over` is `true` for an access check asked again that let a later request go first, at most 10 s. A request that stopped waiting counts the time it waited. The dynamic client (custom resources, applies) keeps client-go's own rate and is not counted |
| `kubeast_k8s_client_rate_waits_total` | counter | `service`, `limiter` | Requests to a cluster that waited for that rate at all, given their turn or not |
| `kubeast_k8s_access_reviews_total` | counter | `service`, `asked_as` | SelfSubjectAccessReviews k8s-service sent for the access checks it remembers for a minute (the screens' list and get checks), summed over clusters. `asked_as` is `person`, or `groups` for a read check one review answered for everyone with the person's groups (`auth.impersonation.sharedReadChecks`, [cluster requirements](cluster-requirements.md) §1). Can-i, the log search, flows and Top Talkers send theirs as the person and are not counted |
| `kubeast_k8s_cluster_breakers_open` | gauge | `service` | Clusters whose breaker is open now: their requests are answered 503 at once, but for one that tries the cluster every `multicluster.breakerOpenSec`. Always 0 with `multicluster.breakerConsecutiveFails` 0 (the breaker off). Each replica holds its own breakers |
| `kubeast_k8s_cluster_breaker_opens_total` | counter | `service`, `by` | Times a cluster's breaker opened since start, summed over clusters. `by` is `requests` (`breakerConsecutiveFails` requests in a row could not reach the cluster) or `health_check` (the probe every `multicluster.healthcheckIntervalSec` could not, or got a 5xx). A breaker already open is not counted again |
| `kubeast_k8s_cluster_breaker_refusals_total` | counter | `service` | Requests answered 503 "currently unreachable" at once by an open breaker since start |
| `kubeast_k8s_node_drains_running` | gauge | `service` | Node drains this replica runs now (`node_drains` rows it owns) |
| `kubeast_k8s_node_drains_holding` | gauge 0/1 | `service` | 1 while this replica's drains hold their evictions: it runs some and has saved no heartbeat of theirs for 15 s (the database does not take it). They go on once a beat is saved, or stop when another replica marked them interrupted meanwhile |
| `kubeast_k8s_node_drains_ended_total` | counter | `service`, `status` | Node drains whose end this replica wrote since start (the finished `k8s.node.drain` row), by `status`: `success`, `error`, or `interrupted` (its own drains at its shutdown, and the drains of a server gone that it found stale) |
| `kubeast_redis_refusals_total` | counter | `service`, `command` | Redis commands k8s-service sent that Redis refused for its user's ACL (`NOPERM`, `redis.acl`), by command, since start. The cache reads such a refusal as a miss and asks the cluster, so the screens work without the cache and nothing else shows it. The log names the command at most once every 10 s ([Redis users](configuration.md#redis-users)) |
| `kubeast_shared_writes_without_place_total` | counter | `service` | Node list and node box answers and shared reads' answers past 256 KiB whose waits for the 16 write places reached a second in all, so the rest was written without one, since start ([architecture](architecture.md#many-users)). It rises during a crowd larger than the places get through in a second and for a slow reader whose turns add up to a second; rising at quiet times means readers that hold places and do not read |
| `kubeast_audit_sink_pending` | gauge | `service`, `sink`, `type` | Audit rows an audit sink (`audit.sinks`) has not sent yet. Only the auth-service replica that does the sending exposes it |
| `kubeast_audit_sink_failures_total` | counter | same | Failed sends since that replica started sending |
| `kubeast_audit_sink_last_success_timestamp_seconds` | gauge | same | When the sink cursor last moved forward (starting from the time sending began) |
| `kubeast_session_recording_pending_bytes` | gauge | `service` | Terminal output bytes recorded but not yet uploaded to the store (`sessionRecording`) |
| `kubeast_session_recording_upload_failures_total` | counter | `service` | Failed recording part uploads since start |
| `kubeast_session_recording_last_upload_timestamp_seconds` | gauge | `service` | When a recording part was last uploaded (starting from the start time) |
| `go_*`, `process_*` / `python_*` | default collectors | | Runtime and process |

`service` is one of `auth`, `ai`, `k8s`, `session` and `tool-server`.
User and cluster IDs are not put in labels. This follows the Prometheus instrumentation guidelines: keep label sets small, and do not put identifiers in labels.

## Scraping

```yaml
metrics:
  enabled: true
  serviceMonitor:
    enabled: true           # needs the prometheus-operator CRD
    interval: 30s
    labels: {release: monitoring}   # the label kube-prometheus-stack selects
  networkPolicy:
    from:
      - namespaceSelector: {matchLabels: {kubernetes.io/metadata.name: monitoring}}
  prometheusRule:
    enabled: true           # five alerts, six with an audit anchor sink
```

One ServiceMonitor selects the five backend Services labelled `kubeast.io/metrics: "true"`, with port name `http` and path `/metrics`. A Prometheus without the Operator can select the same label with `kubernetes_sd_configs` (role `endpoints`).

## Alerts (`metrics.prometheusRule.enabled`)

| Name | Expression | Meaning |
|---|---|---|
| `KubeastAuditStoreDown` | `min by (service) (kubeast_audit_store_up) == 0` for 2 minutes | The audit DB cannot be used, so audited actions are being refused |
| `KubeastHighErrorRate` | 5xx ratio > `errorRatio` (0.05) for 10 minutes | Console error rate. A database outage longer than that now fires it from signed-in reads alone: a request whose session cannot be read is answered 503, where 0.7.7 answered 401, a 4xx it does not count |
| `KubeastSlowRequests` | p95 > `p95Seconds` (2 s) for 10 minutes | Console latency |
| `KubeastAuditSinkStalled` | `kubeast_audit_sink_pending > 0` and the last successful send more than 10 minutes ago, for 5 minutes | Audit sink sending has stopped (errors in the auth-service log; retention keeps the unsent rows) |
| `KubeastSessionRecordingUploadStalled` | `kubeast_session_recording_pending_bytes > 0` and the last upload more than 10 minutes ago, for 5 minutes | Session recording upload has stopped (output piles up in the k8s-service spool; sessions are not blocked) |
| `KubeastAuditAnchorStalled` | `time() - max by (service) (kubeast_audit_anchor_last_timestamp_seconds)` above twice `audit.integrity.anchor.hours`, for 30 minutes. Only with `audit.integrity.anchor.sink` set | No audit anchor has been written for two periods: the writes fail, or the anchor job does not run. A failed anchor is in the auth-service log and an `audit.chain.anchor` row ([security-audit.md](security-audit.md)) |

Useful expressions:

- Request rate per service: `sum by (service) (rate(kubeast_http_requests_total[5m]))`
- p95 per route: `histogram_quantile(0.95, sum by (route, le) (rate(kubeast_http_request_duration_seconds_bucket{service="k8s"}[5m])))`
- p95 wait for the client's rate to the clusters: `histogram_quantile(0.95, sum by (limiter, le) (rate(kubeast_k8s_client_rate_wait_seconds_bucket[5m])))`. Near 0 the rate is not what slows the screens; seconds while the API server answers without 429 point at `multicluster.clientQPS` and `clientBurst` (or `reviewQPS` for the access checks)

## Check

```bash
kubectl -n kubeast port-forward svc/k8s-service 18002:8002 &
curl -s localhost:18002/metrics | grep -E '^kubeast_'
```
