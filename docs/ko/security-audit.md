[English](../security-audit.md) | **한국어**

# 보안·감사

## API 키 (자동화)

사람이 로그인하는 대신 스크립트나 CI가 쓰는 수명이 긴 자격 증명입니다.
Settings → API keys에서 이름, 만료(기본 30일, 상한은 차트 `auth.apiKeys.maxDays`), 클러스터, 역할 상한(기본 Read)을 정해 발급하면 키 값(`kbk_…`)이 한 번만 표시됩니다.
키로 API를 직접 부르지 않고, 짧은 액세스 토큰으로 교환해 씁니다.
토큰에는 발급자가 그 순간 가진 권한 중 키의 범위에 드는 권한만 담기므로 발급자보다 많은 일을 할 수 없습니다.
키를 폐기하거나 키가 만료되면 다음 교환부터 거부되고, 그 키로 이미 받은 토큰도 서비스의 토큰 확인 주기(30초) 안에 거부됩니다.
관리자는 사용자 상세에서 다른 사람의 키를 폐기할 수 있지만, 발급은 본인만 할 수 있습니다.

```bash
TOKEN=$(curl -s -X POST https://console.example.com/api/v1/auth/token \
  -H "Authorization: Bearer $KUBEAST_API_KEY" | jq -r .access_token)     # expires_in 초 뒤 다시 교환
curl -s "https://console.example.com/api/v1/cluster/overview?cluster=prod" \
  -H "Authorization: Bearer $TOKEN" -H "X-Cluster-Name: prod"
```

`?cluster=`를 빼면 요청은 레지스트리의 기본 클러스터로 가고, 권한도 그 클러스터 기준으로 검사합니다.
기본 클러스터는 self 클러스터이며, 없으면 가장 먼저 등록한 클러스터입니다. 어느 클러스터인지는 `GET /api/v1/cluster/current`(`{"id": "…"}`)로 확인할 수 있습니다.

끄려면 `auth.apiKeys.enabled: false`로 설정하세요(컴포즈는 `API_KEYS_ENABLED`). 발급·폐기·교환은 감사 로그에 남습니다.

## 접근 권한 검토 (Access review)

"지금 누가 무엇을 할 수 있는가"를 한 장으로 뽑아 주기적으로 검토하고, 검토했다는 기록을 남기는 기능입니다(ISMS-P 2.5.6 접근권한 검토, NIST 800-53 AC-2(j)).
관리자 → Access review에서 섹션 5개를 표로 볼 수 있습니다.

| 섹션 | 내용 | 플래그 |
|---|---|---|
| 사용자 | 이메일·팀·전역 역할·인증 출처·생성일·**마지막 로그인**(`auth_users.last_login_at`, 로그인에 성공할 때마다 기록, 과거 값은 감사 로그에서 백필)·클러스터 역할/API 키/임시 권한 개수 | `global_admin` · `never_logged_in` · `dormant`(마지막 로그인이나 생성이 `dormantDays` 이전) · `locked` |
| 클러스터 역할 | 사용자별 클러스터·역할, 영구 부여인지 요청으로 받았는지, 만료와 만료 뒤 돌아갈 역할 | `temporary` · `admin_role` |
| API 키 | 소유자·이름·접두어·클러스터·역할 상한·생성·만료·마지막 사용 시각 | `expired` · `expiring_30d` · `unused_30d` |
| 임시 권한 이력 | 마지막 검토 이후의 권한 요청: 신청자·클러스터·역할·기간·사유·승인자·결정·종료 | — |
| 역할 | 이름·시스템 역할 여부·권한 목록·이 역할을 쓰는 사용자/바인딩 수 | `has_admin_permissions` · `unused` |

- 탭마다 **CSV**로 내려받을 수 있습니다(UTF-8 BOM, 수식 주입 방지).
- 상단 카드에는 다음이 나옵니다.
  - 전역 Admin, 휴면 계정, 만료가 임박한 키, 활성 임시 권한의 수
  - **마지막 검토·다음 기한**(`intervalDays` 뒤, 기한이 지나면 표시)
- **검토 완료** 버튼을 누르면 그 시점의 보고서 전체를 메모와 함께 저장합니다(`access_reviews`, 보존 기간 `retention.reviewDays`, 기본 3년).
  지난 검토는 목록에서 열어 볼 수 있고, 당시의 CSV로 다시 내려받을 수 있습니다.
