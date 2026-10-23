[English](../configuration.md) | **한국어**

# 설정 (values.yaml)


자주 쓰는 값은 다음과 같습니다.

```yaml
global:
  imageTag: "v0.1.0"

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
  # 설치된 클러스터의 k8s-service와 tool-server ServiceAccount도 이 ClusterRole과 kubeconfig Secret 읽기 Role만 받습니다.
  # false면 예전처럼 cluster-admin을 받습니다.
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
# networkPolicy.enabled면 스크레이퍼를 from에 적어 열어 줍니다. 알람 5개는 prometheusRule에 있습니다.
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
nodeShell:
  enabled: false
  images:
    - docker.io/library/busybox:1.38.0

# 파드 보안(기본 Pod Security Standards restricted).
# 사용자 네임스페이스를 지원하지 않는 클러스터(커널 6.3 미만)에서는 hostUsers: true로 두세요.
podSecurity:
  enabled: true
  hostUsers: false
  readOnlyRootFilesystem: true

# 가용성 — replicas를 2 이상으로 올릴 때는 pdb.enabled: true로 두세요
replicas:
  gateway: 1
pdb:
  enabled: false
topologySpread:
  enabled: true
resources:               # 컨테이너별 requests / memory limit(전체 목록은 values.yaml)
  aiService:
    requests: { cpu: 100m, memory: 256Mi }
    limits: { memory: 1Gi }

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
  model: "gpt-4o-mini"
  baseUrlAllowedHosts: []  # 모델 설정의 base_url이 사설 주소(클러스터 안 Ollama, 사내 LLM 게이트웨이)면 여기에 등록하세요
  providers:
    claudeCode: { enabled: false, maxConcurrent: 1, turnTimeoutSeconds: 300, maxTurns: 10 }

# 내장 PostgreSQL(false면 외부 DB)과 Redis(false면 k8s-service가 메모리에 캐시).
# Redis를 쓰는 곳은 k8s-service 하나뿐입니다.
postgresql:
  enabled: true
  user: kubeast
  password: ""          # 비우면 설치 때 생성하고 업그레이드해도 유지합니다(secret에서 확인). 외부 DB(enabled: false)면 필수입니다
  database: kubeast
redis:
  enabled: true
  password: ""          # requirepass — 비우면 생성합니다(REDIS_PASSWORD)
networkPolicy:
  enabled: true         # 기본 거부 + 서비스가 쓰는 흐름만 허용합니다. NetworkPolicy를 강제하지 않는 CNI(kindnet 등)에서는 영향이 없습니다

# Gateway 노출 방식
gateway:
  service:
    type: NodePort        # NodePort | ClusterIP | LoadBalancer
    nodePort: 30333
  trustedProxies: []      # 앞단 프록시(Ingress 컨트롤러, LB) CIDR — 감사 로그의 클라이언트 주소를 그 뒤에서 읽습니다
  allowedOrigins: []      # 게이트웨이 자기 호스트와 Ingress 호스트 외에 API·WebSocket을 열어 줄 브라우저 origin(없으면 같은 호스트만)

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

전체 옵션은 [helm/kubeast/values.yaml](../../helm/kubeast/values.yaml)에서 볼 수 있습니다.
