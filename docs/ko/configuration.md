[English](../configuration.md) | **한국어**

# 설정 (values.yaml)


자주 쓰는 값은 다음과 같습니다.

```yaml
global:
  # 릴리스된 차트에는 자기 버전이 이미 들어 있습니다. 다른 빌드를 쓸 때만 지정하세요.
  imageTag: "vX.Y.Z"

# 초기 관리자 계정 — password를 비우면 설치할 때 무작위로 생성합니다
admin:
  email: admin
  password: ""          # 비우면 자동 생성(secret에서 확인)

# JWT 서명 키 — 비우면 설치할 때 생성해 Secret(kubeast-auth-keys)에 보관하고 upgrade 때 다시 씁니다.
# 직접 관리하는 Secret(키 이름 jwt_private.pem)이 있으면 지정하세요.
# 토큰 유효 시간은 15분입니다(활동 중이면 UI가 자동 갱신). 셀프 가입과 데모 계정은 기본으로 꺼져 있습니다.
auth:
  signingKey:
    existingSecret: ""
  tokenTTLMinutes: 15
  allowRegistration: false
  bootstrapDemoUsers: false
  passwordMinLength: 12
  # 세션 쿠키 Secure(HTTPS에서만 전송). TLS 뒤(Ingress, Gateway API)에서는 true로 두세요.
  # localhost가 아닌 주소를 plain http로 쓸 때만 false로 바꿉니다. 이때 true로 두면 로그인 쿠키가 버려집니다.
  cookieSecure: true
  # 클러스터에는 로그인한 사용자 본인(이메일)으로 impersonation합니다.
  # 최종 판단은 클러스터 RBAC이 하고, K8s audit에 사용자가 남습니다.
  # 등록하는 모든 클러스터에 아래 RBAC을 적용하세요:
  #   helm template kubeast helm/kubeast -s templates/impersonation-rbac.yaml | kubectl --context <cluster> apply -f -
  # 아래 커스텀 역할, Read 프록시, 로그 파일 권한까지 한 번에 적용하려면 다음 명령을 씁니다.
  # 쓰지 않는 템플릿은 건너뜁니다(docs/ko/cluster-requirements.md §1).
  #   scripts/render-target-rbac.sh -f values.yaml -f <그 클러스터 값> | kubectl --context <cluster> apply -f -
  # Kubeast 자격증명에는 ClusterRole kubeast-impersonator만 있으면 됩니다.
  # 이 ClusterRole로 kube-system 네임스페이스도 읽을(get) 수 있습니다.
  # 그 UID로 한 클러스터의 두 번째 등록과, 등록된 클러스터의 kubeconfig를 다른 클러스터 것으로 바꾸는 것을 거절합니다.
  # 이 get이 없는 자격증명은 UID 없이 등록되고 두 검사를 건너뜁니다.
  # 설치된 클러스터의 k8s-service와 tool-server ServiceAccount도 이 ClusterRole과 kubeconfig Secret 읽기 Role만 받습니다.
  # false면 예전처럼 cluster-admin을 받습니다.
  # auth-service는 그 클러스터의 kube-system 네임스페이스를 읽을(get) 수 있습니다. 그 UID로 같은 클러스터가 kubeconfig로 두 번 등록되는 것을 막습니다.
  # 커스텀 역할(Read/Write/Admin 외)을 클러스터에 부여하면 그룹 kubeast:role:<slug>로 동작합니다.
  # 위 RBAC은 고정 그룹 4개만 impersonate를 허용하므로, 그 그룹을 허용하려면 customRoles에 적으세요.
  # 그 그룹은 항목에 적은 ClusterRole에 묶입니다. 등록 클러스터마다 같은 렌더를 적용하세요:
  #   helm template kubeast helm/kubeast -s templates/impersonation-custom-roles.yaml -f values.yaml | kubectl --context <cluster> apply -f -
  # 항목에 namespaces를 적으면 네임스페이스 범위로 부여하고, 그 네임스페이스마다 RoleBinding으로 묶습니다.
  # Read/Write/Admin이든 커스텀이든 그룹 kubeast:role:<slug>에 똑같이 적용됩니다.
  # Read(kubeast:viewer)는 기본 view라 프록시가 없어 Prometheus와 OpenCost 화면이 거부됩니다.
  # viewerProxyServices에 그 클러스터의 Service를 적으면 그 Namespace에 Role을 만들어 "<service>:<port>" GET만 허용합니다.
  # 다른 Service, POST, NS 범위 부여는 그대로 거부합니다. 클러스터마다 그 클러스터 값으로 적용하세요:
  #   helm template kubeast helm/kubeast -s templates/impersonation-viewer-proxy.yaml -f values.yaml | kubectl --context <cluster> apply -f -
  impersonation:
    enabled: true
    clusterRoles: true
    userPrefix: ""  # 예: kubeast:user: — 사람의 주소 앞에 붙음. 주소로 묶은 User 바인딩은 적용되지 않게 됨(cluster-requirements §1)
    # kubeast:cache로 읽어 보여 주는 화면은 그 사람이 그것을 list·get할 수 있는지 먼저 묻습니다. 켜면 그 읽기 확인을
    # 그룹 집합마다 한 번 kubeast:group-check:<시작마다 만든 꼬리>로 묻고, 허용 답을 같은 그룹의 모든 사람에게 최대 1분
    # 씁니다. 거절은 그 사람으로 다시 묻습니다. 그 확인은 클러스터 감사 로그에 그 이름으로 남습니다. 모든 인가기가
    # 그 이름과 그 사람의 그룹에 허용한 것을 그 사람에게도 허용한다는 조건에 기댑니다. RBAC 앞이든 뒤든 사용자 이름에
    # 따라 답하는 인가기가 있거나, Kubeast가 대신할 수 있는 사용자 이름을 제한한 클러스터는 목록에 넣고, 그 이름은
    # 바인딩하지 마세요(cluster-requirements §1).
    sharedReadChecks:
      enabled: false
      excludeClusters: []  # 사람마다 계속 묻는 등록 클러스터 ID
    customRoles: []
    #  - name: Read
    #    namespaces: [team-a, team-b]
    #    clusterRoles: [view]
    #  - name: sre-readonly
    #    clusterRoles: [view, "kubeast:cluster-reader"]
    viewerProxyServices: []
    #  - {namespace: monitoring, service: prometheus, port: 9090}
    #  - {namespace: opencost, service: opencost, port: 9003}
  # 임시 권한 요청 — 기본으로 꺼져 있습니다.
  # 켜면 사용자가 Settings → Cluster access에서, 이미 권한이 있는 클러스터의 더 높은 역할(기본 Write까지)을
  # 사유와 함께 최대 maxHours 동안 요청할 수 있습니다.
  # 관리자(본인 제외)는 Admin → Access requests에서 승인하거나 거절합니다.
  # 승인되면 요청자는 다시 로그인해 그 역할로 들어오고, 시간이 지나면 자동으로 이전 역할로 돌아갑니다.
  # 감사 로그는 access.request.* / access.grant.expire로 남습니다.
  # 클러스터 RBAC이 그 역할의 그룹을 바인딩한 클러스터에서만 효력이 있습니다.
  # viewer만 바인딩한 운영 클러스터에서는 승격돼도 403입니다.
  # roles는 역할을 이름 그대로 적습니다. 기본 역할 이름을 대소문자만 달리 쓴 항목(WRITE)은 그 기본 역할을 뜻합니다.
  accessRequests:
    enabled: false
    maxHours: 8
    roles: [Write]
  # 클러스터가 하나도 없는 사용자에게 "어디서 권한을 요청하나"를 알려 줍니다.
  # 대시보드와 Settings의 "접근 가능한 클러스터 없음" 아래에 보입니다.
  # 한 줄 문구 + http(s) 링크(사내 요청 양식 등)입니다.
  # #이 들어가면 따옴표로 감싸세요(YAML 주석). 비우면 일반 문구만 보입니다.
  accessHelp:
    text: ""
    url: ""

# EKS: k8s-service와 tool-server 파드가 aws-iam-authenticator를 실행할 때 쓰는 IRSA 롤 + STS 리전
aws:
  irsaRoleArn: ""
  region: ""
# 서비스마다 쓰는 자기 롤(IRSA)이나 다른 클라우드의 워크로드 아이덴티티 주석입니다.
# 감사 S3 싱크는 authService, S3 세션 기록은 k8sService를 씁니다(aws.irsaRoleArn 위에 덮어씀).
serviceAccounts:
  authService:
    annotations: {}   # eks.amazonaws.com/role-arn: arn:aws:iam::<계정>:role/kubeast-audit-sink
  k8sService:
    annotations: {}

# 콘솔 자체 메트릭 — 백엔드 5개가 각자 포트의 /metrics로 Prometheus 메트릭을 냅니다.
# 내용은 요청 수, 지연, 진행 중 요청, 감사 저장소 상태, WebSocket 구독입니다(docs/ko/metrics.md).
# 게이트웨이는 /metrics를 프록시하지 않습니다. prometheus-operator가 있으면 ServiceMonitor를 쓰세요.
# networkPolicy.enabled면 스크레이퍼를 from에 적어 열어 줍니다. 알람 5개는 prometheusRule에 있습니다(감사 앵커 싱크가 있으면 6개).
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

# 서비스 간 토큰 — k8s-service의 /internal 라우트는 사용자 JWT에 더해
# Secret kubeast-secrets의 INTERNAL_API_TOKEN을 X-Internal-Token으로 요구합니다(차트가 생성·보존).
# 해당 라우트: tool-server의 kubeconfig 조회, auth-service의 validate·invalidate
# 회전하려면 값을 바꾼 뒤 auth-service, k8s-service, tool-server를 롤아웃하세요.
# secrets.existingSecret를 쓰면 그 Secret에 넣으세요.

# 노드 셸(특권 디버그 파드) — 기본으로 꺼져 있습니다.
# 켜면 전용 네임스페이스와 이미지 허용 목록(첫 항목이 기본)을 씁니다.
# 이미지는 IfNotPresent로 받으므로 버전을 고정하세요(또는 사내 미러 주소). 이미 받은 노드는 레지스트리에 가지 않습니다.
# 셸이 끝나면 그 파드를 지웁니다. 연 k8s-service가 죽으면(메모리 부족, 노드 잃음) 1~2분 뒤에 다른 k8s-service가
# 지우고(표 node_shells), 늦어도 nodeShell.timeoutSeconds(3600)에 끝나며 행은 그 150초 뒤에 지웁니다.
# 45초 동안 데이터베이스에 노드 셸을 적지 못한 k8s-service는 그 셸을 스스로 닫고(데이터베이스 전체가
# 그만큼 멈춰도, 장애 조치 포함), 데이터베이스가 행을 받지 못한 셸은 파드를 만들기 전에 거절합니다.
nodeShell:
  enabled: false
  images:
    - docker.io/library/busybox:1.38.0

# 파드 보안(기본 Pod Security Standards restricted).
# 사용자 네임스페이스를 지원하지 않는 클러스터(커널 6.3 미만)에서는 hostUsers: true로 두세요.
# enabled: false는 securityContext를 두지 않아 uid·fsGroup을 플랫폼에 맡기고, Secret 파일을 0440 대신 0444로 마운트합니다.
# 이때 audit.fileSinkVolume, sessionRecording.spoolVolume·fileVolume에 준 PVC는 uid 65532가 스스로 쓸 수 있어야 합니다(플랫폼이 fsGroup을 넣어 주면 됨 — OpenShift의 restricted SCC는 넣어 줍니다).
podSecurity:
  enabled: true
  hostUsers: false
  readOnlyRootFilesystem: true

# 가용성 — replicas를 2 이상으로 올렸거나 autoscaling의 minReplicas가 2 이상인 Deployment에는 PodDisruptionBudget이 생깁니다(pdb.maxUnavailable, 1 · pdb.enabled: false면 만들지 않음). 판을 올릴 때는 새 파드를 먼저 띄우고, 새 파드가 준비된 뒤에 옛 파드를 멈춥니다(postgres·redis는 옛 파드를 먼저 내리기 시작)
# 그래서 sessionRecording.fileVolume(storage: file)은 k8s-service 파드가 바뀌는 동안 파드 둘이 붙입니다. ReadWriteOnce 볼륨은 한 번에 한 노드에만 붙으니, 노드가 여럿이면 ReadWriteMany 볼륨을 주거나 storage s3·database를 쓰세요(docs/ko/operations.md)
# 프로브 — liveness는 /livez(다른 것은 안 봄), readiness는 /readyz(SIGTERM부터 503, DB는 보지 않음 — 모두가 쓰는 DB가 죽으면 모든 파드가 한꺼번에 빠지므로). DB 상태는 auth-service·session-service의 /health와 k8s-service의 kubeast_audit_store_up에서 봅니다
# podShutdown.preStopSeconds: Service 뒤의 파드는(번들 PostgreSQL과 Redis는 빼고 — 둘은 preStop 기다림이 없고 Kubernetes 기본 종료 유예 30초) 종료 요청 뒤 이 초만큼 더 응답하고(preStop sleep, Kubernetes 1.30 이상) 그다음 30초 안에 종료합니다(터미널을 맡은 서버는 드레인 대기와 닫기 대기만큼 더). 파드 IP로 보내는 로드 밸런서 뒤라면 로드 밸런서가 떠나는 파드에 새 요청을 그만 보낼 때까지보다 길게 두세요(AWS Application Load Balancer 뒤에서는 기본 5초로 충분했습니다)
replicas:
  gateway: 1
# 서비스마다 HPA 하나, 기본 꺼짐. k8sService · toolServer를 2대 이상으로 하려면 redis.enabled가 필요(docs/ko/high-availability.md)
autoscaling:
  gateway: { enabled: false, minReplicas: 2, maxReplicas: 3, targetCPUUtilizationPercentage: 80, behavior: {} }
pdb:
  enabled: true
  maxUnavailable: 1
# 터미널과 실시간 로그를 따로 맡는 서버, 기본 꺼짐(docs/ko/operations.md "터미널과 실시간 로그를 따로 맡는 서버")
streams:
  enabled: false
  replicas: 1            # 1 그대로 — 스트림 서버 둘 이상은 아직 지원하지 않습니다
  drainSeconds: 60       # 터미널을 맡은 서버가 교체될 때 열린 터미널을 기다리는 시간(꺼져 있으면 k8s-service)
  preStopSeconds: 10     # k8s-service-stream이 드레인을 시작하기 전에 Service 엔드포인트에서 빠져 있는 시간
topologySpread:
  enabled: true
podShutdown:
  preStopSeconds: 5
resources:               # 컨테이너별 requests / memory limit(전체 목록은 values.yaml)
  aiService:
    requests: { cpu: 100m, memory: 256Mi }
    limits: { memory: 1Gi }
  k8sServiceStream:      # streams.enabled일 때만. 아직 재지 않아 k8sService 값으로 시작
    requests: { cpu: 100m, memory: 128Mi }
    limits: { memory: 512Mi }

# AI 키 — ai-service 환경변수로만 주입하고 DB에는 저장하지 않습니다.
# 모델 설정(UI/CRD)은 변수 이름(api_key_env)만 가리킵니다.
# api_key_env는 OPENAI/ANTHROPIC/GEMINI_API_KEY, CLAUDE_CODE_OAUTH_TOKEN(claude-code 전용), KUBEAST_AI_KEY_* 중 하나입니다.
# ESO 등으로 만든 Secret이 있으면 apiKeysSecret에 지정하세요.
ai:
  openaiApiKey: ""
  anthropicApiKey: ""
  geminiApiKey: ""
  claudeCodeOAuthToken: ""  # Claude 구독 setup-token(provider claude-code, 개인용). "4. AI 활성화"를 참고하세요
  apiKeysSecret: ""
  model: "gpt-6-luna"
  baseUrlAllowedHosts: []  # 모델 설정의 base_url이 사설 주소(클러스터 안 Ollama, 사내 LLM 게이트웨이)면 여기에 등록하세요
  providers:
    claudeCode: { enabled: false, maxConcurrent: 2, maxConcurrentTotal: 0, memoryLimit: 2Gi, queueWaitSeconds: 60, turnTimeoutSeconds: 300, maxTurns: 10 }
    # maxConcurrent: 서버 한 대의 Claude Code 실행 수(메모리), maxConcurrentTotal: 복제본 전체(0 = maxConcurrent),
    # queueWaitSeconds: 칸을 기다리는 최대 시간. 넘으면 "바쁨"으로 끝납니다.
    # memoryLimit: 프로바이더가 켜져 있을 때 ai-service 메모리 한도. resources.aiService.limits.memory보다 클 때 씁니다

# 내장 PostgreSQL(false면 외부 DB)과 Redis(false면 k8s-service가 메모리에 캐시).
# Redis에 캐시하는 곳은 k8s-service 하나이고, tool-server는 클러스터 바뀜 알림만 듣습니다.
postgresql:
  enabled: true
  user: kubeast
  password: ""          # 비우면 설치 때 생성하고 업그레이드해도 유지합니다(secret에서 확인). 외부 DB(enabled: false)면 필수입니다
  database: kubeast
  sessionLimits: { statementTimeoutMs: 30000, lockTimeoutMs: 15000, idleInTransactionTimeoutMs: 300000 }  # 각 서비스가 연결한 뒤 SET으로 거는 PostgreSQL statement_timeout, lock_timeout, idle_in_transaction_session_timeout입니다(마이그레이션은 역할(role)에 걸려 있어도 앞의 둘 없이 돕니다). 0이면 걸지 않습니다. RDS Proxy 뒤에서는 SET이 세션을 고정(pinning)하니 0으로 두고 프록시의 초기화 쿼리나 데이터베이스 역할(role)에 거세요. PgBouncer는 session 풀링으로만 쓰세요. transaction 풀링은 트랜잭션 사이에 서버 연결을 다른 클라이언트에게 넘기므로 SET이나 세션 advisory lock(마이그레이션, 감사 디스패처, k8s-service 상태 확인 잠금)이 그것을 건 클라이언트에 남지 않습니다
  pool: { authService: { maxConns: 20 }, sessionService: { maxConns: 20 }, k8sService: { maxConns: 10 }, aiService: { maxConns: 15 }, modelConfigController: { maxConns: 4 } }  # 파드 하나의 연결 수입니다. 차트의 PostgreSQL이면 파드들(롤아웃 때 하나 더, 오토스케일링의 maxReplicas 포함)이 maxConnections보다 많이 열 수 있을 때 설치가 멈추고, 외부 데이터베이스면 NOTES가 그 합을 보여 주니 그쪽 max_connections와 비교하세요
  maxConnections: 300   # 차트 PostgreSQL의 max_connections
# 업그레이드할 때 Redis는 옛 파드를 먼저 내리기 시작한 뒤 새 파드를 만듭니다(maxSurge 0). 새 파드는 빈 캐시로 시작하고, 옛 파드가 끝나는 몇 초 동안 둘이 같이 있을 수 있지만 데이터는 나누지 않습니다(emptyDir). Redis가 답하지 않는 동안 k8s-service는 클러스터에서 읽습니다. 캐시 명령은 0.5초 안에 그만두고, 그 뒤 3초 동안 캐시는 Redis를 건너뜁니다.
redis:
  enabled: true
  password: ""          # requirepass, Redis 사용자가 꺼져 있는 동안 씁니다 — 비우면 생성합니다(REDIS_PASSWORD)
  acl:
    enabled: true       # 서비스마다 Redis 사용자 하나(아래 "Redis 사용자"). false면 예전처럼 비밀번호 하나
    existingSecretHasKeys: false  # secrets.existingSecret을 쓸 때: 그 Secret에 사용자 비밀번호를 넣은 뒤 true
    existingSecret: ""            # 사용자 키만 든 Secret. 서비스마다 자기 키만 읽습니다
networkPolicy:
  enabled: true         # 기본 거부 + 서비스가 쓰는 흐름만 허용합니다. NetworkPolicy를 강제하지 않는 CNI(Flannel 등)에서는 영향이 없습니다. kind의 kindnet은 kind 0.24부터 강제합니다

# Gateway 노출 방식
gateway:
  service:
    type: NodePort        # NodePort | ClusterIP | LoadBalancer
    nodePort: 30333
  trustedProxies: []      # 앞단 프록시(Ingress 컨트롤러, LB) CIDR — 감사 로그의 클라이언트 주소를 그 뒤에서 읽습니다
  allowedOrigins: []      # 게이트웨이 자기 호스트와 Ingress 호스트 외에 API·WebSocket을 열어 줄 브라우저 origin(없으면 같은 호스트만)
  accessLog:
    upstreamTimes: false  # true면 접근 로그 줄마다 요청 시간, 서비스 연결·헤더·응답 시간(초), 서비스 주소, 클라이언트 포트를 덧붙입니다

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
  breakerConsecutiveFails: 5  # 클러스터 차단기를 여는, API 서버에 닿지 못한(어느 호출도 응답을 받지 못한) 연속 요청 수. 0 = 끔, 어떤 요청도 바로 실패시키지 않음
  breakerOpenSec: 30        # 열린 차단기가 503으로 답하는 시간. 지나면 요청 하나를 클러스터로 보내 봄(0 = 30)
  clientQPS: 100            # 클러스터 API 서버로 보내는 client-go 속도
  clientBurst: 200
  reviewQPS: 0              # 0 = 권한 확인이 clientQPS를 같이 씀. architecture.md "Many users" 참고
  reviewBurst: 0
  wsWatchOpeningConcurrency: 8  # 모든 클러스터를 합쳐 첫 객체를 한꺼번에 받는 실시간 목록 수, 다른 클러스터가 기다리는 동안 한 클러스터는 그 절반까지. architecture.md "Many users" 참고
  wsWatchStreamWindowKiB: 1024  # 실시간 목록 스트림 하나의 HTTP/2 창: 느린 브라우저의 watch가 쥐는 메모리와, 왕복이 긴 망에서 목록이 오는 빠르기의 맞바꿈. architecture.md "Many users" 참고
  maxTerminalsPerAccount: 20     # 한 계정이 k8s-service 하나(streams를 켜면 k8s-service-stream)에 한꺼번에 열어 둘 수 있는 터미널(파드 exec, 노드 셸) 수. 넘는 것은 열기 전에 거절하고 화면이 까닭을 보여 줌. 0 = 상한 없음, 0보다 작으면 차트가 멈춤
  maxFollowedLogsPerAccount: 20  # 실시간 로그(컨테이너 출력, 로그 파일)도 같은 방식
```

