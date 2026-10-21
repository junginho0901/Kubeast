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
| D4 | **DB 행은 민감 동작의 선행 조건**(fail-closed), stdout 미러만 best-effort. 감사 DB에 기록할 수 없으면 쓰기와 민감 읽기는 503 `audit unavailable`, 목록·조회는 계속. 이미 실행된 변경의 사후 쓰기 실패는 세고 ERROR 로그, 응답은 유지. 부팅 때 DB가 없으면 기다렸다가(`AUDIT_DB_WAIT_SEC` 90 s) 종료 — 로그 전용 폴백 없음(NIST AU-5(4) 제한 모드·Vault 감사 장치·kube-apiserver `--audit-log-mode blocking`과 같은 방향) | k8s-service: `audit.Guarded`(핑 캐시 2 s·실패 카운터·`/health` `audit` 블록) + 변경 라우트 `audit.RequireWritable`(POST `/search` 제외) + 조건부 감사 GET 핸들러의 `auditReady`/`refuseUnaudited`. auth-service: 같은 `audit.Guarded` + 로그인한 라우트에 `RequireWritable`(토큰 갱신·본인 비밀번호 변경·클러스터 전환 신호 제외 — 로그인·로그아웃·API 키 교환은 원래 그 밖) + 감사 로그·권한 검토·AI 사용량·디렉터리 그룹 읽기 전 준비 확인(2026-10-21, 관리자 쓰기만 거부). session-service: 같은 `audit.Guarded` + 대화방 이름 변경·삭제에 `RequireWritable`. ai-service: `require_audit_ready()`가 승인된 쓰기 툴 실행·거절·AI 모델 설정 추가·수정·삭제 전, 채팅 도구·알림 조사는 실행 전 `audit_ready()`(안 되면 도구 결과 `audit_unavailable`, 조사는 실패로). **쓰기 실패 뒤 시험 쓰기**: 핑(SELECT 1)만으로는 DB는 살아 있고 감사 표만 행을 못 받는 경우(디스크·잠금·트리거)를 못 잡으므로, 감사 행 쓰기가 한 번 실패하면 준비 확인이 행을 넣었다 되돌리는 시험 쓰기로 바뀌고 쓸 수 있을 때까지 거부(`audit.WriteProber`, Python `_write_broken`). 스위치 `AUDIT_FAIL_CLOSED`(기본 true, 차트 `audit.failClosed`) |
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
| `user.cluster_role.set` / `user.cluster_role.unset` | 클러스터별 Read/Write/Admin(또는 커스텀) 부여·회수. `after.role`, 네임스페이스 범위 부여면 `after.namespaces`(부여당 최대 50, 토큰 `ns` 클레임으로 감). 직접 부여는 영구 — 그 뒤에 있던 승인된 권한 요청은 `superseded`/`revoked`로 닫힌다. 상한 위반(권한·네임스페이스 모두)은 `failure` · OIDC 로그인 때 그룹으로 바뀐 클러스터 권한도 같은 액션(`after.via = oidc`, actor = 그 사용자, 2026-10-21) |
| `access.request.create` / `.cancel` | 사용자가 이미 권한이 있는 클러스터에 더 높은 역할을 기간 한정으로 요청 / 본인이 대기 중 요청을 취소(`ACCESS_REQUESTS_ENABLED`). actor = target = 요청자, `cluster` = 대상 클러스터, `after` = `{request_id, role, current_role, duration_minutes, reason, namespaces?}`(요청자의 부여가 네임스페이스 범위면 그 안에서만 요청 가능). 권한이 없는 클러스터에 대한 요청은 거부되고 `access.request.create` failure로 남는다 |
| `access.request.approve` / `.reject` | 관리자(`admin.users.update`, 본인 요청 불가, 상한 규칙)의 결정. 승인 = 임시 부여(`user_cluster_roles.expires_at`, 요청의 `namespaces` 그대로; 만료 때 이전 부여의 네임스페이스로 복원) + 요청자 토큰 폐기, `after`에 `expires_at`·`note`·`namespaces?`. 본인 요청·상한 위반 거부도 `failure`로 남는다 |
| `access.request.expire` | 대기 요청이 24 h 동안 결정되지 않아 소멸(`after.end_reason = not_reviewed`). actor `system` · 스위퍼가 상태를 못 바꾸면 같은 액션의 failure(2026-10-21) |
| `access.grant.expire` | 임시 부여가 기간을 다해 이전 역할로 복귀(`after.restored_role`, 없으면 `null` = 부여 삭제) + 토큰 폐기. actor `system`, 스위퍼 `ACCESS_REQUESTS_SWEEP_SEC`(기본 60 s) · 되돌리기를 못 하면 같은 액션의 failure(2026-10-21) |
| `user.apikey.create` / `.delete` | API 키 발급·폐기(본인). `target_type = api_key`, `target_id` = 키 id, `target_email` = 소유자. `after` = `{name, key_prefix, cluster_ids, role_ceiling, expires_at}` — 키 값은 절대 안 남는다 |
| `user.apikey.exchange` | API 키를 액세스 토큰으로 교환(`POST /auth/token`). 성공·실패(모르는/폐기/만료 키, 소유자 없음·Pending) 모두 1행; actor = 키 소유자(키를 못 찾으면 actor 없음, `target_id` = 제시된 접두). 성공 `after`에 `akid`(키 id)와 토큰이 받은 `clusters` |
| `admin.apikey.delete` | 관리자(`admin.users.update`)가 남의 키를 폐기. target = 키(id), `target_email` = 소유자 |
| `admin.oidc.groups.read` | 관리자(`admin.users.read`)가 한 사용자의 Google Workspace 그룹 조회 결과와 매핑을 미리 봄(`GET /api/v1/auth/admin/oidc/groups?email=`, `auth.oidc.googleGroups`). target = 그 이메일, `after` = `{mapped_groups, other_groups, role, cluster_grants}`(개수와 역할만 — 그룹 이름은 남기지 않음), 조회 실패면 result failure |
| `admin.roles.create` / `.update` / `.delete` | 역할 생성·수정·삭제. `before`/`after` = `{name, description, permissions}` — 권한 목록 변경이 그대로 남는다 |
| `admin.organizations.create` / `.delete` | 조직(팀) 생성·삭제. `after`/`before` = `{type, name}` |
| `admin.cluster.register` / `.update` / `.delete` / `.test` | 클러스터 등록·수정·삭제·연결 테스트. `.update`의 `after`에는 외부 Prometheus 소스(`prometheus_url`·`prometheus_cluster_label`·`prometheus_auth`(있음/없음)·`prometheus_auth_change: set|cleared`)와 지정 Service(`prometheus_service`)가 들어가고 인증 헤더 값은 Secret `cluster-prometheus-<id>`에만 있어 기록되지 않는다. API 서버 주소를 비워 등록하면 연결 확인이 본 주소가 들어가고, 주소가 빈 클러스터는 연결 테스트가 채움(`.test`의 `after.server`) · 등록·kubeconfig 교체에서 kubeconfig 거부(허용 안 된 exec 명령·TLS 검증 끄기 등)·연결 확인 실패, 같은 클러스터 중복 등록·교체 kubeconfig가 다른 클러스터를 가리킴(409), 수정 중 kubeconfig·인증값 저장 실패(앞 단계는 이미 바뀐 채)도 failure — kubeconfig 내용은 안 남김(2026-10-21) |
| `user.cluster.switch` | 사용자가 클러스터 피커로 활성 클러스터를 바꿈(`POST /api/v1/audit/cluster-switch`, 프론트가 전환 시 fire-and-forget). `cluster` = 새 클러스터, `after` = `{previous, new}`. 모든 인증 사용자가 기록 가능, DB 쓰기 실패도 204. v0.6.0 전 행은 `cluster.switch` |
| `admin.audit.read` / `admin.audit.export` | 감사 로그 조회·CSV |
| `user.account.dormant_lock` | 휴면 계정 스위퍼(`DORMANT_ACCOUNTS_ENABLED`)가 활동(로그인·API 키 교환·생성) 없이 `DORMANT_ACCOUNTS_DAYS`가 지난 계정을 잠금 — actor `system`, target = 계정, `after` = `{last_activity, days, exempt_admins}`. 잠긴 계정의 로그인은 `user.login.failed` `reason: dormant`(OIDC는 `account_dormant`), 키 교환은 `user.apikey.exchange` failure `owner dormant` · 예약 스위프의 잠금 실패도 failure(2026-10-21) |
| `admin.dormant.sweep` | 관리자(`admin.users.update`)가 "지금 스위프" — `after` = `{cutoff, days, locked, users}` |
| `admin.users.unlock` | 관리자(`admin.users.update`)가 휴면 잠금·비밀번호 실패 잠금을 풂 — target = 계정, `before` = `{dormant_locked_at, locked_until}` |
| `admin.review.read` / `admin.review.export` / `admin.review.signoff` | 접근 권한 검토(Admin → Access review, `ACCESS_REVIEW_ENABLED`). 보고서 조회(`after.counts` = 섹션별 건수; 지난 서명의 스냅샷 열람은 `target_id` = 서명 id) · 섹션 CSV 내보내기(`after` = 섹션·행 수·`review_id`) · 검토 완료 서명(`access_reviews` 행 생성, `target_id` = 서명 id, `after` = 건수·메모). 실패는 `failure`로 남는다 |
| `admin.retention.purge` | 보존 기간(`RETENTION_AUDIT_DAYS`·`RETENTION_CHAT_DAYS`)이 지난 감사·채팅 행 삭제 — auth-service의 일일 작업, actor `system`. `after`에 기간·기준 시각·삭제 행 수(감사·세션·툴 승인); 실패면 `failure` |
| `audit.chain.anchor` | 감사 로그 해시 체인의 주기 앵커(`AUDIT_INTEGRITY_ANCHOR_SINK`·`_HOURS`) — actor `system`, `target_id` = 싱크 이름, `after` = `{from_seq, to_seq, rows, object_key, anchor_hash, sink}`; 싱크 쓰기 실패는 `failure` |
| `admin.audit.verify` | 관리자(`admin.audit.read`)의 체인 검증 — `after` = `{from_seq, to_seq, rows, ok, first_bad_seq, reason, anchors, objects}`; 범위 초과(413)·오류는 `failure` |
| `admin.audit.anchor` | 관리자(`admin.audit.export`)의 "지금 앵커" — `after`는 `audit.chain.anchor`와 같음, actor = 관리자 |

