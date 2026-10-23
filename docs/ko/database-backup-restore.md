[English](../database-backup-restore.md) | **한국어**

# 데이터베이스: TLS, 백업과 복원

Kubeast는 오래 남아야 하는 상태를 PostgreSQL 데이터베이스 하나에 둡니다(사용자, 역할, 등록한 클러스터, 채팅 세션과 메시지, 도구 승인, 모델 설정, 감사 로그). 이 문서는 서비스가 TLS로 그 데이터베이스에 붙는 방법과, 차트가 기본으로 설치하는 클러스터 안 데이터베이스를 백업·복원하는 방법을 다룹니다. 아래 절차는 kind에서 리허설했습니다(덤프 → uninstall + PVC 삭제 → 재설치 → 복원 → 로그인·행 수·등록한 클러스터).

## 무엇이 어디에 있나 (What lives where)

| 데이터 | 위치 | 백업 수단 |
|---|---|---|
| 테이블(`services/pkg/dbmigrate/migrations` 참고) | PostgreSQL | `pg_dump` / 볼륨 스냅샷 |
| 관리자 비밀번호, JWT 서명 키 | Secret `kubeast-secrets`, `kubeast-auth-keys`(uninstall 때 남음; 또는 `secrets.existingSecret` / `auth.signingKey.existingSecret`으로 지정한 직접 만든 Secret) | 그 Secret의 원천(ESO, sealed-secrets, …) — 데이터베이스 덤프에는 **들어 있지 않음** |
| 등록한 클러스터의 kubeconfig | auth-service가 릴리스 네임스페이스에 만드는 Secret(`clusters.kubeconfig_secret_name`); in-cluster(`self`) 모드에는 없음 | 위와 같음 — Secret 없이 데이터베이스 행만 복원하면 그 클러스터를 다시 등록해야 함 |
| LLM API 키 | `model_configs.api_key_secret_name`이 가리키는 Secret | 위와 같음 |

그래서 데이터베이스를 복원하면 사용자, 권한, 감사 이력, 채팅 이력, 클러스터 등록이 돌아옵니다. 그 옆의 Secret은 각자의 원천(source of truth)에서 가져와야 합니다.

## 데이터베이스 TLS (TLS to the database)

`DATABASE_URL`은 모든 서비스가 읽는 URL 하나입니다. Go 서비스(pgx)와 ai-service(asyncpg, `app/db_ssl.py`에서 변환) 모두 그 안의 libpq `sslmode`·`sslrootcert`를 따릅니다.

| 값 | 효과 |
|---|---|
| `postgresql.sslMode: ""` (기본) | 파라미터 없음 → 드라이버 기본값 `prefer`: 서버가 TLS를 제공하면 TLS, 아니면 평문, 인증서 검증 없음. 파드 네트워크 위의 클러스터 안 데이터베이스에는 이것으로 충분합니다. |
| `postgresql.sslMode: require` | TLS 필수, 인증서 검증 안 함 |
| `postgresql.sslMode: verify-full` + `postgresql.sslRootCert.secretName` | TLS, 그 Secret의 CA로 인증서 체인과 호스트 이름 검증(모든 데이터베이스 클라이언트 파드와 마이그레이션 Job의 `/etc/kubeast/db-ca/<key>`에 마운트) |

외부 데이터베이스 예시(RDS for PostgreSQL, 15 버전부터 `rds.force_ssl`이 기본으로 켜져 있음):

```yaml
postgresql:
  enabled: false
  externalHost: kubeast.abc123.ap-northeast-2.rds.amazonaws.com
  sslMode: verify-full
  sslRootCert:
    secretName: rds-ca          # kubectl create secret generic rds-ca --from-file=ca.crt=global-bundle.pem
    key: ca.crt
```

## 클러스터 안 데이터베이스 백업 (Backing up the in-cluster database)

서로 독립된 두 겹입니다. 둘 다 쓰세요.

