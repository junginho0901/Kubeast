[English](../high-availability.md) | **한국어**

# 여러 대로 띄우기 (Running more than one replica)

Kubeast의 서비스는 기본으로 하나씩 파드 1개로 뜹니다.
이 문서는 어느 서비스를 여러 대로 띄울 수 있는지, 그때 무엇이 필요한지, 대수를 직접 정하거나 HorizontalPodAutoscaler(HPA)에 맡기는 방법, 그리고 콘솔을 쓰는 사람에게 무엇이 달라지는지를 설명합니다.

## 어느 서비스를 여러 대로 띄울 수 있나

| 서비스 | 2대 이상 | 파드가 들고 있는 것 | 필요한 것 |
| --- | --- | --- | --- |
| gateway | 됨 | 없음. WebSocket은 처음 연 업스트림 연결에 계속 붙어 있습니다 | — |
| frontend | 됨 | 없음(정적 파일) | — |
| auth-service | 됨 | 없음. 배경 작업은 데이터베이스 잠금으로 차례를 정하고, 보존 기간 정리는 다른 파드가 먼저 돌았으면 지울 것이 없습니다 | `migrations.mode: job`(아래) |
| session-service | 됨 | 없음. 세션과 메시지는 데이터베이스에 있습니다 | — |
| ai-service | 됨 | 답 스트림. 대기 중인 알림 조사는 데이터베이스 행이고 한 파드가 가져갑니다. Claude Code 실행 수에는 파드당 상한(`ai.providers.claudeCode.maxConcurrent`)과 설치 전체 상한이 있습니다 | — |
| k8s-service | Redis가 있으면 됨 | 맡은 클러스터의 목록과 감시(자기 메모리). 목록 · YAML · Helm 캐시는 Redis에 있습니다. 클러스터가 바뀌면 10초 안에 모든 파드가 압니다. 노드 드레인 진행은 데이터베이스에 있습니다 | `redis.enabled: true` |
| tool-server | Redis가 있으면 됨 | 클러스터의 kubeconfig를 길어야 10초. 클러스터가 바뀐 것을 Redis로 듣습니다 | `redis.enabled: true` |
| ModelConfig controller | 안 됨, 1대 | 없음. 한 번에 한 파드만 일하므로(리더 선출) 차트는 1대를 띄웁니다 | — |
| postgres(차트 내장) | 안 됨, 1대 | 데이터 | 노드가 죽어도 남는 데이터베이스가 필요하면 바깥 PostgreSQL을 쓰세요(`postgresql.enabled: false`) |
| redis(차트 내장) | 안 됨, 1대 | 캐시와 바뀜 알림뿐. 새 파드는 비어서 시작하고 캐시는 다시 찹니다 | — |

`redis.enabled: false`인데 `replicas.k8sService`나 `replicas.toolServer`가 1보다 크면 차트가 까닭을 말하고 설치를 막습니다.
`values-minimal.yaml`은 Redis를 끄므로 모두 1대입니다.

## 시작하기 전에

- **Redis**: k8s-service나 tool-server를 2대 이상 띄우려면 `redis.enabled: true`(차트 기본값)를 그대로 두세요.
- **노드**: 차트는 한 서비스의 파드를 영역(zone)과 노드에 나눠 놓습니다(`topologySpread.enabled`). 강제가 아니라 권장(`ScheduleAnyway`)이라, 파드 2개가 노드 2개에 가려면 받을 수 있는 노드가 2개 있어야 합니다. 노드가 1개면 같은 노드에 갑니다.
- **마이그레이션**: auth-service를 2대 이상 띄우거나 데이터베이스가 크면 `migrations.mode: job`으로 두세요. `startup`이면 같이 뜬 파드들이 마이그레이션 잠금을 서로 기다리고, 기다림이 시작 확인(startup probe) 180초를 넘으면 기다리던 파드가 재시작됩니다.
- **로드 밸런서**: 파드 IP로 보내는 로드 밸런서(IP 모드의 AWS Load Balancer Controller) 뒤라면 네임스페이스에 `elbv2.k8s.aws/pod-readiness-gate-inject: enabled` 라벨을 붙여, 새 파드가 대상으로 정상이 된 뒤에만 요청을 받게 하세요. `podShutdown.preStopSeconds`는 해제 지연(deregistration delay)에 몇 초를 더한 값으로 두세요(docs/ko/configuration.md).
- **데이터베이스 연결**: 파드마다 자기 연결 풀을 엽니다. 띄울 파드 수를 아래 표에 곱해 더하고, 합이 데이터베이스의 `max_connections`보다 작게 하세요.

