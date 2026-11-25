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
| `kubeast_ai_model_requests_total` | counter | `service`, `outcome` | Requests ai-service sent a model provider since start (the chat, the floating assistant, alert investigations, history summaries, the connection test): `outcome` is `ok` when the provider answered (a stream that fails later is still `ok`), else the refusal kind it answered with, `credit`, `rate`, `auth`, `unavailable`, `address` (Kubeast refused the model's address and sent nothing) or `other`. A Claude Code run that never got its slot sent nothing and is not counted (`kubeast_claude_code_busy_total`). No provider or model label |
| `kubeast_ai_investigations_total` | counter | `service`, `outcome` | Alert investigations this ai-service ended since start: `done`, `failed` (a run that failed, also one interrupted twice by a stopping server or past its time limit), or `skipped` (stored skipped by the webhook, or skipped when the worker took it: a cap, the daily budget, a provider pause) |
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
| `kubeast_k8s_client_rate_wait_seconds` | histogram | `service`, `limiter`, `passed_over` | How long a request from k8s-service to a cluster's API server waited for the client's rate before it was sent, 0 when it went at once, summed over clusters (buckets 1 ms to 60 s). `limiter` is `user` (the clients' rate, `multicluster.clientQPS` and `clientBurst`), `review` (the access checks' own rate, only with `multicluster.reviewQPS` set) or `cache` (what k8s-service reads once for everyone as `kubeast:cache` — the overview informers' lists, a node's pods, an object's events, the read of whether a cluster serves metrics.k8s.io (`GET /apis/metrics.k8s.io`); client-go takes no token for a watch — on client-go's token bucket at the same `clientQPS` and `clientBurst`). `passed_over` is `true` for an access check asked again that let a later request go first, at most 10 s; `cache` has no such series. A request that stopped waiting counts the time it waited. The dynamic client (custom resources, applies) keeps client-go's own rate and is not counted |
| `kubeast_k8s_client_rate_waits_total` | counter | `service`, `limiter` | Requests to a cluster that waited for that rate at all, given their turn or not |
| `kubeast_k8s_read_place_wait_seconds` | histogram | `service`, `places` | How long a read of a cluster waited for one of the places for its kind of read, summed over clusters (buckets 1 ms to 60 s; a few microseconds when a place was free). `places` is `node_pods` (each cluster's 16 places of a node's pods read, shared or as the caller — Cluster View's node boxes, the Node drawer), `event_list` (each cluster's `EVENT_LIST_CONCURRENCY`, 4: an object's events read for a drawer) or `big_read` (`multicluster.bigReadConcurrency`, 2, in each k8s-service for all its clusters together: a read of more than one page of pods, ReplicaSets or ControllerRevisions — the timeline's rollouts, the issues, the Resource Graph, the Namespace drawer — takes one before its second page, once, so a read of one page is not counted). A read that stopped waiting counts the time it waited |
| `kubeast_k8s_access_reviews_total` | counter | `service`, `asked_as` | SelfSubjectAccessReviews k8s-service sent for the access checks it remembers for a minute (the screens' list and get checks), summed over clusters. `asked_as` is `person`, or `groups` for a read check one review answered for everyone with the person's groups (`auth.impersonation.sharedReadChecks`, [cluster requirements](cluster-requirements.md) §1). Can-i, the log search, flows and Top Talkers send theirs as the person and are not counted |
| `kubeast_k8s_cluster_breakers_open` | gauge | `service` | Clusters whose breaker is open now: their requests are answered 503 at once, but for one that tries the cluster every `multicluster.breakerOpenSec`. Always 0 with `multicluster.breakerConsecutiveFails` 0 (the breaker off). Each replica holds its own breakers |
| `kubeast_k8s_cluster_breaker_opens_total` | counter | `service`, `by` | Times a cluster's breaker opened since start, summed over clusters. `by` is `requests` (`breakerConsecutiveFails` requests in a row could not reach the cluster) or `health_check` (the probe every `multicluster.healthcheckIntervalSec` failed: it could not reach the cluster, got no answer to its call within 5 s, got an error status from in front of the API server, one without `Audit-ID`, or ended before its call with an error of Kubeast's own such as a credential plugin's; the API server's own error status, a 5xx too, closes the breaker). A breaker already open is not counted again |
| `kubeast_k8s_cluster_breaker_refusals_total` | counter | `service` | Requests answered 503 "currently unreachable" at once by an open breaker since start |
| `kubeast_k8s_node_drains_running` | gauge | `service` | Node drains this replica runs now (`node_drains` rows it owns) |
| `kubeast_k8s_node_drains_holding` | gauge 0/1 | `service` | 1 while this replica's drains hold their evictions: it runs some and has saved no heartbeat of theirs for 15 s (the database does not take it). They go on once a beat is saved, or stop when another replica marked them interrupted meanwhile |
| `kubeast_k8s_node_drains_ended_total` | counter | `service`, `status` | Node drains whose end this replica wrote since start (the finished `k8s.node.drain` row), by `status`: `success`, `error`, or `interrupted` (its own drains at its shutdown, and the drains of a server gone that it found stale) |
| `kubeast_redis_refusals_total` | counter | `service`, `command` | Redis commands k8s-service sent that Redis refused for its user's ACL (`NOPERM`, `redis.acl`), by command, since start. The cache reads such a refusal as a miss and asks the cluster, so the screens work without the cache and nothing else shows it. The log names the command at most once every 10 s. go-redis's own `CLIENT` commands on connect are not counted ([Redis users](configuration.md#redis-users)) |
| `kubeast_shared_writes_without_place_total` | counter | `service` | Node list, node box, Pods page and node map answers and shared reads' answers past 256 KiB whose waits for the 16 write places reached a second in all, so the rest was written without one, since start ([architecture](architecture.md#many-users)). It rises during a crowd larger than the places get through in a second and for a slow reader whose turns add up to a second; rising at quiet times means readers that hold places and do not read |
| `kubeast_shared_write_place_wait_seconds` | histogram | `service`, `places` | How long those answers waited for one of the 16 write places of their k8s-service, each time they took one (buckets 1 ms to 60 s; a few microseconds when a place was free). `places` is `big_write`. A body takes a place before its first part and again after each part that took more than 100 ms and gave its place back, so a slow reader's body is counted more than once. A body's waits share one second from its start; a take that reached it (the rest then goes without a place) counts the time up to it and no more, so no observation passes 1 s (the `le="1"` bucket), and one whose caller left counts the time it waited |
| `kubeast_audit_sink_pending` | gauge | `service`, `sink`, `type` | Audit rows an audit sink (`audit.sinks`) has not sent yet. Only the auth-service replica that does the sending exposes it |
| `kubeast_audit_sink_failures_total` | counter | same | Failed sends since that replica started sending |
| `kubeast_audit_sink_last_success_timestamp_seconds` | gauge | same | When the sink cursor last moved forward (starting from the time sending began) |
| `kubeast_db_pool_connections` | gauge | `service`, `state` | The connections of the service's database pool (auth, ai, k8s, session), read at each scrape: `in_use`, `idle` and, in the Go services, `opening`. A connection opened apart from the pool, as k8s-service's lock for writing the clusters' health, is not counted; one taken from the pool and held, as an audit sink's leader lock in auth-service, is `in_use` |
| `kubeast_db_pool_max_connections` | gauge | `service` | The most connections that pool may hold (`postgresql.pool.<service>.maxConns`) |
| `kubeast_db_pool_empty_acquires_total` | counter | `service` | Takes of a connection that found none idle and waited for one to be given back or opened, since start. Go services only: SQLAlchemy's pool (ai-service) keeps no such count |
| `kubeast_db_pool_empty_acquire_wait_seconds_total` | counter | `service` | Seconds those takes waited, summed (Go services) |
| `kubeast_db_pool_canceled_acquires_total` | counter | `service` | Takes of a connection whose request ended (its time, or the caller gone) before one came (Go services) |
| `kubeast_session_recording_pending_bytes` | gauge | `service` | Terminal output bytes recorded but not yet uploaded to the store (`sessionRecording`) |
| `kubeast_session_recording_upload_failures_total` | counter | `service` | Failed recording part uploads since start |
| `kubeast_session_recording_last_upload_timestamp_seconds` | gauge | `service` | When a recording part was last uploaded (starting from the start time) |
| `kubeast_claude_code_runs` | gauge | `service`, `lane` | Claude Code runs (provider `claude-code`) holding their place in this ai-service now: `lane` `chat` (this server's slots, `AI_CLAUDE_CODE_MAX_CONCURRENT`, and one of the install's, `AI_CLAUDE_CODE_MAX_CONCURRENT_TOTAL`) or `investigation` (the investigator's one place per server). The series appear with the first run |
| `kubeast_claude_code_waiting` | gauge | `service` | Chat runs waiting for their slots now (their chat stream sent `{"queued": true}`) |
| `kubeast_claude_code_slot_wait_seconds` | histogram | `service` | How long a chat run waited for its slots, this server's and the install's, 0 when both were free; a run that ended busy or was stopped while it waited counts the time it waited |
| `kubeast_claude_code_busy_total` | counter | `service` | Chat runs that ended as busy since start: no slot came free within `AI_CLAUDE_CODE_QUEUE_WAIT` (the chat's "Claude Code is busy") |
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
    enabled: true           # five alerts, one more each with the AI on (the default), an audit anchor sink and alert investigations
```

One ServiceMonitor selects the five backend Services labelled `kubeast.io/metrics: "true"`, with port name `http` and path `/metrics`. A Prometheus without the Operator can select the same label with `kubernetes_sd_configs` (role `endpoints`).

## Alerts (`metrics.prometheusRule.enabled`)

| Name | Expression | Meaning |
|---|---|---|
| `KubeastAuditStoreDown` | `min by (service) (kubeast_audit_store_up) == 0` for 2 minutes | The audit DB cannot be used, so audited actions are being refused |
| `KubeastHighErrorRate` | 5xx ratio > `errorRatio` (0.05) for 10 minutes | Console error rate. A database outage longer than that now fires it from signed-in reads alone: a request whose session cannot be read is answered 503, where 0.7.7 answered 401, a 4xx it does not count. A read of a cluster whose API server does not start its answer within 20 s is a 503 of k8s-service too, so people keeping the screens of one cut-off cluster open can fire it alone |
| `KubeastSlowRequests` | p95 > `p95Seconds` (2 s) for 10 minutes | Console latency |
| `KubeastAuditSinkStalled` | `kubeast_audit_sink_pending > 0` and the last successful send more than 10 minutes ago, for 5 minutes | Audit sink sending has stopped (errors in the auth-service log; retention keeps the unsent rows) |
| `KubeastSessionRecordingUploadStalled` | `kubeast_session_recording_pending_bytes > 0` and the last upload more than 10 minutes ago, for 5 minutes | Session recording upload has stopped (output piles up in the k8s-service spool; sessions are not blocked) |
| `KubeastAuditAnchorStalled` | `time() - max by (service) (kubeast_audit_anchor_last_timestamp_seconds)` above twice `audit.integrity.anchor.hours`, for 30 minutes. Only with `audit.integrity.anchor.sink` set | No audit anchor has been written for two periods: the writes fail, or the anchor job does not run. A failed anchor is in the auth-service log and an `audit.chain.anchor` row ([security-audit.md](security-audit.md)) |
| `KubeastAIModelUnreachable` | `kubeast_ai_model_requests_total` over 10 minutes: 3 or more not `ok` and none `ok`, for 10 minutes. Only with `ai.enabled` | No request to a model provider was answered: a key or token that expired, no credit, the provider down, or its address left out (`networkPolicy.aiEgress`). The `outcome` label says which; chats end with the model's error and alert investigations fail |
| `KubeastAIInvestigationsFailing` | `kubeast_ai_investigations_total` over 1 hour: 3 or more `failed`, more than half of `done` and `failed`, for 15 minutes. Only with `features.alertInvestigation.enabled` | Most alert investigations fail. Admin → Investigations shows each one's error; `skipped` ones are not counted |

Useful expressions:

- Request rate per service: `sum by (service) (rate(kubeast_http_requests_total[5m]))`
- Share of each pod's database pool in use: `kubeast_db_pool_connections{state="in_use"} / ignoring(state) kubeast_db_pool_max_connections`. Near 1 for minutes, with `rate(kubeast_db_pool_empty_acquire_wait_seconds_total[5m])` above 0, requests wait for a connection: see `postgresql.pool.<service>.maxConns` and `postgresql.maxConnections`
- p95 per route: `histogram_quantile(0.95, sum by (route, le) (rate(kubeast_http_request_duration_seconds_bucket{service="k8s"}[5m])))`
- p95 wait for a write place of the big shared answers: `histogram_quantile(0.95, sum by (le) (rate(kubeast_shared_write_place_wait_seconds_bucket[5m])))`. Near 0 the write places do not slow the node list, the node boxes, the Pods page, the node map or the shared reads; a body's waits stop a second after it began, and the rest of it goes without a place (`kubeast_shared_writes_without_place_total`)
- p95 wait for the client's rate to the clusters: `histogram_quantile(0.95, sum by (limiter, le) (rate(kubeast_k8s_client_rate_wait_seconds_bucket[5m])))`. Near 0 the rate is not what slows the screens; seconds while the API server answers without 429 point at `multicluster.clientQPS` and `clientBurst` (or `reviewQPS` for the access checks)
- p95 wait for a cluster's read places: `histogram_quantile(0.95, sum by (places, le) (rate(kubeast_k8s_read_place_wait_seconds_bucket[5m])))`. Seconds for `node_pods` while `limiter="cache"` waits near 0 mean the places, not the rate, set the pace of the node boxes
- Big reads waiting for a place, per second: `sum(rate(kubeast_k8s_read_place_wait_seconds_count{places="big_read"}[5m])) - sum(rate(kubeast_k8s_read_place_wait_seconds_bucket{places="big_read",le="0.001"}[5m]))`. Above 0 while `limiter="user"` waits near 0, the timeline and the other paged reads wait for `multicluster.bigReadConcurrency`, which holds k8s-service's memory, not for the API server

## Check

```bash
kubectl -n kubeast port-forward svc/k8s-service 18002:8002 &
curl -s localhost:18002/metrics | grep -E '^kubeast_'
```
