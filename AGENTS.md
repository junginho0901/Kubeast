# Kubeast — Agent Guidance

이 문서는 Claude Code, Codex 등 AI 어시스턴트와 사람 기여자 모두가
이 리포지토리에서 작업할 때 따라야 할 **프로젝트 고유 규칙**을 모은다.

관련 계획서:
- [docs/audit-log-plan.md](docs/audit-log-plan.md)

---

## 감사 로그(Audit Log) 필수 규칙

> 2026-04-15 발효. 근거: [docs/ko/audit-log-plan.md §8](docs/ko/audit-log-plan.md#8-개발-규칙-영속화)

모든 **쓰기(write) 성격의 HTTP 핸들러**, 그리고 **민감 정보 열람
(Secret reveal / Node shell / 세션 기록 열람 / 감사 로그 조회)** 은 반드시
[services/pkg/audit](services/pkg/audit) 를 통해 감사 로그를 기록한다.

**포함 대상:**
- 리소스의 상태를 변경하는 모든 동작 (create / update / delete / rollback / restart / …)
- Pod Exec, Node Shell, Pod Logs(민감 조회), Cronjob Trigger 등 실행/연결 개시
- Secret 복호화 열람 (`k8s.secret.reveal`)
- Helm Release 의 install / upgrade / rollback / uninstall / test
- 감사 로그 조회 자체 (`admin.audit.read`) — 메타 감사

**제외 대상:**
- 일반 조회(Pod 목록, Deployment 상세 등) — 트래픽 대비 가치 낮음
- 헬스체크 / public 엔드포인트

### 패턴

```go
// 핸들러 레이어에서 감사 레코드 작성
rec := audit.FromHTTPRequest(r)
rec.Service = audit.ServiceK8s          // 또는 ServiceHelm / ServiceAI / ServiceAuth
rec.Action  = "k8s.pod.delete"           // "<domain>.<object>.<verb>"
rec.ActorUserID = payload.UserID
rec.ActorEmail  = payload.Email
rec.TargetID    = name
rec.TargetType  = "pod"
rec.Namespace   = namespace
rec.Before      = audit.MustJSON(before) // 필요 시
rec.After       = audit.MustJSON(after)

if err := doTheThing(ctx); err != nil {
    rec.Result = audit.ResultFailure
    rec.Error  = err.Error()
    _, _ = h.auditStore.Write(r.Context(), rec)
    h.handleError(w, err)
    return
}
rec.Result = audit.ResultSuccess
_, _ = h.auditStore.Write(r.Context(), rec)
```

### Action 네이밍 — 엄격

형식: `<domain>.<object>.<verb>`

- `user.create`, `role.update`
- `k8s.pod.delete`, `k8s.pod.exec`, `k8s.secret.reveal`, `k8s.node.drain`
- `helm.release.rollback`, `helm.release.uninstall`
- `ai.tool.execute`
- `admin.audit.read`

전체 카탈로그는 [docs/ko/audit-log-plan.md §5-2](docs/ko/audit-log-plan.md#5-2-카탈로그-초기-확정) 를 항상 기준으로 한다.
카탈로그에 없는 신규 action 을 추가할 때는 **계획서부터 갱신**한다.

### 예외 없는 원칙

- **성공뿐 아니라 실패도 기록**. 실패 시 `Result = audit.ResultFailure`, `Error` 필드 채움.
- **DB 감사 행은 민감 동작의 선행 조건, stdout 미러만 best-effort.** 감사 DB에 기록할 수 없으면
  쓰기·민감 읽기(Secret/Helm reveal, exec, 노드 셸, 로그, 컨테이너 로그 파일, kubeconfig, AI 쓰기 툴)는 **503 `audit unavailable`**로
  거부한다(`AUDIT_FAIL_CLOSED`, 기본 true; 차트 `audit.failClosed`). 목록·조회는 계속된다.
  구현 = 변경 라우트는 `audit.RequireWritable` 미들웨어, 감사가 조건부인 GET 핸들러는 동작 전 `h.auditReady(r)` +
  `recordAudit*` 반환 오류 확인(`h.refuseUnaudited`). 이미 실행된 변경의 사후 쓰기 실패는 `audit.Guarded`가 세고
  ERROR 로그로 남기며 응답은 그대로다 — 그 뒤로는 준비 확인이 시험 쓰기(넣었다 되돌림)로 바뀌어 감사 표가 다시
  행을 받을 때까지 거부한다. auth-service는 관리자 쓰기만 거부(로그인·로그아웃·토큰 갱신·본인 비밀번호 변경은 계속),
  AI 채팅 도구·알림 조사도 실행 전에 확인한다. 읽기 도구는 행을 못 남기면 답을 버리고(`audit_unavailable`: 채팅·MCP·알림 조사, `test_audit_after_read.py`), 이미 실행된 쓰기 도구는 답을 그대로 준다. 모델 연결 시험과 공급자 모델 목록은 서버 키를 쓰므로 시작 전에 503으로 거부한다(`model_config_audit.ready_or_503`). 부팅 때 DB가 없으면 기다렸다가 종료한다(k8s-service = `AUDIT_DB_WAIT_SEC` 90 s · auth-service와 session-service = DB 60 s(핑마다 5 s, `audit.WaitReady`) + 스키마 60 s, 차트의 startupProbe 180 s가 이 기다림을 liveness에서 지킴) —
  로그 전용 폴백은 없다.
- 민감 필드(password, secret, token, apikey 등)는 **`audit.MaskSensitive(...)` 적용 후** 저장. 문자열 안은 읽지 못하므로 YAML·JSON 글은 행에 넣지 말고 길이나 요약만 남긴다(`yaml_len`, `helmValuesAudit`).
- 값을 못 읽는 사람이 저장한 Secret·Helm values의 행에는 값 대신 자리 이름만 남긴다: 값이 그대로인 자리는 `kept_masked`, Helm에서 새로 쓰거나 지운 자리는 `changed_masked`.
- AI 쓰기 도구의 인자는 실행에 필요한 동안만 원문이다. 저장되는 답과 스트림(멈춘 답은 화면이 스트림에서 받은 글로 저장한다)은 처음부터, 승인 행은 실행·거절·만료·중단(실행 도중 ai-service가 멈춘 호출은 승인 10분이 지난 뒤 처음 들여다본 ai-service가 `ai.tool.interrupt`로 끝냄. 들여다보는 때는 새 승인 카드, 카드 열기, 프로세스의 첫 데이터베이스 사용이고 타이머는 없음) 뒤에 필드가 같은 가린 사본을 갖는다(`audit_target.shown_tool_args`, `kept_tool_args`).

### PR 리뷰 기준

> 쓰기 성격의 HTTP 핸들러를 추가/수정하면서 감사 로그 호출이 없으면 PR 통과 불가.

---

## 감사 로그를 지원해야 하는 신규 기능 계획서

모든 feature plan 문서(`docs/*-plan.md`)는 다음 섹션을 **반드시 포함**한다:

```markdown
## N. 감사 로그

### N-1. 기록 대상 action
- `<domain>.<object>.<verb>` — 설명
- ...

### N-2. Permission 매핑
| HTTP Endpoint | Permission | Audit Action |
```

계획서 작성 시 [docs/ko/audit-log-plan.md §5-3](docs/ko/audit-log-plan.md#5-3-새-액션-추가-절차) 를 참고한다.

---

## 클러스터 글과 모델

- 클러스터에서 읽은 글은 도구 결과 자리로만 모델에 간다(채팅·알림 조사, 두 루프 모두). `ai.toolResultsJSON`이면 결과마다 JSON 객체 하나(`app/services/ai/tool_results.py`). 도구 결과가 아닌 자리 — 울타리 안의 조사 알림·떠 있는 채팅 화면, 기록이 읽는 assistant 메시지인 승인된 쓰기의 결과 — 는 docs/ai-alerts.md "Planted instructions"에 적고 `tests/test_tool_results_json.py`가 지킨다. MCP 서버는 바깥 에이전트에 답을 그대로 준다. 프롬프트·도구·루프를 바꾸면 심어 둔 지시 사례(`evals/ai-planted/`, `scripts/ai_eval_planted.py`)를 모델마다 돌린다.

## 여러 레플리카

- 서비스는 레플리카 여러 개로 돌 수 있다([docs/ko/high-availability.md](docs/ko/high-availability.md)). 한 파드만 해야 하는 일(주기 작업 · 큐)은 프로세스 메모리가 아니라 DB로 차례를 정한다:
  작업 동안 자기 연결에 쥐는 advisory lock(`pg_try_advisory_lock`, auth-service `internal/auditsink`), 트랜잭션 하나 동안의 lock(`pg_try_advisory_xact_lock`, `internal/auditchain`),
  또는 `FOR UPDATE SKIP LOCKED`로 행을 가져가기(권한 요청 · 휴면 계정 정리, ai-service 알림 조사 큐). lock을 못 잡은 파드는 그 차례를 넘긴다.
- 프로세스 안의 한도 · 캐시 · 카운터는 파드마다다(설치 전체로는 레플리카 수만큼 곱해진다). 설치 전체에서 지켜야 하는 값은 DB나 Redis에 둔다.
  그런 일이나 상태를 더하는 변경은 docs/high-availability.md(en · ko)에 파드가 무엇을 쥐는지 적는다.

## 메모리

- Go 서비스는 `services/pkg/memlimit`로 cgroup 메모리 한도의 90 %를 GC 한도로 주고(`Set`), k8s-service는 85 %다(`SetShare(k8sMemoryLimitShare, 0)`). 나머지는 cgroup은 세고 Go는 모르는 커널 몫(소켓 버퍼 · slab)이다. 실시간 목록의 메모리 문(`watchMemoryShare` 0.8)은 이 GC 한도에 대한 몫이다. `GOMEMLIMIT` 환경 값이 있으면 그 값이 한도다.
- k8s-service가 받은 연결은 보내기 버퍼가 128 KiB다(리눅스는 두 배로 잡고 더 늘리지 않는다, `cmd/server/conn_buffers.go`의 `capSendBuffer`). Go 안에서 한 벌을 같이 쓰는 답(노드 목록)도 커널은 소켓마다 따로 쥐고, 그 몫은 cgroup에는 세지만 Go 메모리 한도는 모른다. k8s-service에 리스너를 더하면 같은 상한을 걸고, k8s-service가 여는 연결(API 서버 · auth-service · DB)은 커널 기본값 그대로 둔다.
- 여러 사람에게 같은 바이트를 보내는 답(노드 목록 · 노드 칸 답은 묶였든 아니든, `handler.Shared`가 기다린 사람에게 주는 답)은 `writeShared`로 쓴다(`internal/handler/shared_write.go`). 256 KiB를 넘는 본문은 64 KiB씩, 자리 16개 중 하나를 쥐고 쓰고, 한 덩어리가 100 ms를 넘게 걸린 느린 읽는 이는 그 덩어리 뒤에 자리를 내놓고, 자리를 기다린 시간이 본문마다 합쳐 1초에 닿으면 남은 것을 자리 없이 쓴다(읽지 않는 이가 자리를 쥐어도 멈추지 않게, `kubeast_shared_writes_without_place_total`이 센다). 자리를 받을 때마다 기다린 시간은 그만둔 받기도 `kubeast_shared_write_place_wait_seconds`(`places="big_write"`)에 남는다. 첫 덩어리를 쓴 뒤 다음 차례를 기다리다 요청이 떠나면 연결을 끊는다(`http.ErrAbortHandler`) — 잘린 본문이 다 받은 것처럼 끝나지 않게. 초마다 다시 만드는 노드 목록을 기다리던 사람들이 한꺼번에 쓰면 소켓마다 커널이 한 벌씩 쥐기 때문이다. 같은 바이트를 여럿에게 보내는 새 답도 이 함수로 쓴다.

## 빌드 / 배포

- **빌드/배포는 항상 `scripts/rebuild-kind.sh` 를 통해 수행**한다. 직접 docker/kubectl 명령을 돌리지 않는다.
  게이트웨이(nginx.conf)는 `scripts/rebuild-kind.sh gateway` — 릴리스 값 그대로 `helm upgrade`로 다시 렌더한다.
  ConfigMap을 `kubectl apply`로 쓰면 kubectl이 필드 소유자가 돼 다음 `helm upgrade`(Helm 4 서버 측 적용)가 충돌로 멈춘다.
- `docs/X.md`와 `docs/ko/X.md`(`README.md`·`README.ko.md`도)는 같은 PR에서 고치고, `helm/kubeast/values.yaml`에 새 값 경로를 넣으면 `docs/configuration.md`·`docs/ko/configuration.md`에 적는다. 일부러 한쪽만 고치면 그 PR 커밋 메시지의 마지막 문단에 `Co-Authored-By`와 빈 줄 없이 붙여 트레일러로 까닭을 단다: `Docs-Pair: en-only [<파일>...] <이유>`(또는 `ko-only`, `values-not-in-docs [<값 경로>...] <이유>`). 파일·경로를 적으면 그것만, 안 적으면 PR 전체가 빠진다 — CI `scripts/check-docs-pair.sh`.

## Redis

- 서비스마다 차트 Redis에 자기 사용자로 붙고, 그 사용자는 코드가 보내는 명령과 `kubeast:` 아래 키 · 채널만 쓸 수 있다(`helm/kubeast/templates/_helpers.tpl`의 `kubeast.redisUsersAcl`, `redis.acl`).
- 서비스가 Redis에 새 명령을 보내기 시작하면 그 서비스 사용자 줄에 명령을 넣고 `tests/redis_test.yaml`에 케이스를 더한다. 빠뜨리면 Redis ACL을 켠 설치에서 그 명령이 거절(NOPERM)되고 캐시는 오류 없이 빈 것처럼 읽힌다.
  `services/pkg/redisacl`로 서비스가 보내는 명령을 그 줄과 비교하는 시험이 있다(k8s-service `internal/cache`, k8s-service `internal/clustersync` 클러스터 변경 알림 보내기 · 듣기, tool-server 클러스터 변경 알림). Redis 명령을 보내는 새 곳에도 같은 시험을 붙인다.

## 데이터베이스 연결

- 서비스마다 연결한 뒤 SET으로 세션 한도(statement 30초 · lock 15초 · idle-in-transaction 5분, 차트 `postgresql.sessionLimits`)를 걸고(`services/pkg/dbsession`, ai-service는 롤백에 풀리지 않게 autocommit으로 `app/db_session.py`), 마이그레이션은 값과 상관없이 statement · lock을 항상 0으로 둔다(`ApplyMigrations`).
- 풀 크기는 서비스별 `postgresql.pool.<svc>.maxConns`이고, 새 서비스나 새 풀(잠금 전용 연결 포함)은 합계식 `kubeast.dbConnections`에 더한다 — `templates/checks/db-connections.yaml`이 그 합을 `postgresql.maxConnections` 아래로 막는다(`tests/db_connections_test.yaml`). PgBouncer는 session 모드만 쓴다.

## 클러스터 요청의 신원

- `auth.impersonation.enabled`가 켜지면 k8s-service의 클러스터 transport(`auth.ImpersonationRoundTripper`)는 문맥의 사람으로 보내고, 사람이 없는 요청은 `auth.AsKubeast` 표시(서버 버전 · 클러스터마다 모두에게 쓰는 디스커버리 · 상태 확인)가 없으면 보내지 않는다(`auth.ErrNoPerson`). 표시가 있어도 클러스터 서버 URL 경로 아래 `/version` · `/api` · `/apis` · `/api/v1` · `/apis/<group>/<version>`의 GET만 보내고 나머지는 같게 거절한다(`kubeastOwnRead`, `ImpersonationRoundTripperAt`). client-go 호출은 호출자 문맥을 넘긴다(`…WithContext(ctx)` — 문맥 없는 디스커버리 메서드는 안에서 `context.Background()`). 호출자가 자기 문맥으로 요청하는 config(Helm SDK · exec · 로그 파일)는 사람을 고정한다(`UserRESTConfigFor`, `auth.WithPinnedPerson`). informer · 공유 이벤트 · 노드 파드 읽기는 이 transport를 거치지 않는 `cacheClient`(고정 신원 `kubeast:cache`)로 읽는다. tool-server는 사람이 없으면 kubectl을 준비하지 않는다(`errNoPerson`). `TestEveryUserCallCarriesThePerson`이 개요 · 디스커버리 · cluster config · hygiene · watch · 고정 config · 상태 확인 읽기를 서버 URL 경로가 있을 때와 없을 때 보고, `TestKubeastOwnRequestsAreVersionAndDiscoveryReadsOnly`가 경로 · 메서드를 본다.
- API 서버 프록시로 Service를 읽는 곳(Prometheus · OpenCost · Hubble Relay · Whisker)은 리다이렉트를 같은 API 서버의 그 Service 프록시 경로 안에서만 따라간다(`internal/proxypath` `Follow`, `internal/k8s`는 `proxyClient` · `proxyGet`) — client-go는 따라가는 요청마다 클러스터 자격 증명과 사람 머리를 다시 붙이고, API 서버는 다른 호스트를 가리키는 `Location`을 그대로 넘긴다. 주소로 읽는 흐름 저장소는 리다이렉트를 따라가지 않는다(`FollowNone`). 실패한 답의 몸통이 Kubernetes `Status`면 API 서버 자신의 답이고(`proxypath.APIServerAnswer`), 저장소 자신의 401 · 403은 로그아웃 · 거절이 아니라 502다. 새 Service 프록시 읽기도 이 둘을 쓴다.

## 컨테이너 exec

- **서버가 `pods/exec`로 띄운 프로세스는 클라이언트가 끊겨도 컨테이너에 남는다**(TTY 유무와 무관, 컨테이너 런타임이
  정리하지 않음). 서비스 코드에서 `tail -F`·대기하는 셸 같은 장기 명령을 exec로 돌리지 말고, 바로 끝나는 짧은 명령을
  주기적으로 실행한다(예: 로그 파일 실시간 보기 = `tail -c +<오프셋>` 2초 폴링, `services/k8s-service-go/internal/handler/logfiles.go`).
  사람이 쓰는 대화형 터미널(Pod exec·노드 셸)은 예외지만, 브라우저가 `exit` 없이 끊기면 서버가 셸에 Ctrl-C·Ctrl-D를 보내고
  끝나기를 잠깐 기다린 뒤 끊는다(`remote_shell.go` `streamShell`) — 이걸 빼면 끊길 때마다 컨테이너에 셸이 남는다.
  닫지 않고 사라진 브라우저도 같다: 서버는 25초마다 핑을 보내고, 60초 동안 키도 퐁도 없으면 떠난 것으로 본다(`readFrames`).
- 노드 셸 파드의 로그는 터미널에 찍힌 전부다. 네임스페이스 없는 로그 저장소 읽기(검색·LogQL·레이블·패턴)는 그 클러스터에 `resource.node.shell`이 없으면 질의의 매처로 노드 셸 네임스페이스를 뺀다(`hiddenLogNamespace`).
- exec 명령은 인자 배열로 넘기고 셸을 거치지 않는다. 사용자 입력이 들어가는 인자는 허용 목록으로 검증하고 `--`로 옵션 파싱을 끝낸다.
- 로컬 실행은 [docker-compose.yml](docker-compose.yml) 참고.

## 종료(SIGTERM)

- Go 서비스(auth · k8s · session · tool-server)는 SIGTERM을 받으면 먼저 준비 상태를 내린다: `services/pkg/probe`의 `Leave`로 `/readyz`가 503이 되고,
  `probe.Hold`로 잡은 오래 열린 연결(WebSocket · 이벤트 스트림 · 따라가는 로그)을 끝낸 뒤 `probe.Wait`로 기다린다(차트 grace에서 preStop 뒤 남는 30초 안).
- `/readyz`는 서버가 받고 있고 떠나는 중이 아닌지만 본다. DB나 다른 서비스는 묻지 않는다 — 모든 레플리카가 같이 쓰므로 하나가 죽으면 레플리카가 한꺼번에 Service에서 빠진다.
- 이렇게 끝나는 WebSocket은 1001 `server_shutdown`(`probe.ShutdownCloseCode` · `ShutdownReason`)으로 닫고, 터미널은 그 이유로 `k8s.session.end` 행을 남긴다.
  새 오래 열린 연결은 `probe.Hold`, 터미널(Pod exec · 노드 셸)은 `probe.HoldTerminal`을 쓴다. 스트림 drain이 켜져 시작 때 `probe.HandOverTerminals`를 부르면 터미널은 drain이 닫는다(merge plan S21). 터미널과 실시간 로그는 열기 전에 계정의 자리를 하나 잡고(`takeTerminal` · `takeFollowedLog`, `internal/streamcap`, 차트 `multicluster.maxTerminalsPerAccount` · `maxFollowedLogsPerAccount`) `defer`로 돌려준다. 상한을 넘으면 그 action의 실패 행을 남기고 닫는 코드 4429 `terminal_limit` 또는 이벤트 `stream-limit`으로 거절한다. 셈은 파드마다다.
