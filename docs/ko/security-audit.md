[English](../security-audit.md) | **한국어**

# 보안·감사

## API 키 (자동화)

사람 로그인 대신 스크립트·CI가 쓰는 긴 자격입니다. Settings → API keys에서 이름·만료(기본 30일, 상한은 차트
`auth.apiKeys.maxDays`)·클러스터·역할 상한(기본 Read)을 정해 발급하면 값(`kbk_…`)이 한 번만 보입니다. 키는 그
자체로 API를 부르지 않고 짧은 액세스 토큰으로 교환해 씁니다 — 토큰은 발급자가 그 순간 가진 권한을 키의 범위로
잘라낸 것이라 발급자보다 많은 일을 할 수 없고, 키를 폐기하면(또는 만료되면) 다음 교환부터 거부되고 그 키로 이미
받은 토큰도 서비스의 토큰 확인 주기(30초) 안에 거부됩니다(관리자는 사용자 상세에서 남의 키를 폐기할 수 있고, 발급은 본인만).

```bash
TOKEN=$(curl -s -X POST https://console.example.com/api/v1/auth/token \
  -H "Authorization: Bearer $KUBEAST_API_KEY" | jq -r .access_token)     # expires_in 초 뒤 다시 교환
curl -s "https://console.example.com/api/v1/cluster/overview?cluster=prod" \
  -H "Authorization: Bearer $TOKEN" -H "X-Cluster-Name: prod"
```

`?cluster=`를 빼면 레지스트리 기본 클러스터(self 클러스터, 없으면 가장 먼저 등록한 것)로 가고 권한도 그 클러스터로 검사합니다. 어느 클러스터인지는 `GET /api/v1/cluster/current`(`{"id": "…"}`)로 확인합니다.

끄려면 `auth.apiKeys.enabled: false`(컴포즈는 `API_KEYS_ENABLED`). 발급·폐기·교환은 감사 로그에 남습니다.

## 접근 권한 검토 (Access review)

"지금 누가 무엇을 할 수 있나"를 한 장으로 뽑아 주기적으로 검토하고 "검토했다"를 남기는 기능입니다(ISMS-P 2.5.6 접근권한 검토, NIST 800-53 AC-2(j)). 관리자 → Access review에 섹션 5개가 표로 뜹니다.

| 섹션 | 내용 | 플래그 |
|---|---|---|
| 사용자 | 이메일·팀·전역 역할·인증 출처·생성일·**마지막 로그인**(`auth_users.last_login_at`, 로그인 성공마다 기록·감사 로그로 백필)·클러스터 역할/API 키/임시 권한 개수 | `global_admin` · `never_logged_in` · `dormant`(마지막 로그인 또는 생성이 `dormantDays` 전) · `locked` |
| 클러스터 역할 | 사용자별 클러스터·역할, 영구/요청 경유, 만료·복귀 역할 | `temporary` · `admin_role` |
| API 키 | 소유자·이름·접두어·클러스터·역할 상한·생성·만료·마지막 사용 | `expired` · `expiring_30d` · `unused_30d` |
| 임시 권한 이력 | 마지막 검토 이후의 권한 요청: 신청자·클러스터·역할·기간·사유·승인자·결정·종료 | — |
| 역할 | 이름·시스템 여부·권한 목록·쓰는 사용자/바인딩 수 | `has_admin_permissions` · `unused` |

- 탭마다 **CSV**(UTF-8 BOM, 수식 주입 방지) · 상단 카드에 전역 Admin·휴면·만료 임박 키·활성 임시 권한 수와 **마지막 검토·다음 기한**(`intervalDays` 뒤, 지나면 표시).
- **검토 완료** 버튼이 메모와 함께 그 시점 보고서를 통째로 저장합니다(`access_reviews`, 보존 `retention.reviewDays` 기본 3년). 지난 검토는 목록에서 열어 보고 그때 CSV로 다시 내려받을 수 있습니다.
- 권한 `admin.review.read` · `admin.review.export` · `admin.review.signoff`(시스템 Admin 역할에 포함), 감사 액션도 같은 이름. 쓰기는 서명뿐이고 권한 변경은 기존 화면에서 합니다.
- 끄려면 `auth.accessReview.enabled: false`(메뉴·API가 사라짐). 비용: 페이지를 열 때 조회 7번, 서명 1건당 스냅샷 수십 KB.

