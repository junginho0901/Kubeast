# K8s (kind) 개발 매니페스트

## 1) 이미지 빌드
```bash
docker build -t kube-assistant/auth-service:local services/auth-service
docker build -t kube-assistant/ai-service:local services/ai-service
docker build -t kube-assistant/k8s-service:local services/k8s-service
docker build -t kube-assistant/tool-server:local services/tool-server
docker build -t kube-assistant/session-service:local services/session-service
docker build -t kube-assistant/frontend:local frontend
docker build -t kube-assistant/model-config-controller-go:local services/model-config-controller-go
```

## 2) kind 로드
```bash
kind load docker-image kube-assistant/auth-service:local --name kube-assistant
kind load docker-image kube-assistant/ai-service:local --name kube-assistant
kind load docker-image kube-assistant/k8s-service:local --name kube-assistant
kind load docker-image kube-assistant/tool-server:local --name kube-assistant
kind load docker-image kube-assistant/session-service:local --name kube-assistant
kind load docker-image kube-assistant/frontend:local --name kube-assistant
kind load docker-image kube-assistant/model-config-controller-go:local --name kube-assistant
```

## 3) 시크릿 값 수정
`k8s/secret.yaml`의 `OPENAI_API_KEY`, `POSTGRES_PASSWORD`, `DATABASE_URL` 등을 로컬 값으로 바꾼 뒤 적용하세요.

## 4) 적용
```bash
kubectl apply -k k8s
```

## 4-1) 외부 클러스터 연결 (선택)
kind 내부가 아니라 **기존 클러스터**를 보려면 kubeconfig를 시크릿으로 주입하세요.
```bash
KUBECONFIG=/Users/okestro/AgentForCMP/.kubeconfig-kind kubectl -n kube-assistant create secret generic k8s-kubeconfig \
  --from-file=kubeconfig.yaml=/Users/okestro/AgentForCMP/kubeconfig-proxy.yaml \
  --dry-run=client -o yaml | KUBECONFIG=/Users/okestro/AgentForCMP/.kubeconfig-kind kubectl apply -f -
KUBECONFIG=/Users/okestro/AgentForCMP/.kubeconfig-kind kubectl -n kube-assistant rollout restart deploy/k8s-service
```
> kubeconfig 경로는 로컬 환경에 맞게 바꿔주세요.

## 5) 접속 (NodePort)
```bash
kubectl -n kube-assistant get svc gateway
```
기본 NodePort는 `30080`이므로 `http://localhost:30080`로 접근합니다.

> kind에서 NodePort가 로컬에 안 뜨면, 포트포워딩으로 임시 접근하거나
> cluster 재생성 시 `extraPortMappings`를 설정해야 합니다.
>
> 예: `kind-config.yaml` 사용
> ```bash
> kind create cluster --name kube-assistant --config kind-config.yaml
> ```

## 6) LiteLLM 사용 (선택)
`k8s/configmap.yaml`의 `OPENAI_BASE_URL`을 `http://litellm:4000/v1`로 설정 후 재적용.

## 참고
- kind 기본 설치에는 metrics-server가 없어서 일부 메트릭 API가 실패할 수 있습니다.
- 컨트롤러 메트릭은 `METRICS_ADDR`로 제어합니다 (`0` 기본 비활성, 활성화는 `:8080`).

## ModelConfig (DB 기반) 사용
AI 모델 설정을 DB에서 관리합니다. API 키는 **K8s Secret의 키 이름**을 참조합니다.

예시 (admin 계정으로 토큰 발급 후 호출):
```bash
# 로그인 → 토큰
curl -s -X POST http://localhost:30080/api/v1/auth/login \
  -H "Content-Type: application/json" \
  -d '{"email":"admin@local","password":"admin"}'

# 모델 설정 생성
curl -s -X POST http://localhost:30080/api/v1/ai/model-configs \
  -H "Authorization: Bearer <TOKEN>" \
  -H "Content-Type: application/json" \
  -d '{
    "name":"openai-default",
    "provider":"openai",
    "model":"gpt-4o-mini",
    "base_url":"https://api.openai.com/v1",
    "api_key_secret_name":"kube-assistant-secrets",
    "api_key_secret_key":"OPENAI_API_KEY",
    "is_default":true
  }'
```

## ModelConfig (CRD + Controller)
CRD와 컨트롤러로 ModelConfig를 관리합니다. 컨트롤러가 CRD를 DB로 동기화합니다.

### 적용
```bash
kubectl apply -f k8s/model-config-crd.yaml
kubectl -n kube-assistant apply -f k8s/model-config-controller-go.yaml
```

### 컨트롤러 이미지 (kind)
```bash
docker build -t kube-assistant/model-config-controller-go:local services/model-config-controller-go
kind load docker-image kube-assistant/model-config-controller-go:local --name kube-assistant
kubectl -n kube-assistant rollout restart deploy/model-config-controller-go
```


### 예시 CR
```bash
kubectl -n kube-assistant apply -f k8s/model-config-sample.yaml
```
