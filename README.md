# Kubeast

> 자연어 AI 어시스턴트 + 멀티클러스터 대시보드를 하나로 합친 Kubernetes 운영 플랫폼

**Kubeast**는 "클러스터에 자연어로 말을 걸어 운영한다"는 발상에서 출발한 Kubernetes
운영 플랫폼입니다. 풍부한 멀티클러스터 대시보드 위에 LLM 기반 AI 어시스턴트를 얹어,
리소스 조회·진단·변경을 채팅으로 수행할 수 있고, 동시에 전통적인 GUI로
Workloads / Network / Storage / RBAC / GPU / Helm 까지 한 화면에서 다룹니다.

- 🤖 **AI가 일급 시민** — 단순 챗봇이 아니라, 화면 컨텍스트를 이해하고 화이트리스트
  툴로 실제 클러스터를 조작하는 에이전트
- 🌐 **멀티클러스터 + 클러스터별 RBAC** — 여러 클러스터를 한 UI에서, 사용자×클러스터
  단위 권한(deny-by-default)으로 관리
- 📋 **감사 로그 내장** — 모든 쓰기 작업과 민감 조회를 기록
- 🚀 **한 줄 설치** — 공개 컨테이너 이미지(ghcr.io)로 K8s·Docker 어디든 즉시 배포

---

## 목차

