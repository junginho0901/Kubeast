# Kubest

> Kubernetes DevOps Assistant with AI Chat

Kubest는 자연어 기반 AI 어시스턴트와 풍부한 대시보드를 결합한 Kubernetes 운영 플랫폼입니다.
멀티 클러스터 관리, GPU/DRA 모니터링, RBAC, Node Shell, 토폴로지 시각화 등 운영에 필요한 기능을
하나의 UI에서 제공합니다.

---

## 빠른 시작

이미 동작 중인 Kubernetes 클러스터에 한 줄로 설치할 수 있습니다.
모든 컴포넌트 이미지는 Docker Hub에 푸시되어 있으므로 별도 빌드가 필요 없습니다.

### 옵션 1. 설치 스크립트 (가장 간단)

```bash
curl -sSL https://raw.githubusercontent.com/JeongInho/kube-assistant/main/install.sh | bash
```

옵션 예시:

```bash
# NodePort 변경
curl -sSL .../install.sh | bash -s -- --node-port 30080

# LoadBalancer 사용 (클라우드 환경)
curl -sSL .../install.sh | bash -s -- --load-balancer

# 네임스페이스 지정
curl -sSL .../install.sh | bash -s -- --namespace my-ns
```

### 옵션 2. Helm 직접 사용

```bash
git clone https://github.com/JeongInho/kube-assistant.git
cd kube-assistant

helm install kubest ./helm/kubest \
  --namespace kubest --create-namespace \
  --set ai.openaiApiKey=$OPENAI_API_KEY
```

### 접속

```bash
kubectl -n kubest get pods
kubectl -n kubest port-forward svc/gateway 8000:8000
```

브라우저에서 `http://localhost:8000/setup` 으로 접속한 뒤,

- 기본 관리자 계정: `admin@local` / `admin`
- 로그인 후 **Admin > AI Models** 에서 LLM 키를 등록하면 챗봇이 활성화됩니다.

### 제거

```bash
helm uninstall kubest -n kubest
```

---

## 주요 기능

### AI Assistant
- OpenAI · Anthropic · Gemini 다중 LLM 지원
- 세션 기반 대화형 챗봇 (스트리밍)
- 로그 분석 / 트러블슈팅 / 리소스 설명 / 최적화 제안
- Tool calling 기반 K8s 리소스 자동 조회

### Kubernetes 리소스 관리
- **Workloads**: Pod, Deployment, StatefulSet, DaemonSet, Job, CronJob, ReplicaSet, HPA, VPA, PDB
- **Network**: Service, Ingress, NetworkPolicy, EndpointSlice, Gateway API
- **Storage**: PV, PVC, StorageClass, VolumeSnapshot
- **Configuration**: ConfigMap, Secret, ResourceQuota, LimitRange, PriorityClass
- **Security**: Role, ClusterRole, RoleBinding, ServiceAccount
- **Custom Resources**: CRD 동적 탐색 및 편집

### GPU & DRA (Dynamic Resource Allocation)
- GPU 노드 / Pod / 사용률 대시보드
- DeviceClass, ResourceClaim, ResourceClaimTemplate, ResourceSlice 관리
- NVIDIA GPU 메트릭 시각화

### 운영 도구
- **Topology View**: 클러스터 리소스 관계 시각화 (React Flow)
- **Dependency Graph**: 워크로드 간 의존성 그래프
- **Node Shell**: 웹 기반 노드 터미널 (xterm.js)
- **Advanced Search**: JSONPath · 표현식 기반 리소스 탐색
- **Monitoring**: Prometheus 메트릭 차트, 이상 감지, 상관 분석
- **Multi-Cluster**: 여러 클러스터 동시 관리

### 인증 / 권한
- JWT 기반 자체 인증 (auth-service)
- 조직(Organization) / 팀(Team) / 사용자(User) 계층
- 리소스 단위 RBAC (Custom Roles)
- i18n: 한국어 · 영어

---

## 아키텍처

```
                   ┌──────────────────────────┐
                   │   Frontend (React + TS)  │
                   └────────────┬─────────────┘
                                │
                   ┌────────────▼─────────────┐
                   │   Gateway (NGINX, :8000) │
                   └────────────┬─────────────┘
        ┌───────────┬───────────┼───────────┬───────────┐
        ▼           ▼           ▼           ▼           ▼
   ┌─────────┐ ┌─────────┐ ┌─────────┐ ┌─────────┐ ┌──────────┐
   │  Auth   │ │   AI    │ │   K8s   │ │ Session │ │   Tool   │
   │   Go    │ │ Python  │ │   Go    │ │   Go    │ │ Server   │
   │  :8004  │ │  :8001  │ │  :8002  │ │  :8003  │ │   Go     │
   └────┬────┘ └────┬────┘ └────┬────┘ └────┬────┘ └────┬─────┘
        │           │           │           │           │
        └─────┬─────┴─────┬─────┴─────┬─────┘           │
              ▼           ▼           ▼                  ▼
        ┌──────────┐ ┌──────────┐ ┌──────────┐    ┌──────────┐
        │ Postgres │ │  Redis   │ │   K8s    │    │  Model   │
        │          │ │          │ │   API    │    │  Config  │
        └──────────┘ └──────────┘ └──────────┘    │   CRD    │
                                                   │Controller│
                                                   └──────────┘
```

### 서비스 구성

