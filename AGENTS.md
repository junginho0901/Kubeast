# Kubeast — Agent Guidance

이 문서는 Claude Code, Codex 등 AI 어시스턴트와 사람 기여자 모두가
이 리포지토리에서 작업할 때 따라야 할 **프로젝트 고유 규칙**을 모은다.

관련 계획서:
- [docs/audit-log-plan.md](docs/audit-log-plan.md)

---

## 감사 로그(Audit Log) 필수 규칙

> 2026-04-15 발효. 근거: [docs/audit-log-plan.md §8](docs/audit-log-plan.md#8-개발-규칙-영속화)

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

전체 카탈로그는 [docs/audit-log-plan.md §5-2](docs/audit-log-plan.md#5-2-카탈로그-초기-확정) 를 항상 기준으로 한다.
카탈로그에 없는 신규 action 을 추가할 때는 **계획서부터 갱신**한다.

### 예외 없는 원칙

- **성공뿐 아니라 실패도 기록**. 실패 시 `Result = audit.ResultFailure`, `Error` 필드 채움.
- **DB 감사 행은 민감 동작의 선행 조건, stdout 미러만 best-effort.** 감사 DB에 기록할 수 없으면
  쓰기·민감 읽기(Secret/Helm reveal, exec, 노드 셸, 로그, 컨테이너 로그 파일, kubeconfig, AI 쓰기 툴)는 **503 `audit unavailable`**로
  거부한다(`AUDIT_FAIL_CLOSED`, 기본 true; 차트 `audit.failClosed`). 목록·조회는 계속된다.
  구현 = 변경 라우트는 `audit.RequireWritable` 미들웨어, 감사가 조건부인 GET 핸들러는 동작 전 `h.auditReady(r)` +
  `recordAudit*` 반환 오류 확인(`h.refuseUnaudited`). 이미 실행된 변경의 사후 쓰기 실패는 `audit.Guarded`가 세고
  ERROR 로그로 남기며 응답은 그대로다. 부팅 때 DB가 없으면 `AUDIT_DB_WAIT_SEC`(90 s)까지 기다렸다가 종료한다 —
  로그 전용 폴백은 없다.
- 민감 필드(password, secret, token, apikey 등)는 **`audit.MaskSensitive(...)` 적용 후** 저장.

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

계획서 작성 시 [docs/helm-plan.md §8](docs/helm-plan.md#8-감사-로그-공용화-사전-작업) 를 참고한다.

---

## 빌드 / 배포

- **빌드/배포는 항상 `scripts/rebuild-kind.sh` 를 통해 수행**한다. 직접 docker/kubectl 명령을 돌리지 않는다.
  게이트웨이(nginx.conf)는 `scripts/rebuild-kind.sh gateway` — 릴리스 값 그대로 `helm upgrade`로 다시 렌더한다.
  ConfigMap을 `kubectl apply`로 쓰면 kubectl이 필드 소유자가 돼 다음 `helm upgrade`(Helm 4 서버 측 적용)가 충돌로 멈춘다.

## 컨테이너 exec

- **서버가 `pods/exec`로 띄운 프로세스는 클라이언트가 끊겨도 컨테이너에 남는다**(TTY 유무와 무관, 컨테이너 런타임이
  정리하지 않음). 서비스 코드에서 `tail -F`·대기하는 셸 같은 장기 명령을 exec로 돌리지 말고, 바로 끝나는 짧은 명령을
  주기적으로 실행한다(예: 로그 파일 실시간 보기 = `tail -c +<오프셋>` 2초 폴링, `services/k8s-service-go/internal/handler/logfiles.go`).
  사람이 쓰는 대화형 터미널(Pod exec·노드 셸)은 예외지만, 브라우저가 `exit` 없이 끊기면 서버가 셸에 Ctrl-C·Ctrl-D를 보내고
  끝나기를 잠깐 기다린 뒤 끊는다(`remote_shell.go` `streamShell`) — 이걸 빼면 끊길 때마다 컨테이너에 셸이 남는다.
- exec 명령은 인자 배열로 넘기고 셸을 거치지 않는다. 사용자 입력이 들어가는 인자는 허용 목록으로 검증하고 `--`로 옵션 파싱을 끝낸다.
- 로컬 실행은 [docker-compose.yml](docker-compose.yml) 참고.
