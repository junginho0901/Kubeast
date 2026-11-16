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
| `k8s-service-stream` | Go | 8002 | `streams.enabled`일 때만: k8s-service와 같은 이미지(`SERVER_ROLE=stream`)로 Pod exec·노드 셸·실시간 로그를 맡음 |
| `session-service` | Go | 8003 | 채팅 세션 / 메시지 기록 |
| `tool-server` | Go | — | AI 도구 호출 백엔드 (kubectl 실행) |
| `model-config-controller` | Go (controller-runtime) | — | `ModelConfig` CRD 컨트롤러 |
| `frontend` | React + Vite + TS | 5173 | UI (prod는 정적 빌드를 nginx로 서빙) |
| `postgres` | — | 5432 | 메인 DB (durable state) — PostgreSQL 18 |
| `redis` | — | 6379 | k8s-service 캐시 — Valkey 9.1(Redis 프로토콜). k8s-service와 tool-server(클러스터 바뀜 알림만)가 각자 자기 Redis 사용자로 로그인하고, 이 둘만 연결할 수 있습니다([Redis 사용자](configuration.md#redis-사용자)). `redis.enabled: false`면 k8s-service가 메모리에 캐시합니다 |

k8s-service는 Redis에 캐시를 키 앞머리 `kubeast:cache:` 아래에 쓰고, 모든 항목은 최대 1시간 뒤에 만료됩니다. 클러스터 등록이 바뀌면 그 앞머리의 키만 지우므로(`SCAN`과 `UNLINK`) 같은 Redis 데이터베이스의 다른 키는 남습니다. 시작할 때 Redis가 답하지 않은 k8s-service는 메모리에 캐시하고 5초마다 Redis에 다시 묻다가, 답하면 캐시를 Redis로 옮깁니다. 어느 클러스터가 바뀌었는지는 Redis가 아니라 PostgreSQL에 둡니다. auth-service가 kubeconfig를 바꾸거나 Prometheus·로그 저장소 설정을 바꾸는 데이터베이스 거래에서 클러스터의 `config_version`을 새 값으로 바꿉니다. 이 거래는 Secret을 쓴 뒤에만 반영됩니다. 실패하면 오류로 답합니다. 쓴 Secret은 클러스터 행을 잠근 채로 되돌리므로, 같은 클러스터를 바꾸려고 기다리던 변경은 그 값을 보지 않습니다. 그 뒤 클러스터의 `config_version`을 한 번 더 새 값으로 바꾸므로, 그사이 쓴 Secret으로 만든 연결도 버립니다. 되돌리지 못한 Secret은 응답과 감사 행에 이름이 남습니다. 모든 k8s-service가 5초마다 이 값을 읽어 다른 값으로 만든 연결과 지운 클러스터의 연결을 버립니다. Redis가 있으면 auth-service가 알린 k8s-service가 다른 k8s-service에도 바로 알립니다(채널 `kubeast:clusters:changed:<db>`).

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
| `redis.enabled` (기본 켬) | 1 | +9 MiB | 없음 — 끄면 k8s-service가 메모리에 캐시하고, tool-server의 kubeconfig는 클러스터 바뀜 알림 없이 10초에 만료됩니다 |
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
  - 60초마다 등록된 클러스터별 상태 확인(`multicluster.healthcheckIntervalSec`). 확인은 서버마다 자기 빠른 실패 판단에 쓰고, `clusters.health_status`는 PostgreSQL advisory lock(따로 연 연결 하나)을 잡은 서버 한 대만 씀. 확인이 실패하거나, 사이에 API 서버의 답 없이 요청이 `multicluster.breakerConsecutiveFails`번 실패하면 그 클러스터의 차단기가 열림: `multicluster.breakerOpenSec`(30초) 동안 그 클러스터 요청에 503으로 답하고, 그 뒤 서버마다 요청 하나를 클러스터로 보내 봄. 요청 가운데서는 그 요청만 열린 차단기를 닫을 수 있고(성공한 확인과 클러스터 변경도 닫음), API 서버가 처음 500 미만으로 답한 순간 닫힘(터미널·로그 따라가기도 끝날 때가 아니라 바로). 그 요청이 실패하면 다시 열리고, 그런 답을 받지 못한 요청(캐시로 답함, Kubeast가 스스로 거절함, 요청 수 제한)이면 다음 요청이 다시 보내 봄. 클러스터 목록을 읽지 못하는 동안(DB 다운)에는 서버마다 마지막 판정을 그대로 두고 로그를 한 번 남김
  - `/health`(콘솔 머리 표시가 열린 탭마다 5초에 한 번 물음)는 기본 클러스터의 `/version`을 모든 호출자 몫으로 5초에 한 번만 읽고, 한 번 읽기는 클러스터 클라이언트가 준비된 뒤 1.5초 안에 끝나며 사람들의 요청 뒤에 줄 서지 않음. 그래서 `kubernetes` 값은 클러스터보다 최대 약 7초 늦고, 탭 수만큼 늘지 않음. 답은 감사 저장소 상태를 함께 읽어 1.5초 안에 나가므로, auth-service가 기다리는 2초 안에 듦
  - 오래 쓰지 않은 클러스터의 informer 캐시 정리
  - 레플리카마다 5초(앞뒤 1초)마다 DB에서 등록된 클러스터의 `config_version` 읽기, 쿼리 하나(`internal/clustersync`). Redis가 있으면 다른 레플리카의 클러스터 변경 알림도 구독
  - 켜질 때 Redis가 답하지 않았으면 답할 때까지 5초마다 다시 묻기(답하면 캐시를 Redis로 옮김)
  - 노드 드레인을 맡은 동안 5초마다 살아 있음을 적음 · 10초마다 맡은 서버가 멈춘 드레인을 중단됨으로 적음 · 1시간마다 하루 전에 끝난 드레인 지움(`node_drains`)

표의 MCP, 알림 조사, 세션 녹화, 노드 셸, `features.*` 줄은 코드를 보고 적은 값입니다. 파드가 생기지 않아 따로 재지 않았고, MCP 값은 2026-10-13에 측정했습니다.

다시 재려면 다음 순서로 실행하세요. dev 클러스터와 별도로 `kubeast-fp` 클러스터를 만듭니다.

1. `scripts/kind-footprint.sh up`
2. `measure <이름> 30`
3. `load <이름> 2`
4. `step <이름> 15 --set ai.enabled=true`
5. `down`

## 많은 사람이 큰 클러스터를 쓸 때

v0.7.6 코드로 2026-11-08에 잰 값입니다. k8s-service 하나를 차트 한도 512 Mi(Go 수집기 한도는 그 90%인 461 MiB)로 두고, 노트북 kind 클러스터에서 노드 1 000 · 파드 50 000 · 이벤트 100 000개인 KWOK 클러스터를 대상으로, 요청은 kind 망 안에서 보냈습니다. 사람마다 자기 계정으로 로그인했습니다(계정 500개, 그중 5분의 1은 네임스페이스 5개나 20개로 한정). 한 계정의 같은 읽기는 묶이므로(`handler.Shared`) 서로 다른 계정이 더 어려운 경우입니다. 시험마다 k8s-service를 새로 띄우고 KWOK 클러스터를 데운 뒤 쟀습니다.

| 무엇 | 결과 |
| --- | --- |
| 서로 다른 100명, 그다음 300명이 파드 50 000 · 이벤트 76 000개인 네임스페이스의 ConfigMap 드로어를 10초 안에 열고 2분 동안 켜 둠 | 오류 0 · 재시작 0 · 여는 구간 p95 1.4초(100명) · 1.2초(300명) · 켜 둔 동안 p95 6 ms · API 서버가 Kubeast 요청에 429로 답한 것 0 · k8s-service 최대 150 MiB |
| 서로 다른 100명이 파드 500개인 Deployment, 그다음 파드 1 000개인 DaemonSet의 롤아웃을 드로어에서 따라감(각 3분) | 오류 0 · 재시작 0 · k8s-service 최대 300 MiB · 모든 변경이 모든 드로어에 닿음 · 다시 읽은 드로어 describe p95 12.0초(Deployment) · 7.2초(DaemonSet) · 변경이 화면에 뜬 시간 p95 22초 · 17초 |
| 서로 다른 500명이 Dashboard · Pods · Cluster View를 6분 동안 켜 둔 뒤, 그중 100명이 같은 순간에 그 화면들을 엶 | 켜 둔 동안 p95 16 ms · 재시작 0 · 429 0 · k8s-service 최대 440 MiB · 100명 중 절반은 마지막 답을 부하기의 60초 시간 초과에서야 받았고 요청 263건이 실패 |
| 20명이 AI의 읽기 도구를 동시에 2분 동안 씀(계정 하나, 호출 407번) | 재시작 0 · tool-server 최대 162 MiB(한도 256 Mi) · 실패 8건, 모두 이벤트 읽기(`k8s_get_events` · `timeline`) |

메모리 크기는 다음과 같이 정하세요.

- 차트의 k8s-service 512 Mi는 위의 v0.7.6 시험(파드 50 000)을 모두 버텼습니다. 많은 사람이 큰 클러스터를 한꺼번에 쓰지 않는다면 그대로 두세요.
- 수백 개 계정이 파드 수만 개인 클러스터를 한꺼번에 쓴다면 `resources.k8sService.limits.memory`를 `1Gi`로 올리세요(수집기 한도도 따라 올라갑니다). 위의 100명 몰림은 수집기 한도까지 21 MiB를 남겼고, 이 문서가 설명하는 고침 전인 2026-11-07에는 같은 몰림에서 1 Gi 한도의 k8s-service가 611 MiB까지 썼습니다.
- 메모리를 늘린다고 몰림이 빨라지지는 않습니다. 2026-11-07의 1 Gi 시험도 똑같이 60초 걸린 답이 있었습니다. 늘린 메모리는 몰림과 큰 네임스페이스가 겹칠 때 k8s-service가 재시작하지 않게 해 줍니다.

이 시험에서 나온 v0.7.6의 알려진 한계는 다음과 같습니다.

- 위의 100명 동시 접속: k8s-service는 요청에 답을 다 냈습니다. 같은 날 앞선 시험에서 k8s-service가 게이트웨이로 가는 소켓에 46 MB를 못 보낸 채 재전송하고 있었고, 조용한 구간에도 k8s-service와 auth-service가 6분에 약 4 200번 재전송했습니다. Kubeast보다 노트북 kind 망 쪽으로 보이지만, 실제 클러스터에서는 아직 재지 않았습니다.
- 객체를 따라가는 드로어는 객체가 바뀔 때 describe를 다시 읽고, 사람마다의 그 읽기는 클러스터로 가는 클라이언트 속도(`multicluster.clientQPS`)에 줄을 섭니다. 거기서 기다린 시간은 `kubeast_k8s_client_rate_wait_seconds`([메트릭](metrics.md))로 봅니다. 서로 다른 100명이 롤아웃을 따라가는 동안에는 그 읽기가 몇 초 걸립니다(위 표). 조용한 드로어는 밀리초 안에 답합니다.
- 객체를 따라가는 드로어와, 파드 300개까지의 워크로드 파드 표는 각각 그 사람으로 클러스터 watch 하나를 씁니다. 사람끼리 나눠 쓰지 않습니다.
- AI의 이벤트 읽기(`k8s_get_events` · `timeline`)는 `multicluster.eventListConcurrency` 밖에서 이벤트를 쪽 단위로 읽습니다.
- 네임스페이스 파드 전체 목록(`GET /api/v1/namespaces/{namespace}/pods`)은 k8s-service가 다 만든 뒤 보냅니다. v0.7.5의 드로어가 이 길로 읽었고, 지금 화면은 표의 선 아래인 네임스페이스이거나 쪽 읽기가 거부될 때만 이 길로 읽으며, 스크립트도 이 API를 부를 수 있습니다. 한 계정이 같은 순간에 읽으면 답 하나를 나눠 받지만(차례로 많아야 두 번 읽음), 다른 계정은 각자 만듭니다. 그래서 많은 계정이 큰 네임스페이스를 이 길로 한꺼번에 읽으면 k8s-service가 512 Mi를 넘을 수 있습니다. 파드 50 000개를 한 번 읽으면 답 36 MiB 말고 약 80 MiB를 더 쥡니다(`BenchmarkTenReadersOfOneNamespacesPods`). v0.7.6의 한 고침 전에는 줄마다 map도 쥐어 약 300 MiB였고, 한 계정 10명이 그 네임스페이스에서 v0.7.5의 ConfigMap 드로어를 열자 시험에서 k8s-service가 512 Mi를 넘었습니다.

이 한도들을 정하는 차트 값과 2026-10-30에 잰 값은 영어 문서의 [Many users](../architecture.md#many-users)에 있습니다. 그중 몇 가지는 이렇게 걸립니다.

- 새 실시간 watch는 k8s-service가 수집기 한도에 맞서 쥔 메모리(마지막 수집이 찾은 살아 있는 힙, 고루틴 스택, 런타임 자체 몫)가 그 한도의 80 %를 넘은 동안 `multicluster.wsMaxSubscriptions`를 넘었을 때처럼 기다리고(`watchMemoryFull`), 화면은 서버의 메모리가 모자라다고 말합니다. 화면이 watch를 청할 때와 그 watch가 열릴 차례가 왔을 때 두 번 보고, 그 목록의 watch가 한 번 켜진 적이 있으면(버전이 만료돼 다시 여는 watch) 차례에서는 보지 않습니다. 처음 꼴은 살아 있는 힙만 75 %와 견줬는데, 700명에서는 스택만 한도 461 MiB 가운데 58~92 MiB여서 그 몫에 닿을 때가 곧 메모리가 다 찬 때였고, 둘째 W2 밤(2026-11-15)에 k8s-service가 네 번 메모리가 다 차 재시작했습니다. 이미 켜진 watch는 그대로 갑니다.
- `multicluster.wsWatchOpeningConcurrency`(8): 버전 없이 여는 watch가 열며 받는 객체를 한꺼번에 받을 수 있는 수로, 모든 클러스터를 합친 수입니다. 버전 없이 여는 watch는 API 서버가 있는 객체를 모두 보내며 열립니다. 둘째 W2 밤에 재시작 뒤 700명의 소켓이 돌아오자 살아 있는 힙이 2초 만에 121 MiB에서 285 MiB로 늘었고 30초 뒤 메모리가 다 찼습니다. 그래서 이런 watch는 시작하기 전에 자리를 잡고, 객체가 오는 대로 읽습니다. 답한 watch를 읽지 않고 두면 API 서버 쪽 버퍼가 차고, 서버는 100 ms가 지나면 그 watch를 닫습니다(`cache_watcher.go`). 클러스터는 자리를 이렇게 잡습니다. 클러스터마다 한도가 있고, 한도는 1에서 시작합니다. 시작을 보낸 뒤 5초 안에 API 서버가 답할 때마다 1씩 오르고, 답하지 않거나 5xx로 답할 때마다 반으로 줄어듭니다. 그래서 답하지 않는 클러스터는 자리 하나만 쥐고, 답하는 시작들 사이에 느린 시작이 섞여도 잠깐 한도가 반이 될 뿐입니다(시작 셋 중 하나가 5초를 넘는 열기 60개: 그런 시작 하나가 클러스터를 자리 하나로 내리던 때 22.0초, `TestASlowStartAmongAnsweredOnesCostsHalfTheLimit`). 다른 클러스터가 자리를 기다리는 동안에는 절반까지 잡습니다. 그 밖에는 한도까지 빈 자리를 빌려 잡습니다. 빌린 자리는 답이 오기 전 시계가 5초가 아니라 1초입니다. 클러스터가 하나인 서버는 목록 8개를 한꺼번에 엽니다(0.2초짜리 열기 64개: 한 클러스터가 절반만 쓸 수 있을 때 4.05초, `TestOneClusterOpensWithEveryPlace`). 답하지 않는 클러스터 둘 옆에서 셋째 클러스터의 목록 50개가 1초 안에 열렸습니다(`TestAClusterThatDoesNotAnswerHoldsOneOpeningPlace`). 이 규칙 없이 자리를 잡던 때에는 그런 클러스터 하나 옆에서 11.8초를 기다렸습니다. API 서버가 5초(빌린 자리는 1초, 이때는 한도를 내리지 않음) 안에 답하지 않은 시작은 자리를 돌려주고, 객체가 나중에 오면 자리 없이 읽습니다. watch list로 묻고(`sendInitialEvents=true`, `resourceVersion=0`에서 `resourceVersionMatch=NotOlderThan`: API 서버가 버전 없는 watch처럼 watch cache에서 내주고, 객체 끝을 북마크로 알림), 자리는 다음 가운데 먼저 오는 때 돌려줍니다: 그 북마크나 변경, 브라우저를 기다려야 할 프레임, watch 끝, API 서버가 답한 뒤 2초. watch list를 거절하는 API 서버(기본값으로 1.27~1.31과 1.33)는 422로 답합니다. 받아들이고도 북마크를 보내지 않는 서버에서는 watch list가 연달아 세 번, 2초가 됐을 때 마지막 1초 동안 이벤트가 없는 채로 남습니다(아직 객체가 오는 목록은 세지 않음). 어느 쪽이든 그 클러스터는 10분 동안 보통 watch로 열며, 그 열기는 변경이나 50 ms 동안 객체가 없을 때 끝납니다. 변경 감시 watch, 버전에서 이어 가는 watch, Helm 화면의 스트림은 열기 자리를 잡지 않습니다. 노드 1 000개 목록 8개가 한 개 약 5.5 MiB로 열려도 44 MiB로, 메모리 문(461 MiB의 0.80)과 700명이 메모리가 다 찬 0.94 사이 65 MiB 안입니다.
- `multicluster.wsWatchStreamWindowKiB`(1024): 실시간 목록 스트림 하나의 HTTP/2 창이며, 양쪽으로 대가가 있습니다. 브라우저가 느리게 읽는 watch는 열기 자리를 돌려준 뒤, 소켓의 256 프레임과 읽지 않은 목록을 이 크기까지 쥐고 기다립니다. 이 몫은 메모리 문만 셉니다. 또 스트림은 왕복 한 번에 이만큼만 읽으므로, 왕복이 긴 망에서는 큰 목록이 늦게 옵니다. 그 목록을 쓰는 API 서버는 뒤에 변경이 쌓이면 watch를 닫을 수 있습니다. 노트북에서 잰 값(느린 브라우저 16개가 4 KB 객체 2 000개 목록을 열 때 늘어난 살아 있는 힙, 왕복 50 ms 망으로 26 MB watch list를 받는 시간): 256 KiB +4.7 MiB · 5.3초, 512 KiB +10 MiB · 2.7초, 1 MiB +18 MiB · 1.4초, 2 MiB +33 MiB · 0.75초, Go 기본 4 MiB +65 MiB · 0.69초. 멀리 있는 클러스터는 올리고(왕복 30~50 ms면 2048), 느린 브라우저가 많은 곳은 내립니다.
- 이 셈 밖에 남는 것이 있습니다. 첫째, 느린 브라우저를 기다리는 watch는 세지 않습니다. 둘째, 답하던 클러스터가 답을 멈추면 빌린 자리는 1초, 제 절반은 5초 동안 쥐고, 그 뒤에는 자리 하나만 쥡니다. 그때 온 클러스터는 한 번 1초쯤 기다립니다(모든 자리가 5초이던 때 4.50초, `TestAClusterThatGoesDarkGivesItsLentPlacesBackSoon`). 셋째, 5초 뒤에 답한 시작은 자리 없이 객체를 읽습니다. 넷째, 보통 watch에서 객체가 80 ms 멈추면 열기가 일찍 끝납니다. 자리를 10초 넘게 기다리면 메모리 한도로 화면에 알리고, watch가 켜지면 목록을 다시 읽습니다. `TestWSMemoryPerUser`(노트북 go1.27.1, 수집기 한도 461 MiB, 메모리 문 켬, 클러스터 하나, 목록의 객체를 한 번에 보내고 아무것도 바꾸지 않는 TLS·HTTP/2 대역 API 서버, 다른 프로세스에서 최대한 빨리 읽는 브라우저)에서 700명이 W2의 켜 둔 화면을 한꺼번에 열 때 사람당 더 쥔 최고가 열기 자리 없이 634~635 KiB였던 것이 290~297 KiB가 됐고, 거절은 0이었으며, 모든 watch가 객체를 받기까지 4.7초가 걸렸습니다. 500명은 852~863 KiB에서 320~333 KiB가 됐고 2.9~3.1초가 걸렸습니다. 같은 방법으로 잰 앞 판(한 클러스터를 자리 절반으로 막고 창을 256 KiB로 둔 판)은 700명 266~269 KiB · 5.5~5.8초, 500명 278~280 KiB · 3.8초였습니다. 계속 바뀌는 목록과 느린 브라우저는 이 측정이 아니라 패키지 시험이 위 규칙대로인지 봅니다. Pod · Node · Deployment watch는 행이 읽는 것만 디코드합니다(`watch_decode.go`).
- Helm 화면의 스트림도 `multicluster.wsMaxSubscriptions`에 셉니다(watch 하나, 네임스페이스로 한정된 grant면 네임스페이스마다 하나). 한도를 넘으면 같은 알림이 그렇다고 말하고, 스트림은 30초~5분 뒤 다시 묻습니다. watch 시작도 `multicluster.wsWatchStartConcurrency` 자리를 거칩니다.
- Cluster View의 노드 칸, Node 드로어의 파드 표와 Allocated Resources는 그 순간 묻는 모두를 위해 노드마다 한 번 `kubeast:cache`로 읽고, 사람마다 자기 신원이 파드를 볼 수 있는 네임스페이스만 남깁니다(SelfSubjectAccessReview, 60초). Allocated Resources의 합은 kubectl describe node와 같은 계산입니다(init 컨테이너는 가장 큰 값, 사이드카 더함, pod overhead).
- 노드 칸을 그 사람으로 읽는 목록(접근 확인이 거부한 네임스페이스, 재시작 뒤 informer가 동기화되기 전, `kubeast:cache`가 거부될 때)도 공유 읽기와 같은 노드 읽기 자리 16개를 거칩니다.
- AI의 `k8s_jq_query` 프로그램은 tool-server의 자식 프로세스에서 한 번에 하나만 돕니다(`jqRuns`). 자식은 kubectl 자리(`multicluster.toolServerKubectlConcurrency`) 하나도 차지하고, 배포 이미지처럼 cgo 없이 빌드한 리눅스 바이너리에서는 시작할 때 잡은 주소 공간보다 80 MiB를 넘게 잡지 못합니다(`RLIMIT_AS`, `jq_limit_linux.go`). 그래서 2ms마다 재는 메모리 상한이 놓치는 한 번의 큰 할당도 할당하는 순간 거절됩니다. 80 MiB는 Go 힙 아레나 하나(64 MiB, 첫 아레나 안의 힙 시작 위치가 무작위)와 런타임 몫입니다. 2026-11-09 리눅스 컨테이너(Go 1.27.3)에서 64 MiB는 908 KB 목록의 보통 프로그램 80번 중 6번을 죽였고 80 MiB는 480번 중 0번이었으며, 200 MB 문자열은 매번 거절됐습니다. 다른 무엇도 막지 않을 때 자식 하나는 약 124 MiB까지 갔습니다(자리 하나의 40 MiB보다 큼). 보통 프로그램은 41 MiB 아래였고, 한 번에 하나라서 넘는 몫도 하나뿐입니다. 차례를 기다리다 호출의 50초가 다 되면 tool-server가 바쁘니 다시 물으라고 503으로 답합니다. macOS는 이 상한을 받지 않고, cgo로 빌드하면 cgo가 띄우는 스레드의 스택이 이 상한에 걸려 걸지 않습니다. 이 두 경우에는 메모리 상한 감시만 있습니다.
- 여러 쪽 읽기(`multicluster.bigReadConcurrency`)는 자리를 기다리는 동안 읽은 쪽을 쥐지 않고 다음 쪽의 위치만 쥡니다. 2026-11-08 전에는 기다리는 읽기마다 쪽 하나를 쥐었습니다(파드 256개 × 64 KiB에 16 MiB).
- Pods 화면은 3초마다 페이지를 다시 읽고, 화면이 세는 파드(고른 네임스페이스, 전체면 사용자가 볼 수 있는 모든 네임스페이스의 파드)가 10 000개를 넘으면 10초마다 읽습니다. 그래서 큰 클러스터에서는 k8s-service가 받은 변경이 10초 안에 화면에 보입니다. 읽을 때마다 가진 판 번호를 보내고 k8s-service가 가진 행에서 답을 받습니다. 사용자가 볼 수 있는 행이 안 바뀌었으면 정렬하기 전에 `unchanged`로 답합니다. 클러스터로 가는 요청이 아닙니다(위 표: 서로 다른 500명이 파드 50 000개에서 켜 둔 동안 p95 16 ms). 행을 사용자 신원으로 받는 동안(informer 동기화 전, `kubeast:cache`가 파드를 watch할 수 없을 때)은 30초마다 읽습니다.
- Pods 화면 · 노드 지도 · 노드 목록이 파드 행을 다루는 일은 CPU 수만큼, 많아야 8개가 한꺼번에 돕니다. 차트가 CPU limit을 두지 않아 Go는 노드의 CPU를 모두 세고, 하나가 파드 50 000개에서 행 약 2 MB를 쥡니다. k8s-service 환경 변수 `POD_ROW_CONCURRENCY`로 다른 수를 정할 수 있습니다.
