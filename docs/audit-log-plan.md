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
- **싱크(선택)**: DB가 1차 저장소이고, 싱크는 DB 행을 **밖으로 복사**한다. auth-service 한 곳의 디스패처(여러 replica 중 Postgres advisory lock을 잡은 하나)가 싱크마다 커서(`audit_sink_cursors.last_id`)보다 큰 행을 읽어 배치로 보내고, 성공하면 커서를 옮긴다. 쓰는 서비스(Go·Python)는 그대로 DB에만 INSERT한다. 늦게 커밋된 작은 id를 놓치지 않게 5초 지난 행만 읽는다.
  - 종류: `s3`(S3 호환: AWS·MinIO·GCS·R2 — 시간 파티션 NDJSON gzip, 키 `prefix/YYYY/MM/DD/HH/<첫 id>-<끝 id>.ndjson.gz`) · `webhook`(`json` 범용 · `slack` · `teams`(Workflows Adaptive Card) · `discord` · `telegram` · `pagerduty`(Events v2)) · `email`(SMTP) · `file`(NDJSON, 크기 로테이션). 싱크마다 액션 필터(권한 패턴과 같은 와일드카드, 예 `k8s.*.delete`)와 결과 필터.
  - 전달은 **최소 1회**(보낸 뒤 커서를 옮기기 전에 죽으면 다시 보냄): 레코드의 `id`가 수신 측 중복 제거 키, S3 객체 키는 id 범위라 같은 배치는 같은 키에 덮어쓴다.
  - 요청 경로를 막지 않는다 — 싱크가 실패하면 커서가 멈추고 재시도(지수 백오프, 최대 5분)하며, 메트릭 `kubeast_audit_sink_pending`·`_failures_total`·`_last_success_timestamp_seconds`와 알람 `KubeastAuditSinkStalled`로 드러난다. 전송 결과는 감사 행으로 남기지 않는다(감사가 감사를 낳는 루프).
  - 내보내는 레코드(snake_case): `id, time, service, action, result, error, actor_user_id, actor_email, target_type, target_id, target_email, cluster, namespace, path, request_ip, user_agent, request_id, before, after` — DB 행 그대로(마스킹은 기록 때 이미 됨).
  - 설정: 차트 `audit.sinks[]`(비밀은 Secret 이름만), Object Lock(WORM)은 버킷 기본 보존에 맡기고 Kubeast는 `s3:PutObject`만 쓴다.
- **무결성(해시 체인 · 앵커, `AUDIT_INTEGRITY_*`, 차트 `audit.integrity`)**: auth-service의 sealer가 `AUDIT_INTEGRITY_SEAL_SEC`(기본 10초)마다 아직 봉인 안 된 행을 id 순으로 묶어 `chain_seq`(봉인 순번)·`prev_hash`·`row_hash = sha256(prev_hash ‖ 0x1e ‖ 정규화 행)`을 채운다(정규화 식 = `internal/auditchain.CanonSQL`, Postgres가 만든 문자열이라 psql 한 줄로 재계산 가능). 쓰기 경로는 그대로(서비스들은 INSERT만). `AUDIT_INTEGRITY_ANCHOR_SINK`에 s3 싱크 이름을 주면 `AUDIT_INTEGRITY_ANCHOR_HOURS`(기본 24)마다 체인 머리를 다이제스트 JSON(`{version, created_at, from_seq, to_seq, rows, head_hash, prev_anchor{object_key, hash}, access_reviews[{id, reviewed_at, hash}], hash_algorithm}`)으로 그 싱크 버킷의 `<prefix>digests/YYYY/MM/DD/<HHMMSS>Z-<from>-<to>.json`에 쓰고(새 행이 없어도 쓴다, 메타데이터 `anchor-hash`) `audit_anchors`에 남긴다. 관리자(`admin.audit.read`)는 `GET /api/v1/auth/admin/audit/integrity`로 상태를, `POST …/integrity/verify {from_seq?, to_seq?, anchors?}`로 구간 재계산(기본 = 마지막 앵커부터, 상한 200,000행 → 413; 결과 `{ok, first_bad_seq, reason: hash_mismatch|chain_break|gap|anchor_mismatch, anchors[{head_ok, object_ok, reviews_ok}]}`)을, `admin.audit.export`는 `POST …/integrity/anchor`로 즉시 앵커를 얻는다. 봉인 전 창(≤ SEAL_SEC)에 지워진 행은 못 잡고, 앵커 버킷의 Object Lock이 신뢰 근거다(다이제스트에 서명은 없음).

