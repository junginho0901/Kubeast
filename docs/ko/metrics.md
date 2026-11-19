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
| `kubeast_db_pool_connections` | gauge | `service`, `state` | 서비스(auth · ai · k8s · session)의 데이터베이스 풀 연결 수, 긁을 때마다 읽음: `in_use`, `idle`, 그리고 Go 서비스는 `opening`(여는 중). 풀과 따로 연 연결(k8s-service가 클러스터 상태를 쓰는 잠금)은 세지 않고, 풀에서 가져가 쥔 연결(auth-service 감사 싱크의 리더 잠금)은 `in_use`입니다 |
| `kubeast_db_pool_max_connections` | gauge | `service` | 그 풀이 쥘 수 있는 최대 연결 수(`postgresql.pool.<service>.maxConns`) |
| `kubeast_db_pool_empty_acquires_total` | counter | `service` | 기동 뒤 연결을 가져가려다 쉬는 연결이 없어 돌려받거나 새로 열릴 때까지 기다린 수. Go 서비스만 — SQLAlchemy 풀(ai-service)은 이 수를 세지 않습니다 |
| `kubeast_db_pool_empty_acquire_wait_seconds_total` | counter | `service` | 그렇게 기다린 시간의 합, 초(Go 서비스) |
| `kubeast_db_pool_canceled_acquires_total` | counter | `service` | 연결이 오기 전에 요청이 끝나(시간이 다 됨, 호출자가 떠남) 그만둔 가져가기 수(Go 서비스) |
| `kubeast_ws_subscriptions` | gauge | `service` | k8s-service에 살아 있는 watch 수(`multicluster.wsMaxSubscriptions`에 세는 것): 실시간 목록의 WebSocket 구독과 Helm 릴리스 스트림의 Secret watch. 터미널·실시간 로그는 다음 두 줄 |
| `kubeast_terminals_open` | gauge | `service` | k8s-service에 열려 있는 터미널(Pod exec, 노드 셸) 수 |
| `kubeast_followed_logs_open` | gauge | `service` | k8s-service에 열려 있는 실시간 로그(컨테이너 출력, 로그 파일) 수 |
| `kubeast_stream_cap_refusals_total` | counter | `service`, `kind` | 기동 뒤 k8s-service가 계정 상한(`multicluster.maxTerminalsPerAccount`, `maxFollowedLogsPerAccount`)에서 거절한 터미널(`kind="terminal"`)과 실시간 로그(`followed_log`) 수. 거절마다 실패 감사 행도 남습니다. 실시간 로그 거절은 200이라 요청 지표에는 안 보입니다 |
| `kubeast_k8s_client_rate_wait_seconds` | histogram | `service`, `limiter`, `passed_over` | k8s-service가 클러스터 API 서버로 보내는 요청이 보내기 전에 클라이언트 속도를 기다린 시간입니다. 바로 나간 요청은 0이고, 클러스터를 모두 더한 값입니다(버킷 1 ms~60 s). `limiter`는 `user`(클라이언트 속도, `multicluster.clientQPS`·`clientBurst`) 또는 `review`(접근 확인 전용 속도, `multicluster.reviewQPS`를 정했을 때만)입니다. `passed_over`는 다시 묻는 접근 확인이 나중에 온 요청을 먼저 보낸 경우 `true`이며, 그렇게 양보하는 시간은 최대 10초입니다. 기다리다 그만둔 요청도 기다린 시간만큼 셉니다. dynamic 클라이언트(커스텀 리소스, apply)는 client-go의 자체 속도를 쓰므로 세지 않습니다 |
| `kubeast_k8s_client_rate_waits_total` | counter | `service`, `limiter` | 그 속도를 조금이라도 기다린 클러스터 요청 수(차례를 받았든 못 받았든) |
| `kubeast_k8s_access_reviews_total` | counter | `service`, `asked_as` | k8s-service가 1분 기억하는 접근 확인(화면의 list·get 확인)에 보낸 SelfSubjectAccessReview 수, 클러스터를 합친 값. `asked_as`는 `person`, 또는 리뷰 하나로 그 사람의 그룹을 가진 모두에게 답한 읽기 확인이면 `groups`(`auth.impersonation.sharedReadChecks`, [클러스터 요구 사항](cluster-requirements.md) §1). can-i, 로그 검색, 흐름, Top Talkers는 그 사람으로 따로 보내며 여기 세지 않습니다 |
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
    enabled: true           # 알람 5개, 감사 앵커 싱크가 있으면 6개