## 휴면 계정 자동 잠금 (Dormant accounts)

위 보고서가 휴면 계정을 **보여 주는** 것이라면, 이 기능은 사람이 안 봐도 **닫습니다**(ISMS-P 2.5.6 결함 사례 "6개월 이상 미접속 계정 활성", NIST 800-53 AC-2(3)). `auth.dormantAccounts.enabled: true`면 auth-service 안의 스위퍼가 `sweepHours`(24)마다 돌면서 `days`(90) 동안 **로그인도 API 키 교환도 없는 계정**(한 번도 안 쓴 계정은 생성일 기준)을 잠그고 그 계정의 세션을 회수합니다. 잠긴 계정은 비밀번호 로그인·SSO·API 키 교환이 모두 거부되고(응답은 일반 401, 사유는 감사 로그 `reason: dormant`), 관리자가 Admin → User Management에서 **잠금 해제**를 눌러야 다시 들어옵니다.

- `exemptAdmins: true`(기본)면 역할에 `*`나 `admin.*` 권한이 있는 계정은 잠그지 않습니다 — 마지막 관리자까지 잠기면 아무도 못 풀기 때문. 대신 접근 권한 검토 보고서에 `dormant`로 계속 보입니다.
- Admin → User Management: 잠긴 계정에 "휴면 잠김"/"잠김" 배지와 **잠금 해제** 버튼, 상단에 **휴면 계정 지금 점검**(스위퍼를 즉시 1회 실행, `admin.users.update`). 감사 액션: `user.account.dormant_lock`(actor `system`) · `admin.dormant.sweep` · `admin.users.unlock`.
- 끄면 스위퍼가 멈추고 새로 잠그지 않지만, 이미 잠긴 계정은 풀 때까지 그대로입니다. 접근 권한 검토의 `dormantDays`(표시 기준)와는 별개 값이라 "60일부터 표시, 90일에 잠금"처럼 벌릴 수 있습니다.

## 감사 싱크 (S3 · 웹훅 · 메일 · 파일)

감사 로그의 1차 저장소는 DB이고, 싱크는 그 행을 **밖으로 복사**합니다. auth-service 한 replica가 싱크마다
"어디까지 보냈는지"(커서)를 DB에 두고 배치로 보내므로, 싱크가 죽어도 요청은 막히지 않고 복구되면 이어서
보냅니다(최소 1회 전달 — 레코드의 `id`로 중복 제거). 싱크가 없으면 지금과 똑같습니다.

| 종류 | 용도 | 비밀(Secret 키) |
|---|---|---|
| `s3` | 장기 보관(S3·MinIO·GCS·R2). 시간 파티션 NDJSON gzip | `accessKeyId`·`secretAccessKey` — 없으면 IRSA(`serviceAccounts.authService.annotations`에 롤) |
| `webhook` `json` | SIEM·n8n 등 범용(선택 HMAC 서명 `X-Kubeast-Signature`) | `url`, `hmacSecret` |
| `webhook` `slack` · `teams` · `discord` | 채팅 알림 | `url` |
| `webhook` `telegram` | 채팅 알림(`chatId`) | `botToken` |
| `webhook` `pagerduty` | 온콜(Events v2, 이벤트당 1건) | `routingKey` |
| `email` | 메일(SMTP, STARTTLS/TLS) | `username`·`password` |
| `file` | PVC에 NDJSON(`/var/lib/kubeast-audit`, `audit.fileSinkVolume`) | — |

`teams`·`discord`·`pagerduty`는 각 서비스의 공개 페이로드 형식을 따르지만 실제 서비스로는 아직 확인하지 않았습니다.