- 권한은 `admin.review.read` · `admin.review.export` · `admin.review.signoff`이고(시스템 Admin 역할에 포함), 감사 액션도 같은 이름입니다.
  이 기능의 쓰기 동작은 서명뿐이며, 권한 변경은 기존 화면에서 합니다.
- 끄려면 `auth.accessReview.enabled: false`로 설정하세요. 메뉴와 API가 사라집니다.
- 비용은 페이지를 열 때 조회 7번, 서명 1건당 스냅샷 수십 KB입니다.

## 휴면 계정 자동 잠금 (Dormant accounts)

위 보고서가 휴면 계정을 **보여 준다면**, 이 기능은 사람이 보지 않아도 휴면 계정을 **닫습니다**(ISMS-P 2.5.6 결함 사례 "6개월 이상 미접속 계정 활성", NIST 800-53 AC-2(3)).
`auth.dormantAccounts.enabled: true`이면 auth-service 안의 스위퍼가 `sweepHours`(24)마다 돌면서, `days`(90) 동안 **로그인도 API 키 교환도 없었던 계정**을 잠그고 그 계정의 세션을 회수합니다.
한 번도 쓰지 않은 계정은 생성일부터 셉니다.
잠긴 계정은 비밀번호 로그인, SSO, API 키 교환이 모두 거부됩니다. 응답은 일반 401이고, 사유는 감사 로그에 `reason: dormant`로 남습니다.
관리자가 Admin → User Management에서 **잠금 해제**를 눌러야 다시 들어올 수 있습니다.

- `exemptAdmins: true`(기본)이면 역할에 `*`나 `admin.*` 권한이 있는 계정은 잠그지 않습니다. 마지막 관리자까지 잠기면 아무도 잠금을 풀 수 없기 때문입니다.
  대신 이런 계정은 접근 권한 검토 보고서에 계속 `dormant`로 표시됩니다.
- Admin → User Management에서는 잠긴 계정에 "휴면 잠김"/"잠김" 배지와 **잠금 해제** 버튼이 붙습니다.
  상단에는 **휴면 계정 지금 점검** 버튼이 있습니다(스위퍼를 즉시 1회 실행, `admin.users.update`).
- 감사 액션은 `user.account.dormant_lock`(actor `system`) · `admin.dormant.sweep` · `admin.users.unlock`입니다.
- 끄면 스위퍼가 멈춰 더는 잠그지 않지만, 이미 잠긴 계정은 풀 때까지 잠긴 채로 남습니다.
  이 값은 접근 권한 검토의 `dormantDays`(표시 기준)와 별개라서 "60일부터 표시, 90일에 잠금"처럼 서로 다르게 둘 수 있습니다.

## 감사 싱크 (S3 · 웹훅 · 메일 · 파일)

감사 로그의 1차 저장소는 DB이고, 싱크는 그 행을 **밖으로 복사**합니다.
auth-service replica 하나가 싱크마다 "어디까지 보냈는지"(커서)를 DB에 기록하고 배치로 보냅니다.
그래서 싱크가 죽어도 요청은 막히지 않고, 싱크가 복구되면 이어서 보냅니다.
전달은 최소 1회 보장이므로 레코드의 `id`로 중복을 걸러 내세요. 싱크가 없으면 아무것도 달라지지 않습니다.

| 종류 | 용도 | 비밀(Secret 키) |
|---|---|---|
| `s3` | 장기 보관(S3·MinIO·GCS·R2). 시간별로 나눈 NDJSON gzip | `accessKeyId`·`secretAccessKey` — 없으면 IRSA(`serviceAccounts.authService.annotations`에 롤 지정) |
| `webhook` `json` | SIEM·n8n 같은 범용 수신처(HMAC 서명 `X-Kubeast-Signature` 선택) | `url`, `hmacSecret` |
| `webhook` `slack` · `teams` · `discord` | 채팅 알림 | `url` |
| `webhook` `telegram` | 채팅 알림(`chatId`) | `botToken` |
| `webhook` `pagerduty` | 온콜(Events v2, 이벤트당 1건) | `routingKey` |
| `email` | 메일(SMTP, STARTTLS/TLS) | `username`·`password` |
| `file` | PVC에 NDJSON으로 저장(`/var/lib/kubeast-audit`, `audit.fileSinkVolume`) | — |

