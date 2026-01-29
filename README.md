# 🚀 Kube Assistant - MSA 아키텍처

AI-powered Kubernetes cluster management assistant with Microservice Architecture. Natural language interface for K8s resource queries, log analysis, and cluster monitoring using OpenAI.

## 📊 아키텍처 개요

```
┌─────────────────────────────────────────────────────────────┐
│                    API Gateway (NGINX)                       │
│                       Port: 8000                             │
└─────────────────────────────────────────────────────────────┘
                            │
        ┌───────────────────┼───────────────────┬─────────────┐
        ↓                   ↓                   ↓             ↓
┌───────────────┐   ┌──────────────┐   ┌─────────────────┐  │
│  AI Service   │   │ K8s Service  │   │ Session Service │  │
│  Port: 8001   │   │  Port: 8002  │   │   Port: 8003    │  │
│               │   │              │   │                 │  │
│ - OpenAI      │   │ - Cluster    │   │ - Chat History  │  │
│ - Chat Stream │   │ - Pods/Nodes │   │ - User Sessions │  │
│ - Analysis    │   │ - Logs WS    │   │ - DB Management │  │
│               │   │ - Topology   │   │                 │  │
└───────┬───────┘   └──────┬───────┘   └────────┬────────┘  │
        │                  │                     │           │
        ↓                  ↓                     ↓           ↓
┌───────────────┐   ┌──────────────┐   ┌─────────────────┐  │
│   PostgreSQL  │←──┤   Redis      │   │   Frontend      │  │
│   Port: 5432  │   │   Port: 6379 │   │   Port: 5173    │←─┘
└───────────────┘   └──────────────┘   └─────────────────┘
```

## 🎯 서비스 구성

### 1. **AI Service** (Port 8001)
- **역할**: OpenAI 통합 및 AI 기능 전담
- **기능**:
  - 세션 기반 AI 챗봇 (`/api/v1/ai/sessions/{id}/chat`)
  - 로그 분석 (`/api/v1/ai/analyze-logs`)
  - 트러블슈팅 (`/api/v1/ai/troubleshoot`)
  - 리소스 설명 (`/api/v1/ai/explain-resource`)
  - 최적화 제안 (`/api/v1/ai/suggest-optimization`)
- **의존성**: PostgreSQL, Redis, K8s Service

### 2. **K8s Service** (Port 8002)
- **역할**: Kubernetes 클러스터 관리 전담
- **기능**:
  - 클러스터 리소스 조회 (`/api/v1/cluster/*`)
  - Pod/Deployment/Service 관리
  - WebSocket 로그 스트리밍 (`/api/v1/ws/*`)
  - 토폴로지 시각화 (`/api/v1/topology/*`)
- **의존성**: Kubernetes API, kubeconfig

### 3. **Session Service** (Port 8003)
- **역할**: 채팅 세션 및 히스토리 관리
- **기능**:
  - 세션 CRUD (`/api/v1/sessions/*`)
  - 메시지 히스토리 저장/조회
  - Tool Context 저장 (Redis)
- **의존성**: PostgreSQL

### 4. **API Gateway** (Port 8000)
- **역할**: 라우팅 및 로드 밸런싱
- **기능**:
  - 요청 라우팅
  - CORS 처리
  - SSE 및 WebSocket 프록시
- **기술**: NGINX

### 5. **Frontend** (Port 5173)
- **역할**: React 기반 UI
- **기술**: React + TypeScript + Tailwind CSS

## 🚀 실행 방법

### 1. 환경 변수 설정

`.env` 파일 생성:

```bash
# OpenAI
OPENAI_API_KEY=your-api-key-here
OPENAI_MODEL=gpt-4

# PostgreSQL
POSTGRES_USER=kagent
POSTGRES_PASSWORD=your-password
POSTGRES_DB=kagent

# Kubernetes
K8S_API_HOST=your-k8s-api-host
K8S_API_IP=your-k8s-api-ip
```

### 2. kubeconfig 파일 배치

프로젝트 루트에 `kubeconfig.yaml` 파일을 배치하세요.

### 3. 서비스 실행

```bash
# 모든 서비스 빌드 및 실행
docker-compose up --build

# 백그라운드 실행
docker-compose up -d --build

# 로그 확인
docker-compose logs -f

# 특정 서비스만 실행
docker-compose up ai-service k8s-service

# 서비스 중지
docker-compose down
```

### 4. 서비스 접속

- **Frontend**: http://localhost:5173
- **API Gateway**: http://localhost:8000
- **AI Service**: http://localhost:8001
- **K8s Service**: http://localhost:8002
- **Session Service**: http://localhost:8003

## 🔍 헬스 체크

각 서비스의 상태 확인:

```bash
# API Gateway
curl http://localhost:8000/health

# AI Service
curl http://localhost:8001/health

# K8s Service
curl http://localhost:8002/health

# Session Service
curl http://localhost:8003/health
```

## 📁 디렉토리 구조

```
├── services/
│   ├── ai-service/           # AI 서비스
│   │   ├── app/
│   │   │   ├── api.py
│   │   │   ├── config.py
│   │   │   ├── database.py
│   │   │   ├── ai.py
│   │   │   └── services/
│   │   │       ├── ai_service.py
│   │   │       └── k8s_client.py
│   │   ├── Dockerfile
│   │   ├── requirements.txt
│   │   └── main.py
│   ├── k8s-service/          # K8s 서비스
│   │   ├── app/
│   │   │   ├── api.py
│   │   │   ├── config.py
│   │   │   ├── cluster.py
│   │   │   └── services/
│   │   │       ├── k8s_service.py
│   │   │       └── topology_service.py
│   │   ├── Dockerfile
│   │   ├── requirements.txt
│   │   └── main.py
│   ├── session-service/      # Session 서비스
│   │   ├── app/
│   │   │   ├── api.py
│   │   │   ├── config.py
│   │   │   └── database.py
│   │   ├── Dockerfile
│   │   ├── requirements.txt
│   │   └── main.py
│   └── gateway/              # API Gateway
│       └── nginx.conf
├── frontend/                 # 프론트엔드
├── docker-compose.yml        # Docker Compose 설정
└── README.md                 # 이 파일
```

## 🔧 개발 가이드

### 서비스 간 통신

AI Service에서 K8s Service 호출 예시:

```python
from app.services.k8s_client import K8sServiceClient

k8s_client = K8sServiceClient()
pods = await k8s_client.get_pods(namespace="default")
```

### 새로운 엔드포인트 추가

1. 해당 서비스의 `app/api.py`에 라우터 추가
2. Gateway의 `nginx.conf`에 라우팅 규칙 추가
3. 서비스 재시작

### 데이터베이스 마이그레이션

```bash
# PostgreSQL 컨테이너 접속
docker exec -it agentforcmp-postgres-1 psql -U kagent -d kagent

# 테이블 확인
\dt

# 세션 확인
SELECT * FROM chat_sessions;
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