## 5. 카탈로그

### 5-1. 이름 규칙

`<domain>.<object>.<verb>` — 소문자, 점 구분. verb는 `create` `update` `delete` `read` `reveal` `exec` `shell` `drain` `cordon` `uncordon` `apply` `rollback` `upgrade` `uninstall` `test` `trigger` `suspend` `resume` `set` `unset` `sync` `send` `call` `approve` `reject` 등 현재 사용 중인 것에서 고른다.

### 5-2. 카탈로그 초기 확정

코드에서 추출(2026-09-27). 서비스별.

**auth-service (`auth` / `admin`)** — `cluster`는 클러스터에 대한 행(역할 부여·접근 요청·클러스터 전환 등)만 채우고, 로그인처럼 클러스터와 무관한 행은 비운다.

| 액션 | 뜻 |
|---|---|
| `user.login.success` / `user.login.failed` | 로그인 성공·실패(비밀번호, OIDC). 실패 `after.reason` = `user_not_found` / `password_mismatch` / `password_login_disabled` / `locked`(잠금 중 시도) |
| `user.login.locked` | 비밀번호 실패가 `LOGIN_MAX_FAILURES`(기본 5)회에 닿아 계정이 `LOGIN_LOCKOUT_MINUTES`(기본 15)분 잠김. `after` = `{failures, locked_until}`. 응답은 잠금 여부와 무관하게 `Invalid credentials` 401 |
| `user.logout` | 로그아웃(토큰 서명만 검증, 만료 무시하고 actor 기록) |
| `user.token.refresh` | 액세스 토큰 갱신. 세션 절대 수명(`SESSION_ABSOLUTE_HOURS`, 기본 8 h — 마지막 로그인 `auth_time` 기준)을 넘긴 갱신은 401로 거부되고 같은 액션에 `after.reason = session_absolute_lifetime`(+ `auth_time`, `limit_hours`)로 남는다 |
| `user.password.change` / `user.password.reset` | 비밀번호 변경·재설정. 변경에서 현재 비밀번호가 틀리면 `user.password.change` failure(`error` = `password_mismatch`) |
| `admin.access.denied` | 관리자 API(사용자·역할·조직·클러스터 등록·접근 요청 결정·API 키 관리·휴면·접근 권한 검토·감사 로그)를 앱 권한이 거부함 — 권한이 모두 `admin.*`라 읽기 거부도 남긴다. result failure, `after` = `{permission, method, path}`. 일반 사용자 화면은 이 API를 부르지 않는다(권한 있는 화면에서만) |
| `user.account.provision` | OIDC 첫 로그인으로 계정 생성(JIT) |
| `user.register` | 자기 가입(`ALLOW_REGISTRATION`) → `Pending` 역할. actor = target = 새 계정 |
| `user.role.update` / `user.role.sync` | 계정 등급 변경 / OIDC 그룹 동기화. 대량 API(`PATCH /admin/users/bulk-role`)는 계정마다 1행, `after.bulk = true`. 자기 등급 변경 시도·상한 위반은 거부되고 `failure`로 남는다 |
| `user.create` / `user.update` / `user.delete` | 관리자의 계정 생성·수정·삭제. 대량 생성(`POST /admin/users/bulk`)은 계정마다 1행, `after.bulk = true` |
| `user.cluster_role.set` / `user.cluster_role.unset` | 클러스터별 Read/Write/Admin 부여·회수. 직접 부여는 영구 — 그 뒤에 있던 승인된 권한 요청은 `superseded`/`revoked`로 닫힌다 |
| `access.request.create` / `.cancel` | 사용자가 이미 권한이 있는 클러스터에 더 높은 역할을 기간 한정으로 요청 / 본인이 대기 중 요청을 취소(`ACCESS_REQUESTS_ENABLED`). actor = target = 요청자, `cluster` = 대상 클러스터, `after` = `{request_id, role, current_role, duration_minutes, reason}`. 권한이 없는 클러스터에 대한 요청은 거부되고 `access.request.create` failure로 남는다 |
| `access.request.approve` / `.reject` | 관리자(`admin.users.update`, 본인 요청 불가, 상한 규칙)의 결정. 승인 = 임시 부여(`user_cluster_roles.expires_at`) + 요청자 토큰 폐기, `after`에 `expires_at`·`note`. 본인 요청·상한 위반 거부도 `failure`로 남는다 |
| `access.request.expire` | 대기 요청이 24 h 동안 결정되지 않아 소멸(`after.end_reason = not_reviewed`). actor `system` |
| `access.grant.expire` | 임시 부여가 기간을 다해 이전 역할로 복귀(`after.restored_role`, 없으면 `null` = 부여 삭제) + 토큰 폐기. actor `system`, 스위퍼 `ACCESS_REQUESTS_SWEEP_SEC`(기본 60 s) |
| `user.apikey.create` / `.delete` | API 키 발급·폐기(본인). `target_type = api_key`, `target_id` = 키 id, `target_email` = 소유자. `after` = `{name, key_prefix, cluster_ids, role_ceiling, expires_at}` — 키 값은 절대 안 남는다 |
| `user.apikey.exchange` | API 키를 액세스 토큰으로 교환(`POST /auth/token`). 성공·실패(모르는/폐기/만료 키, 소유자 없음·Pending) 모두 1행; actor = 키 소유자(키를 못 찾으면 actor 없음, `target_id` = 제시된 접두). 성공 `after`에 `akid`(키 id)와 토큰이 받은 `clusters` |
| `admin.apikey.delete` | 관리자(`admin.users.update`)가 남의 키를 폐기. target = 키(id), `target_email` = 소유자 |
| `admin.users.create` / `.read` / `.update` / `.delete` | 관리자 사용자 관리 |
| `admin.roles.create` / `.update` / `.delete` | 역할 생성·수정·삭제. `before`/`after` = `{name, description, permissions}` — 권한 목록 변경이 그대로 남는다 |
| `admin.organizations.create` / `.delete` | 조직(팀) 생성·삭제. `after`/`before` = `{type, name}` |
| `admin.cluster.register` / `.update` / `.delete` / `.test` | 클러스터 등록·수정·삭제·연결 테스트 |
| `user.cluster.switch` | 사용자가 클러스터 피커로 활성 클러스터를 바꿈(`POST /api/v1/audit/cluster-switch`, 프론트가 전환 시 fire-and-forget). `cluster` = 새 클러스터, `after` = `{previous, new}`. 모든 인증 사용자가 기록 가능, DB 쓰기 실패도 204. v0.6.0 전 행은 `cluster.switch` |
| `admin.audit.read` / `admin.audit.export` | 감사 로그 조회·CSV |
| `user.account.dormant_lock` | 휴면 계정 스위퍼(`DORMANT_ACCOUNTS_ENABLED`)가 활동(로그인·API 키 교환·생성) 없이 `DORMANT_ACCOUNTS_DAYS`가 지난 계정을 잠금 — actor `system`, target = 계정, `after` = `{last_activity, days, exempt_admins}`. 잠긴 계정의 로그인은 `user.login.failed` `reason: dormant`(OIDC는 `account_dormant`), 키 교환은 `user.apikey.exchange` failure `owner dormant` |
| `admin.dormant.sweep` | 관리자(`admin.users.update`)가 "지금 스위프" — `after` = `{cutoff, days, locked, users}` |
| `admin.users.unlock` | 관리자(`admin.users.update`)가 휴면 잠금·비밀번호 실패 잠금을 풂 — target = 계정, `before` = `{dormant_locked_at, locked_until}` |
| `admin.review.read` / `admin.review.export` / `admin.review.signoff` | 접근 권한 검토(Admin → Access review, `ACCESS_REVIEW_ENABLED`). 보고서 조회(`after.counts` = 섹션별 건수; 지난 서명의 스냅샷 열람은 `target_id` = 서명 id) · 섹션 CSV 내보내기(`after` = 섹션·행 수·`review_id`) · 검토 완료 서명(`access_reviews` 행 생성, `target_id` = 서명 id, `after` = 건수·메모). 실패는 `failure`로 남는다 |
| `admin.retention.purge` | 보존 기간(`RETENTION_AUDIT_DAYS`·`RETENTION_CHAT_DAYS`)이 지난 감사·채팅 행 삭제 — auth-service의 일일 작업, actor `system`. `after`에 기간·기준 시각·삭제 행 수(감사·세션·툴 승인); 실패면 `failure` |
| `audit.chain.anchor` | 감사 로그 해시 체인의 주기 앵커(`AUDIT_INTEGRITY_ANCHOR_SINK`·`_HOURS`) — actor `system`, `target_id` = 싱크 이름, `after` = `{from_seq, to_seq, rows, object_key, anchor_hash, sink}`; 싱크 쓰기 실패는 `failure` |
| `admin.audit.verify` | 관리자(`admin.audit.read`)의 체인 검증 — `after` = `{from_seq, to_seq, rows, ok, first_bad_seq, reason, anchors, objects}`; 범위 초과(413)·오류는 `failure` |
| `admin.audit.anchor` | 관리자(`admin.audit.export`)의 "지금 앵커" — `after`는 `audit.chain.anchor`와 같음, actor = 관리자 |
| `ai.tool.helm_execute` | AI 승인 경로의 Helm 쓰기 실행 |

