[English](../upgrade-0.7.8.md) | **한국어**

# 0.7.7에서 0.7.8로 업그레이드

**손 써야 하는 변경: 있음(설치에 따라 다름).** Kubernetes 1.30보다 오래된 클러스터는 `podShutdown.preStopSeconds: 0`이 필요합니다([1.3](#13-kubernetes-버전)). 값에 `pdb.minAvailable`이 있으면 그 값을 뺄 때까지 업그레이드가 멈춥니다([3](#3-바꿔야-하는-값)). `gpt-4o-mini`를 적은 저장된 AI 모델 설정은 2027-01-14 전에 다른 모델로 바꿉니다([1.9](#19-기본-ai-모델)). `secrets.existingSecret`을 쓰면 이번 업그레이드에서 바꿀 것은 없습니다. Redis 사용자는 그 키를 `redis.acl.existingSecret`이 가리키는 Secret에 넣거나, 주 Secret에 넣고 `redis.acl.existingSecretHasKeys: true`로 둘 때까지 꺼진 채입니다([1.7](#17-secretsexistingsecret과-redis-사용자)). 아래 다른 항목은 그 항목이 적은 설치에만 해당합니다.

이 문서는 0.7.7 설치를 0.7.8로 올릴 때 먼저 확인할 것, 저절로 바뀌는 것, 바꿔야 하는 값, 업그레이드가 한 번 하는 일, 되돌리는 방법을 다룹니다.
업그레이드 명령은 [설치와 첫 설정](getting-started.md#업그레이드)의 명령에 `--version 0.7.8`을 쓴 것입니다.
항목마다 그 변경을 만든 풀 리퀘스트 번호를 붙였습니다.

아래 명령은 네임스페이스 `kubeast`의 릴리스 `kubeast`를 기준으로 합니다. 자기 이름으로 바꿔 씁니다.

## 요약

- 먼저 [1.2](#12-드라이런으로-미리-해-보기)의 드라이런을 돌립니다. 업그레이드를 멈출 수 있는 검사는 모두 거기서 멈추고, 아무것도 바뀌지 않습니다.
- Kubeast가 도는 클러스터는 Kubernetes 1.30 이상이어야 합니다. 아니면 `podShutdown.preStopSeconds: 0`으로 둡니다(#856).
- Kubeast에서 시작한 노드 드레인은 업그레이드 전에 끝냅니다(#858).
- 레플리카가 많으면 데이터베이스 연결 수가 `postgresql.maxConnections`(300) 안에 들어와야 하고, 아니면 업그레이드가 멈춥니다(#868).
- 다른 역할과 같은 역할 그룹이 되는 이름의 사용자 정의 역할은 이름이 바뀌고 클러스터 부여를 잃으며, 바뀐 것마다 감사 행이 남습니다. `Pending` 그룹의 역할(`PENDING`)인 계정 등급은 기본 `Pending`으로 옮겨집니다(#865).
- ASCII가 아닌 글자가 든 역할 이름은 자기 그룹을 받습니다(`운영팀`은 `kubeast:role:~c6b4~c601~d300`으로 동작하고, 0.7.7에서는 `kubeast:role:---`였습니다). 그래서 클러스터에서 옛 그룹에 바인딩한 RBAC는 그 역할에 더는 적용되지 않습니다(#865).
- 서비스 말고도 차트의 PostgreSQL과 Redis가 한 번 다시 시작하고, 캐시는 비어서 시작합니다(#866, #868). 데이터베이스가 멈춘 때부터 20초쯤은 옛 파드로 가는 요청이 기다릴 수 있고 몇 개는 실패하고, 쓰던 사람은 다시 로그인해야 할 수 있습니다(로그인한 요청이 이 릴리스의 kind 리허설에서는 1~2초, #953 전 빌드의 EKS에서는 18초쯤 401을 받았습니다). 0.7.7 파드가 바뀌는 동안에도 요청 몇 개는 실패할 수 있습니다. 0.7.7 파드는 기다리지 않고 멈추고, 0.7.8부터는 파드가 멈추기 전에 기다립니다(#856). 사용자가 적은 때 업그레이드합니다([2](#2-업그레이드)).
- 기본 AI 모델은 `gpt-4o-mini` 대신 `gpt-6-luna`입니다. 저장된 모델 설정은 처음 시작할 때 만든 `default-openai` 설정까지 자기 모델을 그대로 씁니다([1.9](#19-기본-ai-모델), #924).
- 한 계정은 k8s-service 하나에 터미널 20개, 실시간 로그 20개까지 열어 둘 수 있고, 넘는 것은 거절합니다(`multicluster.maxTerminalsPerAccount`, `multicluster.maxFollowedLogsPerAccount`, `0`이면 상한을 끕니다. [4](#4-저절로-바뀌는-것), #971).
- 먼저 데이터베이스를 백업합니다. 되돌려도 역할 이름 바꾸기는 되돌아가지 않습니다.

## 1. 업그레이드 전에

### 1.1 지금 버전

```bash
helm list -n kubeast                          # CHART kubeast-0.7.7
helm get values kubeast -n kubeast -o yaml    # 직접 넣은 값
```

0.7.7보다 앞 버전에서는 먼저 0.7.7로 올리고, 그 사이 버전의 릴리스 노트도 읽습니다. 이 업그레이드는 0.7.7에서 올리는 경우만 리허설했습니다.

### 1.2 드라이런으로 미리 해 보기

```bash
helm upgrade kubeast oci://ghcr.io/junginho0901/charts/kubeast --version 0.7.8 \
  -n kubeast --reset-then-reuse-values --dry-run=server > /dev/null
```

지금 값으로 0.7.8을 렌더하고 아무것도 바꾸지 않습니다. 검사가 멈추면 Helm이 무엇을 바꿔야 하는지 담은 오류를 출력하고, 그 목록은 [3](#3-바꿔야-하는-값)의 표에 있습니다. `--dry-run=server`(Helm 3.13 이상)는 차트가 Secret을 읽게 하므로 [1.7](#17-secretsexistingsecret과-redis-사용자)의 Redis 사용자 검사도 돕니다.

이 드라이런은 렌더와 차트의 검사만 봅니다. 객체를 API 서버에 보내지 않으므로, 업그레이드 때 API 서버가 거절할 것(바꿀 수 없는 필드, 다른 관리자가 가진 필드)은 여기서 걸리지 않습니다. 업그레이드가 서버 측으로 적용될 때(Helm 4에서 `--server-side=true`, 또는 기본값 `auto`이고 직전 릴리스를 서버 측으로 적용했을 때)는 아래처럼 렌더한 객체를 Helm의 이름으로 API 서버에 드라이런으로 보내 볼 수 있습니다. `helm template`은 클러스터에서 아무것도 읽지 않고, 값이 다른 네임스페이스에 두는 객체는 네임스페이스 오류로 멈추므로 그 `-n`으로 따로 보냅니다.

```bash
chart=$(mktemp -d)
helm pull oci://ghcr.io/junginho0901/charts/kubeast --version 0.7.8 --untar --untardir "$chart"
helm get values kubeast -n kubeast -o yaml \
  | helm template kubeast "$chart/kubeast" -n kubeast --no-hooks -f - \
  | kubectl apply --server-side --dry-run=server --field-manager=helm -n kubeast -f -
```

차트를 먼저 받는 것은 Helm 4.2.1~4.2.x가 OCI 레지스트리의 차트를 렌더할 때 YAML 앞에 `Pulled:`·`Digest:` 줄을 출력하고, `kubectl apply`가 그 줄을 읽지 못하기 때문입니다.

설치 안내(예: [1.6](#16-데이터베이스-연결)의 바깥 데이터베이스 연결 합계)를 보려면 `helm upgrade` 드라이런을 `> /dev/null` 없이 돌리고 끝의 `NOTES:`를 읽습니다.

### 1.3 Kubernetes 버전

```bash
kubectl version    # Server Version: v1.30 이상
```

Service 뒤에 있는 차트 파드는(번들 PostgreSQL과 Redis는 빼고) 이제 SIGTERM 전에 `preStop`에서 `podShutdown.preStopSeconds`(5초)를 기다리며, 이때 쿠버네티스 내장 `sleep` 동작(1.30에서 베타·기본 켜짐, 1.34에서 GA)을 씁니다. 더 낮은 클러스터에서는 `podShutdown.preStopSeconds: 0`으로 둡니다(#856).
Helm의 확인은 이것을 잡지 않습니다. API 서버가 preStop 기다림이 있는 Deployment마다 `spec.template.spec.containers[0].lifecycle.preStop: Required value: must specify a handler type`로 거절합니다.
[1.2](#12-드라이런으로-미리-해-보기)의 `kubectl apply` 드라이런이 업그레이드 전에 이것을 보여 줍니다. Kubernetes 1.29.14(kind, `PodLifecycleSleepAction` 기능 게이트 꺼짐)에서 preStop 기다림이 있는 Deployment 7개가 거절되었고, `podShutdown.preStopSeconds: 0`으로 두면 모든 객체를 받았습니다.
이 드라이런은 `streams.enabled`를 끈 설치였습니다. 켜면 `k8s-service-stream`은 `podShutdown.preStopSeconds`와 상관없이 `preStop`에서 `streams.preStopSeconds`(10초)를 기다리므로 Kubernetes 1.30 이상이 필요하고, 1.33 아래에서는 `streams.preStopSeconds`를 1 이상으로 둡니다(Kubernetes는 1.33부터 `sleep` 0을 받습니다. [클러스터 요구 사항](cluster-requirements.md) §15).

### 1.4 노드 드레인

Kubeast에서 시작한 노드 드레인은 k8s-service 안에서 돕니다. 0.7.7은 그 진행을 프로세스 메모리에 두므로, k8s-service를 바꾸는 업그레이드가 드레인을 그 자리에서 끝내고 노드는 cordon된 채 남습니다(#858).

- 드레인이 모두 끝날 때까지 기다립니다. 드레인이 도는 동안 노드 서랍에 "드레인 진행 중입니다."가 보입니다.
- 등록한 클러스터마다 아직 cordon된 노드를 봅니다.

```bash
kubectl get nodes    # STATUS Ready,SchedulingDisabled
```

0.7.8부터는 드레인 진행이 데이터베이스에 있고, 중간에 끊긴 드레인은 "Interrupted"와 Start again 버튼으로 보입니다(#858).

### 1.5 역할 이름

업그레이드는 다른 역할이나 기본 역할과 같은 역할 그룹이 되는 이름의 사용자 정의 역할(`Admin` 옆의 `ADMIN`, ` read `, `a b` 옆의 `a-b`, `Ops 팀` 옆의 `OPS-팀`)의 이름을 바꾸고, 그 역할이 클러스터에서 가졌던 것을 지웁니다([5](#5-이번-업그레이드에서-한-번-일어나는-일), #865).
이제 ASCII가 아닌 글자는 그룹에 코드 포인트로 남으므로, 글자 수가 같은 한글 이름(`운영팀`, `개발팀`)은 서로 다른 그룹이 되어 이름이 바뀌지 않고 부여도 그대로 남습니다.

[설치와 첫 설정](getting-started.md#업그레이드)의 "업그레이드"에 업그레이드가 이름을 바꿀 역할을 보여 주는 읽기 전용 쿼리가 있습니다. 각 역할이 그룹을 함께 쓰는 역할(`same_group_as`)과 각 역할의 부여·임시 부여의 복원·대기 중이거나 승인된 접근 요청·계정 등급 수가 나옵니다.
그 쿼리를 `preview.sql`에 복사해 실행합니다.

```bash
kubectl -n kubeast exec -i deploy/postgres -c postgres -- psql -U kubeast -d kubeast < preview.sql
```

행이 없으면 이름이 바뀌는 역할이 없습니다. 행이 있으면 그 역할을 누가 어느 클러스터에서 가졌는지(Admin → Users → Cluster access) 적어 두어 나중에 다시 부여할 수 있게 합니다.
`same_group_as`가 `Pending`인 행의 계정 등급은 기본 `Pending`으로 옮겨지고, 나머지는 바뀐 이름의 역할에 남습니다.

이름에 ASCII가 아닌 글자가 든 사용자 정의 역할은 새 그룹으로 동작합니다. 0.7.7은 그런 글자를 하나씩 `-`로 적었고(`운영팀`은 `kubeast:role:---`), 0.7.8은 `~`와 코드 포인트로 적습니다(`kubeast:role:~c6b4~c601~d300`).
옛 그룹에 바인딩한 RBAC는 그 역할에 더는 적용되지 않습니다. 등록한 클러스터마다 Kubeast 역할 그룹의 바인딩을 나열하고, 이름에서 그런 글자가 있는 자리에 그룹이 `-`를 가진 것을 적어 둡니다.

```bash
kubectl get clusterrolebindings,rolebindings -A -o wide | grep 'kubeast:role:'
```

역할 이름을 적는 차트 설정과, 각 설정이 바뀐 역할의 옛 이름으로 어떻게 되는지는 [6](#6-업그레이드한-뒤)에 있습니다.

```bash
helm get values kubeast -n kubeast -o yaml | grep -n -A6 -E 'roleMapping|defaultRole|clusterGroupMapping|accessRequests|customRoles'
```

### 1.6 데이터베이스 연결

이제 서비스마다 연결 풀 크기가 정해져 있고, 차트의 PostgreSQL은 `postgresql.maxConnections`(300. PostgreSQL 자체 기본값은 100)의 `max_connections`로 시작합니다. 차트의 PostgreSQL을 쓸 때 파드들이 그보다 많이 열 수 있으면 렌더가 멈춥니다(#868).

차트가 확인하는 합계는 다음과 같습니다.

| 부분 | 연결 |
| --- | --- |
| auth-service | `postgresql.pool.authService.maxConns`(20) × 롤아웃 파드 수 |
| session-service | `postgresql.pool.sessionService.maxConns`(20) × 롤아웃 파드 수 |
| k8s-service | (`postgresql.pool.k8sService.maxConns`(10) + 상태 확인 잠금 1) × 롤아웃 파드 수(#858) |
| ai-service(AI를 켰을 때) | `postgresql.pool.aiService.maxConns`(15) × 롤아웃 파드 수 |
| ModelConfig controller(AI를 켰을 때) | `postgresql.pool.modelConfigController.maxConns`(4) × 2 |
| k8s-service-stream(`streams.enabled`일 때) | `postgresql.pool.k8sService.maxConns` × (`streams.replicas` + 1) |
| 마이그레이션과 남겨 둘 몫 | 4 + 10 |

"파드 수"는 `replicas.<service>`이고, HPA를 켠 서비스는 `autoscaling.<service>.maxReplicas`입니다. "롤아웃 파드 수"는 롤아웃 몫으로 하나를 더한 수입니다. 롤아웃은 파드를 한 번에 하나만 더 띄웁니다(`maxSurge: 1`, #901). 파드 1개면 2, 4개면 5입니다.
상태 확인 잠금은 k8s-service 파드마다 풀 밖에 자기 연결을 하나 둡니다. k8s-service-stream은 두지 않습니다(#858).
AI를 켜고 서비스마다 파드 1개면 20 × 2 + 20 × 2 + 11 × 2 + 15 × 2 + 4 × 2 + 14 = 40 + 40 + 22 + 30 + 8 + 14 = 154입니다.
auth-service, session-service, ai-service를 4개씩 띄우면 20 × 5 + 20 × 5 + 11 × 2 + 15 × 5 + 4 × 2 + 14 = 100 + 100 + 22 + 75 + 8 + 14 = 319로 300을 넘어 업그레이드가 멈추고, 메시지가 합계를 알려 줍니다.

그만큼 띄우는 설치라면 업그레이드와 함께 다음 중 하나를 바꿉니다.

- `postgresql.maxConnections`를 합계나 그보다 조금 큰 수로 올립니다. PostgreSQL은 연결마다 프로세스를 하나씩 쓰므로 `resources.postgres`도 함께 봅니다.
- 또는 파드가 많아 파드마다 연결이 덜 필요하면 풀을 줄입니다. 예를 들어 `postgresql.pool.authService.maxConns: 10`으로 둡니다.

바깥 데이터베이스(`postgresql.enabled: false`)는 차트가 상한을 읽을 수 없습니다. 설치 안내가 합계를 출력하므로 데이터베이스의 `max_connections`를 그보다 크게 둡니다.

```bash
psql "<데이터베이스 URL>" -c 'SHOW max_connections'
```

풀러 뒤에서는 다음과 같습니다.

- RDS Proxy: `SET`이 클라이언트 연결을 고정(pinning)합니다. `postgresql.sessionLimits.statementTimeoutMs`, `lockTimeoutMs`, `idleInTransactionTimeoutMs`를 `0`으로 두고, 한도는 프록시의 초기화 질의나 데이터베이스 역할에 둡니다(#868).
- PgBouncer: 세션 풀링을 쓰거나 직접 연결합니다. 트랜잭션 풀링은 지원하지 않습니다. 트랜잭션 사이에 서버 연결을 다른 클라이언트에게 넘기므로, 한도를 거는 `SET`과 세션 advisory lock(마이그레이션, 감사 싱크, 상태 확인 잠금의 것)이 그것을 건 클라이언트에 남지 않습니다. 데이터베이스 역할에 한도를 걸어도 이것은 바뀌지 않습니다(#858, #868).

### 1.7 `secrets.existingSecret`과 Redis 사용자

차트의 Redis는 이제 k8s-service, tool-server, 프로브에 사용자를 하나씩 주고 `default` 사용자를 끕니다. 비밀번호는 Secret `kubeast-redis-users`에 생성됩니다(#866).

`secrets.existingSecret`을 쓰면 이번 업그레이드에서는 아무것도 바뀌지 않습니다. 사용자를 켤 때까지 Redis는 비밀번호 하나(`REDIS_PASSWORD`)를 그대로 쓰고, 설치 안내가 그렇다고 알려 줍니다. 지금이든 나중이든 사용자를 켜려면 다음 중 하나를 고릅니다.

- `REDIS_K8S_SERVICE_PASSWORD`, `REDIS_PROBE_PASSWORD`, AI를 켰다면 `REDIS_TOOL_SERVER_PASSWORD`까지 따로 만든 Secret에 넣고 `redis.acl.existingSecret`에 그 이름을 둡니다. 그러면 서비스마다 자기 키만 읽습니다.
- 또는 그 키를 주 Secret에 더하고 `redis.acl.existingSecretHasKeys: true`로 둡니다. 백엔드는 모두 그 Secret을 통째로 읽으므로 서비스마다 모든 사용자의 비밀번호를 갖게 되고, 설치 안내가 그렇다고 알려 줍니다.

Secret을 읽을 수 있는 업그레이드는 키가 없거나 비어 있으면 멈추고 그 키 이름을 알려 줍니다. `helm template`과 Argo CD는 Secret을 읽지 못하므로, 거기서는 redis 파드의 `acl` 컨테이너가 키 이름을 알려 주고 멈춥니다.

`images.redis`에 직접 고른 이미지를 쓰면 Valkey나 Redis 6.2 이상이어야 합니다. 규칙에 든 명령을 이미지가 모르면 시작할 때 멈춥니다.

사용자별 규칙은 [Redis 사용자](configuration.md#redis-사용자)에 있습니다.

### 1.8 Claude Code 프로바이더

`ai.providers.claudeCode.enabled: true`라면 다음이 바뀝니다.

- 직접 넣지 않았다면 `maxConcurrent`가 ai-service 서버마다 1에서 2로 바뀝니다(#859).
- ai-service의 메모리 limit은 `resources.aiService.limits.memory`(1Gi)와 새 값 `ai.providers.claudeCode.memoryLimit`(2Gi) 중 큰 쪽이 됩니다. `""`로 두면 `resources.aiService.limits.memory`가 정한 그대로입니다(#859).

네임스페이스에 ResourceQuota나 LimitRange가 있으면 ai-service가 들어가는지 확인합니다.

```bash
kubectl -n kubeast get resourcequota,limitrange
```

### 1.9 기본 AI 모델

0.7.8부터 차트의 `ai.model`은 `gpt-4o-mini` 대신 `gpt-6-luna`입니다. OpenAI는 2027-01-14에 `gpt-4o-mini-2024-07-18`을 종료하고 대체 모델로 `gpt-6-luna`를 안내합니다(#924). 업그레이드는 저장된 설정을 하나도 바꾸지 않습니다.

- **모델을 정하지 않은 설치**: 차트에 OpenAI 키(`ai.openaiApiKey`)를 넣었다면 ai-service가 처음 시작할 때 0.7.7의 기본값 `gpt-4o-mini`로 `default-openai` 설정을 저장했고, 그 설정은 그 모델을 그대로 씁니다. **Admin > AI Models**에서 만든 설정도 마찬가지입니다. 2027-01-14 전에 거기서 모델을 바꿉니다.
- **저장된 설정이 없는 설치**(키 없이 `ai.baseUrl`의 게이트웨이를 쓰는 설치): 업그레이드한 때부터 `gpt-6-luna`를 보냅니다. 게이트웨이(LiteLLM 등)는 매핑한 이름에만 답하므로, 먼저 게이트웨이에 `gpt-6-luna`를 매핑하거나 `ai.model`을 게이트웨이가 매핑한 이름으로 둡니다.
- **값에 적은 `ai.model`**(예: 0.7.7의 `helm show values`에서 복사한 파일의 `gpt-4o-mini`)은 그대로 남고, 저장된 설정이 없을 때만 모델을 정합니다.
- **도구**: `gpt-6-luna`는 Chat Completions에서 `reasoning_effort: "none"`일 때만 도구를 받습니다. Kubeast는 OpenAI와 Azure OpenAI 프로바이더의 `gpt-6-sol`, `gpt-6-luna`라는 이름으로 가는 모든 호출에 이 값을 보냅니다(#923). 다른 이름(Azure 배포, 게이트웨이 별칭, 프로바이더 `custom`)으로 `gpt-6-luna`에 닿는 설정은 도구 호출이 OpenAI의 400 "Function tools with reasoning_effort are not supported"로 한 번 거절된 뒤부터 `none`을 보냅니다. 첫 호출부터 보내려면 그 설정의 옵션에 `"reasoning_effort": "none"`을 넣습니다.
- **가격**(1M 토큰당): `gpt-6-luna` 입력 $0.10 · 출력 $0.50, `gpt-4o-mini` 입력 $0.15 · 출력 $0.60입니다. 그 밖의 가격 조건은 [설치와 첫 설정](getting-started.md#업그레이드)의 "업그레이드"에, Docker Compose는 [8](#8-docker-compose)에 있습니다.

### 1.10 데이터베이스 백업

```bash
kubectl -n kubeast exec deploy/postgres -c postgres -- pg_dump -Fc -U kubeast kubeast > kubeast-before-0.7.8.dump
```

바깥 데이터베이스는 그 데이터베이스의 백업을 씁니다. 두 방법과 복원은 [데이터베이스: TLS, 백업과 복원](database-backup-restore.md#클러스터-안-데이터베이스-백업-backing-up-the-in-cluster-database)에 있습니다.

## 2. 업그레이드

```bash
helm upgrade kubeast oci://ghcr.io/junginho0901/charts/kubeast --version 0.7.8 \
  -n kubeast --reset-then-reuse-values
```

- 마이그레이션은 auth-service가 시작할 때 적용하고, `migrations.mode: job`이면 마이그레이션 Job이 적용합니다. Job은 시도마다 파드를 따로 쓰고 10분에 끝납니다(#829, #834).
- 0.7.7이 띄운 파드는 0.7.7 방식으로 멈춥니다. `preStop` 기다림, 터미널이 닫히기 전에 받는 안내, 돌던 알림 조사를 대기열에 되돌리는 일은 0.7.8이 띄운 파드부터 적용됩니다(#856, #901). 업그레이드 동안 열려 있던 터미널과 따라가던 로그는 끝납니다.
- 이번 업그레이드 동안 잠깐 요청이 실패할 수 있으므로 Kubeast를 쓰는 사람이 적은 때 업그레이드합니다. 0.7.7에서 올릴 때 한 번만 일어납니다. 0.7.7 파드는 `preStop` 기다림 없이 멈추고, 차트의 PostgreSQL은 한 번 다시 시작하고, Redis는 바뀝니다(#856, #866, #868). t3.medium 노드 3대의 EKS 1.35 클러스터에서 게이트웨이 파드 하나를 파드 IP로 보내는 AWS Application Load Balancer 뒤에 두었을 때, 0.7.7 게이트웨이 파드가 멈추는 동안 로드 밸런서를 거친 요청이 6초쯤 502를 받았고, EBS 볼륨의 PostgreSQL은 멈춘 뒤 16초에 다시 떴습니다. PostgreSQL이 다시 시작하는 동안 아직 바뀌지 않은 0.7.7 파드는 토큰 버전을 읽지 못해 401로 답하고, 화면은 로그인 화면으로 가므로 그때 Kubeast를 쓰던 사람은 다시 로그인해야 할 수 있습니다. 그 클러스터에서 #953 전의 0.7.8 빌드로는 로그인한 요청이 18초쯤 401을 받았습니다. 이 릴리스로 kind에서 리허설했을 때는 0.7.7 auth-service만 준비돼 있던 초에만 401을 받았습니다. 기본 설치에서 2초, 기존 Secret을 쓰는 설치에서 1초였습니다. Redis가 바뀌는 동안 시작한 0.7.8 k8s-service 파드는 시작할 때 Redis에 거절될 수 있습니다(로그에 `redis not available`). 그때는 캐시를 메모리에 두었다가 Redis가 답하면 Redis로 옮깁니다(`redis answered`). 0.7.8부터는 Service 뒤의 파드가 멈추기 전에 5초를 기다립니다. 같은 로드 밸런서 뒤에서 차트와 로드 밸런서의 기본값 그대로 0.7.8 게이트웨이를 다시 띄웠을 때도 파드를 30번 바꾸는 동안 3번, 로드 밸런서를 거친 요청이 2~3초 동안 실패했습니다. 실패가 없던 설정은 [4](#4-저절로-바뀌는-것)에 있습니다.
- 새 기능(`autoscaling`, `streams.enabled`)은 이번 업그레이드가 자리 잡은 뒤 다음 업그레이드에서 켭니다. 서비스마다 두 번째 파드 전에 필요한 것은 [여러 대로 띄우기](high-availability.md)에 있습니다(#867).

## 3. 바꿔야 하는 값

자기 설치에 맞는 행만 봅니다. "멈춤"인 행은 그 값을 바꿀 때까지 메시지와 함께 업그레이드를 멈춥니다.

| 언제 | 0.7.7 | 0.7.8 | PR |
| --- | --- | --- | --- |
| 값에 `pdb.minAvailable`이 있을 때 | `pdb.minAvailable: 1` | 멈춤. `pdb.minAvailable`을 뺍니다. 한 서비스의 파드를 노드 드레인이 한 번에 몇 개 내보낼지는 `pdb.maxUnavailable`(1)이 정합니다 | #901, #908 |
| Kubernetes 1.30 미만([1.3](#13-kubernetes-버전)) | — | `podShutdown.preStopSeconds: 0` | #856 |
| 파드 IP로 보내는 로드 밸런서 뒤 | — | `podShutdown.preStopSeconds`는 로드 밸런서가 떠나는 파드에 새 요청을 그만 보낼 때까지보다 길게 둡니다. AWS Application Load Balancer 뒤에서는 `podShutdown.preStopSeconds: 25`와 대상 그룹 등록 해제 지연 20초를 씁니다. 이 값으로는 게이트웨이 파드를 18번 바꾸는 동안 실패한 요청이 없었고, 기본값(5초, 300초)으로는 30번 중 3번에서 요청이 실패했습니다(EKS 1.35, AWS Load Balancer Controller v3.6.2, [4](#4-저절로-바뀌는-것)) | #856 |
| 차트의 PostgreSQL에 레플리카가 많을 때([1.6](#16-데이터베이스-연결)) | PostgreSQL의 `max_connections` 100 | `postgresql.maxConnections`(300)를 넘으면 멈춤. 올리거나 `postgresql.pool.<service>.maxConns`를 줄입니다 | #868 |
| 바깥 데이터베이스 | — | `max_connections`를 설치 안내가 출력한 합계보다 크게 | #868 |
| RDS Proxy 뒤 | — | `postgresql.sessionLimits.*: 0`, 한도는 프록시나 역할에 | #868 |
| 트랜잭션 풀링 PgBouncer 뒤 | — | 지원하지 않음. 세션 풀링이나 직접 연결 | #858, #868 |
| `secrets.existingSecret`([1.7](#17-secretsexistingsecret과-redis-사용자)) | `REDIS_PASSWORD` | 사용자 키 셋을 넣고 `redis.acl.existingSecret`이나 `redis.acl.existingSecretHasKeys: true`. 그때까지는 비밀번호 하나 | #866 |
| 직접 고른 `images.redis` | 아무 Redis | Valkey나 Redis 6.2 이상 | #866 |
| Claude Code를 켜고 메모리 limit을 그대로 둘 때 | `resources.aiService.limits.memory` | `ai.providers.claudeCode.memoryLimit: ""` | #859 |
| Claude Code를 켜고 서버마다 한 턴만 둘 때 | `maxConcurrent: 1`(기본값) | `ai.providers.claudeCode.maxConcurrent: 1`(기본값 2) | #859 |
| 저장된 AI 모델 설정이나 값의 `ai.model`이 `gpt-4o-mini`일 때([1.9](#19-기본-ai-모델)) | `gpt-4o-mini` | 2027-01-14 전에 **Admin > AI Models**나 `ai.model`에서 다른 모델로 | #924 |
| 이름이 바뀐 역할을 차트 설정이 적고 있을 때([1.5](#15-역할-이름)) | 옛 이름 | 뜻한 역할의 이름. 새 이름, 역할에 새로 준 이름, 또는 기본 역할 | #865 |
| `auth.accessRequests.roles`가 기본 역할 이름을 대소문자만 달리 적었을 때(`WRITE`) | 그 이름의 사용자 정의 역할 | 기본 역할(`Write`)로 읽힘. 뜻한 역할의 이름을 적습니다 | #865 |
| `replicas`나 `autoscaling`에 서비스 일곱 개가 아닌 키가 있을 때 | 무시됨 | 멈춤. 키는 `authService`, `aiService`, `k8sService`, `sessionService`, `frontend`, `toolServer`, `gateway`입니다 | #867 |
| 0.7.8이 더는 읽지 않는 값 | 무시됨 | 멈추고 대신 넣을 값을 알려 줍니다 | #908 |
| `chartVersion`이나 릴리스의 `global.imageTag`가 든 값 파일 | `chartVersion`으로 멈춤 | 릴리스의 `global.imageTag`로도 멈춤. 둘 다 뺍니다 | #818 |
| `--reuse-values`로 업그레이드 | 멈춤 | 0.7.7처럼 멈춤. `--reset-then-reuse-values`를 씁니다 | — |

값을 빼려면 그 값이 없는 값 파일로, `--reset-then-reuse-values` 대신 `--reset-values`를 써서 올립니다.

```bash
helm get values kubeast -n kubeast -o yaml > my-values.yaml    # 그다음 파일에서 그 줄을 지움
helm upgrade kubeast oci://ghcr.io/junginho0901/charts/kubeast --version 0.7.8 \
  -n kubeast --reset-values -f my-values.yaml
```

기본값 그대로 두면 되는 새 값은 `podShutdown.preStopSeconds`(5, AWS Application Load Balancer 뒤라면 위 표의 행), `pdb.maxUnavailable`(1), `streams.*`(꺼짐), `autoscaling.<service>`(꺼짐), `redis.acl.*`(켜짐), `postgresql.sessionLimits.*`, `postgresql.pool.<service>.maxConns`, `postgresql.maxConnections`(300), `ai.providers.claudeCode.maxConcurrentTotal`(0), `queueWaitSeconds`(60), `memoryLimit`(2Gi), `gateway.accessLog.upstreamTimes`(꺼짐), `multicluster.wsWatchOpeningConcurrency`(8), `multicluster.wsWatchStreamWindowKiB`(1024), `auth.impersonation.sharedReadChecks.*`(꺼짐)입니다. 각 값의 설명은 [설정](configuration.md)에 있습니다.

## 4. 저절로 바뀌는 것

**파드와 롤아웃**

- Service 뒤의 파드는 SIGTERM 전에 `podShutdown.preStopSeconds`를 기다립니다. 번들 PostgreSQL과 Redis는 예외로, preStop 기다림이 없고 Kubernetes 기본 종료 유예(30초)를 씁니다. 나머지 파드의 종료 유예는 그 기다림, SIGTERM 뒤 서비스가 기다리는 시간, 5초를 더한 것이고 기본값으로는 35초입니다. k8s-service는 열린 터미널이 끝나도록 `streams.drainSeconds`(60)와 닫을 시간 5초를 더 주므로, 기본값으로 종료 유예가 100초입니다(#856, #824, #825). 파드 IP로 보내는 로드 밸런서 뒤라면 이 기다림은 로드 밸런서가 그 파드에 새 요청을 그만 보낼 때까지 이어져야 합니다. EKS 1.35에서 파드 IP로 보내는 AWS Application Load Balancer(AWS Load Balancer Controller v3.6.2) 뒤에 두었을 때, 떠나는 게이트웨이 파드의 대상은 파드를 지운 뒤 1초 안에 draining이 되었지만, 기본값(5초, 로드 밸런서의 해제 지연 300초)에서는 게이트웨이 파드를 30번 바꾸는 동안 3번, 로드 밸런서가 그 파드의 기다림이 끝난 뒤에도(파드를 지운 뒤 약 8초까지) 새 요청을 보냈고, 그 2~3초 동안 요청의 3분의 1에서 절반이 502나 504로 실패했습니다([2](#2-업그레이드)). `podShutdown.preStopSeconds: 25`와 대상 그룹 등록 해제 지연 20초(`ingress.annotations`에 `alb.ingress.kubernetes.io/target-group-attributes: deregistration_delay.timeout_seconds=20`)로는 게이트웨이 파드가 하나일 때와 둘일 때 이틀에 걸쳐 파드를 18번 바꾸는 동안 실패한 요청이 없었고, 서비스마다 파드 2개로 노드 하나를 한 번 비울 때도 없었습니다. 기본값으로 비울 때는 요청이 실패하고 4초 동안 응답이 없었으며 실시간 목록이 23.1초 끊겼습니다.
- liveness는 다른 것을 읽지 않는 `/livez`를 묻습니다. readiness는 `/readyz`를 묻고, 이것은 SIGTERM부터 503을 답하며 데이터베이스는 묻지 않습니다(#901).
- 롤아웃은 새 파드를 하나 띄우고 그 파드가 준비된 뒤에만 옛 파드를 멈춥니다(`maxSurge: 1`, `maxUnavailable: 0`). 그래서 Deployment마다 파드 하나가 더 들어갈 자리가 필요합니다. PostgreSQL은 `Recreate`를 유지하고, Redis는 옛 파드를 먼저 내리기 시작한 뒤 새 파드를 만듭니다(`maxSurge: 0`). 옛 파드가 끝나는 몇 초 동안 둘이 같이 있을 수 있지만 데이터는 나누지 않습니다(emptyDir)(#901, #860).
- `pdb.enabled`가 이제 `true`입니다. 파드가 둘 이상 남을 수 있는 Deployment(`replicas`, 또는 HPA를 켰을 때 `autoscaling.<service>.minReplicas`)는 `unhealthyPodEvictionPolicy: AlwaysAllow`인 PodDisruptionBudget을 받고, 파드 하나인 Deployment는 받지 않습니다(#901).
- 멈추는 파드는 오래 열린 연결을 닫습니다. 실시간 목록과 따라가는 로그는 남는 파드로 다시 붙고, 터미널은 서버가 다시 시작한다는 줄과 함께 끝납니다(닫힘 코드 1001, `server_shutdown`)(#901).

**데이터베이스**

- 서비스마다 연결이 되면 `SET`으로 `statement_timeout` 30초, `lock_timeout` 15초, `idle_in_transaction_session_timeout` 5분을 둡니다. 마이그레이션은 앞의 둘 없이 돕니다. `0`이면 아무것도 두지 않고 데이터베이스 설정을 따릅니다(#868).
- 서비스별 풀: auth-service 20, session-service 20, k8s-service 10(노드 CPU 수 대신 고정값), ai-service 15, ModelConfig controller 4입니다(#868).
- 새 표나 열: 기록 소유자(#851), 로그아웃한 로그인(#849), 클러스터 버전(#857), 노드 드레인(#858), Claude Code 자리(#859), 조사 재대기(#901)입니다.
- 역할 이름마다 만들어지는 그룹에 고유 인덱스가 생깁니다. 데이터베이스가 다른 역할의 그룹이 되는 이름을 거부합니다(#865).

**Redis**

- 서비스마다 사용자 하나, Secret `kubeast-redis-users`(`kubeast-secrets`처럼 제거해도 남음), `default` 끔입니다(#866).
- `maxmemory`는 `resources.redis.limits.memory`의 80 %이고 정책은 `volatile-lru`라 TTL이 있는 키만 내보냅니다(#866).
- 캐시 키가 `kubeast:cache:` 아래로 옮겨 가고, 클러스터가 바뀌면 Redis 데이터베이스 전체가 아니라 그 키만 지웁니다(#857).

**로그인, 역할, AI**

- 로그아웃하면 서버에서 그 로그인이 끝납니다. 그 토큰은 거부되고 갱신할 수 없습니다(#849).
- 데이터베이스가 다시 시작하는 동안처럼 세션을 읽을 수 없는 토큰은 401 대신 503으로 거절됩니다. 콘솔은 401을 로그아웃으로 읽었지만, 이제 화면은 그대로 있고 다시 묻습니다. auth-service, k8s-service, session-service, ai-service는 `Retry-After`를 함께 보냅니다. auth-service는 곧바로 거절하고, 다른 서비스는 최근 5분 안에 읽은 버전을 먼저 씁니다. API 키의 토큰으로 API를 부르는 스크립트는 0.7.7이 401로 답하던 곳에서 이 503을 받고, 키 교환(`POST /auth/token`)은 키나 그 주인을 읽을 수 없으면 0.7.7의 500이나 401 대신 503으로 답합니다. 키가 거절된 것으로 보지 말고 `Retry-After` 뒤에 다시 보내세요. 지난 버전, 로그아웃한 로그인, 사라진 사용자나 API 키는 그대로 401이고, ai-service의 MCP 끝점은 세션을 읽을 수 없는 동안에도 그대로 401로 답합니다. 세션을 5분 동안 확인하지 못한 실시간 목록이나 터미널은 4401 대신 1013으로 닫힙니다(이유는 둘 다 `session_unverified`). 목록은 다시 붙고 터미널은 Reconnect를 보여 줍니다. 이 503은 `KubeastHighErrorRate` 알림에 셉니다([메트릭](metrics.md))(#953).
- 기본 역할은 정확한 이름(`Pending`, `Member`, `Read`, `Write`, `Admin`)으로만 알아보고, `Pending` 계정 등급도 서비스의 미들웨어, API 키 교환, ai-service, Admin Users 어디서나 정확한 이름으로만 알아봅니다. 다른 역할과 같은 그룹이 되는 역할의 부여, 승인, OIDC 그룹 동기화는 거부됩니다(400 `role_same_group`). 업그레이드 뒤에는 그런 역할이 저장되어 있지 않으므로 이것은 두 번째 확인입니다(#865).
- 역할의 그룹은 ASCII를 전과 같이 두고, 그 밖의 글자는 `~`와 코드 포인트 16진수 네 자리로 적습니다(U+FFFF 위는 `~~`와 여섯 자리). `운영팀`은 `kubeast:role:~c6b4~c601~d300`, `개발팀`은 `kubeast:role:~ac1c~bc1c~d300`입니다. 두 이름은 `A`–`Z` 대소문자·공백·ASCII 기호만 다를 때만 같은 그룹이 됩니다(`Ops 팀`, `OPS-팀`). 역할 창이 이름이 만드는 그룹을 보여 줍니다(#865).
- 차트는 `auth.impersonation.customRoles`의 그룹 대신 이름을 auth-service에 넘기고(`IMPERSONATION_CUSTOM_ROLES`, 이름 안의 쉼표는 `-`), auth-service가 그룹을 직접 만듭니다. 값은 바꾸지 않아도 됩니다(#865).
- auth-service는 시작할 때 `auth.oidc.roleMapping`, `auth.oidc.defaultRole`, `auth.oidc.clusterGroupMapping`, `auth.accessRequests.roles`, `auth.impersonation.customRoles`의 역할 이름 가운데 그 이름 그대로인 역할이 없는 것마다(`customRoles`는 그 그룹이 되는 역할이 없을 때) 경고를 남깁니다. `roleMapping`이나 `defaultRole`이 없는 역할을 적은 로그인은 `oidc_role_missing`으로 실패합니다. 0.7.7에서는 `oidc_provision`이었습니다(#865).
- 기본 역할 이름을 대소문자만 달리 쓴 `auth.accessRequests.roles` 항목(`WRITE`)은 기본 역할(`Write`)을 뜻합니다(#865).
- Claude Code 턴은 데이터베이스의 설치 전체 자리(`maxConcurrentTotal`)를 씁니다. 턴은 자리를 `queueWaitSeconds`까지 기다립니다(#859).
- 알림의 `startsAt`은 보낸 쪽이 어떤 오프셋을 쓰든 UTC로 저장됩니다(#909).
- 차트의 기본 `ai.model`은 `gpt-6-luna`이고, 저장된 모델 설정이 없는 설치는 업그레이드한 때부터 이 모델을 씁니다. `gpt-6-sol`이나 `gpt-6-luna`로 가는 호출은 `reasoning_effort: "none"`을 보냅니다([1.9](#19-기본-ai-모델), #923, #924).

**그 밖**

- 클러스터 요청은 로그인한 사람으로 보내거나 아예 보내지 않습니다. 화면이 여는 서버 버전 · API discovery 읽기(Cluster config의 API 그룹, Cluster Hygiene, 개요의 버전)는 이제 대상 클러스터의 감사 로그에 그 사람 이름으로 남습니다. 기본 RBAC(`system:discovery`)에서는 누구나 같은 답을 받으므로 화면은 바뀌지 않습니다. 문맥에 사람이 없는 요청은 Kubeast 자신의 요청(클러스터마다 두는 서버 버전과 discovery, 상태 확인)이면서 `/version`, `/api`, `/apis`, `/api/v1`, `/apis/<group>/<version>`의 `GET`인 것(#945)이 아니면 보내지 않고, 500으로 답하며 k8s-service가 `cluster request with no person refused`를 로그에 남깁니다. 클러스터 감사 로그에 Kubeast 이름으로 남는 요청은 [클러스터 요구 사항](cluster-requirements.md) §1에 있습니다(#926).
- 클러스터 차단기: `multicluster.breakerConsecutiveFails: 0`이면 차단기를 끕니다. 0.7.7은 이때 실패 하나에 차단기를 열었습니다. 열린 차단기는 `multicluster.breakerOpenSec`(30초)이 지나면 요청 하나를 클러스터로 보내 봅니다. 0.7.7은 이 값을 읽지 않았습니다. 실패는 이제 호출이 API 서버에 닿지 못한 요청(거부됨, 이름을 찾지 못함, TLS 핸드셰이크가 끝나지 않음, 응답 없이 끊긴 연결)입니다. 집계 API의 503, API 서버 자체의 시간 초과, 요청을 보낸 뒤 지난 화면의 기한, 호출 전에 난 Kubeast 자신의 오류로는 더 이상 열리지 않습니다(#930, #932). 클러스터마다 도는 건강 점검 요청은 사람들의 요청 뒤에서 기다리지 않습니다. API 서버가 버전 없이 500 아래로 답한 점검(401, 프록시의 404)은 차단기를 닫고, 클러스터는 그대로 `disconnected`로 보입니다. 자격 증명 플러그인이 실패하면 0.7.7처럼 여전히 차단기가 열립니다(#936).
- k8s-service가 Go 메모리 한도에 맞서 쥔 메모리(살아 있는 힙, 고루틴 스택, 런타임 자체 몫)가 그 한도의 80 %를 넘는 동안 새 실시간 목록은 화면에 안내를 띄우고 기다립니다. 이미 열린 목록은 그대로 돕니다. 있는 객체를 모두 받으며 여는 목록은 시작 전부터 그 객체가 다 지나갈 때까지 서버 전체 8개(`multicluster.wsWatchOpeningConcurrency`)인 자리 하나를 쥡니다. 한 클러스터는 API 서버가 답하기 전까지 하나씩, 답할수록 더 많이, 다른 클러스터가 기다리는 동안 절반까지 잡습니다. 그래서 재시작 뒤에는 몇 개씩 차례로 돌아오고, 답하지 않는 클러스터가 다른 클러스터를 기다리게 하지 않습니다. 자리를 10초 넘게 기다린 목록은 메모리 안내와 따로, 곧 시작한다고 화면에 알립니다. 목록 하나의 HTTP/2 창은 1 MiB입니다(`multicluster.wsWatchStreamWindowKiB`). 이런 목록은 watch list(`sendInitialEvents`)로 묻고, 이를 거절하는 API 서버(기본값으로 1.33, 1.27~1.31)의 클러스터는 예전 watch로 엽니다. 메모리 안내가 자주 보이면 `resources.k8sService.limits.memory`를 올립니다(#896, #931).
- k8s-service가 받은 연결은 보내기 버퍼가 128 KiB입니다. 리눅스는 이를 두 배로 잡고 더 늘리지 않으므로, 커널이 쥘 수 있는 것보다 큰 답은 게이트웨이가 읽어 갈 때까지 k8s-service 안에서 기다립니다. k8s-service가 여는 연결(API 서버, auth-service, 데이터베이스, Redis)은 커널이 정하는 크기 그대로입니다(#994).
- k8s-service는 Go 수집기에 메모리 한도의 85 %를 줍니다(차트의 512 Mi에서 435 MiB). 0.7.7은 90 %(461 MiB)였고, 다른 Go 서비스는 그대로 90 %입니다. 위 실시간 목록의 80 %는 이 한도에 대한 몫이라 348 MiB입니다. k8s-service 환경에 `GOMEMLIMIT`이 있으면 여전히 그 값이 한도입니다(#995).
- 256 KiB를 넘는 노드 목록 · 노드 칸 답과 묶인 읽기의 답은 k8s-service마다 자리 16개 중 하나를 쥐고 64 KiB씩 씁니다. 나머지는 차례를 기다리고, 덩어리 하나에 100 ms를 넘게 걸린 읽는 이는 덩어리 사이에 자리를 내놓으며, 자리를 기다린 시간이 합쳐 1초에 닿은 본문은 남은 것을 자리 없이 씁니다(`kubeast_shared_writes_without_place_total`). 바이트, 상태 코드, 헤더는 그대로이고, 다음 차례를 기다리다 떠난 요청은 연결을 끊습니다(#994).
- 한 계정은 k8s-service 하나(`streams.enabled`면 k8s-service-stream)에 터미널을 `multicluster.maxTerminalsPerAccount`개, 실시간 로그를 `multicluster.maxFollowedLogsPerAccount`개(각 20)까지 열어 둘 수 있습니다. 넘는 것은 열기 전에 실패 감사 행을 남기고 거절합니다. 터미널 소켓은 4429 `terminal_limit`으로 닫히고, 실시간 로그는 200에 이벤트 `stream-limit`을 받고 끝납니다(401이나 429가 아님). API 키를 쓰는 스크립트는 키 주인의 로그인과 함께 세고, 공유 계정 하나로 로그인한 사람들은 그 계정 하나로 셉니다. 로그를 따라가다 스트림의 `retry`를 기다리지 않고 바로 다시 붙는 스크립트는 거절될 때마다 실패 행을 하나씩 남깁니다. `0`이면 상한을 끕니다(#971).
- 감사 앵커의 S3 다이제스트 객체 키 끝에 해시의 앞 16진수 8자리가 붙습니다(`…-<from>-<to>-<hash8>.json`). 다이제스트를 이름으로 읽는 스크립트는 새 꼴도 받게 고칩니다(#852).
- 감사 로그 검색과 그 내보내기, AI Usage 기간, 채팅 목록 API의 `before_updated_at`은 오프셋이 붙은 시각(`+09:00`)을 그것이 가리키는 시각으로 읽습니다. 0.7.7은 그 시계 시각을 UTC로 읽었습니다. 감사 로그 검색과 내보내기는 RFC 3339 시각이 아닌 `since`나 `until`에 400으로 답합니다. 0.7.7은 그 경계를 빼고 읽었습니다. 콘솔은 UTC로 보냅니다(#956).
- 새 차트 객체는 Secret `kubeast-redis-users`, 파드 둘 이상인 서비스의 PodDisruptionBudget, 그리고 켰을 때 HPA와 `k8s-service-stream`의 Deployment·Service·PodDisruptionBudget·NetworkPolicy입니다. 새 ClusterRole이나 Role은 없습니다.

## 5. 이번 업그레이드에서 한 번 일어나는 일

- **역할 이름 바뀜**(#865). 기본 역할의 그룹(`ADMIN`, ` read `, `PENDING`)이나 다른 역할의 그룹(`a b` 옆의 `a-b`, `Ops 팀` 옆의 `OPS-팀`)이 되는 이름의 사용자 정의 역할은 `<이름>-renamed-<id>`로 이름이 바뀝니다. 한 그룹의 역할들 가운데 기본 역할, 없으면 가장 오래된 역할이 이름을 지킵니다. 글자 수가 같은 한글 이름은 서로 다른 그룹이라 이름을 지킵니다. 이름이 바뀐 역할은 클러스터 부여와 열린 접근 요청을 잃습니다. 그 역할의 부여는 지워지고(임시 부여는 되돌릴 역할로 돌아감), 그 역할로 돌아갈 임시 부여는 끝날 때 돌아갈 역할 없이 끝나며, 대기 중이거나 승인된 요청은 `role_renamed`로 끝납니다. 부여가 바뀐 사람과 계정 등급이 그런 역할인 계정은 다시 로그인합니다. 계정 등급은 바뀐 이름의 역할로 남지만, `Pending` 그룹의 역할(`PENDING`)은 예외로 기본 `Pending`으로 옮겨지고(아직 없으면 그때 저장) 계속 승인을 기다립니다. 바뀐 것마다 `system` / `migration`이 남긴 감사 행이 있습니다(`admin.roles.update`, `user.cluster_role.unset`, `access.request.expire`, `user.role.update`). 그 뒤로는 데이터베이스가 그런 이름을 거부합니다. 다음에 할 일은 [6](#6-업그레이드한-뒤)에 있고, 자세한 내용은 [기능](features.md)의 "역할 이름"에 있습니다.
- **ASCII가 아닌 역할 이름의 새 그룹**(#865). 이름에 ASCII가 아닌 글자가 든 사용자 정의 역할은 클러스터에서 새 그룹으로 동작하고(`운영팀`: `kubeast:role:---` → `kubeast:role:~c6b4~c601~d300`), 옛 그룹에 바인딩한 RBAC는 새 그룹을 바인딩할 때까지 그 역할에 적용되지 않습니다([6](#6-업그레이드한-뒤)). 그런 이름이 `auth.impersonation.customRoles`에 있으면 Kubeast가 도는 클러스터에서는 업그레이드가 옛 그룹의 바인딩을 새 그룹의 바인딩으로 바꿉니다. 다른 등록 클러스터에는 0.7.8 렌더를 적용할 때까지 옛 바인딩이 남습니다.
- **PostgreSQL이 한 번 다시 시작함**(#868). 파드가 이제 `max_connections`를 받아 시작하므로 새 파드가 뜨는 동안 데이터베이스가 멈춥니다. 다시 뜰 때까지 쓰기와 민감한 읽기는 데이터베이스가 다시 시작할 때마다 그렇듯 503 `audit unavailable`을 답합니다.
- **Redis와 k8s-service가 다시 시작하고 캐시가 비어서 시작함**(#866, #857). 0.7.7 k8s-service 파드가 사라질 때까지 그 파드가 새 Redis에 보내는 요청은 거부되고 캐시 미스로 처리됩니다.
- **다른 시간대를 쓰는 곳에서 온 알림**(#909). 0.7.7까지는 `startsAt`의 오프셋을 버렸습니다. 업그레이드 뒤에도 울리는 그런 알림은 받은 편지함에 새 행이 생기고, 옛 행은 `inbox.staleAfterHours`가 지나면 Status unknown이 됩니다.
- **중간에 끊긴 드레인**(#858). 0.7.7 k8s-service가 멈출 때 돌던 드레인은 노드를 cordon된 채 두고, 뒤에 화면에 나오지 않습니다. `kubectl uncordon <node>`를 하거나 다시 드레인합니다.
- **진행 중이던 세션 기록**(#851). 0.7.7 파드가 쓰던 기록에는 소유자가 없습니다. 0.7.8 파드는 처음 5분 동안 그 기록을 두었다가 가져가며, 스풀 파일을 갖고 있으면 올리고 없으면 interrupted로 표시합니다.
- **Claude Code 자리**(#859). 롤링 업데이트의 몇 분 동안 0.7.7 ai-service 파드는 설치 전체 자리를 세지 않으므로 합계가 `maxConcurrentTotal`을 넘을 수 있습니다.
- **새로 고치지 않은 페이지**(#952). 열어 둔 0.7.7 페이지는 다시 불러올 때까지, 여는 자리를 기다리는 실시간 목록을 탭의 한도로 보여 줍니다.

## 6. 업그레이드한 뒤

```bash
helm list -n kubeast                 # CHART kubeast-0.7.8
kubectl -n kubeast get pods          # 모든 파드가 Running이고 준비됨
helm get notes kubeast -n kubeast    # 1.2에서 본 설치 안내
```

**이름이 바뀐 역할**(#865). 감사 로그에 역할마다 `system` / `migration`이 남긴 `admin.roles.update` 행이 있고, 아래 명령이 그 역할을 보여 줍니다.

```bash
kubectl -n kubeast exec deploy/postgres -c postgres -- \
  psql -U kubeast -d kubeast -c "SELECT id, name FROM roles WHERE name LIKE '%-renamed-%' ORDER BY id"
```

마이그레이션이 도는 동안에도 0.7.7 파드가 요청을 받습니다. 마이그레이션이 커밋하기 직전에 그 파드가 쓴 부여는 바뀐 이름의 역할에 남습니다.
업그레이드 직후, 누군가 바뀐 역할을 다시 부여하기 전에 아래 명령([설치와 첫 설정](getting-started.md#업그레이드)의 "업그레이드"에 있는 쿼리)으로 그런 부여를 볼 수 있습니다. 보통은 아무것도 나오지 않습니다. 나온 부여는 그 역할이 필요하지 않으면 Cluster access에서 지웁니다.

```bash
kubectl -n kubeast exec -i deploy/postgres -c postgres -- psql -U kubeast -d kubeast <<'SQL'
SELECT g.user_id, g.cluster_id, r.name
  FROM user_cluster_roles g JOIN roles r ON r.id = g.role_id
 WHERE r.id IN (SELECT target_id::int FROM auth_audit_logs
                 WHERE actor_user_id = 'system' AND actor_email = 'migration' AND action = 'admin.roles.update');
SQL
```

- 이름이 바뀐 역할이 아직 필요하면 그 클러스터에 다시 부여합니다. 누구에게 줄지는 [1.5](#15-역할-이름)에서 적어 둔 목록에 있습니다. 새 이름은 이미 유일하므로 먼저 이름을 고칠 필요는 없습니다.
- 계정 등급이 이름이 바뀐 역할이던 계정은 다시 로그인하고 그 역할을 유지합니다. `Pending` 그룹의 역할이던 계정은 예외로 이제 기본 `Pending`에 있고, 전처럼 Admin → Users에서 승인을 기다립니다. `Pending` 계정 등급은 어디서나 정확한 이름으로만 알아봅니다.

**역할 이름을 적는 차트 설정**(#865). auth-service는 시작할 때 설정이 적은 역할 이름 가운데 그 이름 그대로인 역할이 없는 것마다(`auth.impersonation.customRoles`는 그 그룹이 되는 역할이 없을 때) 설정, 역할, 그 결과(`outcome`), 이름이 만드는 그룹의 역할(`same_group_as`)과 함께 경고를 남깁니다.

```bash
kubectl -n kubeast logs deploy/auth-service | grep 'a chart setting names a role not stored as written'
```

바꾸기 전까지, 이름이 바뀐 역할을 옛 이름으로 적은 설정은 다음과 같이 됩니다.

- `auth.oidc.roleMapping`, `auth.oidc.defaultRole`: 그 설정이 적용되는 사람의 로그인이 `oidc_role_missing`으로 실패합니다([OIDC](oidc.md) §6).
- `auth.oidc.clusterGroupMapping`: 그 클러스터 부여만 로그에 경고를 남기고 건너뛰며, 로그인은 계속됩니다.
- `auth.accessRequests.roles`: 기본 역할 이름을 대소문자만 달리 쓴 항목(`WRITE`)은 기본 역할(`Write`)을 뜻합니다. 기본 역할의 권한은 이름이 바뀐 사용자 정의 역할보다 넓을 수 있습니다. 그 밖의 옛 이름은 `Unknown role`로 거절됩니다.
- `auth.impersonation.customRoles`: 차트는 이름이 만드는 그룹을 바인딩합니다. 그 그룹은 이제 이름을 지킨 역할이 갖거나, 어떤 역할에도 붙지 않습니다.

각 설정을 뜻한 역할의 이름으로 바꾸고 `--reset-then-reuse-values`로 다시 업그레이드합니다.

**ASCII가 아닌 역할 이름의 그룹**(#865). 역할 관리의 역할 창이 각 역할이 이제 만드는 그룹을 보여 줍니다.
등록한 클러스터마다 그 그룹을 ClusterRole `kubeast-impersonator`에 넣고, 옛 그룹을 바인딩했던 곳([1.5](#15-역할-이름)에서 나열한 바인딩)에 바인딩합니다. 둘 다 [클러스터 요구 사항](cluster-requirements.md) §1에 있습니다.
`auth.impersonation.customRoles`의 이름은 Kubeast가 도는 클러스터를 뺀 등록 클러스터마다 0.7.8 렌더(`scripts/render-target-rbac.sh`)를 적용하고, 거기 남은 옛 그룹의 바인딩(`kubeast-role-<옛 slug>-<ClusterRole>`, `view`에 바인딩한 `운영팀`이면 `kubeast-role-----view`)을 지웁니다. `helm upgrade`는 Kubeast가 도는 클러스터에서만 그 바인딩을 바꿨습니다.

**cordon된 노드**(#858). 등록한 클러스터마다 `kubectl get nodes`를 보고, 끊긴 드레인이 cordon된 채 남긴 노드는 `kubectl uncordon <node>`로 풉니다.

**`kubeast-impersonator`의 `kube-system` 읽기**(#970). Kubeast가 도는 클러스터를 뺀 등록 클러스터마다 RBAC을 다시 적용합니다(`helm template kubeast helm/kubeast -s templates/impersonation-rbac.yaml | kubectl --context <cluster> apply -f -`, [클러스터 요구 사항](cluster-requirements.md) §1). 이제 이 ClusterRole로 자격 증명이 `kube-system` Namespace를 읽을(get) 수 있고, 그 UID로 한 클러스터의 두 번째 등록과 등록된 클러스터에 다른 클러스터의 kubeconfig를 주는 것을 거절합니다.
UID 없이 등록된 클러스터는 다음에 UID를 읽을 수 있는 자격 증명의 kubeconfig로 바꿀 때 UID를 얻습니다. 그 전까지는 그 클러스터를 다시 등록해도 거절하지 않습니다.

**Redis 사용자**(#866). `secrets.existingSecret`을 쓰면 사용자를 켤 때까지 Redis가 비밀번호 하나로 돈다고 설치 안내가 알려 줍니다([1.7](#17-secretsexistingsecret과-redis-사용자)).

## 7. 0.7.7로 되돌리기

```bash
helm history kubeast -n kubeast                        # 0.7.7의 revision
helm rollback kubeast <revision> -n kubeast
```

- **데이터베이스**: 0.7.8의 표와 열은 남고 0.7.7은 그대로 시작합니다. 0.7.7의 마이그레이션은 앞선 데이터베이스에서 적용할 것을 찾지 못하고, 서비스는 스키마 22 이상을 기다립니다.
- **역할**(#865): 바뀐 이름, 지워진 부여, `Pending`으로 옮겨진 계정 등급은 그대로 남고, 다른 역할의 그룹이 되는 이름을 거부하는 인덱스도 남습니다. [1.10](#110-데이터베이스-백업)의 덤프를 복원해야만 옛 이름과 부여가 돌아오며, 그러면 데이터베이스 전체가 그 시점으로 돌아갑니다.
- **역할 그룹**(#865): 0.7.7은 옛 그룹을 다시 만들므로(`운영팀`은 `kubeast:role:---`로 동작) 새 그룹에 만든 바인딩은 0.7.7에서 적용되지 않습니다.
- **로그아웃**(#849): 0.7.7의 auth-service는 로그아웃한 로그인을 읽지 않으므로, 로그아웃한 로그인의 토큰도 만료될 때까지(`auth.tokenTTLMinutes`, 기본 15분) 다시 받아들입니다.
- **Redis**(#866): 0.7.7의 Redis가 비밀번호 하나(`REDIS_PASSWORD`, `kubeast-secrets`에 그대로 있음)로 돌아오고, 그 k8s-service가 그 비밀번호로 로그인합니다. 그 Redis가 답하기 전에 뜬 0.7.7 k8s-service 파드는 다시 시작할 때까지 메모리에 캐시합니다. `kubeast-redis-users`는 남고(`helm.sh/resource-policy: keep`), 다음 업그레이드가 그 비밀번호를 다시 읽습니다.
- **PostgreSQL**(#868)은 한 번 더 다시 시작하고 `max_connections` 100으로 돌아갑니다.
- **PodDisruptionBudget과 HPA**는 0.7.7의 값에 따라 사라집니다(#901, #867).
- **알림**(#909): 0.7.7은 `startsAt`의 오프셋을 다시 버리므로, 다른 시간대를 쓰는 곳에서 온 알림은 다시 새 행이 생깁니다.
- **드레인**(#858): 되돌릴 때 돌던 드레인은 그 자리에서 끝나고 노드는 cordon된 채 남습니다. 0.7.7은 `node_drains`를 읽지 않습니다.
- **AI 모델**(#923, #924): 0.7.7은 `reasoning_effort`를 보내지 않으므로, `gpt-6-luna`로 바꾼 설정의 도구 호출은 0.7.7에서 모두 거절됩니다. 되돌리기 전에 그런 설정을 0.7.7이 쓸 수 있는 모델로 돌려 둡니다.

## 8. Docker Compose

내려받은 폴더에서 올립니다. 스크립트는 `.env`의 비밀번호와 키를 그대로 두지만 `--port`(빼면 8000)를 `.env`에 쓰므로, 지금 쓰는 Gateway 포트를 줍니다.

```bash
cd Kubeast
docker compose exec -T postgres pg_dump -Fc -U kubeast kubeast > kubeast-before-0.7.8.dump
git fetch --tags && git checkout v0.7.8
./install-docker.sh --port <지금 포트>
```

`KUBEAST_TAG`를 정해 두었다면 `v0.7.8`로 바꾸거나 지웁니다.

차트와 다른 점은 다음과 같습니다.

- **멈출 때 기다림**: Kubeast 서비스 일곱 개에 멈출 시간을 35초, Redis와 PostgreSQL에 Kubernetes 기본값인 30초를 줍니다(`stop_grace_period`. Docker 기본값은 10초). 기본값일 때 차트가 각각에 주는 시간입니다. `docker compose stop`과 업그레이드는 컨테이너마다 그만큼 걸릴 수 있습니다. `preStop` 기다림, 터미널 드레인, PodDisruptionBudget, HPA는 없습니다(#856).
- **Redis**: 전과 같이 사용자도 비밀번호도 없고 Compose 네트워크 안에서만 닿습니다(#866은 차트만 바꿉니다).
- **AI 모델**(#921, #924): `install-docker.sh`를 다시 돌려도 `.env`에 이미 있는 `OPENAI_MODEL`과 `OPENAI_BASE_URL`은 그대로 두고, 0.7.7 이하가 쓴 `.env`에는 `gpt-4o-mini`가 있습니다. 2027-01-14 전에 바꿉니다. `ai.model`처럼 저장된 설정이 없을 때만 모델을 정하므로, 그 값으로 만든 `default-openai` 설정은 **Admin > AI Models**에서 바꿉니다([1.9](#19-기본-ai-모델)). `.env`가 없으면 이제 `gpt-6-luna`를 씁니다. 0.7.7은 OpenAI가 종료한 `gpt-4`를 썼습니다. `KUBEAST_TAG`를 v0.7.7 이하로 두면 `OPENAI_MODEL`도 그 이미지가 쓸 수 있는 모델로 둡니다. 그 이미지는 `reasoning_effort`를 보내지 않아 `gpt-6-luna`로 가는 도구 호출이 모두 거절됩니다.
- **데이터베이스 한도**: 같은 세션 한도와 풀이 기본으로 적용됩니다. 바꾸려면 `.env`에 `DB_STATEMENT_TIMEOUT_MS`, `DB_LOCK_TIMEOUT_MS`, `DB_IDLE_IN_TRANSACTION_TIMEOUT_MS`(`0`이면 두지 않음)나 `DB_POOL_MAX_AUTH`, `DB_POOL_MAX_SESSION`, `DB_POOL_MAX_K8S`, `DB_POOL_MAX_AI`를 넣습니다. Compose의 PostgreSQL은 기본 `max_connections`(100)를 그대로 쓰며, 서비스마다 컨테이너 하나면 그 안에 들어갑니다(#868).
- **사용자 정의 역할 바인딩**: `.env`의 `IMPERSONATION_CUSTOM_ROLES`는 전과 같이 역할 이름을 받습니다. ASCII가 아닌 이름의 새 그룹은 클러스터에 바인딩합니다([6](#6-업그레이드한-뒤)).
- **차트와 같은 것**: 마이그레이션, 역할 이름 바꾸기([1.5](#15-역할-이름)와 [6](#6-업그레이드한-뒤)의 쿼리는 `kubectl -n kubeast exec -i deploy/postgres -c postgres -- psql -U kubeast -d kubeast` 대신 `docker compose exec -T postgres psql -U kubeast -d kubeast`로 돌림), 알림 시간의 UTC 저장, 캐시가 비어서 시작하는 것, 드레인([1.4](#14-노드-드레인))은 차트와 같습니다.
- **되돌리기**: `git checkout v0.7.7 && ./install-docker.sh --port <지금 포트>`를 씁니다. Redis를 빼면 [7](#7-077로-되돌리기)의 내용이 그대로 적용됩니다.
