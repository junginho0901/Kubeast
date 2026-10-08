# Kubeast

AI 어시스턴트를 내장한 멀티클러스터 Kubernetes 운영 플랫폼입니다. 웹 UI에서 여러
클러스터의 리소스(Workloads, Network, Storage, RBAC, GPU, Helm 등)를 조회·관리하고,
LLM 기반 채팅으로 리소스 조회·진단·변경을 수행할 수 있습니다.

주요 특징:

- 다중 LLM(OpenAI · Anthropic · Gemini · Ollama) AI 어시스턴트, Tool calling 기반 클러스터 조작
- 멀티클러스터 관리 및 사용자×클러스터 단위 RBAC
- Helm 릴리스 관리 (rollback / upgrade / uninstall / test)
- GPU & DRA 모니터링, Prometheus 메트릭, 토폴로지 시각화, Node Shell
- 모든 쓰기/민감 작업에 대한 감사 로그
- 공개 컨테이너 이미지(ghcr.io) 기반 한 줄 설치 (Kubernetes / Docker)
- 한국어 · 영어 지원

---

## 목차

- [빠른 시작](#빠른-시작)
- [설치 후 첫 설정](#설치-후-첫-설정)
- [주요 기능](#주요-기능)
- [아키텍처](#아키텍처)
- [설정 (values.yaml)](#설정-valuesyaml)
- [디렉터리 구조](#디렉터리-구조)
- [개발](#개발)
- [기술 스택](#기술-스택)

---

## 빠른 시작

모든 컴포넌트 이미지는 **GitHub Container Registry(ghcr.io)에 공개 패키지**로 게시되어
있어 별도 빌드 없이 바로 설치됩니다. (공개 패키지는 익명 pull rate limit이 없습니다.)

### 옵션 1. 설치 스크립트 (이미 동작 중인 K8s 클러스터)

태그가 붙은 스크립트를 내려받아 내용을 확인한 뒤 실행합니다(검토하지 않은 스크립트를 `curl | bash`로 바로 실행하지 않습니다).

```bash
curl -fsSLo install.sh https://raw.githubusercontent.com/junginho0901/Kubeast/v0.3.0/install.sh
less install.sh
bash install.sh
```

옵션:

```bash
# NodePort 변경 (기본 30333)
bash install.sh --node-port 30333

# LoadBalancer (클라우드 환경)
bash install.sh --load-balancer

# 네임스페이스 지정
bash install.sh --namespace my-ns

# 차트 버전 지정
bash install.sh --version 0.3.0
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

- **NodePort**: `http://<노드IP>:30333`
- **포트포워드**: `kubectl -n kubeast port-forward svc/gateway 8000:8000` → `http://localhost:8000`
- **Docker**: `http://localhost:8000`

### 2. 관리자 비밀번호 확인

초기 admin 비밀번호는 **설치 시 무작위 생성**되며(`admin.password`를 비워둔 경우),
**설치 스크립트가 끝날 때 화면에 출력**합니다.

```text
Default account:
  ID:       admin
  Password: KhHAm7GGGvXiT9ysnOiV     ← 설치 출력에서 바로 확인
```

출력을 놓쳤다면 언제든 다시 조회할 수 있습니다.

```bash
# K8s / Helm
kubectl -n kubeast get secret kubeast-secrets \
  -o jsonpath='{.data.DEFAULT_ADMIN_PASSWORD}' | base64 -d ; echo

# Docker — .env 파일의 DEFAULT_ADMIN_PASSWORD
grep DEFAULT_ADMIN_PASSWORD .env
```

비밀번호를 직접 지정하려면 설치 시 `--set admin.password=<원하는비번>`.

### 3. 로그인 후 클러스터 연결 (Connect your cluster)

`admin` 계정으로 먼저 로그인합니다. 등록된 클러스터가 없으면 로그인 직후 `/setup` 마법사로 이동합니다
(마법사와 그 API는 관리자 권한이 필요합니다). **로그인 후 즉시 비밀번호를 변경하세요.**

- **In-cluster** — Kubeast가 떠 있는 그 클러스터를 ServiceAccount 권한으로 자동 연결
- **External** — 다른 클러스터의 kubeconfig를 등록 (멀티클러스터)

**EKS 클러스터**는 IAM으로 인증합니다. k8s-service·tool-server 이미지에 `aws-iam-authenticator`가 들어 있으므로 kubeconfig에는 정적 자격증명 대신 exec 플러그인을 적습니다. Kubeast 파드의 IRSA 롤(`values.yaml`의 `aws.irsaRoleArn`)이 `-r`의 대상 롤을 AssumeRole하고, 대상 클러스터의 access entry가 그 롤을 Kubernetes 그룹에 매핑합니다(그룹 권한은 `helm/kubeast/files/impersonation-rbac.yaml`).

```yaml
users:
- name: kubeast
  user:
    exec:
      apiVersion: client.authentication.k8s.io/v1beta1
      command: aws-iam-authenticator
      args: ["token", "-i", "<cluster-name>", "-r", "arn:aws:iam::<account>:role/kubeast-target"]
      interactiveMode: Never
```

등록되는 kubeconfig의 exec 명령은 허용 목록(`multicluster.execCommands`, 기본 `aws-iam-authenticator`)에 있어야 하고, `AWS_ACCESS_KEY_ID` 같은 정적 키 env는 거부됩니다.

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
- **리소스 최적화 제안** — 네임스페이스 관측값(requests/limits·사용량) 표 + AI 제안 스트리밍
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

#### 역할과 권한 — 기본 역할이 무엇을 할 수 있고, 클러스터에는 누구로 가나

| Kubeast 역할 | 어디에 주나 | 앱 권한 | 클러스터 안 신원(impersonation 그룹) |
| --- | --- | --- | --- |
| **Pending** | 가입·SSO 직후 기본값 | 없음 — 로그인만 되고 API는 403 | — |
| **Member** | 계정 등급 | 전역 권한 없음, **클러스터별 부여로만** 접근 | `kubeast:authenticated`(권한 없음) |
| **Read** | 클러스터별 | 메뉴 10 · 모든 리소스 읽기(`resource.*.read`) · Helm 읽기 | `kubeast:viewer` = `view` + `kubeast:cluster-reader`. `view`는 Secret을 제외하므로 Secret과 Helm 릴리스(Secret에 저장)는 클러스터가 거부하고 화면은 권한 안내를 띄운다 |
| **Write** | 클러스터별 | `menu.*` · 리소스 생성/수정/삭제 · CronJob suspend/trigger · Secret 값 보기 · Helm rollback/upgrade/test · AI 툴 전부 | `kubeast:operator` = `edit` + viewer |
| **Admin** | 계정 등급(`*`) 또는 클러스터별 | 전부 — 관리자 메뉴, 모든 클러스터(나중에 등록한 것 포함) | `kubeast:admin` = `cluster-admin` |
| 커스텀 | 클러스터별 | 고른 권한만(만드는 사람이 가진 권한 안에서) | `kubeast:role:<이름>` — 클러스터가 이 그룹을 바인딩하기 전엔 모든 호출이 403(`auth.impersonation.customRoles`) |

- **Admin만 되는 것**: Pod exec · Node shell · cordon/drain · 워크로드 rollback · Helm uninstall. `resource.pod.exec`·`resource.node.cordon/drain/shell`·`resource.workload.rollback`·`resource.helm.uninstall`은 Write에 없고, 필요하면 커스텀 역할에 넣는다.
- **쓰기 API는 전부** 핸들러에서 권한을 검사하고 감사 행 없이는 거부된다(fail-closed). **읽기 API**는 "그 클러스터에 역할이 있나"(클러스터 미들웨어, deny-by-default) + 클러스터의 RBAC(viewer 그룹)으로 막힌다. `menu.*`는 화면 메뉴만 가린다.
- 네임스페이스 단위 권한은 없다(클러스터 단위). 팀별로 네임스페이스를 나누려면 커스텀 역할을 만들고 그 클러스터에서 `kubeast:role:<이름>` 그룹을 RoleBinding으로 묶는다.
- `auth.impersonation.enabled=false`는 데모용이다: k8s-service가 `cluster-admin`, tool-server가 `*`로 돌고 읽기 API는 클러스터 부여만으로 열린다.
- 회귀 확인: `e2e/tests/rbac-matrix.spec.ts`(역할 × 동작 403/200 표) · `permission-ceiling.spec.ts`(남에게 자기 이상 못 줌) · `reader-ui-notices.spec.ts`(Read의 화면 안내).

### ☸️ Kubernetes 리소스 관리

| 도메인 | 리소스 |
| --- | --- |
| **Workloads** | Pod, Deployment, StatefulSet, DaemonSet, ReplicaSet, Job, CronJob, HPA, VPA, PDB |
| **Network** | Service, Endpoint, EndpointSlice, Ingress, IngressClass, NetworkPolicy |
| **Gateway API** | Gateway, GatewayClass, HTTPRoute, GRPCRoute, ReferenceGrant, BackendTLSPolicy, Policies(모든 구현체의 정책 한 화면 — `gateway.networking.k8s.io/policy` 라벨 CRD 자동 탐색 + Envoy Gateway·Istio 내장 + `gatewayApi.policyKinds`) |
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
- **API 키** — 스크립트·CI용 자격(설정 → API 키). 키는 짧은 액세스 토큰으로 교환해 쓰며 클러스터 범위·역할 상한·만료를 갖고, 발급자의 권한을 넘지 못함(아래 "API 키" 절)
- **감사 로그** — 모든 쓰기 작업 + 민감 조회(Secret 열람, Node Shell, Helm 변경 등)를
  기록, 성공/실패 모두 추적
- **AI 사용량** — 채팅 턴과 Optimization의 AI 설명마다 남는 `ai.chat.complete` 감사 행(제공자가 보낸 토큰 수를 턴 단위로 합산)을 사용자·모델·클러스터별로 집계(Admin → AI Usage). 한도는 없고 누가 얼마나 썼는지 본다; 제공자가 usage를 안 보낸 호출은 합계에서 빼고 건수로 표시
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
| `ai-service` | Python (FastAPI) | 8001 | LLM 통합, 스트리밍 챗봇, 최적화 제안, Tool calling |
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

# JWT 서명키 — 비우면 설치 시 생성해 Secret(kubeast-auth-keys)에 보관, upgrade 때 재사용.
# 직접 관리하는 Secret(키 이름 jwt_private.pem)이 있으면 지정.
# 토큰 60분(활동 중이면 UI가 자동 갱신), 셀프 가입·데모 계정은 기본 off
auth:
  signingKey:
    existingSecret: ""
  tokenTTLMinutes: 15
  allowRegistration: false
  bootstrapDemoUsers: false
  passwordMinLength: 12
  # 세션 쿠키 Secure(HTTPS에서만 전송). TLS 뒤(Ingress·Gateway API)면 true 유지,
  # localhost 아닌 주소를 plain http로 쓸 때만 false (아니면 로그인 쿠키가 버려짐)
  cookieSecure: true
  # 클러스터에는 로그인한 사용자 본인(이메일)으로 impersonation — 클러스터 RBAC이
  # 최종 판단, K8s audit에 사용자가 남음. 등록하는 모든 클러스터에 아래 RBAC 적용:
  #   helm template kubeast helm/kubeast -s templates/impersonation-rbac.yaml | kubectl --context <cluster> apply -f -
  # (Kubeast 자격증명은 ClusterRole kubeast-impersonator 만 있으면 됨 — 설치된
  #  클러스터의 k8s-service·tool-server ServiceAccount도 이것과 kubeconfig Secret
  #  읽기 Role만 받음; false면 예전처럼 cluster-admin)
  # 커스텀 역할(Read/Write/Admin 외)을 클러스터에 부여하면 그룹 kubeast:role:<slug>로
  # 동작하는데, 위 RBAC은 고정 그룹 4개만 impersonate 허용 → customRoles에 적어야
  # 그 그룹이 허용되고 적은 ClusterRole에 묶임(등록 클러스터마다 같은 렌더 적용):
  #   helm template kubeast helm/kubeast -s templates/impersonation-custom-roles.yaml -f values.yaml | kubectl --context <cluster> apply -f -
  impersonation:
    enabled: true
    clusterRoles: true
    customRoles: []
    #  - name: sre-readonly
    #    clusterRoles: [view, "kubeast:cluster-reader"]
  # 임시 권한 요청 — 기본 off. 켜면 사용자가 Settings → Cluster access에서 이미 권한이 있는
  # 클러스터에 더 높은 역할(기본 Write까지)을 최대 maxHours 동안 사유와 함께 요청하고,
  # 관리자(본인 제외)가 Admin → Access requests에서 승인·거절. 승인되면 요청자는 다시
  # 로그인해 그 역할로 들어오고, 시간이 지나면 자동으로 이전 역할로 돌아간다(감사 로그
  # access.request.* / access.grant.expire). 클러스터 RBAC가 그 역할의 그룹을 바인딩한
  # 클러스터에서만 효력이 있다(viewer만 바인딩한 운영 클러스터에선 승격돼도 403).
  accessRequests:
    enabled: false
    maxHours: 8
    roles: [Write]

# EKS: k8s-service·tool-server 파드가 aws-iam-authenticator를 실행할 IRSA 롤 + STS 리전
aws:
  irsaRoleArn: ""
  region: ""
# 서비스마다 자기 롤(IRSA)이나 다른 클라우드 워크로드 아이덴티티 주석 — 감사 S3 싱크는
# authService, S3 세션 기록은 k8sService(aws.irsaRoleArn 위에 덮어씀)
serviceAccounts:
  authService:
    annotations: {}   # eks.amazonaws.com/role-arn: arn:aws:iam::<계정>:role/kubeast-audit-sink
  k8sService:
    annotations: {}

# 콘솔 자체 메트릭 — 백엔드 5개가 각자 포트의 /metrics로 Prometheus 메트릭을 냄
# (요청 수·지연·진행 중, 감사 저장소 상태, WebSocket 구독; docs/metrics.md).
# 게이트웨이는 /metrics를 프록시하지 않음. prometheus-operator가 있으면 ServiceMonitor,
# networkPolicy.enabled면 스크레이퍼를 from에 적어 열어 줌. 알람 5개는 prometheusRule.
metrics:
  enabled: true
  serviceMonitor:
    enabled: false
    interval: 30s
    labels: {}            # kube-prometheus-stack: {release: <그 릴리스 이름>}
  networkPolicy:
    from: []
  prometheusRule:
    enabled: false

# 서비스 간 토큰 — k8s-service의 /internal 라우트(tool-server의 kubeconfig 조회,
# auth-service의 validate·invalidate)는 사용자 JWT에 더해 Secret kubeast-secrets의
# INTERNAL_API_TOKEN을 X-Internal-Token으로 요구한다(차트가 생성·보존). 회전 = 값 교체 후
# auth-service·k8s-service·tool-server 롤아웃. secrets.existingSecret를 쓰면 그 Secret에 넣는다.

# 노드 셸(특권 디버그 파드) — 기본 off. 켜면 전용 네임스페이스 + 이미지 허용 목록
nodeShell:
  enabled: false
  images:
    - docker.io/library/busybox:latest

# 파드 보안 (Pod Security Standards restricted 기본). 사용자 네임스페이스를
# 지원하지 않는 클러스터(커널 6.3 미만)에서는 hostUsers: true
podSecurity:
  enabled: true
  hostUsers: false
  readOnlyRootFilesystem: true

# 가용성 — replicas 를 2 이상으로 올릴 때 pdb.enabled: true
replicas:
  gateway: 1
pdb:
  enabled: false
topologySpread:
  enabled: true
resources:               # 컨테이너별 requests / memory limit (전체는 values.yaml)
  aiService:
    requests: { cpu: 100m, memory: 256Mi }
    limits: { memory: 1Gi }

# AI 키 — ai-service 환경변수로만 주입되고 DB에는 저장되지 않음. 모델 설정(UI/CRD)은
# 변수 이름(api_key_env)만 가리킴. ESO 등으로 만든 Secret이 있으면 apiKeysSecret에 지정
ai:
  openaiApiKey: ""
  anthropicApiKey: ""
  geminiApiKey: ""
  apiKeysSecret: ""
  model: "gpt-4o-mini"
  baseUrlAllowedHosts: []  # 모델 설정 base_url이 사설 주소(클러스터 안 Ollama·사내 LLM 게이트웨이)면 여기 등록. api_key_env는 OPENAI/ANTHROPIC/GEMINI_API_KEY 또는 KUBEAST_AI_KEY_*

# 내장 PostgreSQL / Redis (false 면 외부 사용)
postgresql:
  enabled: true
  user: kubeast
  password: ""          # 비우면 설치 때 생성·업그레이드에도 유지 (secret 으로 확인). 외부 DB(enabled: false)면 필수
  database: kubeast
redis:
  enabled: true
  password: ""          # requirepass — 비우면 생성 (REDIS_PASSWORD)
networkPolicy:
  enabled: true         # 기본 거부 + 서비스가 쓰는 흐름만. NetworkPolicy를 강제하지 않는 CNI(kindnet 등)에선 무해

# Gateway 노출 방식
gateway:
  service:
    type: NodePort        # NodePort | ClusterIP | LoadBalancer
    nodePort: 30333
  trustedProxies: []      # 앞단 프록시(Ingress 컨트롤러·LB) CIDR — 감사 로그의 클라이언트 주소를 그 뒤에서 읽음
  allowedOrigins: []      # 게이트웨이 자기 호스트·Ingress 호스트 외에 API·WebSocket을 열 브라우저 origin(없으면 같은 호스트만)

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
├── helm/kubeast/                    # Helm 차트 — 모든 설치 경로의 유일한 매니페스트 원본 (정본 nginx.conf = files/nginx.conf)
├── deploy/kind/                     # 로컬 kind 개발 설치 값 (values.yaml; 개인 값은 values.local.yaml, git 제외)
├── e2e/                             # Playwright E2E (라이브 클러스터 대상)
│   └── actions/                     # 옵트인 동작 스위트 — UI 동작 90개 + kubectl 검증 (E2E_ACTIONS=1 --project=actions)
├── scripts/                         # 빌드/배포/개발 스크립트
├── install.sh                       # K8s 원라인 설치
├── install-docker.sh                # Docker 원라인 설치
└── docker-compose.yml               # (+ docker-compose.build.yml 빌드 override)
```

---

## 개발

로컬 개발 루프는 kind 기반이고, dev 클러스터도 **같은 Helm 차트**로 설치합니다(`deploy/kind/values.yaml`
— NodePort 30080·localhost origin·데모 계정·토큰 60분 같은 dev 차이만). 빌드/배포는 **항상
`scripts/rebuild-kind.sh`**를 통해 수행합니다(직접 docker/kubectl 금지).

```bash
scripts/kind-deploy.sh                        # 처음: kind 생성 + 이미지 빌드·적재 + helm install
scripts/rebuild-kind.sh ai-service frontend   # 특정 서비스 재빌드+배포
scripts/rebuild-kind.sh --all                 # 전체
scripts/reset-and-deploy.sh [--keep|--db]     # 전체 재생성 / 릴리스·DB만 재설치 / DB만 비우기
```

kind 노드는 postgres·redis·nginx 이미지를 레지스트리에서 당기는데, 프록시 뒤라 안 되면 `kind-deploy.sh`가
호스트 docker에 있는 같은 이미지를 노드에 넣습니다(미리 `docker pull` 해 두면 됨).

AI 채팅과 AI e2e 스펙은 기본 모델이 하나 등록돼 있어야 합니다. 노트북에서 Ollama를 돌린다면
`kubectl apply -f deploy/kind/modelconfig-ollama.yaml`(모델 `granite4.1:8b`, `host.docker.internal:11434`
— dev 값이 그 주소를 `ai.baseUrlAllowedHosts`와 NetworkPolicy에서 허용)로 등록하면 되고, 리셋 뒤에도 다시 적용합니다.

### API 키 (자동화)

사람 로그인 대신 스크립트·CI가 쓰는 긴 자격입니다. 설정 → API 키에서 이름·만료(기본 30일, 상한은 차트
`auth.apiKeys.maxDays`)·클러스터·역할 상한(기본 Read)을 정해 발급하면 값(`kbk_…`)이 한 번만 보입니다. 키는 그
자체로 API를 부르지 않고 짧은 액세스 토큰으로 교환해 씁니다 — 토큰은 발급자가 그 순간 가진 권한을 키의 범위로
잘라낸 것이라 발급자보다 많은 일을 할 수 없고, 키를 폐기하면 다음 교환부터 거부됩니다(관리자는 사용자 상세에서
남의 키를 폐기할 수 있고, 발급은 본인만).

```bash
TOKEN=$(curl -s -X POST https://console.example.com/api/v1/auth/token \
  -H "Authorization: Bearer $KUBEAST_API_KEY" | jq -r .access_token)     # expires_in 초 뒤 다시 교환
curl -s "https://console.example.com/api/v1/cluster/overview?cluster=prod" \
  -H "Authorization: Bearer $TOKEN" -H "X-Cluster-Name: prod"
```

끄려면 `auth.apiKeys.enabled: false`(컴포즈는 `API_KEYS_ENABLED`). 발급·폐기·교환은 감사 로그에 남습니다.

### 접근 권한 검토 (Access review)

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

### 휴면 계정 자동 잠금 (Dormant accounts)

위 보고서가 휴면 계정을 **보여 주는** 것이라면, 이 기능은 사람이 안 봐도 **닫습니다**(ISMS-P 2.5.6 결함 사례 "6개월 이상 미접속 계정 활성", NIST 800-53 AC-2(3)). `auth.dormantAccounts.enabled: true`면 auth-service 안의 스위퍼가 `sweepHours`(24)마다 돌면서 `days`(90) 동안 **로그인도 API 키 교환도 없는 계정**(한 번도 안 쓴 계정은 생성일 기준)을 잠그고 그 계정의 세션을 회수합니다. 잠긴 계정은 비밀번호 로그인·SSO·API 키 교환이 모두 거부되고(응답은 일반 401, 사유는 감사 로그 `reason: dormant`), 관리자가 사용자 관리에서 **잠금 해제**를 눌러야 다시 들어옵니다.

- `exemptAdmins: true`(기본)면 역할에 `*`나 `admin.*` 권한이 있는 계정은 잠그지 않습니다 — 마지막 관리자까지 잠기면 아무도 못 풀기 때문. 대신 접근 권한 검토 보고서에 `dormant`로 계속 보입니다.
- 사용자 관리 화면: 잠긴 계정에 "휴면 잠김"/"잠김" 배지와 **잠금 해제** 버튼, 상단에 **휴면 계정 지금 점검**(스위퍼를 즉시 1회 실행, `admin.users.update`). 감사 액션: `user.account.dormant_lock`(actor `system`) · `admin.dormant.sweep` · `admin.users.unlock`.
- 끄면 스위퍼가 멈추고 새로 잠그지 않지만, 이미 잠긴 계정은 풀 때까지 그대로입니다. 접근 권한 검토의 `dormantDays`(표시 기준)와는 별개 값이라 "60일부터 표시, 90일에 잠금"처럼 벌릴 수 있습니다.

### Argo CD 가드 (GitOps)

Argo CD가 배포한 객체에는 추적 어노테이션(`argocd.argoproj.io/tracking-id`, 값 `<앱>:<group>/<Kind>:<ns>/<이름>`)이 붙습니다. `gitops.argocd.enabled: true`면 콘솔이 그 표식을 읽어 드로어 머리에 "Argo CD · <앱>" 배지를 달고(`url`을 적으면 Argo CD 앱 페이지로 링크), 콘솔에서 그 객체를 바꾸려 할 때:

- `mode: warn`(기본) — 확인창에서 "다음 동기화 때 되돌아갑니다, Git에서 바꾸세요"를 알린 뒤 진행합니다.
- `mode: block` — k8s-service가 쓰기 요청을 409로 거부하고(`managed by Argo CD application <앱>; change it in Git`), AI 쓰기 도구(apply·delete·patch·scale·rollout)도 같은 이유로 거부합니다. 드로어의 삭제·YAML 적용 버튼은 비활성입니다.

어노테이션은 그 객체 자신을 가리킬 때만 인정합니다(파드 템플릿을 따라 복사된 어노테이션은 무시). 아직 라벨 방식(`app.kubernetes.io/instance` 또는 `argocd-cm`의 `application.instanceLabelKey`)을 쓰는 설치는 `instanceLabel`에 그 키를 적으면 됩니다. Helm 릴리스 작업·노드 cordon/drain·새 객체 생성은 대상이 아닙니다.

### 대시보드 빠른 작업 (이슈 · 최적화 · 스토리지)

세 카드는 모두 k8s-service가 계산한 읽기 전용 결과를 보여 줍니다(AI 도구와 같은 숫자).

- **이슈 확인** — `GET /api/v1/cluster/issues?window=<분>`: 파드(Phase·Ready·CrashLoopBackOff 등 대기/종료 사유·재시작), 워크로드(Deployment `ProgressDeadlineExceeded`·unavailable, StatefulSet·DaemonSet 미준비, Job 실패, CronJob 마지막 실행 실패, HPA 상한 도달), 노드(Ready≠True·압박 조건), PVC(미바인딩)에 최근 `window`분의 Warning 이벤트를 같은 객체 행에 붙여 "왜·언제·몇 번"을 보여 줍니다. 기본 범위는 `features.issues.eventWindowMinutes`(60), 화면에서 1h/6h/24h로 바꿀 수 있습니다. 행을 누르면 그 객체의 드로어가 열립니다.
- **최적화 제안** — `GET /api/v1/cluster/optimization?namespace=…&window=<시간>`: 실행 중인 파드의 컨테이너별 requests/limits와 사용량(Prometheus가 있으면 최근 `window`시간의 CPU 95퍼센타일·메모리 최대, 없으면 metrics-server 순간값, 둘 다 없으면 "없음"으로 표기), 추천값(CPU = p95, 메모리 = 최대+15%, 최소 10m/100Mi — Robusta KRR의 simple 전략), 플래그(`cpu_over`·`cpu_under`·`mem_over`·`mem_under`·`no_cpu_request`·`no_mem_request`·`no_mem_limit`)를 표로 냅니다. 기본 범위는 `features.optimization.windowHours`(24). "AI 설명" 버튼은 이 표를 그대로 모델에 보내 왜 그런 수치인지·무엇부터 바꿀지 설명을 받습니다 — 숫자는 모델이 바꾸지 않습니다. 쓰기는 없습니다.
- **스토리지 분석** — PVC 목록(`?usage=true`)에 Prometheus의 `kubelet_volume_stats_*`로 사용률·용량과 6시간 추세로 계산한 "n일 뒤 가득 참"을 붙입니다(`features.prometheus.enabled`가 켜져 있고 Prometheus가 kubelet `/metrics`를 긁어야 함). CSI 드라이버가 볼륨 통계를 내지 않으면(hostPath·local-path 등) N/A로 표시합니다. 85%/97% 색 경계와 "4일 내 가득 참"은 kube-prometheus의 `KubePersistentVolumeFillingUp` 규칙과 같습니다.

### 감사 싱크 (S3 · 웹훅 · 메일 · 파일)

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

### 감사 로그 무결성 (해시 체인 · S3 앵커)

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
- **독립 검증**: Kubeast 없이 psql로 같은 식을 재계산할 수 있습니다(`services/auth-service-go/internal/auditchain`의 `CanonSQL`, [docs/audit-log-plan.md](docs/audit-log-plan.md) §7).
- **한계**: 봉인 전 창(≤ `sealSeconds`)에 지워진 행은 못 잡습니다. 껐다 켠 구간은 검증 결과에 앵커 없음으로 드러납니다. 보존(`retention.auditDays`)은 체인 접두만 지웁니다.
- 메트릭 `kubeast_audit_chain_sealed_seq` · `kubeast_audit_chain_unsealed_rows` · `kubeast_audit_anchor_last_timestamp_seconds`.

로컬 kind는 dev 값이 `dev-s3` 스탠드인에 앵커합니다(`e2e/tests/audit-integrity.spec.ts`).

### 세션 기록 (exec · 노드 셸)

켜면(`sessionRecording.enabled`, 기본 off) Pod exec와 노드 셸 터미널에 **찍힌 출력**(사용자가 본 화면 — 친 명령은
에코로 보이고, 에코되지 않는 비밀번호 입력은 안 남음)을 asciicast v2로 녹화합니다. 세션을 열면 터미널에
"This session is recorded" 한 줄이 먼저 찍히고, 감사 행(`k8s.pod.exec`·`k8s.node.shell`)에 `recording_id`가 붙습니다.

- **저장**: k8s-service가 로컬 볼륨에 쓰고 세션 중에도 `chunkSeconds`(기본 30초)마다 조각을 올립니다 — k8s-service 파드가 사라져도 잃는 건 마지막 조각 간격만큼. 저장소 = `s3`(운영 권장, 감사 S3 싱크와 같은 필드) · `database`(세션당 1 MiB, S3 없는 작은 설치) · `file`(PVC). S3 키는 파일로 마운트돼 k8s-service의 IRSA 신원을 건드리지 않습니다.
- **끊긴 세션**: k8s-service 쪽 사정으로 끊긴 세션은 `interrupted`로 남습니다 — 정상 종료(롤아웃·드레인)와 컨테이너 재시작은 남은 출력까지 다 올리고, 파드가 통째로 사라지면 그 전에 올린 조각만 남습니다.
- **실패**: 녹화를 시작하지 못하면(로컬 볼륨에 못 씀) 세션을 거부합니다(`required: true`). 저장소 업로드가 실패하거나 조각 하나가 30초 안에 끝나지 않아도 세션은 계속되고, 재시도하며 알람 `KubeastSessionRecordingUploadStalled`로 드러납니다. 세션당 `maxBytes`(기본 64 MiB)를 넘으면 녹화만 멈춥니다.
- **다시보기**: Admin → 세션 기록(권한 `admin.sessions.read`)에서 재생·`.cast`·텍스트 사본 내려받기, 감사 화면의 exec 행에서도 재생. 녹화를 열 때마다 `admin.session.read`가 감사에 남습니다.
- **보존**: 원격 객체는 버킷 수명주기·Object Lock에 맡기고, 목록 행은 `retention.auditDays`를 따릅니다.

```yaml
sessionRecording:
  enabled: true
  s3: {bucket: kubeast-sessions, prefix: sessions/, region: ap-northeast-2}   # k8s-service 롤에 s3:PutObject·GetObject
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

---

## 기술 스택

**Backend**
- Go 1.26 (auth · k8s · session · tool-server · controller · pkg)
- Python 3.14 + FastAPI (ai-service)
- PostgreSQL 15, Redis 7
- controller-runtime (CRD operator)

**Frontend**
- React 19 · TypeScript · Vite · Tailwind CSS
- TanStack Query · React Router
- Monaco Editor · xterm.js
- React Flow · dagre · elkjs (그래프) · three.js (3D 토폴로지)
- i18next (한/영)

**Infra**
- Kubernetes · Helm · NGINX
- GitHub Container Registry (ghcr.io) · GitHub Actions

---

## 라이선스

MIT License