`teams`·`discord`·`pagerduty`는 각 서비스가 공개한 페이로드 형식을 따르지만, 실제 서비스에서는 아직 시험하지 않았습니다.

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

- **필터**: 권한 패턴과 같은 와일드카드(`k8s.*.delete`, `admin.*`)와 `results: [failure]`를 쓸 수 있습니다. 필터가 없으면 전부 보냅니다.
- **시작점**: `s3`·`file`은 처음부터(기존 이력 전체), 나머지는 켠 시점부터 보냅니다. `startFrom`으로 바꿀 수 있습니다.
- **S3 Object Lock(WORM, ISMS-P 증적)**: 버킷을 Object Lock과 버전 관리를 켜서 만들고 **기본 보존**(compliance 또는 governance, 기간)을 거세요.
  Kubeast는 객체마다 보존을 지정하지 않으므로 IAM 권한은 `s3:PutObject` 하나면 됩니다. compliance 모드에서는 보존 기간 동안 root도 지울 수 없습니다.
- **보존**: `retention.auditDays`가 지나도 **아직 싱크로 보내지 않은 행은 지우지 않습니다**.
  멈춘 싱크는 알람 `KubeastAuditSinkStalled`(메트릭 `kubeast_audit_sink_pending`·`_failures_total`·`_last_success_timestamp_seconds`)로 알 수 있습니다.
- **네트워크**: 443은 열려 있습니다. SMTP(587/465)나 클러스터 안 엔드포인트로 보내려면 `audit.sinkEgress`에 NetworkPolicy 규칙을 추가하세요.

로컬 kind에서는 `kind-deploy.sh`가 `deploy/kind/devtools.yaml`(S3 대용 versitygw + Object Lock 버킷, Mailpit, 웹훅 수신기)도 함께 올리고, dev 값이 싱크 3개를 그쪽으로 보냅니다.
메일 수신함은 `kubectl -n kubeast-devtools port-forward svc/mailpit 8025`로 엽니다.

## 감사 로그 무결성 (해시 체인 · S3 앵커)

감사 행을 나중에 고치거나 지웠는지 확인할 수 있게 합니다.
auth-service는 `audit.integrity.sealSeconds`(기본 10초)마다 새 행을 앞 행의 해시를 포함한 sha256으로 묶습니다(`chain_seq`·`prev_hash`·`row_hash`).
`audit.integrity.anchor.sink`에 S3 싱크 이름을 적으면 `anchor.hours`(기본 24)마다 체인의 머리를 다이제스트 JSON으로 만들어 그 버킷의 `<prefix>digests/`에 씁니다.
Admin → 감사 로그 상단 띠에서 봉인 위치와 마지막 앵커를 보고, **검증**(기본은 마지막 앵커부터, 싱크 객체 대조 포함)과 **지금 앵커** 버튼을 누를 수 있습니다.
두 동작 모두 감사 행(`admin.audit.verify`·`admin.audit.anchor`)으로 남고, 주기 앵커는 `audit.chain.anchor`(actor `system`)로 남습니다.

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

- **신뢰 근거는 버킷의 Object Lock**입니다. DB와 S3를 둘 다 고칠 수 있는 사람은 앵커도 다시 쓸 수 있으니, 다이제스트가 놓이는 버킷에 기본 보존을 거세요. 다이제스트에는 서명이 없습니다.
- **독립 검증**: Kubeast 없이 psql로 같은 식을 다시 계산할 수 있습니다(`services/auth-service-go/internal/auditchain`의 `CanonSQL`, [docs/ko/audit-log-plan.md](audit-log-plan.md) §7).
- **한계**
  - 봉인되기 전 구간(≤ `sealSeconds`)에 지워진 행은 잡지 못합니다.
  - 기능을 껐다가 다시 켠 구간은 검증 결과에 앵커 없음으로 나타납니다.
  - 보존(`retention.auditDays`)은 체인의 앞부분만 지웁니다.
- 메트릭 `kubeast_audit_chain_sealed_seq` · `kubeast_audit_chain_unsealed_rows` · `kubeast_audit_anchor_last_timestamp_seconds`.

