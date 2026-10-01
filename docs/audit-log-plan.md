# 감사 로그 계획 (audit-log-plan)

AGENTS.md와 CLAUDE.md가 정본으로 가리키는 문서. 코드가 기준이고, 이 문서는 코드에서 뽑아 정리한 것이다(2026-09-27 재작성 — 이전 판은 저장소 밖에 있어 참조가 끊겨 있었다).

## 1. 목적

누가(actor) 어느 클러스터의 무엇을(target) 언제 어떻게(action, result) 바꿨거나 민감하게 열었는지 남긴다. 조회는 관리자 화면(`admin.audit.read`)과 CSV(`admin.audit.export`), 보존은 애플리케이션 DB와 클러스터 로그 파이프라인 두 곳.

## 2. 원칙

| # | 원칙 | 구현 |
|---|---|---|
| D1 | 모든 **쓰기 핸들러**(create/update/delete/rollback/restart/scale/apply/…)와 **민감 읽기**(Secret reveal, Node shell, Pod exec, Pod logs, kubeconfig 읽기, 감사 로그 조회·내보내기)는 기록한다. 단순 목록/조회, health, 공개 엔드포인트는 제외 | 핸들러가 `audit.FromHTTPRequest(r)`로 레코드를 만들고 `auditStore.Write` |
| D2 | 성공과 실패를 모두 기록한다. 실패는 `Result = failure`, `Error`에 사유 | `recordHelmAudit` 등 헬퍼가 err 유무로 채움 |
| D3 | `Before`/`After`에 비밀이 들어가지 않게 마스킹한다 | `audit.MaskSensitive`(password/secret/token/apikey 키), AI 툴 결과는 `pkg/redact` |
| D4 | **DB 행은 민감 동작의 선행 조건**(fail-closed), stdout 미러만 best-effort. 감사 DB에 기록할 수 없으면 쓰기와 민감 읽기는 503 `audit unavailable`, 목록·조회는 계속. 이미 실행된 변경의 사후 쓰기 실패는 세고 ERROR 로그, 응답은 유지. 부팅 때 DB가 없으면 기다렸다가(`AUDIT_DB_WAIT_SEC` 90 s) 종료 — 로그 전용 폴백 없음(NIST AU-5(4) 제한 모드·Vault 감사 장치·kube-apiserver `--audit-log-mode blocking`과 같은 방향) | k8s-service: `audit.Guarded`(핑 캐시 2 s·실패 카운터·`/health` `audit` 블록) + 변경 라우트 `audit.RequireWritable`(POST `/search` 제외) + 조건부 감사 GET 핸들러의 `auditReady`/`refuseUnaudited`. ai-service: `require_audit_ready()`가 승인된 쓰기 툴 실행 전. 스위치 `AUDIT_FAIL_CLOSED`(기본 true, 차트 `audit.failClosed`) |
| D5 | 감사 1건 = DB 1행 + **stdout JSON 1줄**. 앱 DB와 독립된 사본을 클러스터 로그 파이프라인이 가져간다 | `audit.StdoutTee`(Go), `audit_writer._emit_stdout`(Python). 줄 형식 §4 |
| D6 | 액션 이름은 `<domain>.<object>.<verb>`. 새 액션은 코드보다 이 문서 §5-2에 먼저 추가한다 | 도메인 = `user` `admin` `k8s` `helm` `ai` |

## 3. 레코드

`services/pkg/audit.Record`:

| 필드 | 내용 |
|---|---|
| `Service` | `auth` `k8s` `helm` `ai` `admin` |
| `Action` | §5-2 카탈로그의 이름 |
| `ActorUserID` / `ActorEmail` | 인증된 사용자 |
| `TargetType` / `TargetID` / `TargetEmail` | 대상 종류·식별자(release 이름, pod 이름, user id …); 사용자 대상이면 이메일 |
| `Cluster` / `Namespace` | 범위 |
| `Before` / `After` | 마스킹된 JSON 스냅샷(선택) |
| `Result` / `Error` | `success` `failure`, 실패 사유 |
| `RequestIP` / `UserAgent` / `RequestID` / `Path` | HTTP 컨텍스트 |

## 4. 저장