```yaml
audit:
  sinks:
    - name: archive                      # 장기 보관, 전체 이력
      type: s3
      s3: {bucket: kubeast-audit, prefix: audit/, region: ap-northeast-2}
    - name: slack-danger                 # 위험한 행동만 Slack으로
      type: webhook
      secret: kubeast-audit-slack        # kubectl create secret generic kubeast-audit-slack --from-literal=url=https://hooks.slack.com/...
      webhook: {format: slack}
      filter: {actions: ["k8s.*.delete", "k8s.pod.exec", "k8s.node.shell", "access.request.create", "admin.*"]}
retention:
  auditDays: 90                          # S3를 켰다면 DB는 화면·CSV에 필요한 기간만
```

- **필터**: 권한 패턴과 같은 와일드카드(`k8s.*.delete`, `admin.*`)와 `results: [failure]`. 필터 없음 = 전부.
- **시작점**: `s3`·`file`은 처음부터(기존 이력 전체), 나머지는 켠 시점부터(`startFrom`으로 바꿈).
- **S3 Object Lock(WORM, ISMS-P 증적)**: 버킷을 Object Lock + 버전 관리로 만들고 **기본 보존**(compliance 또는 governance, 기간)을 겁니다. Kubeast는 객체마다 보존을 지정하지 않으며 IAM 권한은 `s3:PutObject` 하나면 됩니다. compliance 모드는 기간 동안 root도 못 지웁니다.
- **보존**: `retention.auditDays`가 지나도 **아직 싱크로 안 보낸 행은 지우지 않습니다**. 멈춘 싱크는 알람 `KubeastAuditSinkStalled`(메트릭 `kubeast_audit_sink_pending`·`_failures_total`·`_last_success_timestamp_seconds`)로 드러납니다.
- **네트워크**: 443은 열려 있습니다. SMTP(587/465)나 클러스터 안 엔드포인트는 `audit.sinkEgress`에 NetworkPolicy 규칙을 추가합니다.

로컬 kind에는 `deploy/kind/devtools.yaml`(S3 대용 versitygw + Object Lock 버킷, Mailpit, 웹훅 수신기)이 `kind-deploy.sh`로
함께 올라가고 dev 값이 싱크 3개를 그쪽으로 향합니다. 메일 수신함은 `kubectl -n kubeast-devtools port-forward svc/mailpit 8025`.

## 감사 로그 무결성 (해시 체인 · S3 앵커)

감사 행을 나중에 고치거나 지웠는지 알 수 있게 합니다. auth-service가 `audit.integrity.sealSeconds`(기본 10초)마다 새 행을 앞 행의 해시를 포함한 sha256으로 묶고(`chain_seq`·`prev_hash`·`row_hash`), `audit.integrity.anchor.sink`에 S3 싱크 이름을 적으면 `anchor.hours`(기본 24)마다 체인 머리를 다이제스트 JSON으로 그 버킷의 `<prefix>digests/`에 씁니다. Admin → 감사 로그 상단 띠에서 봉인 위치와 마지막 앵커를 보고, **검증**(기본 = 마지막 앵커부터, 싱크 객체 대조 포함)과 **지금 앵커**를 누를 수 있습니다. 둘 다 감사 행(`admin.audit.verify`·`admin.audit.anchor`)으로 남고, 주기 앵커는 `audit.chain.anchor`(actor `system`)입니다.

```yaml
audit:
  sinks:
    - name: archive
      type: s3
      s3: {bucket: kubeast-audit, prefix: audit/, region: ap-northeast-2}
  integrity:
    enabled: true        # 기본값: 체인만(의존성 없음)
    sealSeconds: 10
    anchor:
      sink: archive      # 위 s3 싱크의 이름. 비우면 앵커 없음
      hours: 24
```

- **신뢰 근거는 버킷의 Object Lock**입니다. DB와 S3를 둘 다 고칠 수 있는 사람은 앵커도 다시 쓸 수 있으니, 다이제스트가 놓이는 버킷에 기본 보존을 거세요. 다이제스트에 서명은 없습니다.
- **독립 검증**: Kubeast 없이 psql로 같은 식을 재계산할 수 있습니다(`services/auth-service-go/internal/auditchain`의 `CanonSQL`, [docs/ko/audit-log-plan.md](audit-log-plan.md) §7).
- **한계**: 봉인 전 창(≤ `sealSeconds`)에 지워진 행은 못 잡습니다. 껐다 켠 구간은 검증 결과에 앵커 없음으로 드러납니다. 보존(`retention.auditDays`)은 체인 접두만 지웁니다.
- 메트릭 `kubeast_audit_chain_sealed_seq` · `kubeast_audit_chain_unsealed_rows` · `kubeast_audit_anchor_last_timestamp_seconds`.

