# K8s (kind) 개발 매니페스트

## 1) 이미지 빌드
```bash
docker build -t kube-assistant/auth-service:local services/auth-service
docker build -t kube-assistant/ai-service:local services/ai-service
docker build -t kube-assistant/k8s-service:local services/k8s-service
docker build -t kube-assistant/session-service:local services/session-service
docker build -t kube-assistant/frontend:local frontend
```

## 2) kind 로드
```bash
kind load docker-image kube-assistant/auth-service:local --name kube-assistant
kind load docker-image kube-assistant/ai-service:local --name kube-assistant
kind load docker-image kube-assistant/k8s-service:local --name kube-assistant
kind load docker-image kube-assistant/session-service:local --name kube-assistant
kind load docker-image kube-assistant/frontend:local --name kube-assistant
```

## 3) 시크릿 값 수정
`k8s/secret.yaml`의 `OPENAI_API_KEY`, `POSTGRES_PASSWORD`, `DATABASE_URL` 등을 로컬 값으로 바꾼 뒤 적용하세요.

## 4) 적용
```bash
kubectl apply -k k8s
```

## 5) 접속
```bash
kubectl -n kube-assistant port-forward svc/gateway 8000:8000
```
브라우저에서 `http://localhost:8000` 접속.

## 6) LiteLLM 사용 (선택)
`k8s/configmap.yaml`의 `OPENAI_BASE_URL`을 `http://litellm:4000/v1`로 설정 후 재적용.

## 참고
- kind 기본 설치에는 metrics-server가 없어서 일부 메트릭 API가 실패할 수 있습니다.
