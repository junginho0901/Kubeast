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
| redis(차트 내장) | 안 됨, 1대 | 캐시와 바뀜 알림뿐. 새 파드는 비어서 시작하고 캐시는 다시 찹니다. Redis가 답하지 않는 동안 k8s-service의 화면은 클러스터에서 읽습니다. 캐시 명령은 0.5초 안에 그만두고, 그 뒤 3초 동안 캐시는 Redis를 건너뜁니다. Redis가 받지 못한 캐시 항목 지우기는 캐시가 Redis를 다시 읽기 전에 통째로 비워서 메웁니다 | — |

`redis.enabled: false`인데 `replicas.k8sService`나 `replicas.toolServer`가 1보다 크면 차트가 까닭을 말하고 설치를 막습니다.
`sessionRecording.storage: file`인데 k8s-service가 2대 이상이어도(1보다 큰 `replicas.k8sService`, 또는 `maxReplicas`가 1보다 큰 `autoscaling.k8sService`) 막습니다. 모든 파드가 파일 볼륨 하나를 붙이게 되므로 `s3`나 `database`에 녹화하세요(파일 저장소의 배포 때 모습은 [운영](operations.md#터미널과-실시간-로그를-따로-맡는-서버)에 있습니다).
`values-minimal.yaml`은 Redis를 끄므로 모두 1대입니다.

## 시작하기 전에

- **Redis**: k8s-service나 tool-server를 2대 이상 띄우려면 `redis.enabled: true`(차트 기본값)를 그대로 두세요.
- **노드**: 차트는 한 서비스의 파드를 영역(zone)과 노드에 나눠 놓습니다(`topologySpread.enabled`). 강제가 아니라 권장(`ScheduleAnyway`)이라, 파드 2개가 노드 2개에 가려면 받을 수 있는 노드가 2개 있어야 합니다. 노드가 1개면 같은 노드에 갑니다.
- **마이그레이션**: auth-service를 2대 이상 띄우거나 데이터베이스가 크면 `migrations.mode: job`으로 두세요. `startup`이면 같이 뜬 파드들이 마이그레이션 잠금을 서로 기다리고, 기다림이 시작 확인(startup probe) 180초를 넘으면 기다리던 파드가 재시작됩니다.
- **로드 밸런서**: 파드 IP로 보내는 로드 밸런서(IP 모드의 AWS Load Balancer Controller) 뒤라면 네임스페이스에 `elbv2.k8s.aws/pod-readiness-gate-inject: enabled` 라벨을 붙여, 새 파드가 대상으로 정상이 된 뒤에만 요청을 받게 하세요. `podShutdown.preStopSeconds`는 로드 밸런서가 떠나는 파드에 새 요청을 그만 보낼 때까지보다 길게 두세요(docs/ko/configuration.md). AWS Application Load Balancer 뒤에서는 `podShutdown.preStopSeconds: 25`와 대상 그룹 등록 해제 지연(deregistration delay) 20초(`ingress.annotations`에 `alb.ingress.kubernetes.io/target-group-attributes: deregistration_delay.timeout_seconds=20`, 거기 이미 적힌 다른 속성이 있으면 그 뒤에 덧붙임)를 쓰세요. 이 값으로 게이트웨이 파드가 하나일 때와 둘일 때, 이틀에 걸쳐 게이트웨이 파드를 18번 바꾸는 동안 실패한 요청이 없었고, 서비스마다 파드 2개로 노드 하나를 한 번 비울 때도 없었습니다(이때 내보낸 것은 Kubeast 파드뿐이었음). 기본값으로 비울 때는 요청이 실패했지만, 그 노드에는 AWS Load Balancer Controller의 하나뿐인 파드도 있었고 게이트웨이 대상은 파드를 지운 뒤 38초가 지나서야 draining이 되었습니다([EKS에서 잰 것](#eks에서-잰-것)). 컨트롤러 파드는 둘 이상 두세요(컨트롤러 Helm 차트의 기본 `replicaCount`는 2). 하나면 그 파드가 내보내진 때부터 다른 노드에서 다시 뜰 때까지 로드 밸런서 대상이 갱신되지 않습니다. 기본값(5초, 해제 지연 300초)에서는 18번 중 3번(준비 게이트를 켜고 12번 더 바꿀 때는 없었음), 떠나는 게이트웨이 파드의 대상이 이미 draining인데도 로드 밸런서가 그 파드의 기다림이 끝난 뒤에도(파드를 지운 뒤 약 8초까지) 새 요청을 보냈고, 그 2~3초 동안 요청의 3분의 1에서 절반이 502나 504로 실패했습니다. 준비 게이트가 있을 때는 정상인 게이트웨이 대상이 없던 초가 없었습니다(EKS 1.35, AWS Load Balancer Controller v3.6.2).
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
예: 서비스마다 1대면 배포 중의 여분 파드까지 최대 154개, 서비스마다 3대면 286개입니다. `streams.enabled`를 켜면 스트림 서버와 그 여분 파드 몫으로 k8s-service 풀이 더해져(기본 20) 서비스마다 3대면 306개로 기본 300을 넘습니다.
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
- 1대로 도는 서비스는 그 파드가 지워지거나 내보내질 때(노드 드레인 포함) preStop 대기가 끝난 때부터 새 파드가 Ready가 될 때까지 받을 파드가 없습니다. rollout과 달리 지워진 파드는 새 파드를 먼저 띄우지 않기 때문입니다. kind 실측으로 auth-service · k8s-service · session-service는 약 1초입니다. ai-service · frontend · gateway는 시작 확인(startup probe)을 1초마다 묻기 때문에(`podStartup.quickReady`, docs/ko/configuration.md) 새 파드가 포트를 연 뒤 약 1초에 Ready가 됩니다. `podStartup.quickReady: false`로 readiness를 10초마다 물으면 약 6초였습니다(새 파드가 뜨기 전에 첫 probe가 오면 약 16초). 그동안 화면은 502 · 503 · 504를 받습니다. 2대 이상이면 새 파드가 뜨는 동안 나머지가 답하고, PDB가 드레인이 그 파드들을 한꺼번에 내보내지 않게 합니다.

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
- 노드 셸 파드는 그것을 연 k8s-service 파드와 함께 데이터베이스(`node_shells`)에 적히고, 연 파드가 노드 셸을 연 동안 풀에서 하나 떼어 둔 연결로 15초마다 살아 있음을 적습니다. 그 파드가 죽으면(메모리 부족, 노드 잃음) 1분 동안 그렇게 적히지 않은 행을 다른 k8s-service 파드나 같은 파드에서 다시 뜬 컨테이너가 30초마다 찾아 그 셸 파드를 지웁니다. 살아 있고 데이터베이스에 닿는 k8s-service 파드의 셸은 다른 파드가 지우지 않습니다. 45초 동안 살아 있음을 적지 못한 파드(데이터베이스가 멈췄거나 그 파드에서 가는 길만 끊김)는 자기 노드 셸을 먼저 스스로 닫습니다. 그 셸들의 `k8s.session.end` 행은 감사 저장소가 다시 받을 때까지 그 파드의 메모리에 있다가 그 파드가 씁니다(많아야 256개). 그 전에 멈춘 파드의 행은 로그의 감사 줄에만 남습니다.
- 승인된 AI 쓰기는 그 승인을 받은 ai-service 파드에서 돕니다. 결과를 적기 전에 그 파드가 죽거나 종료가 실행을 끊으면, 카드는 승인 10분 뒤까지 "실행 중"으로 보입니다. 그 뒤 처음 들여다본 ai-service 파드(새 승인 카드, 카드 열기, 파드의 첫 데이터베이스 사용)가 중단(`ai.tool.interrupt` 행)으로 실패 처리하고, 승인 행을 잡은 한 트랜잭션에서 그 감사 행과 함께 끝내므로 승인 하나를 한 파드만 끝냅니다. 실행은 10분보다 훨씬 짧으므로 다른 파드가 아직 도는 실행을 끝내는 일은 없습니다. 쓰기가 클러스터를 바꿨는지는 알 수 없고, 다시 실행되지 않습니다.
- k8s-service 파드는 저마다 클러스터를 감시하므로, 두 파드에 간 두 요청이 잠깐 감시 이벤트 하나만큼 다를 수 있습니다.
- k8s-service 파드는 읽은 정책 보고서를 자기 메모리에 60초 동안 둡니다. 새 정책 보고서가 다른 파드에서 읽은 드로어나 목록에 보이기까지 1분까지 걸릴 수 있습니다. Policy Reports 화면의 Refresh는 요청이 닿은 파드에서 새로 읽습니다.
- k8s-service 파드는 맡은 클러스터를 저마다 읽고 감시합니다. informer는 종류마다 watch list로 시작하고 API 서버는 이것을 감시로 셉니다. watch list를 내주지 않는 API 서버에는 종류마다 LIST 하나가 대신 갑니다. API 서버는 이것을 파드 수만큼 받습니다.
- k8s-service 파드 하나의 메모리는 1대일 때와 같고, 합은 파드 수만큼 늡니다.
- k8s-service 파드는 Cluster View의 노드 칸을 저마다의 informer로 답하고, 모든 네임스페이스를 볼 수 있는 사람에게 준 답을 들고 있습니다. 노드 256개와 답 8 MiB(파드당 약 300바이트)까지이고, 파드 행은 들고 있지 않습니다. 한 노드의 칸은 그 노드의 파드가 그대로인 동안 k8s-service 파드마다 한 번 만듭니다.
- 그 순간 묻는 모두를 위한 한 번 읽기(드로어의 이벤트, 노드의 파드, 타임라인과 이벤트 API의 이벤트, 타임라인의 롤아웃)는 k8s-service 파드마다 따로 합니다. 한 파드에서 대략 두 번(하고 있던 읽기와, 그 사이에 온 사람들을 위한 한 번 더)이므로, 사람들이 N대에 나뉘면 많아야 대략 2N번입니다.
- 파드를 지키는 한도(메모리, 동시 작업, 실시간 감시 `multicluster.wsMaxSubscriptions`와 그 열기 `multicluster.wsWatchOpeningConcurrency`)는 파드마다입니다. 클러스터로 보내는 요청 속도(`multicluster.clientQPS`)도 파드마다라, N대면 N배까지 보낼 수 있습니다.
- k8s-service 파드는 계정마다 자기에게 열린 터미널(파드 exec, 노드 셸)과 실시간 로그 수를 세고, `multicluster.maxTerminalsPerAccount`나 `multicluster.maxFollowedLogsPerAccount`(각 20)를 넘는 것을 거절합니다. 이 수는 파드끼리 나누지 않으므로, 이것을 받는 파드(k8s-service, `streams.enabled`면 k8s-service-stream)가 N대면 Service가 나누는 대로 한 계정이 N배까지 열 수 있습니다. 파드가 떠나면(롤아웃, 축소, 노드 잃음) 그 파드의 실시간 로그는 남은 파드로 다시 붙고, 거기서 상한을 넘는 것은 거절됩니다. N배가 아니라 상한을 기준으로 잡으세요.
- 이 파드는 모든 계정의 터미널과 실시간 로그를 합쳐서도 세고, `multicluster.maxStreamsPerServer`(443)를 넘는 것을 거절합니다. 파드가 N대면 설치 전체로는 그 N배까지 열립니다. kind 노드에서 하나가 파드 메모리를 약 0.37 MiB 썼으므로(2026-11-22), 상한을 약 1 160까지 올리면 차트의 512 Mi 파드가 한도에 닿을 수 있습니다. 파드가 떠나면 그 파드의 실시간 로그는 남은 파드로 다시 붙고, 남은 파드는 자기 상한을 넘는 것을 거절합니다.

## EKS에서 잰 것

아래는 t3.medium 온디맨드 노드 3대의 EKS 1.35 클러스터를 파드 IP로 보내는 내부 AWS Application Load Balancer(AWS Load Balancer Controller v3.6.2) 뒤에 두고, 차트와 로드 밸런서의 기본값 그대로, 파드 준비 게이트 없이 잰 것입니다.
같은 클러스터에서 0.7.7부터 올린 업그레이드의 숫자는 [0.7.7에서 0.7.8로 업그레이드](upgrade-0.7.8.md#2-업그레이드)에, `preStop` 기다림의 숫자는 [저절로 바뀌는 것](upgrade-0.7.8.md#4-저절로-바뀌는-것)에 있습니다.

- **노드 드레인**: 2026-11-17에 2대 이상 띄울 수 있는 일곱 서비스를 2대씩과 그 PodDisruptionBudget으로 두고, 그 서비스마다 파드 하나씩과 Redis 파드가 있던 노드(차트 내장 PostgreSQL은 다른 노드에 있었음)를 `kubectl drain`으로 비우는 데 10초 걸렸고, PodDisruptionBudget이 막은 내보내기는 없었습니다. 노드를 비우고 그 인스턴스가 새 노드로 바뀌는 동안 로드 밸런서를 거친 요청 중 실패한 것은 없었고, 로드 밸런서를 거쳐 1초마다 `/healthz`와 대시보드 개요를 읽을 때 답이 없던 초는 없었으며, 실시간 목록은 1.1초 안에 다시 붙었습니다. 2026-11-21에 AWS Application Load Balancer 뒤의 다른 EKS 1.35 클러스터에서 같은 기본값으로 비웠을 때는 답이 없던 초가 4초 있었고, 로드 밸런서를 거친 요청이 실패했으며, 실시간 목록이 23.1초 끊겼습니다. 다만 그 노드에는 AWS Load Balancer Controller의 하나뿐인 파드(그 클러스터는 하나만 돌려 다시 뜰 때까지 대상이 갱신되지 않았고, 컨트롤러 Helm 차트의 기본 `replicaCount`는 2)와 CoreDNS, EBS CSI 컨트롤러, metrics-server 파드도 있었고, 게이트웨이 대상은 파드를 지운 뒤 38초가 지나서야 draining이 되었으므로 이 숫자는 기본값만의 결과가 아닙니다. `podShutdown.preStopSeconds: 25`와 등록 해제 지연 20초로 비웠을 때는 Kubeast 파드만 내보냈고, 게이트웨이 대상은 1초 안에 draining이 되었으며, 이런 일이 없었습니다. 두 설정은 [시작하기 전에](#시작하기-전에)의 게이트웨이 파드 교체로 견줍니다.
- **HPA**: k8s-service와 gateway에 차트의 autoscaling 기본값(파드 2~3개, CPU 80 %, `behavior` 비움)으로 HPA를 켜고, 클러스터 안의 클라이언트 32개가 240초 동안 gateway를 거쳐 목록을 읽자 둘 다 58초 안에 파드 3개가 되었고, 부하가 끝나고 337초 뒤 둘 다 2개로 돌아왔습니다. HPA를 켜자 위에 적은 대로 HPA가 처음 맞출 때까지 Deployment마다 파드가 하나가 되었고, 실시간 목록이 한 번 닫혔다가 1.2초 안에 다시 붙었습니다. 파드가 늘고 주는 동안에도, HPA를 켜고 끌 때도 로드 밸런서를 거친 요청 중 실패한 것은 없었습니다.

## 크기 표

아래 칸은 2026-11-21에 [아키텍처](architecture.md#많은-사람이-큰-클러스터를-쓸-때)의 "많은 사람이 큰 클러스터를 쓸 때"와 같은 방식으로 쟀습니다: kind 노드 하나, KWOK 파드 50 000 · 노드 1 001, k8s-service는 차트 한도 512 Mi.
파드 수끼리 견주는 값이며, 실제 클러스터에서는 초가 다릅니다.
T3는 서로 다른 500명이 Dashboard · Pods · Cluster View를 6분 동안 켜 둔 뒤 그중 100명이 같은 순간에 그 화면들을 연 회이고, p95는 켜 둔 6분 동안의 값입니다.
실시간 목록이 열린 채 파드를 갈아 끼운 T5에서 파드 하나의 최고 메모리는 1 · 2 · 3파드에서 415 · 356 · 298 MiB였습니다.

| k8s-service 파드 | 파드당 메모리, 평소 / 바쁠 때 | 메모리 합 | API 서버가 Kubeast에 쥔 감시 수 | 500명 평소 사용 p95 | 판 올리기 동안 200이 아닌 답 |
| --- | --- | --- | --- | --- | --- |
| 1 | 평소 p90 113 / 바쁠 때(T3) 최고 416 MiB | 416 MiB (T3 중 모든 파드 합이 가장 많던 한 초) | informer 7 · T3 동안 최고 1731 | 17 ms (T3) | 656개 중 0 (없음) |
| 2 | 평소 p90 112 · 109 / 바쁠 때(T3) 최고 322 · 289 MiB | 603 MiB (T3 중 모든 파드 합이 가장 많던 한 초) | informer 14 · T3 동안 최고 1738 | 31 ms (T3) | 730개 중 0 (없음) |
| 3 | 평소 p90 107 · 106 · 103 / 바쁠 때(T3) 최고 239 · 245 · 265 MiB | 736 MiB (T3 중 모든 파드 합이 가장 많던 한 초) | informer 21 · T3 동안 최고 1745 | 33 ms (T3) | 806개 중 0 (없음) |