**k8s-service (`k8s` / `helm`)** — 모든 행의 `cluster` = 요청이 가리킨 클러스터 id(`?cluster=`, 없으면 레지스트리 기본 클러스터 — self 클러스터, 없으면 가장 먼저 등록한 것). `request_ip` = 게이트웨이가 본 클라이언트 주소(`X-Real-IP`; `X-Forwarded-For`는 읽지 않음, 앞단 프록시는 차트 `gateway.trustedProxies`).

| 액션 | 뜻 |
|---|---|
| `k8s.<kind>.delete` | 리소스 삭제. kind = pod, deployment, statefulset, daemonset, replicaset, job, cronjob, hpa, vpa, pdb, service, ingress, ingressclass, networkpolicy, endpoints, endpointslice, gateway, gatewayclass, httproute, grpcroute, referencegrant, backendtlspolicy, configmap, secret, pv, pvc, storageclass, volumeattachment, namespace, node, serviceaccount, role, rolebinding, clusterrole, clusterrolebinding, crd, customresource, priorityclass, runtimeclass, lease, resourcequota, limitrange, mutatingwebhook, validatingwebhook, deviceclass, resourceclaim, resourceclaimtemplate, resourceslice |
| `k8s.namespace.create` / `k8s.namespace.apply` | 네임스페이스 생성·적용 |
| `k8s.yaml.create` / `k8s.yaml.apply` | YAML로 생성·적용. create는 빈 YAML이면 400으로 끝나 행이 없음(문서마다 그 kind의 create 권한). apply는 `features.admissionPolicies.readOnly`가 켜진 설치에서 ValidatingAdmissionPolicy·MutatingAdmissionPolicy와 그 바인딩을 적용 전에 거부하고 `failure` 행(`error` = "admission policies are read-only …")을 남김 |
| `k8s.<kind>.rollback` | Deployment·StatefulSet·DaemonSet 롤백(`POST …/{kind}/{name}/rollback`). `after` = 돌아간 리비전 |
| `k8s.node.cordon` / `.uncordon` / `.drain` / `.edit` / `.delete` | 노드 조작. drain은 시작(수락) 행(`after.phase = started`) + 끝날 때 한 행 더(`after.phase = finished`, `status`·`message` — 축출 못 한 파드·시간 초과면 failure, 2026-10-21) |
| `k8s.node.shell` | 노드 셸(민감 읽기). 시도 하나에 행 하나 — 디버그 Pod가 실행돼 셸을 넘기기 직전에 success, 시작하지 못하면 failure(`error` = 사유: 허용 목록에 없는 이미지 · Pod 생성 실패 · 시작 시간 초과와 마지막 대기 사유 · 셸 전에 Pod가 끝남 · 창을 닫음). 감사 저장소가 행을 못 받으면 Pod를 만들기 전에 503, success 행을 못 쓰면 셸을 넘기지 않음. 세션 기록이 켜져 있으면 `after.recording_id`(시작하지 못한 시도의 녹화는 지움) |
| `k8s.pod.exec` / `k8s.pod.logs.read` | Pod exec, 로그 읽기(민감 읽기). exec는 세션 기록이 켜져 있으면 `after.recording_id`; 기록을 시작하지 못해 거부한 세션은 failure 행(`error` = 사유). 로그는 한 번 읽기와 실시간 보기(`…/logs/stream`, 연결마다 한 줄, `after.follow = true`) 모두 기록 — 기록이 안 되면 한 번 읽기는 503, 실시간은 첫 줄 전에 끊음 · exec가 열린 뒤 클러스터 연결·스트림 시작이 실패하면 failure 행을 하나 더(2026-10-21) |
| `k8s.access.denied` | 쓰기·민감 동작을 앱 권한이 거부함 — 권한 이름이 `.read`로 끝나지 않는 것(생성·편집·삭제·exec·노드 셸·Secret 값·로그 파일·롤백 등)과 `admin.*`. 읽기 거부는 기록하지 않음(화면이 목록을 자동으로 불러와 행이 쌓임). result = failure, `error` = 거부 문구, `after` = `{permission, method, path}`, cluster = 요청의 클러스터 네임스페이스 범위 부여(토큰 `ns`)가 범위 밖 네임스페이스 경로를 거부한 것도 같은 액션(`target_type: namespace`, `after.permission: "namespace scope"`, `after.namespaces` = 부여 목록) — 읽기는 지금처럼 행 없음 |
| `k8s.gitops.refuse` | Argo CD가 관리하는 객체의 쓰기를 가드가 409로 거부(`gitops.argocd.mode: block`). 권한 거부와 같은 "막힌 시도" — `target_type` = 종류, `target_id` = 이름, `after` = `{app, method, path, by}`, 늘 failure(2026-10-21) |
| `k8s.pod.logs.search` | 로그 저장소(Loki) 검색(민감 읽기, `features.logSearch`). `GET /api/v1/namespaces/{ns}/logsearch`(그 NS) · `GET /api/v1/cluster/logsearch`(전체 NS, k8s-service `/api/v1/logsearch` — 그 클러스터에 네임스페이스 범위 부여가 있으면 403). `resource.pod.read` + 사용자 신원으로 `get pods/log`(그 NS 또는 전체)를 물어 허용될 때만 — 기록이 안 되면 503. 검색마다 한 줄, 줄 본문은 남기지 않음. target = 네임스페이스(전체면 빈 값), `after` = `{q(200자까지), match, ignore_case, pod, container, workload, range_seconds, limit, lines, truncated, bytes}`. Kubernetes가 `pods/log`를 거부(403)·사용자별 분당 한도 초과(429)·저장소 오류(502·504)는 failure 행(`error` = 사유) |
| `k8s.pod.logs.logql` | 사람이 화면에서 직접 쓴 LogQL(민감 읽기, `features.logSearch.logql` — 10-19부터 로그 검색을 쓸 수 있는 사람 누구나, `admin.logsearch.query` 폐지). `GET /api/v1/namespaces/{ns}/logsearch/query`(그 NS) · `GET /api/v1/cluster/logsearch/query`(전체 NS, 범위 부여가 있으면 403). 문은 `k8s.pod.logs.search`와 같음. target = 네임스페이스, `after` = `{logql(1,000자까지, 쓴 그대로), effective(1,200자까지, 클러스터·NS 매처가 더해져 실제로 보낸 질의), range_seconds, limit, lines, truncated, bytes}`. 거부(403)·한도(429)·질의 거부(400 — 선택자 없음·리터럴/주석 미종결·메트릭 쿼리)·저장소 오류(502·504)는 failure 행. **AI의 `loki_query`·`loki_patterns`가 쓰는 경로도 같은 액션**: `GET …/logsearch/logql`(로그·메트릭 쿼리, `admin.logsearch.query` 없이 구조화 검색의 문 그대로) · `GET …/logsearch/patterns`(패턴) — `after`에 `kind`(`log`·`metric`·`patterns`)가 붙고 메트릭이면 `lines` 대신 `series`(시리즈 수), 패턴이면 `patterns`(개수); 줄·패턴 글자는 남기지 않음. 레이블 목록 `GET …/logsearch/labels`는 로그 줄이 아니라 감사하지 않음 |
| `k8s.traces.query` | AI의 `traces_*` 도구가 트레이스 저장소(Tempo, `features.traceStore`)를 읽음(민감 읽기 — 스팬 속성에 요청 내용이 들 수 있음). `GET /api/v1/[namespaces/{ns}/]traces/{search,metrics,compare}`(TraceQL — k8s-service가 모든 스팬셋 필터 `{ }`에 `resource.<클러스터 속성> = "<값>"`(NS 경로면 `resource.<NS 속성> = "<ns>"`도)을 AND로 넣음, `parent.`·루트 스팬·트레이스 전체 시간·트리 위치를 읽는 질의는 400) · `GET …/traces/trace/{traceID}`(그 클러스터·NS 스팬만 돌려줌). 문은 `k8s.pod.logs.search`와 같음(Pod 읽기 + 사용자 신원 `get pods/log` + 분당 한도 + 감사 준비). target = 네임스페이스, `after` = `{kind(search·metrics·compare·trace), traceql(1,000자), effective(1,200자, 실제로 보낸 질의), range_seconds, traces·series·spans·hidden(범위 밖 스팬 수)·trace_id}` — 스팬 내용 없음. 거부(403)·한도(429)·질의 거부(400)·저장소 오류(502·504)·없는 트레이스(404)도 failure 행. 속성 이름·값 목록 `…/traces/tags`는 감사하지 않음 |
| `k8s.pod.logfile.read` | 컨테이너 안 로그 파일 읽기(Pod 상세 → 로그 파일, `resource.pod.logfile`, `LOG_FILES_ENABLED`). 고정 명령(`tail`)을 사용자 신원의 `pods/exec`로 실행하므로 민감 읽기 — 기록이 안 되면 503. 본문·실시간 보기마다 한 줄, 파일 목록은 기록하지 않음. target = 파드, `after` = `{container, path, lines, follow}`. `resource.pod.logfile`이 없으면 403 + `k8s.access.denied` 한 줄; 권한이 있는데 허용 패턴·네임스페이스 밖이거나, Kubernetes가 exec를 거부하거나, 파일·`tail`이 없으면 failure 행(`error` = 사유) |
| `admin.session.read` | 세션 기록 본문 열람·내려받기(asciicast 또는 텍스트 사본, `admin.sessions.read`). target = 녹화 id, `after` = `{kind, cluster, target, user_email, format}` |
| `k8s.secret.reveal` | Secret 값 열람(민감 읽기) |
| `k8s.hygiene.scan` | 클러스터 위생 점검 보고서 조회(Admin → Cluster hygiene, `admin.hygiene.read`, `HYGIENE_ENABLED`). 사용자 신원으로 파드·네임스페이스·NetworkPolicy·RBAC와 `kubernetes.io/tls` Secret(인증서 만료일만 씀), 업그레이드 준비 점검용으로 노드·PDB·웹훅 구성·Service·EndpointSlice·CRD·kube-proxy ConfigMap·`/metrics`·Helm 릴리스 매니페스트를 읽으므로 민감 읽기 — 기록이 안 되면 503. target = 클러스터, `after` = `{counts: {critical, warning, info, exempt}, findings, collector_failures}`; 목록을 못 읽은 것은 보고서의 Collector 행 |
| `admin.hygiene.export` / `admin.hygiene.signoff` / `admin.hygiene.read` | 위생 점검 CSV·JSON 내보내기(`admin.hygiene.export`, 스캔을 포함한 한 줄, `after` = 건수·`format`) · 클러스터별 서명(`admin.hygiene.signoff`, `hygiene_reviews` 행 생성, `target_id` = 서명 id, `after` = 건수·메모) · 지난 서명의 스냅샷 열람(`admin.hygiene.read`, `target_id` = 서명 id). 실패는 `failure` |
| `k8s.cronjob.trigger` / `.suspend` / `.resume` | CronJob 조작 |
| `k8s.pod.resize` | 최적화 제안을 재시작 없이 적용(`POST /namespaces/{ns}/optimization/resize`, `resource.pod.edit`, `IN_PLACE_RESIZE_ENABLED`, 서버 1.35+). 워크로드의 파드마다 `resize` 하위 리소스로 컨테이너 requests(·limits)를 바꿈 — target = 워크로드(kind/name); Pod 드로어의 "리소스 조정"은 같은 호출을 `kind: Pod`로 보내 target = 그 파드(소유자와 무관하게 이름으로), `after` = `{container, cpu_request_m, mem_request_bytes, pods, resized, skipped, failed, results[]}`(파드별 resized/skipped/error + 사유). 호출 하나에 행 하나, 실패는 `failure` |
| `k8s.cluster.kubeconfig.read` | tool-server가 클러스터 kubeconfig를 읽음(민감 읽기) |
| `helm.release.reveal` | 릴리스의 manifest·values·hooks·diff와 롤백·값 변경 **미리 보기(dry-run) diff**를 **마스킹 없이** 읽음 — `resource.secret.reveal` 보유자만(없으면 Secret 문서 제거·민감 값 마스킹 후 반환, 기록 없음; diff는 양쪽 원문을 먼저 가린 뒤 만든 diff — diff 출력을 가리면 +/- 줄 머리 때문에 값이 남음). `after.section` = manifest/values/hooks/diff/detail/`rollback dry-run`/`upgrade dry-run` |
| `helm.release.upgrade` / `.rollback` / `.uninstall` / `.test` | Helm 쓰기(dry-run은 기록하지 않음; uninstall은 `?confirm=<release>` 필수) — dry-run은 이 액션으로 안 남고, 그 diff를 원문으로 보면 `helm.release.reveal` |