```

ServiceMonitor 하나가 라벨 `kubeast.io/metrics: "true"`가 붙은 백엔드 Service 다섯 개를 포트 이름 `http`, 경로 `/metrics`로 고릅니다.
Operator 없이 Prometheus를 쓴다면 `kubernetes_sd_configs`(role `endpoints`)로 같은 라벨을 고르면 됩니다.

## 알람 (`metrics.prometheusRule.enabled`)

| 이름 | 식 | 뜻 |
|---|---|---|
| `KubeastAuditStoreDown` | `min by (service) (kubeast_audit_store_up) == 0` 2분 | 감사 DB에 쓸 수 없어 감사 대상 동작을 거부하는 중 |
| `KubeastHighErrorRate` | 5xx 비율 > `errorRatio`(0.05) 10분 | 콘솔 오류율. 데이터베이스 장애가 그보다 길면 로그인한 사람의 읽기만으로도 울립니다. 세션을 읽을 수 없는 요청은 503으로 답하기 때문입니다(0.7.7은 이 알림이 세지 않는 4xx인 401로 답했습니다) |
| `KubeastSlowRequests` | p95 > `p95Seconds`(2 s) 10분 | 콘솔 지연 |
| `KubeastAuditSinkStalled` | `kubeast_audit_sink_pending > 0`이고 마지막 전송 성공 뒤 10분이 넘게 지남, 5분 | 감사 싱크 전송이 멈춤(auth-service 로그에 오류가 남고, 보내지 못한 행은 보존 작업이 지우지 않고 남겨 둠) |
| `KubeastSessionRecordingUploadStalled` | `kubeast_session_recording_pending_bytes > 0`이고 마지막 업로드 뒤 10분이 넘게 지남, 5분 | 세션 녹화 업로드가 멈춤(출력은 k8s-service 스풀에 쌓이고, 세션은 막지 않음) |
| `KubeastAuditAnchorStalled` | `time() - max by (service) (kubeast_audit_anchor_last_timestamp_seconds)`가 `audit.integrity.anchor.hours`의 두 배를 넘음, 30분. `audit.integrity.anchor.sink`가 있을 때만 | 두 주기 동안 감사 앵커가 쓰이지 않음: 쓰기가 실패하거나 앵커 작업이 돌지 않음. 실패한 앵커는 auth-service 로그와 `audit.chain.anchor` 행에 남음([security-audit.md](security-audit.md)) |

자주 쓰는 식:

- 서비스별 요청률 `sum by (service) (rate(kubeast_http_requests_total[5m]))`
- 파드마다 쓰는 데이터베이스 풀 비율 `kubeast_db_pool_connections{state="in_use"} / ignoring(state) kubeast_db_pool_max_connections`. 몇 분째 1에 가깝고 `rate(kubeast_db_pool_empty_acquire_wait_seconds_total[5m])`가 0보다 크면 요청이 연결을 기다리는 중입니다. `postgresql.pool.<service>.maxConns`와 `postgresql.maxConnections`를 보세요
- 라우트별 p95 `histogram_quantile(0.95, sum by (route, le) (rate(kubeast_http_request_duration_seconds_bucket{service="k8s"}[5m])))`
- 클러스터로 가는 클라이언트 속도 대기 p95 `histogram_quantile(0.95, sum by (limiter, le) (rate(kubeast_k8s_client_rate_wait_seconds_bucket[5m])))`. 0에 가까우면 화면을 늦추는 것은 이 속도가 아닙니다. API 서버가 429 없이 답하는데 몇 초씩 나오면 `multicluster.clientQPS`·`clientBurst`(접근 확인이면 `reviewQPS`)를 보세요

## 확인

```bash
kubectl -n kubeast port-forward svc/k8s-service 18002:8002 &
curl -s localhost:18002/metrics | grep -E '^kubeast_'
```