## 새 값의 단계

이번 릴리스가 더하거나 뜻을 바꾼 값마다 단계가 있고, 이 표와 그 값의 `values.yaml` 주석에 적습니다.

- **alpha**: 새로 들어온 값입니다. 키나 동작이 뒤 릴리스에서 바뀌거나 없어질 수 있고, 그때는 그 릴리스 노트에 적습니다.
- **beta**: 기능은 남습니다. 키나 세부는 바뀔 수 있고, 한 릴리스 앞서 알리고 옮기는 법을 적습니다.
- **stable**: 키와 동작이 그대로 남습니다. 이름이 바뀐 키도 한 릴리스 동안은 경고와 함께 읽습니다.

차트 기본값으로 설치하면 읽는 값은 beta이고, 직접 정하거나 그 값을 읽는 기능을 켜야 쓰이는 값은 alpha입니다. `pdb.*`는 서비스가 파드 둘 이상일 때만 PodDisruptionBudget을 만들며, 마지막 칸의 노드 드레인으로 beta입니다. `redis.acl.*`의 Redis 사용자는 `secrets.existingSecret` 설치에서는 `redis.acl.existingSecretHasKeys`나 `redis.acl.existingSecret`을 정하기 전까지 꺼져 있습니다. 마지막 칸은 값마다 아직 돌리지 않은 것이고, "돌려 봄:"으로 시작하면 그 뒤에 돌린 것입니다.