| 서비스 | 파드당 연결, 최대 | 수의 근거 |
| --- | --- | --- |
| auth-service | 20 | `postgresql.pool.authService.maxConns` |
| session-service | 20 | `postgresql.pool.sessionService.maxConns` |
| k8s-service | 10, 더하기 1 | `postgresql.pool.k8sService.maxConns`와, 풀 밖에서 연결을 따로 하나 쥐는 상태 확인 잠금(`internal/pglock`). k8s-service-stream은 풀만 |
| ai-service | 15 | `postgresql.pool.aiService.maxConns` |
| ModelConfig controller | 4 | `postgresql.pool.modelConfigController.maxConns`. 1대 |
| 마이그레이션 | 도는 동안 4 | 마이그레이션 풀(`dbsession.MigrationPoolMaxConns`) |
| tool-server, frontend, gateway | 0 | — |

차트 내장 postgres는 `max_connections`를 `postgresql.maxConnections`(300)로 두고, 파드들이 그보다 많이 쥘 수 있으면 설치가 멈춥니다. 셈은 풀마다 배포 중의 파드 수(Deployment마다 `maxSurge`가 1이라 개수에 하나 더함, autoscaling을 켰으면 `maxReplicas`에 하나 더함)를 곱해 더하고, 마이그레이션 4와 psql·PostgreSQL superuser 몫 10을 더합니다(`templates/checks/db-connections.yaml`).
바깥 데이터베이스는 자기 한도를 쓰고, 차트는 그 값을 읽지 못합니다. NOTES가 같은 합을 적어 주니 그 값과 견주세요. Kubeast 사용자가 superuser가 아니면 그중 3개는 기본으로 superuser 몫입니다.
예: 서비스마다 1대면 배포 중의 여분 파드까지 최대 154개, 서비스마다 3대면 286개입니다.
`postgresql.maxConnections`를 올리거나, 풀이나 파드 수를 줄이거나, 연결을 더 받는 데이터베이스를 쓰세요.

## 대수 정하기

```yaml
replicas:
  k8sService: 2
  toolServer: 2
  gateway: 2
  frontend: 2
```

- `pdb.enabled`(기본 켜짐)는 2대 이상으로 돌거나 autoscaling의 `minReplicas`가 2 이상인 서비스마다, 한 번에 `pdb.maxUnavailable`개(1)까지 내보낼 수 있는 PodDisruptionBudget을 만듭니다. 1대인 서비스에는 만들지 않아 드레인을 막지 않습니다.

## HPA에 대수 맡기기

```yaml
autoscaling:
  k8sService:
    enabled: true
    minReplicas: 2
    maxReplicas: 3
    targetCPUUtilizationPercentage: 80
```

- 켠 서비스마다 `autoscaling/v2` HorizontalPodAutoscaler 하나. 기본은 꺼짐입니다. 키는 `replicas`의 키와 같습니다.
- 켜져 있는 동안 차트는 그 Deployment에서 `spec.replicas`를 뺍니다. HPA와 차트가 대수를 번갈아 바꾸지 않게 하려는 것입니다. `replicas.<서비스>`는 읽지 않습니다.
- CPU로만 늘리고 줄이며, `resources.<서비스>.requests.cpu`에 대한 비율로 봅니다. CPU requests가 없는 서비스의 autoscaling은 차트가 막습니다. 그러면 HPA가 아무것도 하지 않기 때문입니다.
- 메모리 목표는 없습니다. k8s-service 파드는 맡은 클러스터의 목록을 저마다 들고 있어서, 파드를 늘려도 파드당 메모리가 줄지 않습니다.
- 80은 Kubernetes 자체의 기본 목표값입니다. 설치에 맞는 값은 부하 시험으로 정하세요.
- k8s-service나 tool-server의 `maxReplicas`가 1보다 크면 `replicas`와 같이 `redis.enabled: true`가 필요합니다.
- 클러스터에 metrics-server가 있어야 합니다(있으면 `kubectl top pods`가 답합니다).
- HPA는 새 파드가 준비(ready)될 때까지 그 CPU를 셈에서 뺍니다. k8s-service 파드가 처음 목록을 읽느라 쓰는 CPU는 들어가지 않습니다.