**k8s-service (`k8s` / `helm`)** — 모든 행의 `cluster` = 요청이 가리킨 클러스터 id(`?cluster=`, 없으면 레지스트리 기본 클러스터 — self 클러스터, 없으면 가장 먼저 등록한 것). `request_ip` = 게이트웨이가 본 클라이언트 주소(`X-Real-IP`; `X-Forwarded-For`는 읽지 않음, 앞단 프록시는 차트 `gateway.trustedProxies`).

| 액션 | 뜻 |
|---|---|
| `k8s.<kind>.delete` | 리소스 삭제. kind = pod, deployment, statefulset, daemonset, replicaset, job, cronjob, hpa, vpa, pdb, service, ingress, ingressclass, networkpolicy, endpoints, endpointslice, gateway, gatewayclass, httproute, grpcroute, referencegrant, backendtlspolicy, configmap, secret, pv, pvc, storageclass, volumeattachment, namespace, node, serviceaccount, role, rolebinding, clusterrole, clusterrolebinding, crd, customresource, priorityclass, runtimeclass, lease, resourcequota, limitrange, mutatingwebhook, validatingwebhook, deviceclass, resourceclaim, resourceclaimtemplate, resourceslice |
| `k8s.namespace.create` / `k8s.namespace.apply` | 네임스페이스 생성·적용 |
| `k8s.yaml.create` / `k8s.yaml.apply` | YAML로 생성·적용 |
| `k8s.node.cordon` / `.uncordon` / `.drain` / `.edit` / `.delete` | 노드 조작 |
| `k8s.node.shell` | 노드 셸(민감 읽기). 시도 하나에 행 하나 — 디버그 Pod가 실행돼 셸을 넘기기 직전에 success, 시작하지 못하면 failure(`error` = 사유: 허용 목록에 없는 이미지 · Pod 생성 실패 · 시작 시간 초과와 마지막 대기 사유 · 셸 전에 Pod가 끝남 · 창을 닫음). 감사 저장소가 행을 못 받으면 Pod를 만들기 전에 503, success 행을 못 쓰면 셸을 넘기지 않음. 세션 기록이 켜져 있으면 `after.recording_id`(시작하지 못한 시도의 녹화는 지움) |
| `k8s.pod.exec` / `k8s.pod.logs.read` | Pod exec, 로그 읽기(민감 읽기). exec는 세션 기록이 켜져 있으면 `after.recording_id`; 기록을 시작하지 못해 거부한 세션은 failure 행(`error` = 사유). 로그는 한 번 읽기와 실시간 보기(`…/logs/stream`, 연결마다 한 줄, `after.follow = true`) 모두 기록 — 기록이 안 되면 한 번 읽기는 503, 실시간은 첫 줄 전에 끊음 |
| `k8s.access.denied` | 쓰기·민감 동작을 앱 권한이 거부함 — 권한 이름이 `.read`로 끝나지 않는 것(생성·편집·삭제·exec·노드 셸·Secret 값·로그 파일·롤백 등)과 `admin.*`. 읽기 거부는 기록하지 않음(화면이 목록을 자동으로 불러와 행이 쌓임). result = failure, `error` = 거부 문구, `after` = `{permission, method, path}`, cluster = 요청의 클러스터 |
| `k8s.pod.logfile.read` | 컨테이너 안 로그 파일 읽기(Pod 상세 → 로그 파일, `resource.pod.logfile`, `LOG_FILES_ENABLED`). 고정 명령(`tail`)을 사용자 신원의 `pods/exec`로 실행하므로 민감 읽기 — 기록이 안 되면 503. 본문·실시간 보기마다 한 줄, 파일 목록은 기록하지 않음. target = 파드, `after` = `{container, path, lines, follow}`. `resource.pod.logfile`이 없으면 403 + `k8s.access.denied` 한 줄; 권한이 있는데 허용 패턴·네임스페이스 밖이거나, Kubernetes가 exec를 거부하거나, 파일·`tail`이 없으면 failure 행(`error` = 사유) |
| `admin.session.read` | 세션 기록 본문 열람·내려받기(asciicast 또는 텍스트 사본, `admin.sessions.read`). target = 녹화 id, `after` = `{kind, cluster, target, user_email, format}` |
| `k8s.secret.reveal` | Secret 값 열람(민감 읽기) |
| `k8s.hygiene.scan` | 클러스터 위생 점검 보고서 조회(Admin → Cluster hygiene, `admin.hygiene.read`, `HYGIENE_ENABLED`). 사용자 신원으로 파드·네임스페이스·NetworkPolicy·RBAC와 `kubernetes.io/tls` Secret(인증서 만료일만 씀)을 읽으므로 민감 읽기 — 기록이 안 되면 503. target = 클러스터, `after` = `{counts: {critical, warning, info, exempt}, findings, collector_failures}`; 목록을 못 읽은 것은 보고서의 Collector 행 |
| `admin.hygiene.export` / `admin.hygiene.signoff` / `admin.hygiene.read` | 위생 점검 CSV·JSON 내보내기(`admin.hygiene.export`, 스캔을 포함한 한 줄, `after` = 건수·`format`) · 클러스터별 서명(`admin.hygiene.signoff`, `hygiene_reviews` 행 생성, `target_id` = 서명 id, `after` = 건수·메모) · 지난 서명의 스냅샷 열람(`admin.hygiene.read`, `target_id` = 서명 id). 실패는 `failure` |
| `k8s.cronjob.trigger` / `.suspend` / `.resume` | CronJob 조작 |
| `k8s.cluster.kubeconfig.read` | tool-server가 클러스터 kubeconfig를 읽음(민감 읽기) |
| `helm.release.reveal` | 릴리스의 manifest·values·hooks·diff를 **마스킹 없이** 읽음 — `resource.secret.reveal` 보유자만(없으면 Secret 문서 제거·민감 값 마스킹 후 반환, 기록 없음). `after.section` = manifest/values/hooks/diff/detail |
| `helm.release.upgrade` / `.rollback` / `.uninstall` / `.test` | Helm 쓰기(dry-run은 기록하지 않음; uninstall은 `?confirm=<release>` 필수) |