| 값 | 기본값 | 단계 | 아직 안 돌린 것 · 돌려 봄 |
| --- | --- | --- | --- |
| `podShutdown.preStopSeconds` | 5 | beta | 돌려 봄: Kubernetes 1.29.14(kind, `PodLifecycleSleepAction` 기능 게이트 꺼짐)에 기본 설치를 서버 dry-run으로 보내니 API 서버가 preStop 기다림이 있는 Deployment 7개를 거절함(`spec.template.spec.containers[0].lifecycle.preStop: Required value: must specify a handler type`). `0`이면 객체 58개를 모두 받음 |
| `redis.acl.enabled`, `redis.acl.existingSecretHasKeys`, `redis.acl.existingSecret` | true, false, "" | beta | 시험 설치에서 사용자를 끈 경우 |
| 1보다 큰 `replicas.k8sService`와 `replicas.toolServer` | 1 | alpha | k8s-service 2대 · 3대의 크기 |
| `autoscaling.<service>` | 끔 | alpha | 돌려 봄: EKS 1.35에서 k8s-service와 게이트웨이의 HPA가 파드 2대에서 3대로 늘었다가 돌아오고 HPA를 켰다 끄는 동안, 로드 밸런서를 거친 요청 중 실패한 것 없음 |
| `postgresql.sessionLimits.*`, `postgresql.pool.<service>.maxConns`, `postgresql.maxConnections` | 켬, 20 · 20 · 10 · 15 · 4, 300 | beta | 데이터베이스가 오래 멈춘 경우 |
| `pdb.enabled`, `pdb.maxUnavailable` | true, 1 | beta | 돌려 봄: EKS 1.35에서 서비스마다 파드 둘을 두고 노드 하나를 드레인해 바꾸는 동안, 막힌 내보내기 없음 · 로드 밸런서를 거친 요청 중 실패한 것 없음 |
| `streams.*` | 끔 | alpha | kind 개발 설치에서 한 번도 안 돌림 |
| `ai.providers.claudeCode.maxConcurrentTotal`, `queueWaitSeconds`, `memoryLimit` | 0, 60, 2Gi | alpha | 프로바이더를 켠 시험 설치 |
| `gateway.accessLog.upstreamTimes` | false | alpha | 돌려 봄: kind 개발 설치에서 켠 상태로 100명이 한꺼번에 화면을 엶(2026-11-17), 접근 로그 줄마다 여섯 칸이 붙음 |
| `multicluster.breakerConsecutiveFails`(0.7.8부터 `0`이면 차단기 끔), `multicluster.breakerOpenSec`(0.7.8부터 읽음) | 5, 30 | beta | kind 개발 설치에서 클러스터를 끊어 본 경우 |
| `multicluster.wsWatchOpeningConcurrency`, `multicluster.wsWatchStreamWindowKiB` | 8, 1024 | beta | 돌려 봄: kind에서 0.7.7부터 업그레이드 리허설(기본 설치, 기존 Secret, 외부 데이터베이스, AI 끔, 2대 · 3대)과 EKS 1.35. EKS 1.35에서는 노드를 드레인할 때 실시간 목록이 한 번 닫혔다가 1.1초 안에 다시 붙고, HPA를 켜면서 k8s-service가 2대에서 1대로 줄 때 한 번 닫혔다가 1.2초 안에 다시 붙음. HPA가 파드를 늘리고 줄일 때는 닫히지 않음 |
| `multicluster.maxTerminalsPerAccount`, `multicluster.maxFollowedLogsPerAccount` | 20, 20 | beta | 돌려 봄: kind 개발 설치에서 기본값으로 stream-caps e2e(2026-11-19). 한 계정의 21번째 터미널과 실시간 로그가 거절되고 화면이 까닭을 보여 주며, 하나를 닫으면 새로 열림 |
| `auth` 설정의 `customRoles` 옆 `sharedReadChecks.enabled`, `sharedReadChecks.excludeClusters` | false, [] | alpha | 돌려 봄: 켠 상태의 전체 e2e를 kind 개발 설치에서 두 번(실패 없음), 100명이 한꺼번에 화면을 연 부하(오류 없음) |

