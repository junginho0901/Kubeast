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
| `kubeast_http_requests_total` | counter | `service`, `method`, `route`, `code` | 처리한 HTTP 요청 수. `route`에는 실제 경로가 아니라 라우터의 **패턴**(`/api/v1/namespaces/{namespace}/pods/{name}`)이 들어가므로 카디널리티가 고정됩니다. `/metrics`와 확인(probe) 경로는 세지 않습니다: `/health`·`/`·`/livez`·`/readyz`와 ai-service의 `/api/v1/ai/health`입니다. kubelet이 몇 초마다 묻는 경로라, 세면 `KubeastHighErrorRate`·`KubeastSlowRequests`의 분모를 채웁니다. `code`는 서비스가 쓴 상태 코드이며, Go 서비스(auth, k8s, session, tool-server)에 예외가 하나 있습니다. 클라이언트가 이미 떠났고 요청이 시작된 지 5초가 안 됐을 때 쓴 500은 `499`로 셉니다. 게이트웨이 액세스 로그가 이때 적는 코드이며, 클라이언트가 떠나서 그 읽기도 함께 끊긴 것입니다(화면을 닫거나 새로 고침, 채팅을 멈춰 도구 호출도 함께 끝남, 게이트웨이 파드 종료). 499를 답으로 보내지는 않습니다. 그 5초 안에 사람이 새로 고치는 사이에 난 진짜 실패는 이것들과 구분할 수 없어 역시 `499`입니다. 기다리다 그만둔 클라이언트도 서비스에는 똑같이 보이므로(콘솔은 10초 이상, 게이트웨이는 60초 이상 기다린 뒤에 그만둡니다) 시작한 지 5초가 지나 쓴 500은 `500`으로 남고, 클라이언트가 있을 때 쓴 500도 그대로입니다. 다른 상태 코드는 모두 그대로 셉니다 |
| `kubeast_http_request_duration_seconds` | histogram | 같음 | 요청 처리 시간(기본 버킷). ai-service의 스트리밍 응답은 헤더를 보낼 때까지의 시간입니다 |
| `kubeast_http_requests_in_flight` | gauge | `service` | 처리 중인 요청 수 |
| `kubeast_ai_model_requests_total` | counter | `service`, `outcome` | 기동 뒤 ai-service가 모델 제공자에 보낸 요청 수(채팅, 떠 있는 도우미, 알림 조사, 대화 요약, 연결 시험). `outcome`은 제공자가 답했으면 `ok`(나중에 끊긴 스트림도 `ok`), 아니면 받은 거절의 종류 `credit`, `rate`, `auth`, `unavailable`, `address`(Kubeast가 모델 주소를 거절해 보내지 않음), `other`입니다. 자리를 받지 못한 Claude Code 실행은 아무것도 보내지 않았으므로 세지 않습니다(`kubeast_claude_code_busy_total`). 제공자 · 모델 라벨은 없습니다 |
| `kubeast_ai_investigations_total` | counter | `service`, `outcome` | 기동 뒤 이 ai-service가 끝낸 알림 조사 수: `done`, `failed`(실패한 실행, 그리고 멈추는 서버에 두 번 끊겼거나 시간 한도를 넘긴 것), `skipped`(웹훅이 건너뜀으로 저장했거나 작업자가 꺼낼 때 건너뜀 — 상한, 하루 예산, 제공자 멈춤) |
| `kubeast_audit_store_up` | gauge 0/1 | `service` | 감사 저장소가 행을 받을 수 있는지 나타냅니다(k8s-service: `audit.Guarded.Ready`, 2 s 캐시). 0이면 쓰기, Secret 열람, exec, AI 쓰기 툴이 503으로 거부됩니다 |
| `kubeast_audit_write_failures_total` | counter | `service` | 기동 뒤 저장하지 못한 감사 행 수 |
| `kubeast_ws_subscriptions` | gauge | `service` | k8s-service에 살아 있는 watch 수(`multicluster.wsMaxSubscriptions`에 세는 것): 실시간 목록의 WebSocket 구독과 Helm 릴리스 스트림의 Secret watch. 터미널·실시간 로그는 watch 기다림 줄 다음 두 줄 |
| `kubeast_ws_watch_place_wait_seconds` | histogram | `service`, `places` | k8s-service의 watch가 시작하기 전에 자기 자리 하나를 기다린 시간, 클러스터를 모두 더한 값(버킷 1 ms~60 s, 자리가 비어 있으면 몇 마이크로초). `places`는 `start`(그 클러스터의 watch 시작 자리, `multicluster.wsWatchStartConcurrency` — Helm 릴리스 스트림의 Secret watch도 씀) 또는 `opening`(버전 없이 여는 watch가 처음 받는 객체를 위한 서버의 자리, `multicluster.wsWatchOpeningConcurrency`)입니다. 기다리다 그만둔 watch도 기다린 시간만큼 셉니다 |
| `kubeast_ws_watches_waiting_for_place` | gauge | `service`, `places` | 지금 그 자리를 기다리는 watch 수. 10초 넘는 기다림은 화면에 알리고, 그동안 그 목록은 따라가지 않습니다 |
| `kubeast_ws_watch_memory_waits_total` | counter | `service` | k8s-service의 메모리가 모자라 기다리라고 한 새 watch 수(수집기 한도에 대해 쥔 메모리가 그 80 %를 넘음 — `limit_scope` `memory`의 한도 프레임, 화면이 잠시 뒤 다시 요청함). 로그에는 10초에 한 번까지, 그동안 기다리라고 한 수와 쥔 메모리를 적습니다 |
| `kubeast_terminals_open` | gauge | `service` | k8s-service에 열려 있는 터미널(Pod exec, 노드 셸) 수 |
| `kubeast_followed_logs_open` | gauge | `service` | k8s-service에 열려 있는 실시간 로그(컨테이너 출력, 로그 파일) 수 |
| `kubeast_stream_server_cap_refusals_total` | counter | `service`, `kind` | 기동 뒤 k8s-service가 자기 상한(`multicluster.maxStreamsPerServer`, 모든 계정을 합친 수이며 위 두 줄의 합이 그 수를 따라감)에서 거절한 터미널(`kind="terminal"`)과 실시간 로그(`followed_log`) 수. 거절마다 실패 감사 행도 남습니다. 계정 상한에서 거절한 것은 다음 줄에 셉니다 |
| `kubeast_stream_cap_refusals_total` | counter | `service`, `kind` | 기동 뒤 k8s-service가 계정 상한(`multicluster.maxTerminalsPerAccount`, `maxFollowedLogsPerAccount`)에서 거절한 터미널(`kind="terminal"`)과 실시간 로그(`followed_log`) 수. 거절마다 실패 감사 행도 남습니다. 실시간 로그 거절은 200이라 요청 지표에는 안 보입니다 |
| `kubeast_k8s_client_rate_wait_seconds` | histogram | `service`, `limiter`, `passed_over` | k8s-service가 클러스터 API 서버로 보내는 요청이 보내기 전에 클라이언트 속도를 기다린 시간입니다. 바로 나간 요청은 0이고, 클러스터를 모두 더한 값입니다(버킷 1 ms~60 s). `limiter`는 `user`(클라이언트 속도, `multicluster.clientQPS`·`clientBurst`), `review`(접근 확인 전용 속도, `multicluster.reviewQPS`를 정했을 때만) 또는 `cache`(k8s-service가 모두의 몫으로 한 번 `kubeast:cache`로 읽는 것 — 개요 informer의 목록, 노드의 파드, 객체의 이벤트, 클러스터가 metrics.k8s.io를 제공하는지 읽기(`GET /apis/metrics.k8s.io`). client-go는 watch에는 토큰을 쓰지 않음 — 가 같은 `clientQPS`·`clientBurst`의 client-go 토큰 통에서 기다린 시간)입니다. `passed_over`는 다시 묻는 접근 확인이 나중에 온 요청을 먼저 보낸 경우 `true`이며, 그렇게 양보하는 시간은 최대 10초입니다. `cache`에는 이 계열이 없습니다. 기다리다 그만둔 요청도 기다린 시간만큼 셉니다. dynamic 클라이언트(커스텀 리소스, apply)는 client-go의 자체 속도를 쓰므로 세지 않습니다 |
| `kubeast_k8s_client_rate_waits_total` | counter | `service`, `limiter` | 그 속도를 조금이라도 기다린 클러스터 요청 수(차례를 받았든 못 받았든) |
| `kubeast_k8s_read_place_wait_seconds` | histogram | `service`, `places` | 클러스터 읽기가 같은 종류 읽기 자리 하나를 기다린 시간입니다. 클러스터를 모두 더한 값입니다(버킷 1 ms~60 s, 자리가 비어 있으면 몇 마이크로초). `places`는 `node_pods`(클러스터마다 노드의 파드 읽기 자리 16개, 모두의 몫이든 호출자로든 — Cluster View 노드 상자, 노드 서랍), `event_list`(클러스터마다 `EVENT_LIST_CONCURRENCY`, 4: 서랍이 읽는 객체 이벤트) 또는 `big_read`(`multicluster.bigReadConcurrency`, 2, k8s-service마다 모든 클러스터를 합쳐: 파드, ReplicaSet, ControllerRevision을 여러 쪽 읽는 읽기 — 타임라인의 롤아웃, 이슈, Resource Graph, Namespace 서랍 — 가 둘째 쪽 전에 한 번 받으므로 한 쪽 읽기는 세지 않음)입니다. 기다리다 그만둔 읽기도 기다린 시간만큼 셉니다 |
| `kubeast_k8s_access_reviews_total` | counter | `service`, `asked_as` | k8s-service가 1분 기억하는 접근 확인(화면의 list·get 확인)에 보낸 SelfSubjectAccessReview 수, 클러스터를 합친 값. `asked_as`는 `person`, 또는 리뷰 하나로 그 사람의 그룹을 가진 모두에게 답한 읽기 확인이면 `groups`(`auth.impersonation.sharedReadChecks`, [클러스터 요구 사항](cluster-requirements.md) §1). can-i, 로그 검색, 흐름, Top Talkers는 그 사람으로 따로 보내며 여기 세지 않습니다 |
| `kubeast_k8s_cluster_breakers_open` | gauge | `service` | 지금 차단기가 열린 클러스터 수. 그 클러스터로 가는 요청은 바로 503으로 답하고, `multicluster.breakerOpenSec`마다 하나만 클러스터를 시험합니다. `multicluster.breakerConsecutiveFails` 0(차단기 끔)이면 늘 0입니다. 레플리카마다 자기 차단기를 따로 둡니다 |
| `kubeast_k8s_cluster_breaker_opens_total` | counter | `service`, `by` | 기동 뒤 클러스터 차단기가 열린 횟수, 클러스터를 합친 값. `by`는 `requests`(`breakerConsecutiveFails`개 요청이 연달아 클러스터에 닿지 못함) 또는 `health_check`(`multicluster.healthcheckIntervalSec`마다 하는 확인이 실패함: 클러스터에 닿지 못했거나, 보낸 호출에 5초 안에 답이 없거나, API 서버 앞에서 온 오류 상태, 곧 `Audit-ID` 없는 오류 상태를 받았거나, 자격 플러그인 오류처럼 호출 전에 난 Kubeast 자신의 오류로 끝남. API 서버 자신의 오류 상태는 5xx라도 차단기를 닫음)입니다. 이미 열린 차단기는 다시 세지 않습니다 |
| `kubeast_k8s_cluster_breaker_refusals_total` | counter | `service` | 기동 뒤 열린 차단기가 바로 503 "currently unreachable"로 답한 요청 수 |
| `kubeast_k8s_node_drains_running` | gauge | `service` | 이 레플리카가 지금 돌리는 노드 드레인 수(자기가 주인인 `node_drains` 행) |
| `kubeast_k8s_node_drains_holding` | gauge 0/1 | `service` | 이 레플리카의 드레인이 쫓아내기를 멈추고 있으면 1: 드레인을 돌리는데 15초 동안 생존 신호를 저장하지 못함(데이터베이스가 받지 않음). 생존 신호가 다시 저장되면 이어 가고, 그사이 다른 레플리카가 중단 표시를 했으면 멈춥니다 |
| `kubeast_k8s_node_drains_ended_total` | counter | `service`, `status` | 기동 뒤 이 레플리카가 끝을 적은 노드 드레인 수(끝 `k8s.node.drain` 행), `status`별: `success`, `error`, `interrupted`(자기가 내려갈 때의 자기 드레인과, 낡은 행으로 찾은 사라진 서버의 드레인) |
| `kubeast_redis_refusals_total` | counter | `service`, `command` | 기동 뒤 k8s-service가 보낸 Redis 명령 가운데 Redis가 그 사용자의 ACL로 거절한 수(`NOPERM`, `redis.acl`), 명령별. 캐시는 이 거절을 없는 항목으로 읽고 클러스터에 물으므로 화면은 캐시 없이 돌고 다른 데에는 드러나지 않습니다. 로그에는 10초에 한 번까지 그 명령을 적습니다. go-redis가 연결할 때 스스로 보내는 `CLIENT`는 세지 않습니다([Redis 사용자](configuration.md#redis-사용자)) |
| `kubeast_shared_writes_without_place_total` | counter | `service` | 256 KiB 넘는 노드 목록 · 노드 칸 · Pods 화면 · 노드 지도 답과 묶인 읽기 답 가운데 쓰기 자리 16개를 기다린 시간이 합쳐 1초에 닿아 남은 본문을 자리 없이 쓴 수, 시작한 뒤로([아키텍처](architecture.md)). 자리가 1초 안에 내보낼 수 있는 것보다 큰 몰림 때와, 차례 기다림이 합쳐 1초가 된 느린 읽는 이 때 오릅니다. 조용할 때 오르면 자리를 쥔 채 읽지 않는 읽는 이가 있다는 뜻입니다 |
| `kubeast_shared_write_place_wait_seconds` | histogram | `service`, `places` | 그 답이 자기 k8s-service의 쓰기 자리 16개 중 하나를 받을 때마다 기다린 시간입니다(버킷 1 ms~60 s, 자리가 비어 있으면 몇 마이크로초). `places`는 `big_write`입니다. 본문은 첫 덩어리 전에 자리를 받고, 100 ms를 넘게 걸려 자리를 내놓은 덩어리 뒤마다 다시 받으므로 느린 읽는 이의 본문은 여러 번 셉니다. 본문 하나의 기다림은 시작부터 1초를 함께 쓰며, 거기 닿은 받기(남은 것은 자리 없이 씀)는 그 1초까지만 세어 한 관측이 1초를 넘지 않고(`le="1"` 칸), 요청이 떠난 받기는 기다린 시간만큼 셉니다 |
| `kubeast_audit_sink_pending` | gauge | `service`, `sink`, `type` | 감사 싱크(`audit.sinks`)가 아직 보내지 않은 감사 행 수. 전송을 맡은 auth-service 레플리카만 냅니다 |
| `kubeast_audit_sink_failures_total` | counter | 같음 | 그 레플리카가 전송을 시작한 뒤 실패한 전송 수 |
| `kubeast_audit_sink_last_success_timestamp_seconds` | gauge | 같음 | 싱크 커서가 마지막으로 앞으로 나아간 시각(처음 값은 전송을 시작한 시각) |
| `kubeast_db_pool_connections` | gauge | `service`, `state` | 서비스(auth · ai · k8s · session)의 데이터베이스 풀 연결 수, 긁을 때마다 읽음: `in_use`, `idle`, 그리고 Go 서비스는 `opening`(여는 중). 풀과 따로 연 연결(k8s-service가 클러스터 상태를 쓰는 잠금)은 세지 않고, 풀에서 가져가 쥔 연결(auth-service 감사 싱크의 리더 잠금)은 `in_use`입니다 |
| `kubeast_db_pool_max_connections` | gauge | `service` | 그 풀이 쥘 수 있는 최대 연결 수(`postgresql.pool.<service>.maxConns`) |
| `kubeast_db_pool_empty_acquires_total` | counter | `service` | 기동 뒤 연결을 가져가려다 쉬는 연결이 없어 돌려받거나 새로 열릴 때까지 기다린 수. Go 서비스만 — SQLAlchemy 풀(ai-service)은 이 수를 세지 않습니다 |
| `kubeast_db_pool_empty_acquire_wait_seconds_total` | counter | `service` | 그렇게 기다린 시간의 합, 초(Go 서비스) |
| `kubeast_db_pool_canceled_acquires_total` | counter | `service` | 연결이 오기 전에 요청이 끝나(시간이 다 됨, 호출자가 떠남) 그만둔 가져가기 수(Go 서비스) |
| `kubeast_session_recording_pending_bytes` | gauge | `service` | 녹화했지만 아직 저장소에 올리지 못한 터미널 출력 바이트(`sessionRecording`) |
| `kubeast_session_recording_upload_failures_total` | counter | `service` | 기동 뒤 실패한 녹화 조각 업로드 수 |
| `kubeast_session_recording_last_upload_timestamp_seconds` | gauge | `service` | 녹화 조각을 마지막으로 올린 시각(처음 값은 기동 시각) |
| `kubeast_claude_code_runs` | gauge | `service`, `lane` | 지금 이 ai-service에서 자리를 쥐고 도는 Claude Code 실행(공급자 `claude-code`) 수. `lane`은 `chat`(이 서버의 자리 `AI_CLAUDE_CODE_MAX_CONCURRENT`와 설치 전체의 자리 하나 `AI_CLAUDE_CODE_MAX_CONCURRENT_TOTAL`) 또는 `investigation`(서버마다 하나인 조사 자리)입니다. 첫 실행 때 이 계열이 생깁니다 |
| `kubeast_claude_code_waiting` | gauge | `service` | 지금 자리를 기다리는 채팅 실행 수(그 채팅 스트림이 `{"queued": true}`를 보냄) |
| `kubeast_claude_code_slot_wait_seconds` | histogram | `service` | 채팅 실행이 이 서버의 자리와 설치 전체의 자리를 기다린 시간, 둘 다 비어 있었으면 0. 바쁨으로 끝났거나 기다리다 멈춘 실행도 기다린 시간만큼 셉니다 |
| `kubeast_claude_code_busy_total` | counter | `service` | 기동 뒤 바쁨으로 끝난 채팅 실행 수: `AI_CLAUDE_CODE_QUEUE_WAIT` 안에 자리가 나지 않음(채팅의 "Claude Code is busy") |
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
    enabled: true           # 알람 5개, AI를 켜면(기본) · 감사 앵커 싱크가 있으면 · 알림 조사를 켜면 하나씩 더
```

ServiceMonitor 하나가 라벨 `kubeast.io/metrics: "true"`가 붙은 백엔드 Service 다섯 개를 포트 이름 `http`, 경로 `/metrics`로 고릅니다.
Operator 없이 Prometheus를 쓴다면 `kubernetes_sd_configs`(role `endpoints`)로 같은 라벨을 고르면 됩니다.

## 알람 (`metrics.prometheusRule.enabled`)

| 이름 | 식 | 뜻 |
|---|---|---|
| `KubeastAuditStoreDown` | `min by (service) (kubeast_audit_store_up) == 0` 2분 | 감사 DB에 쓸 수 없어 감사 대상 동작을 거부하는 중 |
| `KubeastHighErrorRate` | 5xx 비율 > `errorRatio`(0.05) 10분 | 콘솔 오류율. 데이터베이스 장애가 그보다 길면 로그인한 사람의 읽기만으로도 울립니다. 세션을 읽을 수 없는 요청은 503으로 답하기 때문입니다(0.7.7은 이 알림이 세지 않는 4xx인 401로 답했습니다). API 서버가 20초 안에 답을 시작하지 않는 클러스터 읽기도 k8s-service의 503이므로, 끊긴 클러스터 하나의 화면을 사람들이 계속 열어 두면 그것만으로 울 수 있습니다. 클라이언트가 떠나서 끊긴 읽기(화면을 닫거나 새로 고침, 채팅을 멈춤)는 `499`(위)라 전체에는 들어가고 오류에는 들어가지 않으므로, 사람들이 5초 안에 새로 고치는 장애에서는 비율이 조금 낮게 나옵니다 |
| `KubeastSlowRequests` | p95 > `p95Seconds`(2 s) 10분 | 콘솔 지연 |
| `KubeastAuditSinkStalled` | `kubeast_audit_sink_pending > 0`이고 마지막 전송 성공 뒤 10분이 넘게 지남, 5분 | 감사 싱크 전송이 멈춤(auth-service 로그에 오류가 남고, 보내지 못한 행은 보존 작업이 지우지 않고 남겨 둠) |
| `KubeastSessionRecordingUploadStalled` | `kubeast_session_recording_pending_bytes > 0`이고 마지막 업로드 뒤 10분이 넘게 지남, 5분 | 세션 녹화 업로드가 멈춤(출력은 k8s-service 스풀에 쌓이고, 세션은 막지 않음) |
| `KubeastAuditAnchorStalled` | `time() - max by (service) (kubeast_audit_anchor_last_timestamp_seconds)`가 `audit.integrity.anchor.hours`의 두 배를 넘음, 30분. `audit.integrity.anchor.sink`가 있을 때만 | 두 주기 동안 감사 앵커가 쓰이지 않음: 쓰기가 실패하거나 앵커 작업이 돌지 않음. 실패한 앵커는 auth-service 로그와 `audit.chain.anchor` 행에 남음([security-audit.md](security-audit.md)) |
| `KubeastAIModelUnreachable` | 10분 동안 `kubeast_ai_model_requests_total`이 `ok` 아닌 것 3개 이상이고 `ok`는 0, 10분. `ai.enabled`일 때만 | 모델 제공자에 보낸 요청이 하나도 답을 받지 못함: 만료된 키나 토큰, 크레딧 없음, 제공자 장애, 또는 허용 목록에서 빠진 주소(`networkPolicy.aiEgress`). 어느 것인지는 `outcome` 라벨이 말하고, 채팅은 모델 오류로 끝나며 알림 조사는 실패합니다 |
| `KubeastAIInvestigationsFailing` | 1시간 동안 `kubeast_ai_investigations_total`이 `failed` 3개 이상이고 `done`과 `failed`의 절반을 넘음, 15분. `features.alertInvestigation.enabled`일 때만 | 알림 조사 대부분이 실패함. 각 조사의 오류는 Admin → Investigations에 있고, `skipped`는 세지 않습니다 |

자주 쓰는 식:

- 서비스별 요청률 `sum by (service) (rate(kubeast_http_requests_total[5m]))`
- 파드마다 쓰는 데이터베이스 풀 비율 `kubeast_db_pool_connections{state="in_use"} / ignoring(state) kubeast_db_pool_max_connections`. 몇 분째 1에 가깝고 `rate(kubeast_db_pool_empty_acquire_wait_seconds_total[5m])`가 0보다 크면 요청이 연결을 기다리는 중입니다. `postgresql.pool.<service>.maxConns`와 `postgresql.maxConnections`를 보세요
- 라우트별 p95 `histogram_quantile(0.95, sum by (route, le) (rate(kubeast_http_request_duration_seconds_bucket{service="k8s"}[5m])))`
- 큰 묶인 답의 쓰기 자리 대기 p95 `histogram_quantile(0.95, sum by (le) (rate(kubeast_shared_write_place_wait_seconds_bucket[5m])))`. 0에 가까우면 노드 목록, 노드 칸, Pods 화면, 노드 지도, 묶인 읽기를 늦추는 것은 쓰기 자리가 아닙니다. 본문 하나의 기다림은 시작하고 1초 뒤 멈추고, 남은 것은 자리 없이 갑니다(`kubeast_shared_writes_without_place_total`)
- 클러스터로 가는 클라이언트 속도 대기 p95 `histogram_quantile(0.95, sum by (limiter, le) (rate(kubeast_k8s_client_rate_wait_seconds_bucket[5m])))`. 0에 가까우면 화면을 늦추는 것은 이 속도가 아닙니다. API 서버가 429 없이 답하는데 몇 초씩 나오면 `multicluster.clientQPS`·`clientBurst`(접근 확인이면 `reviewQPS`)를 보세요
- 클러스터 읽기 자리 대기 p95 `histogram_quantile(0.95, sum by (places, le) (rate(kubeast_k8s_read_place_wait_seconds_bucket[5m])))`. `limiter="cache"` 대기는 0에 가까운데 `node_pods`가 몇 초씩이면 노드 상자의 속도를 정하는 것은 토큰 통이 아니라 자리입니다
- 자리를 기다린 여러 쪽 읽기, 초당 `sum(rate(kubeast_k8s_read_place_wait_seconds_count{places="big_read"}[5m])) - sum(rate(kubeast_k8s_read_place_wait_seconds_bucket{places="big_read",le="0.001"}[5m]))`. `limiter="user"` 대기는 0에 가까운데 0보다 크면 타임라인과 다른 쪽 단위 읽기가 기다리는 것은 API 서버가 아니라 k8s-service의 메모리를 지키는 `multicluster.bigReadConcurrency`입니다

## 확인

```bash
kubectl -n kubeast port-forward svc/k8s-service 18002:8002 &
curl -s localhost:18002/metrics | grep -E '^kubeast_'
```
