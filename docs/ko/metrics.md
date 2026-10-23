[English](../metrics.md) | **한국어**

# 콘솔 메트릭 (`/metrics`)

Kubeast **자신**의 상태를 Prometheus 텍스트 포맷으로 노출합니다.
대상 클러스터의 메트릭이 아닙니다 — 그쪽은 Kubeast가 Prometheus를 *읽는* 기능인 `features.prometheus`가 맡습니다.

- 백엔드 서비스 다섯 개(auth 8004 · ai 8001 · k8s 8002 · session 8003 · tool-server 8086)가 각자 서비스 포트의 `GET /metrics`로 내보냅니다.
- 게이트웨이는 이 경로를 프록시하지 않으므로 바깥에서는 보이지 않고, 클러스터 안의 스크레이퍼만 닿습니다(`networkPolicy.enabled`가 켜져 있으면 `metrics.networkPolicy.from`으로 열어 줍니다).
- `METRICS_ENABLED=false`(차트 `metrics.enabled`)이면 404를 돌려줍니다.

## 메트릭

| 이름 | 종류 | 라벨 | 뜻 |
|---|---|---|---|
| `kubeast_http_requests_total` | counter | `service`, `method`, `route`, `code` | 처리한 HTTP 요청 수. `route`에는 실제 경로가 아니라 라우터의 **패턴**(`/api/v1/namespaces/{namespace}/pods/{name}`)이 들어가므로 카디널리티가 고정됩니다. `/metrics`·`/health`·`/`는 세지 않습니다 |
| `kubeast_http_request_duration_seconds` | histogram | 같음 | 요청 처리 시간(기본 버킷). ai-service의 스트리밍 응답은 헤더를 보낼 때까지의 시간입니다 |
| `kubeast_http_requests_in_flight` | gauge | `service` | 처리 중인 요청 수 |
| `kubeast_audit_store_up` | gauge 0/1 | `service` | 감사 저장소가 행을 받을 수 있는지 나타냅니다(k8s-service: `audit.Guarded.Ready`, 2 s 캐시). 0이면 쓰기, Secret 열람, exec, AI 쓰기 툴이 503으로 거부됩니다 |
| `kubeast_audit_write_failures_total` | counter | `service` | 기동 뒤 저장하지 못한 감사 행 수 |
| `kubeast_ws_subscriptions` | gauge | `service` | k8s-service에 살아 있는 WebSocket 구독(로그·exec·watch) 수 |
| `kubeast_audit_sink_pending` | gauge | `service`, `sink`, `type` | 감사 싱크(`audit.sinks`)가 아직 보내지 않은 감사 행 수. 전송을 맡은 auth-service 레플리카만 냅니다 |
| `kubeast_audit_sink_failures_total` | counter | 같음 | 그 레플리카가 전송을 시작한 뒤 실패한 전송 수 |
| `kubeast_audit_sink_last_success_timestamp_seconds` | gauge | 같음 | 싱크 커서가 마지막으로 앞으로 나아간 시각(처음 값은 전송을 시작한 시각) |
| `kubeast_session_recording_pending_bytes` | gauge | `service` | 녹화했지만 아직 저장소에 올리지 못한 터미널 출력 바이트(`sessionRecording`) |
| `kubeast_session_recording_upload_failures_total` | counter | `service` | 기동 뒤 실패한 녹화 조각 업로드 수 |
| `kubeast_session_recording_last_upload_timestamp_seconds` | gauge | `service` | 녹화 조각을 마지막으로 올린 시각(처음 값은 기동 시각) |
| `go_*`, `process_*` / `python_*` | 기본 수집기 | | 런타임·프로세스 |

`service` = `auth` · `ai` · `k8s` · `session` · `tool-server`.
사용자 id와 클러스터 id는 라벨에 넣지 않습니다. Prometheus 계측 지침도 라벨 집합은 작게 두고 식별자는 라벨에 넣지 말라고 권합니다.

## 긁어가기

```yaml
metrics:
  enabled: true
  serviceMonitor:
    enabled: true           # prometheus-operator CRD 필요
    interval: 30s
    labels: {release: monitoring}   # kube-prometheus-stack이 고르는 라벨
  networkPolicy:
    from:
      - namespaceSelector: {matchLabels: {kubernetes.io/metadata.name: monitoring}}
  prometheusRule:
    enabled: true           # 알람 5개
```

ServiceMonitor 하나가 라벨 `kubeast.io/metrics: "true"`가 붙은 백엔드 Service 다섯 개를 포트 이름 `http`, 경로 `/metrics`로 고릅니다.
Operator 없이 Prometheus를 쓴다면 `kubernetes_sd_configs`(role `endpoints`)로 같은 라벨을 고르면 됩니다.

## 알람 (`metrics.prometheusRule.enabled`)

| 이름 | 식 | 뜻 |
|---|---|---|
| `KubeastAuditStoreDown` | `min by (service) (kubeast_audit_store_up) == 0` 2분 | 감사 DB에 쓸 수 없어 감사 대상 동작을 거부하는 중 |
| `KubeastHighErrorRate` | 5xx 비율 > `errorRatio`(0.05) 10분 | 콘솔 오류율 |
| `KubeastSlowRequests` | p95 > `p95Seconds`(2 s) 10분 | 콘솔 지연 |
| `KubeastAuditSinkStalled` | `kubeast_audit_sink_pending > 0`이고 마지막 전송 성공 뒤 10분이 넘게 지남, 5분 | 감사 싱크 전송이 멈춤(auth-service 로그에 오류가 남고, 보내지 못한 행은 보존 작업이 지우지 않고 남겨 둠) |
| `KubeastSessionRecordingUploadStalled` | `kubeast_session_recording_pending_bytes > 0`이고 마지막 업로드 뒤 10분이 넘게 지남, 5분 | 세션 녹화 업로드가 멈춤(출력은 k8s-service 스풀에 쌓이고, 세션은 막지 않음) |

자주 쓰는 식:

- 서비스별 요청률 `sum by (service) (rate(kubeast_http_requests_total[5m]))`
- 라우트별 p95 `histogram_quantile(0.95, sum by (route, le) (rate(kubeast_http_request_duration_seconds_bucket{service="k8s"}[5m])))`

## 확인

```bash
kubectl -n kubeast port-forward svc/k8s-service 18002:8002 &
curl -s localhost:18002/metrics | grep -E '^kubeast_'
```