- **DB**: `auth_audit_logs`(모든 서비스 공용, auth-service가 스키마 관리). Go는 `audit.PostgresStore`, Python은 `audit_writer.py`가 같은 컬럼에 INSERT.
- **stdout**: 서비스 로거(JSON)로 한 줄. `{"time":…,"level":"INFO","msg":"audit","event":"audit","audit":{id,service,action,result,error,actor_user_id,actor_email,target_type,target_id,target_email,cluster,namespace,path,request_ip,user_agent,request_id,before,after}}`. 최상위 `event: "audit"`이 로그 파이프라인의 라우팅 키. `AUDIT_STDOUT=false`(차트 `audit.stdout`)로 끈다. DB 쓰기가 실패해도 줄은 남고 `store_error`가 붙는다.
- **DB를 못 쓸 때(D4)**: 변경·민감 읽기는 503 `{"detail":"audit unavailable"}`(사유는 서비스 로그 `audit: refusing unrecorded action`), k8s-service `/health`의 `audit` 블록에 `ready`·`write_failures`·`last_error`. 스위치 `AUDIT_FAIL_CLOSED`(기본 true, 차트 `audit.failClosed`), 부팅 대기 `AUDIT_DB_WAIT_SEC`(기본 90).
- **조회·내보내기**: `GET /api/v1/auth/admin/audit-logs`(필터·페이지), `GET /api/v1/auth/admin/audit-logs/export`(같은 필터, CSV UTF-8 BOM, 최대 50,000행). 둘 다 감사 대상(`admin.audit.read`, `admin.audit.export`).

## 5. 카탈로그

### 5-1. 이름 규칙

`<domain>.<object>.<verb>` — 소문자, 점 구분. verb는 `create` `update` `delete` `read` `reveal` `exec` `shell` `drain` `cordon` `uncordon` `apply` `rollback` `upgrade` `uninstall` `test` `trigger` `suspend` `resume` `set` `unset` `sync` `send` `call` `approve` `reject` 등 현재 사용 중인 것에서 고른다.

### 5-2. 카탈로그 초기 확정

코드에서 추출(2026-09-27). 서비스별.

**auth-service (`auth` / `admin`)**

| 액션 | 뜻 |
|---|---|
| `user.login.success` / `user.login.failed` | 로그인 성공·실패(비밀번호, OIDC). 실패 `after.reason` = `user_not_found` / `password_mismatch` / `password_login_disabled` / `locked`(잠금 중 시도) |
| `user.login.locked` | 비밀번호 실패가 `LOGIN_MAX_FAILURES`(기본 5)회에 닿아 계정이 `LOGIN_LOCKOUT_MINUTES`(기본 15)분 잠김. `after` = `{failures, locked_until}`. 응답은 잠금 여부와 무관하게 `Invalid credentials` 401 |
| `user.logout` | 로그아웃(토큰 서명만 검증, 만료 무시하고 actor 기록) |
| `user.token.refresh` | 액세스 토큰 갱신 |
| `user.password.change` / `user.password.reset` | 비밀번호 변경·재설정 |
| `user.account.provision` | OIDC 첫 로그인으로 계정 생성(JIT) |
| `user.register` | 자기 가입(`ALLOW_REGISTRATION`) → `Pending` 역할. actor = target = 새 계정 |
| `user.role.update` / `user.role.sync` | 계정 등급 변경 / OIDC 그룹 동기화. 대량 API(`PATCH /admin/users/bulk-role`)는 계정마다 1행, `after.bulk = true` |
| `user.create` / `user.update` / `user.delete` | 관리자의 계정 생성·수정·삭제. 대량 생성(`POST /admin/users/bulk`)은 계정마다 1행, `after.bulk = true` |
| `user.cluster_role.set` / `user.cluster_role.unset` | 클러스터별 Read/Write/Admin 부여·회수 |
| `admin.users.create` / `.read` / `.update` / `.delete` | 관리자 사용자 관리 |
| `admin.roles.create` / `.update` / `.delete` | 역할 생성·수정·삭제. `before`/`after` = `{name, description, permissions}` — 권한 목록 변경이 그대로 남는다 |
| `admin.organizations.create` / `.delete` | 조직(팀) 생성·삭제. `after`/`before` = `{type, name}` |
| `admin.cluster.register` / `.update` / `.delete` / `.test` | 클러스터 등록·수정·삭제·연결 테스트 |
| `admin.audit.read` / `admin.audit.export` | 감사 로그 조회·CSV |
| `admin.retention.purge` | 보존 기간(`RETENTION_AUDIT_DAYS`·`RETENTION_CHAT_DAYS`)이 지난 감사·채팅 행 삭제 — auth-service의 일일 작업, actor `system`. `after`에 기간·기준 시각·삭제 행 수(감사·세션·툴 승인); 실패면 `failure` |
| `ai.tool.helm_execute` | AI 승인 경로의 Helm 쓰기 실행 |

**k8s-service (`k8s` / `helm`)** — 모든 행의 `cluster` = 요청이 가리킨 클러스터 id(`?cluster=` / 세션 기본값). `request_ip` = 게이트웨이가 본 클라이언트 주소(`X-Real-IP`; `X-Forwarded-For`는 읽지 않음, 앞단 프록시는 차트 `gateway.trustedProxies`).