**ai-service (`ai`)** — `cluster` = 요청의 `X-Cluster-Name`, 없으면 k8s-service가 정한 기본 클러스터(`GET /api/v1/cluster/current`). 세션 관리처럼 클러스터와 무관한 행은 비운다.

| 액션 | 뜻 |
|---|---|
| `ai.chat.send` | 채팅 메시지 수신(스트림 시작) |
| `ai.chat.complete` | 채팅 턴 완료(오류로 끝나면 `failure`; 사용자가 중단·이탈하면 `finish_reason: cancelled`로 그때까지의 값) 또는 Optimization 화면의 AI 설명 완료(오류·중단도 같은 규칙). `after`에 `phase`(`chat` = 채팅 턴, `target_type: session` / `optimization` = AI 설명, 세션 없음, `target_type: namespace`·`target_id` = 네임스페이스, 모델 호출 1회라 `iterations 1`·`tool_calls 0`)·`provider`·`model`·`cluster`·`prompt_tokens`/`completion_tokens`/`total_tokens`(제공자가 usage를 안 보내면 null)·`tool_calls`·`iterations`·`duration_ms`·`finish_reason`. `cluster` 컬럼 = 턴이 실행된 클러스터(모든 `ai.*` 행 동일). Admin → AI Usage 화면의 원본 |
| `ai.tool.call` | 모델이 읽기 툴 호출. `after`에 툴·인자·`redacted{count,kinds}` |
| `ai.tool.approval_requested` / `ai.tool.approve` / `ai.tool.reject` | 쓰기 툴 승인 요청·승인·거절 |