## Redis 사용자

차트의 Redis(Valkey)는 Redis를 쓰는 서비스마다 자기 사용자를 둡니다(`redis.acl.enabled`, 기본 켬).

`secrets.existingSecret`을 쓰면, 사용자를 켤 때까지 Redis는 모든 서비스에 비밀번호 하나(`REDIS_PASSWORD`)를 씁니다. 켜려면 그 Secret에 `REDIS_K8S_SERVICE_PASSWORD`, `REDIS_PROBE_PASSWORD`, AI를 켰다면 `REDIS_TOOL_SERVER_PASSWORD`까지 넣고 `redis.acl.existingSecretHasKeys: true`로 두거나, 그 키를 따로 된 Secret에 넣고 `redis.acl.existingSecret`에 그 이름을 두세요. 그 전까지는 설치 안내(NOTES)가 이를 알립니다.

| 사용자 | 할 수 있는 것 | 할 수 없는 것 |
|---|---|---|
| `k8s-service` | 이름이 `kubeast:`로 시작하는 키와 채널. 키 하나씩 읽기·쓰기·지우기, 패턴으로 지울 때 쓰는 `SCAN`, `PUBLISH`/`SUBSCRIBE`(클러스터 바뀜 알림), `PING`, `SELECT`(`REDIS_DB`) | 그 밖의 키와 채널. `FLUSHALL`, `FLUSHDB`, `KEYS`, `CONFIG`, `DEBUG`, `ACL`, `MONITOR`, `EVAL`, `SCRIPT`와 목록에 없는 모든 명령 |
| `tool-server`(AI를 켰을 때) | 클러스터 바뀜 알림 채널(`kubeast:clusters:changed:*`): `SUBSCRIBE`, `PING`, `SELECT` | 모든 키. 알림 보내기. 그 밖의 모든 명령 |
| `probe` | readiness·liveness 프로브의 `PING` | 그 밖의 모든 것 |
| `default` | 없음: 꺼져 있습니다 | 위 사용자로 로그인하지 않은 연결은 모든 명령에 `NOAUTH`를 받습니다 |

