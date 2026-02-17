# 운영 문서 (Kubernetes 배포/운영)

## 개요
- **기본 배포 대상:** `kube-assistant` 네임스페이스
- **접근 방식:** NodePort(로컬), Ingress/Service(운영)
- **모델 설정:** ModelConfig CRD → 컨트롤러 → DB 동기화 → ai-service 런타임 반영

## 필수 리소스
1) **Secret**
- `kube-assistant-secrets` 안에 API 키/DB 비밀번호 저장
- 로컬에서는 `k8s/secret.local.yaml`을 만들어 적용 (파일은 gitignore)

2) **DB**
- Postgres 필요 (`k8s/postgres.yaml`)

3) **컨트롤러**
- `model-config-controller-go`가 CRD를 DB로 동기화

## 컨트롤러 운영 옵션
- **Leader Election**: 기본 활성화. `LEADER_ELECTION=false`로 끌 수 있습니다.
- **Leader Election Namespace**: `LEADER_ELECTION_NAMESPACE` (기본: `WATCH_NAMESPACE`)
- **Metrics**: `METRICS_ADDR`로 제어 (`:8080` 활성, `0` 비활성)

### 컨트롤러 메트릭 (추가)
- `kube_assistant_model_config_controller_sync_total{status,provider}`
- `kube_assistant_model_config_controller_secret_hash_change_total{provider}`

### 컨트롤러 테스트
```bash
cd services/model-config-controller-go
go test ./internal/controller -v
```

## 로컬(kind) 배포
```bash
scripts/kind-deploy.sh
```
> 로컬 Secret은 `k8s/secret.local.yaml`이 있으면 자동 적용됨.

## 운영 배포(예시)
```bash
REGISTRY=registry.example.com/kube-assistant TAG=20260215 \
  scripts/deploy-prod.sh
```
> 이미지 빌드/푸시 후 `kubectl set image`로 배포 업데이트.

## ModelConfig 사용 흐름
1) CR 생성/수정
2) 컨트롤러가 DB 동기화
3) ai-service가 DB의 활성 모델 설정을 사용

예시 CR:
```yaml
apiVersion: ai.kube-assistant.io/v1alpha1
kind: ModelConfig
metadata:
  name: openai-default
  namespace: kube-assistant
spec:
  provider: openai
  model: gpt-4o-mini
  baseURL: https://api.openai.com/v1
  apiKeySecretRef:
    name: kube-assistant-secrets
    key: OPENAI_API_KEY
  enabled: true
  isDefault: true
```

## 상태 확인
```bash
kubectl -n kube-assistant get deploy
kubectl -n kube-assistant get modelconfigs.ai.kube-assistant.io
kubectl -n kube-assistant get modelconfigs.ai.kube-assistant.io openai-default -o jsonpath='{.status}'
```

## 메트릭 관련 주의
- **kind**에는 metrics-server가 기본 없음 → 필요 시 설치
- **외부 클러스터**는 해당 클러스터에 metrics-server가 있어야 정상