`services/pkg/audit`에 상수로 있는 `admin.clusters.*`(create/list/update/delete)와 예시용 `helm.release.rollback`·`k8s.pod.delete`는 위 표의 실제 액션과 같은 뜻이다.

### 5-3. 새 액션 추가 절차

1. §5-2에 행 추가(PR에 포함).
2. 핸들러에서 성공·실패 모두 기록, `Before`/`After` 마스킹.
3. `docs/*-plan.md`를 새로 쓰는 기능이면 `## N. 감사 로그` 절에 대상 액션과 권한 매핑 표.

### 4-1 세션 기록(선택)

- Pod exec·노드 셸 터미널에 **찍힌 출력**(사용자가 본 화면)을 asciicast v2로 녹화한다. 키 입력은 남기지 않는다(비밀번호처럼 에코되지 않는 입력이 남지 않게; asciinema 권고와 같음). 세션 시작 때 터미널에 "이 세션은 기록됩니다" 한 줄이 찍힌다.
- k8s-service가 로컬 볼륨에 쓰고 **세션 중에도 `chunkSeconds`(기본 30 s)마다 조각**을 저장소에 올린다 — k8s-service 파드가 사라져도 잃는 건 마지막 조각 간격만큼. 저장소 = `s3`(S3 호환) · `database`(`session_recording_parts`, 세션당 1 MiB 상한) · `file`(PVC). 목록·상태는 `session_recordings`.
- k8s-service 쪽 사정으로 끊긴 세션은 `interrupted`: 정상 종료·컨테이너 재시작은 남은 출력까지 올리고, 파드가 사라지면 그 전에 올린 조각만 남는다(`last_error`에 사유).
- 녹화를 시작하지 못하면(로컬 볼륨에 못 씀) `required: true`(기본)일 때 세션을 거부한다. 업로드 실패(조각당 30 s 제한)는 세션을 막지 않고 재시도하며 메트릭·알람으로 드러난다. 세션당 `maxBytes`(기본 64 MiB)를 넘으면 녹화만 멈추고 마커와 `truncated`를 남긴다.
- 원격 저장소의 객체는 Kubeast가 지우지 않는다(버킷 수명주기·Object Lock). DB 행은 `retention.auditDays`를 따른다.

