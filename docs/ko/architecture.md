[English](../architecture.md) | **한국어**

# 아키텍처


NGINX 게이트웨이가 모든 요청을 받아 각 마이크로서비스로 라우팅합니다.
오래 보존할 상태는 PostgreSQL이, 캐시와 세션 컨텍스트는 Redis가 맡습니다.

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

**AI Tool-calling 흐름**은 다음과 같습니다.

1. `ai-service`가 채팅을 조율하면서 허용 목록에 있는 도구 호출을 `tool-server`로 보냅니다.
2. `tool-server`가 선택한 클러스터의 K8s API를 호출합니다.
3. 그 결과가 채팅으로 스트리밍됩니다.

## 서비스 구성

| 서비스 | 언어 | 포트 | 역할 |
| --- | --- | --- | --- |
| `gateway` | NGINX | 8000 | API 라우팅, CORS, SSE/WebSocket 프록시 (이미지 빌드 없이 설정만 사용) |
| `auth-service` | Go | 8004 | 인증, JWT/JWKS, 조직/팀/RBAC, 클러스터 레지스트리 |
| `ai-service` | Python (FastAPI) | 8001 | LLM 연동, 스트리밍 채팅, 최적화 제안, Tool calling |
| `k8s-service` | Go | 8002 | K8s 리소스 CRUD, WS 로그/exec, 토폴로지, Helm, GPU/DRA, 멀티클러스터 풀 |
| `session-service` | Go | 8003 | 채팅 세션 / 메시지 기록 |
| `tool-server` | Go | — | AI 도구 호출 백엔드 (kubectl 실행) |
| `model-config-controller` | Go (controller-runtime) | — | `ModelConfig` CRD 컨트롤러 |
| `frontend` | React + Vite + TS | 5173 | UI (prod는 정적 빌드를 nginx로 서빙) |
| `postgres` | — | 5432 | 메인 DB (durable state) — PostgreSQL 18 |
| `redis` | — | 6379 | k8s-service 캐시 — Valkey 9.1(Redis 프로토콜). `redis.enabled: false`면 k8s-service가 메모리에 캐시합니다 |

## 컨테이너 이미지

모든 이미지는 ghcr.io에 공개 패키지로 게시됩니다.

```
ghcr.io/junginho0901/kubeast-frontend
ghcr.io/junginho0901/kubeast-auth-service
ghcr.io/junginho0901/kubeast-ai-service
ghcr.io/junginho0901/kubeast-k8s-service
ghcr.io/junginho0901/kubeast-session-service
ghcr.io/junginho0901/kubeast-tool-server
ghcr.io/junginho0901/kubeast-model-config-controller-go
```

> 릴리스: `v*` 태그를 push하면 GitHub Actions(`.github/workflows/release.yaml`)가 이미지 7개를 자동으로 빌드해 ghcr에 게시하고 Helm 차트를 패키징합니다.

## 자원 사용량

`scripts/kind-footprint.sh`로 잰 값입니다(2026-10-20, kind 단일 노드). 1분마다 컨테이너 메모리 working set(`kubectl top`과 같은 기준)과 CPU를 기록했습니다.

- "놀 때": 설치 직후부터 아무도 쓰지 않은 30분(기본 설치는 15분) 동안의 90번째 백분위
- "쓸 때": 화면 목록 API 9개를 4개씩 동시에 2분 동안 계속 호출했을 때의 최대값

하루 한 번 도는 정리 작업도 서버가 켜질 때 한 번 돌기 때문에 이 구간에 포함됩니다.

| 설치 | 파드 | 요청 합계(CPU / 메모리) | 놀 때 메모리 | 쓸 때 최대 | 놀 때 CPU / 쓸 때 |
| --- | --- | --- | --- | --- | --- |
| 최소 (`-f helm/kubeast/values-minimal.yaml`) | 6 | 140m / 376Mi | 138 MiB | 202 MiB | 3m / 483m |
| 기본 (차트 그대로) | 10 | 530m / 992Mi | 295 MiB | 353 MiB | 10m / 537m |

파드별 값은 다음과 같습니다(기본 설치, MiB).

- ai-service 106
- postgres 64(데이터가 쌓인 dev는 133)
- controller 33 → 16
- k8s-service 28(쓸 때 84)
- auth-service 16(쓸 때 24)
- tool-server 14
- frontend 11
- session-service 9
- redis 9
- gateway 6

쓸 때 CPU는 거의 전부 k8s-service가 씁니다(쿠버네티스 API에서 목록을 읽어 정리하는 일).
최소 설치의 요청값은 다음과 같이 정했습니다.

- 메모리: 놀 때 90번째 백분위와 쓸 때 최대 중 큰 값 + 15%. 요청을 넘는 메모리는 노드 압박 때 먼저 축출 대상이 됩니다.
- CPU: 놀 때 값 + 15%, 최소 25m
- 한도: 차트 기본값 그대로

| 켜는 것 | 늘어나는 파드 | 놀 때 메모리 | 백그라운드 작업 |
| --- | --- | --- | --- |
| `ai.enabled` (기본 켬) | 3 — ai-service · tool-server · ModelConfig 컨트롤러 | +약 155 MiB | 컨트롤러가 ModelConfig를 감시합니다. ai-service·tool-server는 요청이 올 때만 일합니다 |
| `redis.enabled` (기본 켬) | 1 | +9 MiB | 없음 — 끄면 k8s-service가 메모리에 캐시합니다(Redis를 쓰는 곳은 k8s-service뿐) |
| `mcp.enabled` | 0 | ai-service 안에서 약 +15 MiB(MCP SDK) | 없음 |
| `features.alertInvestigation` | 0 | 0 | 없음 — 알림 웹훅이 올 때만 조사 |
| `sessionRecording.enabled` | 0 | 0 | exec·노드 셸이 열려 있는 동안 녹화 조각을 업로드 |
| `nodeShell.enabled` | 셸이 열려 있는 동안 노드마다 1 | 0 | 없음 |
| `features.prometheus`·`logSearch`·`tracing`·`traceStore`·`alertStore`·`networkFlows`·`networkFlowMonitor`·`cost`·`policyReports`·`hygiene`·`inPlaceResize`·`logFiles` | 0 | 0 | 없음 — 화면이나 AI가 요청할 때만 동작(정리 점검도 화면을 열 때 계산) |

늘 도는 작업은 다음과 같습니다.

- auth-service
  - 10초마다 감사 기록 봉인(`audit.integrity.sealSeconds`)
  - 1분마다 만료된 권한 요청 되돌리기
  - 24시간마다 보관 기간이 지난 기록 정리(켜질 때도 1회)
  - `dormantAccounts`를 켜면 24시간마다 휴면 계정 잠금
  - S3 싱크를 지정했다면 24시간마다 감사 앵커
- k8s-service
  - 60초마다 등록된 클러스터별 상태 확인(`multicluster.healthcheckIntervalSec`)
  - 오래 쓰지 않은 클러스터의 informer 캐시 정리

표의 MCP, 알림 조사, 세션 녹화, 노드 셸, `features.*` 줄은 코드를 보고 적은 값입니다. 파드가 생기지 않아 따로 재지 않았고, MCP 값은 2026-10-13에 측정했습니다.

다시 재려면 다음 순서로 실행하세요. dev 클러스터와 별도로 `kubeast-fp` 클러스터를 만듭니다.

1. `scripts/kind-footprint.sh up`
2. `measure <이름> 30`
3. `load <이름> 2`
4. `step <이름> 15 --set ai.enabled=true`
5. `down`