- 규칙은 `helm/kubeast/templates/_helpers.tpl`의 `kubeast.redisUsersAcl`에 있습니다. k8s-service가 새 명령을 쓰기 시작하면 거기에 더합니다.
- go-redis는 연결할 때 `CLIENT SETINFO`와 `CLIENT MAINT_NOTIFICATIONS`를 보냅니다. Redis가 둘 다 거절하고, go-redis는 그대로 이어 갑니다.
- 이 규칙은 `images.redis`가 Valkey이거나 Redis 6.2 이상이어야 합니다. 이미지가 모르는 명령이 있으면 Valkey가 시작하지 않습니다.
- tool-server는 k8s-service의 클러스터 바뀜 알림을 듣고 그 클러스터의 kubeconfig를 버립니다. auth-service가 부른 한 대만이 아니라 모든 tool-server가 바로 버립니다.
- 알림에는 클러스터와 보낸 k8s-service 프로세스만 들어 있습니다(`services/pkg/clusternotice`). 다음 도구 호출은 kubeconfig를 k8s-service에 다시 묻고, 그때 그 사람의 권한도 다시 봅니다. 그래서 진짜가 아닌 알림이 와도 다시 읽기 한 번입니다.
- 알림을 놓치거나 Redis가 꺼져 있으면, 길어야 tool-server가 kubeconfig를 기억하는 10초입니다.