로컬 kind는 dev 값이 `dev-s3` 스탠드인에 앵커합니다(`e2e/tests/audit-integrity.spec.ts`).

## 세션 기록 (exec · 노드 셸)

켜면(`sessionRecording.enabled`, 기본 off) Pod exec와 노드 셸 터미널에 **찍힌 출력**(사용자가 본 화면 — 친 명령은
에코로 보이고, 에코되지 않는 비밀번호 입력은 안 남음)을 asciicast v2로 녹화합니다. 세션을 열면 터미널에
"This session is recorded"(한국어 화면이면 "이 세션은 녹화됩니다") 한 줄이 먼저 찍히고 — 녹화에도 그 줄이 그대로 남습니다 — 감사 행(`k8s.pod.exec`·`k8s.node.shell`)에 `recording_id`가 붙습니다.

- **저장**: k8s-service가 로컬 볼륨에 쓰고 세션 중에도 `chunkSeconds`(기본 30초)마다 조각을 올립니다 — k8s-service 파드가 사라져도 잃는 건 마지막 조각 간격만큼. 저장소 = `s3`(운영 권장, 감사 S3 싱크와 같은 필드) · `database`(세션당 1 MiB, S3 없는 작은 설치) · `file`(PVC). S3 키는 파일로 마운트돼 k8s-service의 IRSA 신원을 건드리지 않습니다.
- **끊긴 세션**: k8s-service 쪽 사정으로 끊긴 세션은 `interrupted`로 남습니다 — 정상 종료(롤아웃·드레인)와 컨테이너 재시작은 남은 출력까지 다 올리고, 파드가 통째로 사라지면 그 전에 올린 조각만 남습니다. 목록의 크기는 남은(올라간) 크기이고, 올라간 조각이 없으면 재생 버튼이 꺼집니다.
- **터미널이 끊길 때**: 브라우저 탭을 닫거나 네트워크가 끊겨 터미널이 `exit` 없이 사라지면, k8s-service가 셸에 Ctrl-C·Ctrl-D를 보내 끝냅니다(컨테이너 런타임은 끊긴 exec의 프로세스를 정리하지 않음). 편집기처럼 이를 무시하는 프로그램이 앞에 떠 있으면 남을 수 있습니다.
- **실패**: 녹화를 시작하지 못하면(로컬 볼륨에 못 씀) 세션을 거부합니다(`required: true`). 저장소 업로드가 실패하거나 조각 하나가 30초 안에 끝나지 않아도 세션은 계속되고, 재시도하며 알람 `KubeastSessionRecordingUploadStalled`로 드러납니다. 세션당 `maxBytes`(기본 64 MiB)를 넘으면 녹화만 멈춥니다.
- **다시보기**: Admin → Session recordings(권한 `admin.sessions.read`)에서 재생·`.cast`·텍스트 사본 내려받기, Audit Logs의 exec 행에서도 재생. 녹화를 열 때마다 `admin.session.read`가 감사에 남습니다.
- **재생기와 CSP**: 재생기(asciinema-player)는 터미널을 WebAssembly로 돌립니다. 그래서 게이트웨이가 보내는 CSP의 `script-src`에 `'wasm-unsafe-eval'`이 들어 있습니다(`'unsafe-eval'`은 아님, `helm/kubeast/files/nginx.conf`). 앞단 Ingress·프록시가 CSP 헤더를 덮어쓰면 같은 값을 허용해야 재생됩니다 — 빠지면 ▶ 버튼과 `--:--`에서 멈춥니다.
- **보존**: 원격 객체는 버킷 수명주기·Object Lock에 맡기고, 목록 행은 `retention.auditDays`를 따릅니다.

```yaml
sessionRecording:
  enabled: true
  s3: {bucket: kubeast-sessions, prefix: sessions/, region: ap-northeast-2}   # k8s-service 롤에 s3:PutObject·GetObject
```