1. PVC `kubeast-postgres-data`의 **볼륨 스냅샷**(차트는 uninstall 때 이 PVC를 남깁니다, `postgresql.persistence.resourcePolicy: keep`). EKS에서는 EBS 볼륨에 AWS Backup 계획을 겁니다(태그 기반 선택, 매일, 보존 기간은 정책에 따라). 복원하면 고른 AZ에 *새* 볼륨이 만들어집니다.
2. 서버에 들어 있는 `pg_dump`로 **논리 덤프**(메이저 버전이 같아야 하고, `pg_restore`로 골라서 복원할 수 있게 custom 포맷):

   ```bash
   kubectl -n <ns> exec deploy/postgres -c postgres -- pg_dump -Fc -U kubeast kubeast > kubeast-$(date -u +%Y%m%dT%H%M%SZ).dump
   ```

   덤프는 시작 시점의 일관된 스냅샷이고, 그동안 서비스는 계속 돕니다. 덤프는 클러스터 밖에 보관하세요(object lock / 버전 관리를 건 S3).

## 복원 (Restoring)

### 논리 덤프에서 복원 (리허설 완료)

새로 설치한 Kubeast에 복원할 수 있습니다. 차트의 마이그레이션이 빈 스키마를 만들고, 덤프가 그 스키마를 대체합니다.

```bash
NS=<ns>
# 1. 쓰기를 하는 것을 모두 멈춤 (마이그레이션 Job이 있다면 이미 끝났음)
for d in auth-service session-service k8s-service ai-service model-config-controller-go; do
  kubectl -n $NS scale deploy/$d --replicas=0
done
# 2. 방금 마이그레이션한 스키마 위에 복원
POD=$(kubectl -n $NS get pod -l app=postgres -o name | head -1)
kubectl -n $NS exec -i $POD -c postgres -- pg_restore --clean --if-exists --no-owner -U kubeast -d kubeast < kubeast-<stamp>.dump
# 3. 서비스 시작: auth-service는 goose_db_version이 필요한 버전인 것을 보고 아무것도 적용하지 않음
for d in auth-service session-service k8s-service ai-service model-config-controller-go; do
  kubectl -n $NS scale deploy/$d --replicas=1
done
```

확인: 유실 **전**의 비밀번호로 admin 로그인이 됩니다(비밀번호는 해시로 덤프에 들어 있음). `auth_users` / `auth_audit_logs` / `clusters` 행 수가 원본과 같고, `GET /api/v1/clusters`가 등록한 클러스터를 보여 주고, 스키마 버전 테이블이 이전과 같은 버전을 보여 줍니다.

덤프가 **더 오래된** Kubeast의 것이라면(`goose_db_version`이 더 낮음) 복원한 뒤 auth-service를 한 번 재시작하세요. auth-service가 부팅할 때 빠진 마이그레이션을 적용하거나(`MIGRATIONS_MODE=startup`), 다음 upgrade 때 hook Job이 적용합니다.

### 볼륨 스냅샷에서 복원

1. 스냅샷을 새 볼륨으로 복원합니다(AWS Backup → "Restore to EBS volume", postgres가 도는 노드 그룹과 같은 AZ).
2. 그 볼륨을 가리키는 PV와, 릴리스 네임스페이스에 그 PV에 묶인 PVC를 만듭니다.
3. 차트가 그 PVC를 쓰게 하고 upgrade합니다:

   ```yaml
   postgresql:
     persistence:
       existingClaim: kubeast-postgres-restored
   ```

   차트는 자기 PVC를 더 렌더링하지 않고 지정한 PVC를 마운트합니다. 데이터 디렉터리가 완전한 PostgreSQL 클러스터이므로 `pg_restore`가 필요 없고, 서버가 그 디렉터리로 바로 시작합니다. 같은 로그인 / 행 수 확인을 하세요.

## PostgreSQL 메이저 버전 올리기 (Upgrading the PostgreSQL major version)

PostgreSQL 서버는 다른 메이저 버전의 데이터 디렉터리로는 시작하지 않으므로("database files are incompatible with server"), `images.postgres`를 새 메이저 버전으로 바꾸려면 데이터를 한 번 옮겨야 합니다. 옛 볼륨은 롤백용으로 남겨 두고 새 볼륨으로 옮깁니다(15 → 18로 리허설함):