| 액션 | 뜻 |
|---|---|
| `k8s.<kind>.delete` | 리소스 삭제. kind = pod, deployment, statefulset, daemonset, replicaset, job, cronjob, hpa, vpa, pdb, service, ingress, ingressclass, networkpolicy, endpoints, endpointslice, gateway, gatewayclass, httproute, grpcroute, referencegrant, backendtlspolicy, backendtrafficpolicy, configmap, secret, pv, pvc, storageclass, volumeattachment, namespace, node, serviceaccount, role, rolebinding, clusterrole, clusterrolebinding, crd, customresource, priorityclass, runtimeclass, lease, resourcequota, limitrange, mutatingwebhook, validatingwebhook, deviceclass, resourceclaim, resourceclaimtemplate, resourceslice |
| `k8s.namespace.create` / `k8s.namespace.apply` | 네임스페이스 생성·적용 |
| `k8s.yaml.create` / `k8s.yaml.apply` | YAML로 생성·적용 |
| `k8s.node.cordon` / `.uncordon` / `.drain` / `.edit` / `.delete` | 노드 조작 |
| `k8s.node.shell` | 노드 셸(민감 읽기) |
| `k8s.pod.exec` / `k8s.pod.logs.read` | Pod exec, 로그 읽기(민감 읽기) |
| `k8s.secret.reveal` | Secret 값 열람(민감 읽기) |
| `k8s.cronjob.trigger` / `.suspend` / `.resume` | CronJob 조작 |
| `k8s.cluster.kubeconfig.read` | tool-server가 클러스터 kubeconfig를 읽음(민감 읽기) |
| `helm.release.reveal` | 릴리스의 manifest·values·hooks·diff를 **마스킹 없이** 읽음 — `resource.secret.reveal` 보유자만(없으면 Secret 문서 제거·민감 값 마스킹 후 반환, 기록 없음). `after.section` = manifest/values/hooks/diff/detail |
| `helm.release.upgrade` / `.rollback` / `.uninstall` / `.test` | Helm 쓰기(dry-run은 기록하지 않음; uninstall은 `?confirm=<release>` 필수) |

**ai-service (`ai`)**

| 액션 | 뜻 |
|---|---|
| `ai.chat.send` | 채팅 메시지 수신(스트림 시작) |
| `ai.chat.complete` | 채팅 턴 완료(오류로 끝나면 `failure`; 사용자가 중단·이탈하면 `finish_reason: cancelled`로 그때까지의 값). `after`에 `provider`·`model`·`cluster`·`prompt_tokens`/`completion_tokens`/`total_tokens`(제공자가 usage를 안 보내면 null)·`tool_calls`·`iterations`·`duration_ms`·`finish_reason`. `cluster` 컬럼 = 턴이 실행된 클러스터(모든 `ai.*` 행 동일). admin AI 사용량 화면의 원본 |
| `ai.tool.call` | 모델이 읽기 툴 호출. `after`에 툴·인자·`redacted{count,kinds}` |
| `ai.tool.approval_requested` / `ai.tool.approve` / `ai.tool.reject` | 쓰기 툴 승인 요청·승인·거절 |

`services/pkg/audit`에 상수로 있는 `admin.clusters.*`(create/list/update/delete)와 예시용 `helm.release.rollback`·`k8s.pod.delete`는 위 표의 실제 액션과 같은 뜻이다.

### 5-3. 새 액션 추가 절차

1. §5-2에 행 추가(PR에 포함).
2. 핸들러에서 성공·실패 모두 기록, `Before`/`After` 마스킹.
3. `docs/*-plan.md`를 새로 쓰는 기능이면 `## N. 감사 로그` 절에 대상 액션과 권한 매핑 표.

## 6. 보존

- DB 행은 삭제하지 않는다(관리자 화면은 조회·CSV만).
- stdout 사본은 클러스터 운영자의 로그 파이프라인 정책(수집·보존·잠금)에 따른다. Kubeast는 백엔드로 직접 보내지 않는다.

## 7. 확인 방법

- 단위: `services/pkg/audit` 테스트(스토어·마스킹·stdout 줄 형식).
- e2e: 쓰기 동작 뒤 `GET /api/v1/auth/admin/audit-logs?action=<name>`에 행이 있고, 파드 로그에 `"event":"audit"` 줄이 같은 수만큼 있는지.

## 8. 개발 규칙 영속화

이 문서의 §2 원칙과 §5 카탈로그는 [AGENTS.md](../AGENTS.md)의 "감사 로그 필수 규칙"이 참조한다. 쓰기 핸들러를 추가·수정하면서 감사 기록이 없는 PR은 받지 않는다. 규칙을 바꾸면 이 문서와 AGENTS.md를 같은 PR에서 고친다.