**비밀번호.**

- 사용자마다 설치 때 32자로 만들어 Secret `kubeast-redis-users`에 둡니다(`REDIS_K8S_SERVICE_PASSWORD`, `REDIS_PROBE_PASSWORD`, `REDIS_TOOL_SERVER_PASSWORD`).
- 업그레이드해도 유지되고, `kubeast-secrets`처럼 `helm uninstall` 뒤에도 남습니다.
- 모든 서비스가 통째로 환경 변수로 읽는 `kubeast-secrets`에는 넣지 않습니다. redis 파드가 읽고, k8s-service와 tool-server는 자기 것만 읽습니다.
- `secrets.existingSecret`과 `redis.acl.existingSecretHasKeys: true`를 쓰면 키를 그 Secret에서 읽습니다. 모든 백엔드가 그 Secret을 통째로 환경 변수로 읽으므로 각자 모든 Redis 사용자의 비밀번호를 갖게 되고, 설치 안내(NOTES)가 이를 알립니다.
- 서비스마다 자기 키만 갖게 하려면 키를 따로 된 Secret에 넣고 `redis.acl.existingSecret`에 그 이름을 두세요. 사용자가 켜지고, redis 파드와 각 서비스가 그 Secret에서 자기 키만 읽으며, 주 Secret에는 키가 없어도 됩니다.
- 바꾸려면 Secret에 새 값을 쓰고 `redis`와 그 비밀번호의 서비스를 다시 시작합니다.

