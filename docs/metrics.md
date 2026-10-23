**English** | [한국어](ko/metrics.md)

# Console metrics (`/metrics`)

Kubeast exposes **its own** state in the Prometheus text format (these are not the target clusters' metrics — for those, `features.prometheus` is the feature where Kubeast *reads* Prometheus). The five backend services (auth 8004 · ai 8001 · k8s 8002 · session 8003 · tool-server 8086) each serve it as `GET /metrics` on their service port. The gateway does not proxy this path, so it is not visible from outside and only scrapers inside the cluster reach it (with `networkPolicy.enabled`, open it with `metrics.networkPolicy.from`). With `METRICS_ENABLED=false` (chart `metrics.enabled`) it returns 404.

## Metrics

| Name | Type | Labels | Meaning |
|---|---|---|---|
| `kubeast_http_requests_total` | counter | `service`, `method`, `route`, `code` | HTTP requests handled. `route` is the router's **pattern** (`/api/v1/namespaces/{namespace}/pods/{name}`), not the actual path (fixed cardinality). `/metrics`, `/health` and `/` are not counted |
| `kubeast_http_request_duration_seconds` | histogram | same | Request handling time (default buckets). For ai-service streaming responses, the time until the headers |
| `kubeast_http_requests_in_flight` | gauge | `service` | Requests being handled |
| `kubeast_audit_store_up` | gauge 0/1 | `service` | Whether the audit store takes rows (k8s-service: `audit.Guarded.Ready`, 2 s cache). At 0, writes, Secret reveals, exec and AI write tools are refused with 503 |
| `kubeast_audit_write_failures_total` | counter | `service` | Audit rows that could not be stored since start |
| `kubeast_ws_subscriptions` | gauge | `service` | Live WebSocket subscriptions (logs, exec, watch) in k8s-service |
| `kubeast_audit_sink_pending` | gauge | `service`, `sink`, `type` | Audit rows an audit sink (`audit.sinks`) has not sent yet. Only the auth-service replica that does the sending exposes it |
| `kubeast_audit_sink_failures_total` | counter | same | Failed sends since that replica started sending |
| `kubeast_audit_sink_last_success_timestamp_seconds` | gauge | same | When the sink cursor last moved forward (starting from the time sending began) |
| `kubeast_session_recording_pending_bytes` | gauge | `service` | Terminal output bytes recorded but not yet uploaded to the store (`sessionRecording`) |
| `kubeast_session_recording_upload_failures_total` | counter | `service` | Failed recording part uploads since start |
| `kubeast_session_recording_last_upload_timestamp_seconds` | gauge | `service` | When a recording part was last uploaded (starting from the start time) |
| `go_*`, `process_*` / `python_*` | default collectors | | Runtime and process |

`service` = `auth` · `ai` · `k8s` · `session` · `tool-server`. User and cluster IDs are not put in labels (Prometheus instrumentation guidelines: keep label sets small, do not put identifiers in labels).

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
    enabled: true           # five alerts
```

One ServiceMonitor selects the five backend Services labelled `kubeast.io/metrics: "true"`, with port name `http` and path `/metrics`. A Prometheus without the Operator can select the same label with `kubernetes_sd_configs` (role `endpoints`).

## Alerts (`metrics.prometheusRule.enabled`)

| Name | Expression | Meaning |
|---|---|---|
| `KubeastAuditStoreDown` | `min by (service) (kubeast_audit_store_up) == 0` for 2 minutes | The audit DB cannot be used, so audited actions are being refused |
| `KubeastHighErrorRate` | 5xx ratio > `errorRatio` (0.05) for 10 minutes | Console error rate |
| `KubeastSlowRequests` | p95 > `p95Seconds` (2 s) for 10 minutes | Console latency |
| `KubeastAuditSinkStalled` | `kubeast_audit_sink_pending > 0` and the last successful send more than 10 minutes ago, for 5 minutes | Audit sink sending has stopped (errors in the auth-service log; retention keeps the unsent rows) |
| `KubeastSessionRecordingUploadStalled` | `kubeast_session_recording_pending_bytes > 0` and the last upload more than 10 minutes ago, for 5 minutes | Session recording upload has stopped (output piles up in the k8s-service spool; sessions are not blocked) |

Useful expressions: request rate per service `sum by (service) (rate(kubeast_http_requests_total[5m]))` · p95 per route `histogram_quantile(0.95, sum by (route, le) (rate(kubeast_http_request_duration_seconds_bucket{service="k8s"}[5m])))`.

## Check

```bash
kubectl -n kubeast port-forward svc/k8s-service 18002:8002 &
curl -s localhost:18002/metrics | grep -E '^kubeast_'
```