`behavior`는 적은 그대로 HPA에 들어갑니다. 비우면 Kubernetes 기본대로 사용량이 300초 동안 낮을 때 줄입니다.
나가는 파드는 자기가 쥔 WebSocket을 닫으므로, k8s-service는 더 천천히 줄이고 싶을 수 있습니다. 예:

```yaml
autoscaling:
  k8sService:
    enabled: true
    behavior:
      scaleDown:
        stabilizationWindowSeconds: 600
        policies:
          - type: Pods
            value: 1
            periodSeconds: 300
```

돌고 있는 릴리스에서 autoscaling을 켜면 Deployment에서 `spec.replicas`가 빠집니다.
그러면 HPA가 처음 맞출 때(기본 15초마다)까지 Kubernetes가 대수를 기본값 1로 두어, 파드 하나만 남고 나머지가 멈추기 시작합니다.
한가한 때 켜거나, Kubernetes HPA 문서의 "Migrating Deployments and StatefulSets to horizontal autoscaling"을 먼저 따르세요.
끄면 `replicas.<서비스>` 값으로 돌아갑니다.

`kubectl -n <네임스페이스> get hpa`로 확인합니다.

## 2대 이상이면 달라지는 것

- 세션 고정이 필요 없습니다. 어느 파드든 어느 요청에나 답하고, 게이트웨이와 앞단 로드 밸런서에 session affinity를 둘 필요가 없습니다.
- WebSocket(실시간 목록, 터미널)은 연 파드에 계속 붙어 있습니다. 그 파드가 나가면(판 올리기, 대수 줄이기, 노드 드레인) 브라우저가 다시 붙고 목록을 다시 읽습니다. 따라가던 로그는 마지막으로 보인 줄 다음부터 이어집니다. 터미널은 1대일 때 재시작하면 그렇듯 끝납니다.
- k8s-service 파드는 저마다 클러스터를 감시하므로, 두 파드에 간 두 요청이 잠깐 감시 이벤트 하나만큼 다를 수 있습니다.
- k8s-service 파드는 읽은 정책 보고서를 자기 메모리에 60초 동안 둡니다. 새 정책 보고서가 다른 파드에서 읽은 드로어나 목록에 보이기까지 1분까지 걸릴 수 있습니다. Policy Reports 화면의 Refresh는 요청이 닿은 파드에서 새로 읽습니다.
- k8s-service 파드는 맡은 클러스터를 저마다 목록으로 읽고 감시합니다. API 서버는 이것을 파드 수만큼 받습니다.
- k8s-service 파드 하나의 메모리는 1대일 때와 같고, 합은 파드 수만큼 늡니다.
- k8s-service 파드는 Cluster View의 노드 칸을 저마다의 informer로 답하고, 모든 네임스페이스를 볼 수 있는 사람에게 준 답을 들고 있습니다. 노드 256개와 답 8 MiB(파드당 약 300바이트)까지이고, 파드 행은 들고 있지 않습니다. 한 노드의 칸은 그 노드의 파드가 그대로인 동안 k8s-service 파드마다 한 번 만듭니다.
- 파드를 지키는 한도(메모리, 동시 작업, 실시간 감시 `multicluster.wsMaxSubscriptions`와 그 열기 `multicluster.wsWatchOpeningConcurrency`)는 파드마다입니다. 클러스터로 보내는 요청 속도(`multicluster.clientQPS`)도 파드마다라, N대면 N배까지 보낼 수 있습니다.

## 크기 표

아래 칸은 [아키텍처](architecture.md#많은-사람이-큰-클러스터를-쓸-때)의 "많은 사람이 큰 클러스터를 쓸 때"와 같은 방식으로 잰 부하 시험으로 채웁니다.
그때까지는 그곳의 1대 값을 파드 수만큼 곱해 보세요.

| k8s-service 파드 | 파드당 메모리, 평소 / 바쁠 때 | 메모리 합 | API 서버가 Kubeast에 쥔 감시 수 | 500명 평소 사용 p95 | 판 올리기 동안 200이 아닌 답 |
| --- | --- | --- | --- | --- | --- |
| 1 | [자원 사용량](architecture.md#자원-사용량), [많은 사람이 큰 클러스터를 쓸 때](architecture.md#많은-사람이-큰-클러스터를-쓸-때) | 같음 | 잴 것 | 잴 것 | 잴 것 |
| 2 | 잴 것 | 잴 것 | 잴 것 | 잴 것 | 잴 것 |
| 3 | 잴 것 | 잴 것 | 잴 것 | 잴 것 | 잴 것 |