```bash
NS=<ns>
# 1. 돌고 있는 서버로 덤프
kubectl -n $NS exec deploy/postgres -c postgres -- pg_dump -Fc -U kubeast kubeast > kubeast-before-upgrade.dump
# 2. 새 claim (크기와 StorageClass는 지금 것과 같게)
kubectl -n $NS apply -f - <<'EOF'
apiVersion: v1
kind: PersistentVolumeClaim
metadata: {name: kubeast-postgres-data-new}
spec: {accessModes: [ReadWriteOnce], resources: {requests: {storage: 5Gi}}}
EOF
# 3. 새 이미지로 그 claim에 upgrade: 새 서버가 빈 볼륨을 초기화함
helm upgrade kubeast <chart> -n $NS --reset-then-reuse-values \
  --set images.postgres=<new image> --set postgresql.persistence.existingClaim=kubeast-postgres-data-new
# 4. 위 "논리 덤프에서 복원"처럼 복원: 쓰는 서비스를 멈추고, pg_restore --clean, 다시 시작
```

같은 확인을 하세요. 롤백: 손대지 않은 옛 claim(`postgresql.persistence.existingClaim`)에 옛 이미지를 씁니다. 옛 claim은 지울 때까지 남아 있습니다. docker-compose: 같은 방법으로 덤프하고(`docker compose exec postgres pg_dump …`), `postgres_data` 볼륨을 옆으로 옮겨 두고, 새 볼륨에서 새 이미지를 시작한 뒤 `docker compose exec -T postgres pg_restore --clean --if-exists --no-owner -U kubeast -d kubeast < kubeast-before-upgrade.dump`로 복원합니다.

## 보존 기간 (Retention)

기본은 꺼져 있습니다. 기간을 정하지 않으면 아무것도 지우지 않습니다. auth-service(스키마 소유자)가 부팅할 때 한 번, 그 뒤 24시간마다 5000행씩 나눠 지우고, 실행할 때마다 감사 액션 `admin.retention.purge`로 남깁니다(actor `system`, `after`에 기간·기준 시각·지운 개수). PostgreSQL의 autovacuum이 비워진 공간을 다시 쓰고, 파일 크기는 줄지 않습니다.

| 값 | env | 지우는 것 |
|---|---|---|
| `retention.auditDays` | `RETENTION_AUDIT_DAYS` | N일보다 오래된 `auth_audit_logs` 행. 각 레코드의 stdout 사본(`audit.stdout` 참고)은 로그 파이프라인에 그쪽 보존 기간대로 남으므로 데이터베이스가 유일한 사본은 아닙니다. `audit.sinks`가 있으면 싱크가 아직 보내지 않은 행은 보낼 때까지 남깁니다. N일보다 오래된 끝난 세션 기록(`session_recordings`, `database` 저장소면 그 조각까지)도 지워져 콘솔 목록에서 빠집니다. S3나 파일에 있는 기록은 그 저장소의 수명주기가 지울 때까지 남습니다. |
| `retention.chatDays` | `RETENTION_CHAT_DAYS` | 마지막 활동(`sessions.updated_at`)이 N일보다 오래된 AI 채팅 세션과 그 메시지·컨텍스트, 그리고 N일보다 오래된 도구 승인 요청(그 결정은 이미 감사 레코드로 남아 있음). |

예시 — 접속 기록 보존 1년, 채팅 6개월:

```yaml
retention:
  auditDays: 365
  chatDays: 180
```

감사 보존 기간은 따라야 하는 규제 기준에서 정하세요(예: 한국의 개인정보의 안전성 확보조치 기준은 접속기록을 최소 1년, 일부 처리자는 2년 보관하도록 요구합니다). auth-service replica가 둘 이상이면 replica마다 삭제를 실행합니다. 삭제는 멱등이라 결과는 같고, replica마다 하루에 감사 레코드가 하나씩 생길 뿐입니다.