로컬 kind에서는 dev 값에 따라 `dev-s3` 스탠드인에 앵커를 씁니다(`e2e/tests/audit-integrity.spec.ts`).

## 세션 기록 (exec · 노드 셸)

켜면(`sessionRecording.enabled`, 기본 off) Pod exec와 노드 셸 터미널에 **찍힌 출력**, 즉 사용자가 본 화면을 asciicast v2로 녹화합니다.
입력한 명령은 에코로 화면에 찍히므로 남고, 에코되지 않는 비밀번호 입력은 남지 않습니다.
세션을 열면 터미널에 "This session is recorded"(한국어 화면이면 "이 세션은 녹화됩니다") 한 줄이 먼저 찍히고, 이 줄은 녹화에도 그대로 남습니다.
감사 행(`k8s.pod.exec`·`k8s.node.shell`)에는 `recording_id`가 붙습니다.

- **저장**: k8s-service가 로컬 볼륨에 쓰고, 세션 중에도 `chunkSeconds`(기본 30초)마다 조각을 올립니다.
  그래서 k8s-service 파드가 사라져도 마지막 조각 간격만큼만 잃습니다. 저장소는 다음 중에서 고릅니다.
  - `s3`(운영 권장, 감사 S3 싱크와 같은 필드)
    - S3 키는 파일로 마운트되므로 k8s-service의 IRSA 신원을 건드리지 않습니다.
  - `database`(세션당 1 MiB, S3가 없는 작은 설치)
  - `file`(PVC)
- **끊긴 세션**: k8s-service 쪽 사정으로 끊긴 세션은 `interrupted`로 남습니다.
  - 정상 종료(롤아웃·드레인)나 컨테이너 재시작 때는 남은 출력까지 모두 올립니다.
  - 파드가 통째로 사라지면 그 전에 올린 조각만 남습니다.
  - 목록에 보이는 크기는 실제로 올라간 크기이고, 올라간 조각이 없으면 재생 버튼이 꺼집니다.
- **터미널이 끊길 때**: 브라우저 탭을 닫거나 네트워크가 끊겨 터미널이 `exit` 없이 사라지면, k8s-service가 셸에 Ctrl-C·Ctrl-D를 보내 셸을 끝냅니다.
  컨테이너 런타임은 끊긴 exec의 프로세스를 정리하지 않기 때문입니다. 편집기처럼 이 입력을 무시하는 프로그램이 포그라운드에 떠 있으면 프로세스가 남을 수 있습니다.
- **실패**
  - 로컬 볼륨에 쓰지 못해 녹화를 시작할 수 없으면 세션을 거부합니다(`required: true`).
  - 저장소 업로드가 실패하거나 조각 하나가 30초 안에 끝나지 않아도 세션은 계속됩니다. 업로드는 재시도하고, 문제는 알람 `KubeastSessionRecordingUploadStalled`로 드러납니다.
  - 세션당 `maxBytes`(기본 64 MiB)를 넘으면 녹화만 멈춥니다.
- **다시보기**: Admin → Session recordings(권한 `admin.sessions.read`)에서 재생하거나 `.cast`·텍스트 사본을 내려받을 수 있고, Audit Logs의 exec 행에서도 재생할 수 있습니다.
  녹화를 열 때마다 `admin.session.read`가 감사 로그에 남습니다.
- **재생기와 CSP**: 재생기(asciinema-player)는 터미널을 WebAssembly로 돌립니다.
  그래서 게이트웨이가 보내는 CSP의 `script-src`에는 `'unsafe-eval'`이 아닌 `'wasm-unsafe-eval'`이 들어 있습니다(`helm/kubeast/files/nginx.conf`).
  앞단의 Ingress나 프록시가 CSP 헤더를 덮어쓴다면 같은 값을 허용해야 재생됩니다. 이 값이 빠지면 재생기가 ▶ 버튼과 `--:--`에서 멈춥니다.
- **보존**: 원격 객체는 버킷 수명주기와 Object Lock에 맡기고, 목록 행은 `retention.auditDays`를 따릅니다.

```yaml
sessionRecording:
  enabled: true
  s3: {bucket: kubeast-sessions, prefix: sessions/, region: ap-northeast-2}   # k8s-service 롤에 s3:PutObject·GetObject
```
