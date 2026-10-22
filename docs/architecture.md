# 아키텍처


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

## 서비스 구성

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
| `postgres` | — | 5432 | 메인 DB (durable state) — PostgreSQL 18 |
| `redis` | — | 6379 | k8s-service 캐시 — Valkey 9.1(Redis 프로토콜). `redis.enabled: false`면 k8s-service가 메모리에 캐시 |

## 컨테이너 이미지

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

## 자원 사용량

`scripts/kind-footprint.sh`로 잰 값입니다(2026-10-20, kind 단일 노드, 1분마다 컨테이너 메모리 working set — `kubectl top`과 같은 기준 — 과 CPU). "놀 때"는 설치 직후부터 아무도 안 쓰는 30분(기본 설치는 15분)의 90번째 백분위, "쓸 때"는 화면 목록 API 9개를 4개씩 동시에 2분 동안 계속 부른 최대값입니다. 하루 한 번 도는 정리 작업은 서버가 켜질 때 한 번 돌기 때문에 이 구간에 들어 있습니다.

| 설치 | 파드 | 요청 합계(CPU / 메모리) | 놀 때 메모리 | 쓸 때 최대 | 놀 때 CPU / 쓸 때 |
| --- | --- | --- | --- | --- | --- |
| 최소 (`-f helm/kubeast/values-minimal.yaml`) | 6 | 140m / 376Mi | 138 MiB | 202 MiB | 3m / 483m |
| 기본 (차트 그대로) | 10 | 530m / 992Mi | 295 MiB | 353 MiB | 10m / 537m |

파드별(기본 설치, MiB): ai-service 106 · postgres 64(데이터가 쌓인 dev는 133) · controller 33 → 16 · k8s-service 28(쓸 때 84) · auth-service 16(쓸 때 24) · tool-server 14 · frontend 11 · session-service 9 · redis 9 · gateway 6. 쓸 때 CPU는 거의 전부 k8s-service(목록을 쿠버네티스 API에서 읽어 정리)입니다. 최소 설치의 요청값은 메모리 = 놀 때 90번째 백분위와 쓸 때 최대 중 큰 값 + 15%(요청을 넘은 메모리가 노드 압박 때 먼저 축출됨), CPU = 놀 때 + 15%, 최소 25m이고 한도는 차트 기본 그대로입니다.

| 켜는 것 | 늘어나는 파드 | 놀 때 메모리 | 백그라운드 작업 |
| --- | --- | --- | --- |
| `ai.enabled` (기본 켬) | 3 — ai-service · tool-server · ModelConfig 컨트롤러 | +약 155 MiB | 컨트롤러가 ModelConfig를 지켜봄. ai-service·tool-server는 요청이 올 때만 |
| `redis.enabled` (기본 켬) | 1 | +9 MiB | 없음 — 끄면 k8s-service가 메모리에 캐시(Redis를 쓰는 곳은 그 하나) |
| `mcp.enabled` | 0 | ai-service 안에서 약 +15 MiB(MCP SDK) | 없음 |
| `features.alertInvestigation` | 0 | 0 | 없음 — 알림 웹훅이 올 때 조사 |
| `sessionRecording.enabled` | 0 | 0 | exec·노드 셸이 열려 있는 동안 조각 업로드 |
| `nodeShell.enabled` | 셸을 연 동안 노드마다 1 | 0 | 없음 |
| `features.prometheus`·`logSearch`·`tracing`·`traceStore`·`alertStore`·`cost`·`policyReports`·`hygiene`·`inPlaceResize`·`logFiles` | 0 | 0 | 없음 — 화면이나 AI가 물을 때만(정리 점검도 화면을 열 때 계산) |

늘 도는 작업: auth-service — 감사 기록 봉인 10초마다(`audit.integrity.sealSeconds`) · 만료된 권한 요청 되돌리기 1분마다 · 보관 기간 지난 기록 정리 24시간마다(켜질 때 1회) · `dormantAccounts`를 켜면 휴면 계정 잠금 24시간마다 · 감사 앵커(S3 싱크를 지정했을 때) 24시간마다. k8s-service — 등록된 클러스터마다 상태 확인 60초마다(`multicluster.healthcheckIntervalSec`) · 오래 안 쓴 클러스터 정보원 캐시 정리. MCP·알림 조사·세션 녹화·노드 셸·`features.*` 줄은 코드 기준(파드가 생기지 않아 따로 재지 않음, MCP 값은 2026-10-13 측정).

다시 재려면 `scripts/kind-footprint.sh up` → `measure <이름> 30` → `load <이름> 2` → `step <이름> 15 --set ai.enabled=true` → `down`(dev 클러스터와 따로 `kubeast-fp` 클러스터를 만듦).