**Valkey가 읽는 방법.**

- redis 파드의 첫 컨테이너 `acl`이 Secret의 비밀번호를 파일로 읽습니다.
- 각 비밀번호의 SHA-256을 메모리 볼륨의 ACL 파일에 쓰고 파일을 읽기 전용으로 둡니다. Valkey는 `--aclfile`로 시작합니다.
- 비밀번호는 파드 스펙에도 Valkey 인자에도 없습니다. 프로브는 `REDISCLI_AUTH`에서 읽습니다.
- 규칙이 바뀌면 Valkey가 다시 시작합니다(파드의 `checksum/redis-users`, 비밀번호를 뺀 규칙의 해시).

**네트워크.** `networkPolicy.enabled`면 Redis는 릴리스 네임스페이스의 k8s-service와 tool-server 파드에서 6379 포트로 오는 연결만 받습니다. 프로브는 redis 컨테이너 안에서 돌아 규칙이 필요 없습니다.

**메모리.**

- Valkey는 `resources.redis.limits.memory`의 80%에서 내보냅니다(`maxmemory`, 기본 128Mi면 107374182바이트). 컨테이너가 한도에 닿기 전에 내보냅니다.
- 한도가 없으면 128Mi의 80%에서 멈춥니다.
- 정책은 `volatile-lru`입니다: TTL이 있는 키만 내보냅니다. 캐시 키는 모두 TTL이 있습니다. TTL이 없는 키는 내보내지 않습니다.