## 6. 보존

- DB 행은 `RETENTION_AUDIT_DAYS`(차트 `retention.auditDays`, 기본 0 = 무기한)가 지난 것만 auth-service가 매일 지운다(관리자 화면은 조회·CSV만). 싱크가 하나라도 있으면 **모든 싱크가 보낸 행까지만** 지운다 — 멈춘 싱크가 있으면 기간이 지나도 남는다.
- 검토 서명(접근 권한 검토 `access_reviews`, 클러스터 위생 점검 `hygiene_reviews`, 스냅샷 포함)은 `RETENTION_REVIEW_DAYS`(차트 `retention.reviewDays`, 기본 1095일)가 지나면 같은 일일 작업이 지운다(`admin.retention.purge`의 `after.access_reviews`·`hygiene_reviews`).
- 장기 보관은 S3 싱크(+ 버킷 Object Lock 기본 보존)로: DB는 콘솔 화면·CSV·fail-closed에 필요한 기간만(S3를 켰다면 90일 정도 권장).
- 해시 체인이 켜져 있으면 purge는 **체인 접두만** 지운다: 보존 기간 안 행 중 가장 작은 `chain_seq`보다 뒤에 봉인된 옛 행(늦게 커밋된 행)은 체인이 거기 닿을 때까지 남는다. `audit_anchors`는 지우지 않는다(작고, 지난 구간의 증거).
- stdout 사본은 클러스터 운영자의 로그 파이프라인 정책(수집·보존·잠금)에 따른다.

## 7. 확인 방법

- 단위: `services/pkg/audit` 테스트(스토어·마스킹·stdout 줄 형식).
- e2e: 쓰기 동작 뒤 `GET /api/v1/auth/admin/audit-logs?action=<name>`에 행이 있고, 파드 로그에 `"event":"audit"` 줄이 같은 수만큼 있는지.
- 무결성: `internal/auditchain` 테스트(해시·봉인 순서·변경/삭제/끼워넣기 탐지·앵커 다이제스트·구간 독립) + e2e `audit-integrity.spec.ts`(행 봉인 → psql 한 줄 재계산 일치 → DB에서 행 고침 → `hash_mismatch` 그 순번 → 원복 → 앵커 → 스탠드인 객체·`object_ok`). Kubeast 없이 psql로: `select chain_seq, encode(row_hash,'hex') = encode(sha256(prev_hash || '\x1e'::bytea || convert_to(<CanonSQL>, 'UTF8')), 'hex') from auth_audit_logs where chain_seq between a and b order by chain_seq;` + 앞 행 `row_hash` = 이 행 `prev_hash`, 마지막 행 = 다이제스트 `head_hash`.

## 8. 개발 규칙 영속화

이 문서의 §2 원칙과 §5 카탈로그는 [AGENTS.md](../AGENTS.md)의 "감사 로그 필수 규칙"이 참조한다. 쓰기 핸들러를 추가·수정하면서 감사 기록이 없는 PR은 받지 않는다. 규칙을 바꾸면 이 문서와 AGENTS.md를 같은 PR에서 고친다.