**ai-service (`ai`)** — `cluster` = 요청의 `X-Cluster-Name`, 없으면 k8s-service가 정한 기본 클러스터(`GET /api/v1/cluster/current`). 세션 관리처럼 클러스터와 무관한 행은 비운다.

| 액션 | 뜻 |
|---|---|
| `ai.chat.send` | 채팅 메시지 수신(스트림 시작) |
| `ai.chat.complete` | 채팅 턴 완료(오류로 끝나면 `failure`; 사용자가 중단·이탈하면 `finish_reason: cancelled`로 그때까지의 값) 또는 Optimization 화면의 AI 설명 완료(오류·중단도 같은 규칙). `after`에 토큰 합계 외에 `cached_tokens`·`cache_creation_tokens`(제공자 캐시 적중·생성분, 제공자가 안 보내면 null)·`prompt_chars`(ai-service가 보낸 프롬프트 크기 — 시스템·도구 정의·이력·메시지 JSON 문자 수, 모델 호출 합)·`model_calls`. `after`에 `phase`(`chat` = 채팅 턴, `target_type: session` / `optimization` = AI 설명, 세션 없음, `target_type: namespace`·`target_id` = 네임스페이스, 모델 호출 1회라 `iterations 1`·`tool_calls 0`)·`provider`·`model`·`cluster`·`prompt_tokens`/`completion_tokens`/`total_tokens`(제공자가 usage를 안 보내면 null)·`tool_calls`·`iterations`·`duration_ms`·`finish_reason`. `cluster` 컬럼 = 턴이 실행된 클러스터(모든 `ai.*` 행 동일). Admin → AI Usage 화면의 원본 |
| `ai.chat.budget_exceeded` | 채팅 토큰 예산(`ai.chat.budget.sessionTokens` 세션 누적 · `ai.chat.budget.userDailyTokens` 사용자 UTC 하루 누적, 기본 0 = 끔)을 넘어 턴을 모델 호출 없이 거부(`failure`). 사용량은 `ai.chat.complete` 행의 `total_tokens` 합(Admin AI 사용량과 같은 값). `after`에 `session_id`·`budget`(`session` / `user_daily`)·`used`·`limit`. 사용자 메시지는 저장하지 않고 `ai.chat.send`·`ai.chat.complete`도 남기지 않음. Optimization AI 설명도 사용자 하루 예산을 넘으면 같은 액션(대상 `namespace`, `after.phase` = `optimization`, 관측 표는 보이고 모델은 안 부름) |
| `ai.chat.summarize` | 채팅 이력 요약 갱신 1회(이력 창 밖으로 밀린 메시지를 같은 모델이 메모 하나로 적어 `session_contexts.state.summary`의 메모 목록에 덧붙임, 상한을 넘으면 오래된 절반을 하나로 합침, `ai.chat.summary.enabled`). `after`에 `session_id`·`messages_summarized`(이번에 접은 메시지 수)·`messages_total`(요약이 덮는 누적 수)·`upto_message_id`·`summary_chars`·`notes`(메모 수)·`compacted`(이번에 합쳤는지)·`model`·`model_calls`·토큰(`prompt_tokens`·`completion_tokens`·`prompt_chars`). 요약 본문은 저장하지 않음(마스킹된 본문은 세션 컨텍스트에만). 모델 호출이 실패하면 `failure` + `error`, 채팅은 새 메모 없이 계속 |
| `ai.session.rename` / `ai.session.delete` | 채팅 대화방 이름 변경·삭제(session-service, 서비스 이름 `ai`). `target_type: session`, `target_id` = 대화방 ID, `before`/`after` = 제목. 삭제는 기록을 지우는 일이라 감사 저장이 안 되면 503(D4). 만들기·메시지 저장은 질문·답마다 `ai.chat.send`/`ai.chat.complete`(멈춘 답은 `finish_reason: cancelled`)가 같은 사실이라 안 남김(2026-10-21) |
| `ai.tool.call` | 모델이 읽기 툴 호출(채팅·플로팅·알림 조사). `after` = 툴·`resource_type`·`status`(도구가 돌려준 상태, 예: `not_found`)·`redacted{count,kinds}` — 인자 값은 안 남김. failure = 도구 오류·권한 거부·`not_permitted`·감사 저장 불가로 실행 안 함(2026-10-21) |
| `ai.tool.execute` | 승인된 쓰기 툴의 실제 실행(Helm 쓰기 `helm_execute` 포함) — 성공·실패. 2026-10-21 전에는 `ai.tool.call`로 남았음 |
| `ai.tool.approval_requested` / `ai.tool.approve` / `ai.tool.reject` | 쓰기 툴 승인 요청·승인·거절 · 거절도 감사 저장이 안 되면 503(D4), 이미 결정됐거나 없는 승인은 failure(2026-10-21) |
| `ai.mcp.call` | 외부 AI 에이전트가 MCP 서버(`/api/v1/ai/mcp`, `MCP_ENABLED`)로 툴 호출 — 읽기 툴, 그리고 `MCP_WRITE_TOOLS`가 켜져 있고 키 상한이 Write일 때 채팅의 쓰기 툴 11(`after.write: true`; 승인 카드 없이 그 사람 권한·JIT 그대로 — tool-server의 승인 게이트(`AI_WRITE_APPROVAL`)는 MCP 서버가 호출마다 서명한 승인 토큰 `after.approval_id: mcp-…`로 통과, Argo CD 가드는 block이면 거부·warn이면 결과에 경고 줄)과 접근 요청 툴 `request_access`(auth-service `access.request.create` 행도 남음). actor = 토큰의 사용자(API 키면 그 소유자), `cluster` = 호출 인자의 클러스터, `target_type`/`target_id`는 `ai.tool.call`과 같은 규칙. `after` = `{tool, resource_type, redacted{count,kinds}, credential: {type: api_key \| session, akid}, client}`(`client` = User-Agent). 권한 없음(`ai.mcp.use`·`ai.tool.<name>`이 그 클러스터에 없음)·툴 오류·감사 저장 불가는 `failure` + `error`. `tools/list`·`initialize`는 조회라 안 남김 |
| `ai.investigation.run` | 알림 → AI 조사(`features.alertInvestigation`) 1건이 끝남 — 성공(`done`) 또는 실패(토큰 발급·모델·도구·시간 초과, `failure` + `error`). 사람 없이 돌아 actor = `system` / `kubeast:investigator`(조사 토큰의 sub·email). `cluster` = 웹훅 `?cluster=`, `namespace` = 알림의 `namespace` 라벨(없으면 비움), `target_type: alert`, `target_id` = Alertmanager fingerprint. `after` = `{investigation_id, alertname, severity, status, provider, model, prompt_tokens, completion_tokens, total_tokens, tool_calls, iterations, duration_ms, summary(보고서 앞 500자), link(consoleUrl가 있을 때)}`. 감사 싱크의 필터에 이 액션을 넣으면 Slack·메일로 요약이 간다. 조사 중 읽기 툴 호출은 같은 actor로 `ai.tool.call`(`after.investigation_id`) |
| `alert.webhook.refuse` | 알림 웹훅(`/api/v1/alerts/webhook`)이 토큰이 없거나 틀려 거부(401) — `target_type: cluster`, `after.reason`, 늘 failure. 받아들인 알림은 받은편지함 행 + `ai.investigation.run`이 기록이라 따로 안 남김(2026-10-21) |
| `ai.investigation.view` | 조사 보고서 상세 열람(`GET /api/v1/ai/investigations/{id}`, 권한 `admin.investigations.read` — 또는 Alerts 받은편지함의 `GET /api/v1/alerts/inbox/{id}/investigation`, 그 클러스터를 클러스터 전체로 읽는 사람, `after.from: inbox`) — 보고서에 파드 로그 일부가 들어갈 수 있어 민감 읽기로 남김(D1). `target_type: investigation`, `target_id` = 조사 ID, `cluster`·`namespace` = 그 조사의 것. 목록은 조회라 안 남김. 감사 DB를 쓸 수 없으면 503(D4) · 권한 없음(403)도 failure(2026-10-21) |
| `alert.silence.create` / `alert.silence.expire` | Alerts 받은편지함에서 알림 저장소(`features.alertStore`, `features.alertStore.silences` 켬)에 무음을 만들기 / 지금 끝내기(`POST /api/v1/alertstore/silences`, `DELETE …/silences/{id}`, 권한 `resource.alert.silence` — 그 클러스터 전체, Write·Admin 기본). k8s-service가 등록된 저장소 인증으로 대신 보내고, 모든 무음에 그 클러스터 조건(`<clusterLabel>="<값>"`)을 붙임 — 그 조건이 없는 무음은 그 클러스터 것이 아니라 끝낼 수 없음(404). `target_type: silence`, `target_id` = 무음 ID, `cluster` = 그 클러스터. `after`: 만들기 = `{matchers(클러스터 조건 포함), duration_minutes, comment, ends_at}`, 끝내기 = `{matchers, comment, created_by, ends_at}`. 거부·저장소 오류도 `failure`(권한 없음은 `k8s.access.denied`). 쓰기라 감사 DB를 못 쓰면 503(`audit.RequireWritable`). 목록·미리보기(영향받는 알림)는 조회라 안 남김 |
| `alert.inbox.update` | Alerts 받은편지함(`features.alertInvestigation`의 웹훅이 받은 알림 1건 = 1행)에서 Kubeast 처리 표시를 바꿈 — 확인함·담당(본인만 맡기/해제)·메모·조치 완료(`PATCH /api/v1/alerts/inbox/{id}`, 그 클러스터 `resource.pod.read` + Namespace 제한 없음). Alertmanager·알림 규칙은 안 바뀜. `target_type: alert`, `target_id` = 받은편지함 행 ID, `cluster`·`namespace` = 그 알림의 것. `after` = `{alertname, fingerprint, before, after}`(바뀐 표시만). 값이 그대로면 안 남김. 감사 DB를 쓸 수 없으면 503이고 표시도 되돌림(D4). 목록·한 건 보기는 조회라 안 남김 |
| `ai.model_config.create` / `.update` / `.delete` | 관리자(`admin.ai_models.*`)의 AI 모델 설정 추가·수정·삭제 — 모든 질문과 도구 결과가 어느 주소·모델로 가는지 정함. `target_type: model_config`, `target_id` = 이름, `after` = `{before, after}` 각각 `{provider, model, base_url, api_key_env, api_key_secret_name/key, tls_verify, enabled, is_default, tier, extra_headers(이름만)}` — 키 값·헤더 값·CA는 없음, 실패도. 감사 저장이 안 되면 503(D4)(2026-10-21) |
| `ai.model_config.test` / `ai.model_config.models` | 연결 시험·공급자 모델 목록 — 서버가 가진 키로 그 주소를 부름. `after` = `{provider, base_url, ok}`, 실패도(2026-10-21) |
| `ai.model_config.sync` | ModelConfig CR을 컨트롤러가 DB에 반영·삭제(actor = `system` / `kubeast:model-config-controller`). `target_id` = 이름, `after` = `{op: upsert|delete, before, after}`(위와 같은 칸 + 헤더 값·CA는 해시 앞 12자리) — 저장된 값이 바뀔 때만(같은 값을 다시 쓰는 맞추기는 안 남김), 실패도(2026-10-21) |