**담는 것.** k8s-service의 캐시 항목(10~30초, Helm 목록의 세대 표시는 1시간)과 지나가는 클러스터 변경 알림뿐입니다. 디스크에 쓰지 않습니다(`--save ""`): 다시 시작한 Redis는 같은 파드에서도 비어서 시작합니다.

**0.7.7 이하에서 올릴 때**(비밀번호 하나 `REDIS_PASSWORD`를 쓰던 판):

- 업그레이드가 `kubeast-redis-users`를 더하고 `kubeast-secrets`의 값은 `REDIS_PASSWORD`까지 모두 그대로 둡니다.
- Redis와 k8s-service가 다시 시작합니다. Redis가 다시 시작할 때마다 그렇듯 캐시는 비어서 시작합니다.
- 옛 k8s-service 파드가 내려갈 때까지 그 파드가 새 Redis에 보내는 요청은 거절되고 캐시에 없는 것으로 읽힙니다.
- 새 Redis가 답하기 전에 뜬 새 k8s-service 파드(업그레이드할 때 Redis는 옛 파드를 먼저 내리기 시작한 뒤 새 파드를 만듭니다, maxSurge 0)는 Redis가 답할 때까지 메모리에 캐시하고, 5초마다 다시 묻습니다. 답은 같고, 그동안 캐시만 나눠 쓰지 않습니다.
- `secrets.existingSecret`을 쓰면 업그레이드에서 바뀌는 것이 없습니다: `redis.acl.existingSecretHasKeys`가 true가 되거나 `redis.acl.existingSecret`이 사용자 키를 담은 Secret을 가리킬 때까지 Redis는 비밀번호 하나를 씁니다.
- 그 값을 켜면, Secret을 읽을 수 있는 업그레이드는 키가 없거나 비었을 때 그 키를 말하고 멈춥니다. `helm template`과 Argo CD는 Secret을 읽지 못합니다: 그때는 `acl` 컨테이너가 어느 키가 없는지 말하고 멈추며, k8s-service는 메모리에 캐시합니다.
- `redis.acl.enabled: false`면 Redis는 예전 그대로(메모리 상한만 더해) 뜹니다.
- 0.7.7로 `helm rollback`하면 Redis가 `kubeast-secrets`에 그대로 있는 비밀번호 하나로 돌아오고, 0.7.7 k8s-service는 그 비밀번호로 로그인합니다. 그 Redis가 답하기 전에 뜬 0.7.7 k8s-service 파드는 다시 시작할 때까지 메모리에 캐시합니다. `kubeast-redis-users`는 남고, 다음 업그레이드가 그 비밀번호를 다시 씁니다.

**나중에.** 바깥 Redis로 가는 TLS는 아직 이 차트에 없습니다. 지금 차트로는 바깥 Redis를 가리킬 수 없습니다: `REDIS_HOST`는 차트의 `redis`이거나 비어 있습니다.

전체 옵션은 [helm/kubeast/values.yaml](../../helm/kubeast/values.yaml)에서 볼 수 있습니다.