| 서비스 | 언어 | 포트 | 역할 |
| --- | --- | --- | --- |
| `gateway` | NGINX | 8000 | API 라우팅, CORS, SSE/WebSocket 프록시 |
| `auth-service` | Go | 8004 | 사용자 인증, JWT 발급, JWKS, 조직/팀/RBAC |
| `ai-service` | Python (FastAPI) | 8001 | LLM 통합, 챗봇, 로그 분석, Tool calling |
| `k8s-service` | Go | 8002 | K8s 리소스 CRUD, WebSocket 로그/exec, 토폴로지 |
| `session-service` | Go | 8003 | 채팅 세션 / 메시지 히스토리 |
| `tool-server` | Go | - | AI Tool 호출 백엔드 |
| `model-config-controller` | Go (controller-runtime) | - | `ModelConfig` CRD 컨트롤러 |
| `frontend` | React + Vite + TS | 5173 | UI |
| `postgres` | - | 5432 | 메인 DB |
| `redis` | - | 6379 | 캐시 / 세션 컨텍스트 |

### 컨테이너 이미지

모든 이미지는 Docker Hub에 게시되어 있습니다.

| 이미지 |
| --- |
| `jeonginho/kubest-frontend` |
| `jeonginho/kubest-auth-service` |
| `jeonginho/kubest-ai-service` |
| `jeonginho/kubest-k8s-service` |
| `jeonginho/kubest-session-service` |
| `jeonginho/kubest-tool-server` |
| `jeonginho/kubest-model-config-controller-go` |

---

## 설정 (values.yaml)

자주 사용하는 설정 값:

```yaml
global:
  imageTag: "v0.1.0"

# 초기 관리자 계정
admin:
  email: admin@local
  password: admin

# AI 키 (Admin UI 에서 추가도 가능)
ai:
  openaiApiKey: ""
  anthropicApiKey: ""
  geminiApiKey: ""
  model: "gpt-4o-mini"

# 내장 PostgreSQL 사용 (false 면 외부 DB 연결)
postgresql:
  enabled: true
  user: kubest
  password: kubest
  database: kubest

# 내장 Redis 사용
redis:
  enabled: true

# Gateway 노출 방식
gateway:
  service:
    type: NodePort        # NodePort | ClusterIP | LoadBalancer
    nodePort: 30333

# Ingress 사용 시
ingress:
  enabled: false
  className: ""
  host: kubest.example.com
  tls: false
```

전체 옵션은 [helm/kubest/values.yaml](helm/kubest/values.yaml) 참고.

---

## 디렉토리 구조

```
.
├── services/
│   ├── ai-service/                  # Python · FastAPI · LLM 통합
│   ├── auth-service-go/             # Go · 인증/RBAC
│   ├── k8s-service-go/              # Go · K8s 리소스 API
│   ├── session-service-go/          # Go · 채팅 세션
│   ├── tool-server/                 # Go · AI Tool 백엔드
│   ├── model-config-controller-go/  # Go · CRD 컨트롤러
│   ├── gateway/                     # NGINX 설정
│   └── pkg/                         # Go 공통 패키지
├── frontend/                        # React + TS + Tailwind
├── helm/kubest/                     # Helm 차트
├── k8s/                             # 원본 매니페스트 (참고용)
├── docs/                            # 기능 설계 문서
└── install.sh                       # 원라인 설치 스크립트
```

---

## 개발

소스에서 직접 빌드해 개발하려는 경우:

### 프론트엔드

```bash
cd frontend
npm install
npm run dev          # http://localhost:5173
npm run build
npm run lint
```

### Go 서비스

```bash
cd services/k8s-service-go
go mod download
go run ./cmd/server
```

### Python AI 서비스

```bash
cd services/ai-service
pip install -r requirements.txt
uvicorn main:app --reload --port 8001
```

## 🐛 트러블슈팅

### 서비스가 시작되지 않을 때

```bash
# 로그 확인
docker-compose logs ai-service

# 컨테이너 상태 확인
docker-compose ps

# 네트워크 확인
docker network inspect agentforcmp_msa-network
```

### Kubernetes 연결 오류

1. kubeconfig 파일 경로 확인
2. K8s API 접근 가능 여부 확인
3. K8s Service 헬스 체크: `curl http://localhost:8002/health`

### AI 서비스 오류

1. OpenAI API 키 확인
2. PostgreSQL 연결 확인
3. AI Service 로그 확인: `docker logs agentforcmp-ai-service-1`

## 📊 성능 및 확장성

### 스케일링

```bash
# AI Service 복제본 3개로 확장
docker-compose up --scale ai-service=3

# K8s Service 복제본 2개로 확장
docker-compose up --scale k8s-service=2
```

### 모니터링

각 서비스는 독립적으로 모니터링 가능:

- **메트릭**: 각 서비스 `/metrics` 엔드포인트
- **로그**: `docker-compose logs -f [service-name]`
- **헬스 체크**: `/health` 엔드포인트

## 🔐 보안

- API Gateway에서 인증/인가 추가 권장
- 환경 변수로 민감 정보 관리
- 서비스 간 통신은 내부 네트워크 사용
- Production 환경에서는 HTTPS 적용 필수

## 🎯 다음 단계

- [ ] API Gateway에 JWT 인증 추가
- [ ] Prometheus + Grafana 모니터링 구축
- [ ] ELK Stack 로깅 시스템 구축
- [ ] Kubernetes 배포 (Helm Chart)
- [ ] CI/CD 파이프라인 구축
- [ ] 추가 AI 기능 UI 구현

## 📝 라이선스

MIT License