`services/pkg/audit`에 상수로 있는 `admin.clusters.*`(create/list/update/delete)와 예시용 `helm.release.rollback`·`k8s.pod.delete`는 위 표의 실제 액션과 같은 뜻이다.

### 5-4. 기록하지 않는 것(이유)

- 목록·조회 GET(민감 읽기 제외) · 무음 목록·미리보기 · 로그 파일 목록(`ls`).
- k8s-service 내부 경로 `/internal/clusters/*/invalidate|validate` — 서비스 토큰 + 사용자 JWT, 게이트웨이 밖. 그 작업(클러스터 등록·수정)은 auth-service가 `admin.cluster.*`로 남김.
- 조사기 토큰 발급(auth-service `/internal/investigator-token`) — 조사 자체가 `ai.investigation.run`.
- 감사 봉인 실패 — 감사가 감사를 낳는 고리라 지표·로그로(`/health` `audit` 블록).
- 채팅 대화방 만들기·메시지 저장, 받아들인 알림 웹훅 — §5-2의 해당 행에 이유.
- 요청 형식 오류(읽을 수 없는 본문·빈 필수 값·주소 모양·FastAPI 422) — 아무것도 시도하지 않은 입력 실수. 정책이 거부한 값(키 직접 입력·허용 안 된 주소, kubeconfig의 허용 안 된 exec 명령·TLS 검증 끄기)과 권한 거부는 failure로 남김.
- 등록 전 연결 시험(`POST /api/v1/clusters/validate`) — 받은 kubeconfig로 접속만 해 보고 아무것도 저장하지 않음. 등록하면 `admin.cluster.register`.

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
