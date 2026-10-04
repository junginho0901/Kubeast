# 콘솔 메트릭 (`/metrics`)

Kubeast **자신**의 상태를 Prometheus 텍스트 포맷으로 노출한다(대상 클러스터의 메트릭이 아니다 — 그쪽은 `features.prometheus`가 Kubeast에서 Prometheus를 *읽는* 기능). 백엔드 서비스 다섯 개(auth 8004 · ai 8001 · k8s 8002 · session 8003 · tool-server 8086)가 각자 서비스 포트의 `GET /metrics`로 낸다. 게이트웨이는 이 경로를 프록시하지 않으므로 바깥에서는 보이지 않고, 클러스터 안의 스크레이퍼만 닿는다(`networkPolicy.enabled`면 `metrics.networkPolicy.from`으로 열어 준다). `METRICS_ENABLED=false`(차트 `metrics.enabled`)면 404.

## 메트릭

| 이름 | 종류 | 라벨 | 뜻 |
|---|---|---|---|
| `kubeast_http_requests_total` | counter | `service`, `method`, `route`, `code` | 처리한 HTTP 요청 수. `route`는 라우터의 **패턴**(`/api/v1/namespaces/{namespace}/pods/{name}`)이지 실제 경로가 아니다(카디널리티 고정). `/metrics`·`/health`·`/`는 세지 않는다 |
| `kubeast_http_request_duration_seconds` | histogram | 같음 | 요청 처리 시간(기본 버킷). ai-service의 스트리밍 응답은 헤더까지의 시간 |
| `kubeast_http_requests_in_flight` | gauge | `service` | 처리 중인 요청 수 |
| `kubeast_audit_store_up` | gauge 0/1 | `service` | 감사 저장소가 행을 받는지(k8s-service: `audit.Guarded.Ready`, 2 s 캐시). 0이면 쓰기·Secret 열람·exec·AI 쓰기 툴이 503으로 거부된다 |
| `kubeast_audit_write_failures_total` | counter | `service` | 기동 뒤 저장하지 못한 감사 행 수 |
| `kubeast_ws_subscriptions` | gauge | `service` | k8s-service의 살아 있는 WebSocket 구독(로그·exec·watch) 수 |
| `go_*`, `process_*` / `python_*` | 기본 수집기 | | 런타임·프로세스 |

`service` = `auth` · `ai` · `k8s` · `session` · `tool-server`. 사용자·클러스터 id는 라벨에 넣지 않는다(Prometheus 계측 지침: 라벨 집합은 작게, 식별자는 라벨에 두지 않는다).

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
    enabled: true           # 알람 3개
```

ServiceMonitor 하나가 라벨 `kubeast.io/metrics: "true"`가 붙은 백엔드 Service 다섯 개를 포트 이름 `http`, 경로 `/metrics`로 고른다. Operator 없이 쓰는 Prometheus는 `kubernetes_sd_configs`(role `endpoints`)로 같은 라벨을 고르면 된다.

## 알람 (`metrics.prometheusRule.enabled`)

| 이름 | 식 | 뜻 |
|---|---|---|
| `KubeastAuditStoreDown` | `min by (service) (kubeast_audit_store_up) == 0` 2분 | 감사 DB를 못 써 감사 대상 동작이 거부되는 중 |
| `KubeastHighErrorRate` | 5xx 비율 > `errorRatio`(0.05) 10분 | 콘솔 오류율 |
| `KubeastSlowRequests` | p95 > `p95Seconds`(2 s) 10분 | 콘솔 지연 |

쓸 만한 식: 서비스별 요청률 `sum by (service) (rate(kubeast_http_requests_total[5m]))` · 라우트별 p95 `histogram_quantile(0.95, sum by (route, le) (rate(kubeast_http_request_duration_seconds_bucket{service="k8s"}[5m])))`.

## 확인

```bash
kubectl -n kubeast port-forward svc/k8s-service 18002:8002 &
curl -s localhost:18002/metrics | grep -E '^kubeast_'
```