- [빠른 시작](#빠른-시작)
- [설치 후 첫 설정](#설치-후-첫-설정)
- [주요 기능](#주요-기능)
- [아키텍처](#아키텍처)
- [설정 (values.yaml)](#설정-valuesyaml)
- [디렉터리 구조](#디렉터리-구조)
- [개발](#개발)
- [문서](#문서)
- [기술 스택](#기술-스택)

---

## 빠른 시작

모든 컴포넌트 이미지는 **GitHub Container Registry(ghcr.io)에 공개 패키지**로 게시되어
있어 별도 빌드 없이 바로 설치됩니다. (공개 패키지는 익명 pull rate limit이 없습니다.)

### 옵션 1. 설치 스크립트 (이미 동작 중인 K8s 클러스터에 한 줄)

```bash
curl -sSL https://raw.githubusercontent.com/junginho0901/Kubeast/main/install.sh | bash
```

옵션:

```bash
# NodePort 변경 (기본 30333)
curl -sSL .../install.sh | bash -s -- --node-port 30333

# LoadBalancer (클라우드 환경)
curl -sSL .../install.sh | bash -s -- --load-balancer

# 네임스페이스 지정
curl -sSL .../install.sh | bash -s -- --namespace my-ns
```

> 사전 요구: `kubectl`, `helm`, 그리고 접근 가능한 Kubernetes 클러스터.

### 옵션 2. Helm 직접 사용

```bash
git clone https://github.com/junginho0901/Kubeast.git
cd Kubeast

helm install kubeast ./helm/kubeast \
  --namespace kubeast --create-namespace \
  --set ai.openaiApiKey=$OPENAI_API_KEY     # 선택: 나중에 UI에서도 등록 가능
```

### 옵션 3. Docker Compose (클러스터 없이 단일 호스트)

```bash
git clone https://github.com/junginho0901/Kubeast.git
cd Kubeast

./install-docker.sh
#   --kubeconfig /path/to/kubeconfig.yaml   # 관리할 클러스터 kubeconfig
#   --port 9000                             # Gateway 포트 (기본 8000)
#   --uninstall                             # 컨테이너 + 볼륨 모두 제거
```

`docker-compose`는 published 이미지를 pull 합니다. 소스에서 빌드하려면:

```bash
docker compose -f docker-compose.yml -f docker-compose.build.yml up -d --build
```

### 제거

```bash
helm uninstall kubeast -n kubeast      # K8s
./install-docker.sh --uninstall        # Docker
```

---

## 설치 후 첫 설정

### 1. 접속

- **NodePort**: `http://<노드IP>:30333/setup`
- **포트포워드**: `kubectl -n kubeast port-forward svc/gateway 8000:8000` → `http://localhost:8000/setup`
- **Docker**: `http://localhost:8000`

### 2. 관리자 비밀번호 확인

초기 admin 비밀번호는 **설치 시 무작위 생성**됩니다(`admin.password`를 비워둔 경우).

```bash
# K8s / Helm
kubectl -n kubeast get secret kubeast-secrets \
  -o jsonpath='{.data.DEFAULT_ADMIN_PASSWORD}' | base64 -d ; echo

# Docker — .env 파일의 DEFAULT_ADMIN_PASSWORD
grep DEFAULT_ADMIN_PASSWORD .env
```

비밀번호를 직접 지정하려면 설치 시 `--set admin.password=<원하는비번>`.

### 3. 클러스터 연결 (Connect your cluster)

`/setup` 페이지에서 관리할 클러스터를 연결합니다.

- **In-cluster** — Kubeast가 떠 있는 그 클러스터를 ServiceAccount 권한으로 자동 연결
- **External** — 다른 클러스터의 kubeconfig를 등록 (멀티클러스터)

연결 후 `admin` 계정으로 로그인합니다. **로그인 후 즉시 비밀번호를 변경하세요.**

### 4. AI 활성화

**Admin > AI Models**에서 OpenAI / Anthropic / Gemini 등의 API 키를 등록하면
AI 어시스턴트가 활성화됩니다.

---

## 주요 기능

### 🤖 AI 어시스턴트

- **다중 LLM 지원** — OpenAI · Anthropic · Gemini · Ollama 등 (OpenAI 호환 어댑터로 통합)
- **스트리밍 채팅** — SSE 기반 실시간 응답, 세션/히스토리 보존
- **다중 라운드 Tool Calling** — AI가 화이트리스트 툴로 K8s를 조회·변경(최대 10라운드).
  읽기/쓰기/관리 툴은 **사용자 권한(JWT)에 따라 게이팅**
- **플로팅 AI 위젯** — 모든 페이지에 떠 있는 위젯이 **현재 화면 컨텍스트(보고 있는 리소스)**
  를 이해하고 답변 (read-only 툴로 제한)
- **로그 분석 / 트러블슈팅 / 리소스 설명 / 최적화 제안** — 원샷 분석 엔드포인트
- **모델 설정** — `ModelConfig` CRD + DB로 관리, Admin UI에서 추가/테스트

### 🌐 멀티클러스터 & RBAC

- **클러스터 레지스트리** — in-cluster(self) + 외부 클러스터(kubeconfig) 등록/검증/헬스체크
- **클러스터별 RBAC** — 사용자×클러스터마다 역할 부여, **deny-by-default**
  (권한 없는 클러스터는 목록에도 안 보임)
- **부하/장애 격리** — 클러스터별 클라이언트 풀(LRU) · 서킷 브레이커 · 헬스체크 ·
  rate limit · Prometheus 쿼리 캐시
- **클러스터 스위처** — UI 상단에서 전환, 탭별 독립(URL 쿼리 기반)
- **커스텀 역할** — 리소스 단위 권한(`resource.*.read/create/edit/delete`),
  메뉴 가시성(`menu.*`), AI 툴(`ai.tool.*`)

### ☸️ Kubernetes 리소스 관리

| 도메인 | 리소스 |
| --- | --- |
| **Workloads** | Pod, Deployment, StatefulSet, DaemonSet, ReplicaSet, Job, CronJob, HPA, VPA, PDB |
| **Network** | Service, Endpoint, EndpointSlice, Ingress, IngressClass, NetworkPolicy |
| **Gateway API** | Gateway, GatewayClass, HTTPRoute, GRPCRoute, ReferenceGrant, BackendTLS/TrafficPolicy |
| **Storage** | PV, PVC, StorageClass, VolumeAttachment |
| **Configuration** | ConfigMap, Secret, ResourceQuota, LimitRange, PriorityClass, RuntimeClass, Lease |
| **Security (RBAC)** | Role, ClusterRole, RoleBinding, ClusterRoleBinding, ServiceAccount |
| **Cluster** | Node, Namespace, Webhook Configuration(Mutating/Validating) |
| **Custom Resources** | CRD 동적 탐색 및 인스턴스 편집 |

- **YAML 편집** (Monaco), **Pod Exec / 로그** (xterm.js, WebSocket)
- **실시간 갱신** — WebSocket 멀티플렉서로 리소스 변경 스트리밍

### ⎈ Helm 릴리스 관리

- 릴리스 목록 / 상세 / 히스토리 / values / 매니페스트 / 리소스 보기
- **Rollback · Upgrade · Uninstall · Test** (모두 dry-run 미리보기 + 확인 후 실행)

### 🎮 GPU & DRA (Dynamic Resource Allocation)

- GPU 노드 / Pod / 사용률 대시보드, NVIDIA GPU 메트릭
- DeviceClass, ResourceClaim, ResourceClaimTemplate, ResourceSlice 관리

### 📊 관측성 (Observability)

- **Topology View** — 클러스터 리소스 관계 시각화 (React Flow / dagre / elkjs)
- **Dependency Graph** — 워크로드 간 의존성 그래프
- **Monitoring** — Prometheus 시계열 차트, 이상 감지, 상관 분석, GPU 심층 메트릭
- **Node Shell** — 웹 기반 노드 터미널
- **Advanced Search** — 표현식 기반 전역 리소스 탐색

### 🔐 인증 · 감사

- JWT 기반 자체 인증(JWKS) — 조직(Organization) / 팀(Team) / 사용자 계층
- **감사 로그** — 모든 쓰기 작업 + 민감 조회(Secret 열람, Node Shell, Helm 변경 등)를
  기록, 성공/실패 모두 추적
- **i18n** — 한국어 · 영어

---

## 아키텍처

NGINX 게이트웨이가 모든 요청을 받아 각 마이크로서비스로 라우팅합니다.
영속 상태는 PostgreSQL, 캐시/세션 컨텍스트는 Redis가 담당합니다.

```
                         ┌──────────────────────────┐
                         │  Frontend (React + Vite) │
                         └────────────┬─────────────┘
                                      │
                         ┌────────────▼─────────────┐
                         │  Gateway (NGINX, :8000)  │  라우팅 · CORS · SSE/WS 프록시
                         └────────────┬─────────────┘
        ┌───────────┬─────────────────┼─────────────────┬───────────┐
        ▼           ▼                 ▼                 ▼           ▼
   ┌─────────┐ ┌─────────┐      ┌──────────┐      ┌─────────┐ ┌──────────┐
   │  Auth   │ │   AI    │      │   K8s    │      │ Session │ │   Tool   │
   │   Go    │ │ FastAPI │─────▶│   Go     │      │   Go    │ │  Server  │
   │  :8004  │ │  :8001  │      │  :8002   │      │  :8003  │ │   Go     │
   └────┬────┘ └────┬────┘      └────┬─────┘      └────┬────┘ └────┬─────┘
        │           │                │                 │           │
        │           └──────┐    ┌────┘                 │      kubectl → K8s API
        ▼                  ▼    ▼                       ▼
   ┌──────────┐        ┌──────────┐               ┌──────────┐
   │ Postgres │        │  Redis   │               │ K8s API  │ (멀티클러스터)
   └──────────┘        └──────────┘               └──────────┘

   model-config-controller (controller-runtime) — ModelConfig CRD 감시
```

**AI Tool-calling 흐름**: `ai-service`가 채팅을 오케스트레이션하며, 화이트리스트된
툴을 `tool-server`로 디스패치 → `tool-server`가 선택된 클러스터의 K8s API를 호출 →
결과가 채팅으로 스트리밍됩니다.

### 서비스 구성

| 서비스 | 언어 | 포트 | 역할 |
| --- | --- | --- | --- |
| `gateway` | NGINX | 8000 | API 라우팅, CORS, SSE/WebSocket 프록시 (이미지 빌드 없음, 설정만) |
| `auth-service` | Go | 8004 | 인증, JWT/JWKS, 조직/팀/RBAC, 클러스터 레지스트리 |
| `ai-service` | Python (FastAPI) | 8001 | LLM 통합, 스트리밍 챗봇, 로그 분석, Tool calling |
| `k8s-service` | Go | 8002 | K8s 리소스 CRUD, WS 로그/exec, 토폴로지, Helm, GPU/DRA, 멀티클러스터 풀 |
| `session-service` | Go | 8003 | 채팅 세션 / 메시지 히스토리 |
| `tool-server` | Go | — | AI Tool 호출 백엔드 (kubectl 실행) |
| `model-config-controller` | Go (controller-runtime) | — | `ModelConfig` CRD 컨트롤러 |
| `frontend` | React + Vite + TS | 5173 | UI (prod 정적 빌드, nginx 서빙) |
| `postgres` | — | 5432 | 메인 DB (durable state) |
| `redis` | — | 6379 | 캐시 / 세션 컨텍스트 |

### 컨테이너 이미지

모두 ghcr.io에 공개 패키지로 게시됩니다.

```
ghcr.io/junginho0901/kubeast-frontend
ghcr.io/junginho0901/kubeast-auth-service
ghcr.io/junginho0901/kubeast-ai-service
ghcr.io/junginho0901/kubeast-k8s-service
ghcr.io/junginho0901/kubeast-session-service
ghcr.io/junginho0901/kubeast-tool-server
ghcr.io/junginho0901/kubeast-model-config-controller-go
```

> 릴리스: `v*` 태그를 push하면 GitHub Actions(`.github/workflows/release.yaml`)가
> 7개 이미지를 ghcr에 자동 빌드·게시하고 Helm 차트를 패키징합니다.

---

## 설정 (values.yaml)

자주 쓰는 값:

```yaml
global:
  imageTag: "v0.1.0"

# 초기 관리자 계정 — password 를 비우면 설치 시 랜덤 생성
admin:
  email: admin
  password: ""          # 비우면 자동 생성 (secret 으로 확인)

# AI 키 (Admin UI 에서도 등록 가능)
ai:
  openaiApiKey: ""
  anthropicApiKey: ""
  geminiApiKey: ""
  model: "gpt-4o-mini"

# 내장 PostgreSQL / Redis (false 면 외부 사용)
postgresql:
  enabled: true
  user: kubeast
  password: kubeast
  database: kubeast
redis:
  enabled: true

# Gateway 노출 방식
gateway:
  service:
    type: NodePort        # NodePort | ClusterIP | LoadBalancer
    nodePort: 30333

# Ingress (선택)
ingress:
  enabled: false
  className: ""
  host: kubeast.example.com
  tls: false

# 멀티클러스터 부하/장애 격리 튜닝
multicluster:
  maxClusters: 20
  healthcheckIntervalSec: 60
  rateLimitQPS: 0           # 0 = off
  breakerConsecutiveFails: 5
```

전체 옵션은 [helm/kubeast/values.yaml](helm/kubeast/values.yaml) 참고.

---

## 디렉터리 구조

```
.
├── services/
│   ├── ai-service/                  # Python · FastAPI · LLM 통합 / Tool calling
│   ├── auth-service-go/             # Go · 인증 / RBAC / 클러스터 레지스트리
│   ├── k8s-service-go/              # Go · K8s 리소스 API / Helm / 멀티클러스터
│   ├── session-service-go/          # Go · 채팅 세션
│   ├── tool-server/                 # Go · AI Tool 백엔드 (kubectl)
│   ├── model-config-controller-go/  # Go · ModelConfig CRD 컨트롤러
│   └── pkg/                         # Go 공통 (audit / auth / cluster / config …)
├── frontend/                        # React + TS + Tailwind
├── helm/kubeast/                    # Helm 차트 (정본 nginx.conf = files/nginx.conf)
├── k8s/                             # 원본 매니페스트 (참고용)
├── e2e/                             # Playwright E2E (라이브 클러스터 대상)
├── docs/                            # 기능 설계 문서
├── scripts/                         # 빌드/배포/개발 스크립트
├── install.sh                       # K8s 원라인 설치
├── install-docker.sh                # Docker 원라인 설치
└── docker-compose.yml               # (+ docker-compose.build.yml 빌드 override)
```

---

## 개발

로컬 개발 루프는 kind 기반입니다. 빌드/배포는 **항상 `scripts/rebuild-kind.sh`**를 통해
수행합니다(직접 docker/kubectl 금지).

```bash
scripts/rebuild-kind.sh ai-service frontend   # 특정 서비스 재빌드+배포
scripts/rebuild-kind.sh --all                 # 전체
```

### 프론트엔드

```bash
cd frontend
npm install
npm run dev      # http://localhost:5173
npm run build    # tsc + vite build
npm run lint     # eslint (--max-warnings 0)
npm run test     # vitest
```

### Go 서비스

```bash
cd services/k8s-service-go
go run ./cmd/server
go test ./...
```

### Python AI 서비스

```bash
cd services/ai-service
pip install -r requirements.txt
uvicorn main:app --reload --port 8001
pytest
```

### 헬스 체크

```bash
curl http://localhost:8000/health   # Gateway
```

> ⚠️ 쓰기 성격의 Go 핸들러를 추가/수정할 때는 **감사 로그 기록이 필수**입니다.
> 자세한 규칙은 [AGENTS.md](AGENTS.md) 참고.

---

## 문서

| 문서 | 내용 |
| --- | --- |
| [AGENTS.md](AGENTS.md) | 기여 규칙 (감사 로그 필수 규칙 등) |
| [docs/multi_cluster.md](docs/multi_cluster.md) | 멀티클러스터 설계 |
| [docs/audit-log-plan.md](docs/audit-log-plan.md) | 감사 로그 설계 / 액션 카탈로그 |
| [docs/helm-plan.md](docs/helm-plan.md) | Helm 릴리스 관리 |
| [docs/floating-ai-chat-plan.md](docs/floating-ai-chat-plan.md) | 플로팅 AI 위젯 |
| [docs/prometheus-*.md](docs/) | 모니터링(시계열/이상감지/상관분석/GPU) |

---

## 기술 스택

**Backend**
- Go 1.22 (auth · k8s · session · tool-server · controller)
- Python 3.11 + FastAPI (ai-service)
- PostgreSQL 15, Redis 7
- controller-runtime (CRD operator)

**Frontend**
- React 18 · TypeScript · Vite · Tailwind CSS
- TanStack Query · React Router
- Monaco Editor · xterm.js
- React Flow · dagre · elkjs (그래프) · Recharts (차트)
- i18next (한/영)

**Infra**
- Kubernetes · Helm · NGINX
- GitHub Container Registry (ghcr.io) · GitHub Actions

---

## 라이선스

MIT License
