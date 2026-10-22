# 설정 (values.yaml)


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
  # 아래 커스텀 역할·Read 프록시·로그 파일 권한까지 한 번에(쓰지 않는 템플릿은 건너뜀, docs/cluster-requirements.md §1):
  #   scripts/render-target-rbac.sh -f values.yaml -f <그 클러스터 값> | kubectl --context <cluster> apply -f -
  # (Kubeast 자격증명은 ClusterRole kubeast-impersonator 만 있으면 됨 — 설치된
  #  클러스터의 k8s-service·tool-server ServiceAccount도 이것과 kubeconfig Secret
  #  읽기 Role만 받음; false면 예전처럼 cluster-admin)
  # 커스텀 역할(Read/Write/Admin 외)을 클러스터에 부여하면 그룹 kubeast:role:<slug>로
  # 동작하는데, 위 RBAC은 고정 그룹 4개만 impersonate 허용 → customRoles에 적어야
  # 그 그룹이 허용되고 적은 ClusterRole에 묶임(등록 클러스터마다 같은 렌더 적용):
  #   helm template kubeast helm/kubeast -s templates/impersonation-custom-roles.yaml -f values.yaml | kubectl --context <cluster> apply -f -
  # 네임스페이스 범위 부여(Read/Write/Admin이든 커스텀이든 그룹 kubeast:role:<slug>)는
  # 항목에 namespaces를 적으면 그 네임스페이스마다 RoleBinding으로 묶인다.
  # Read(kubeast:viewer)는 기본 view라 프록시가 없음 → Prometheus·OpenCost 화면이 거부됨.
  # viewerProxyServices에 그 클러스터의 Service를 적으면 그 Namespace에 Role을 만들어
  # "<service>:<port>" GET만 허용(다른 Service·POST·NS 범위 부여는 그대로 거부, 클러스터마다 그 클러스터 값으로):
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
  # 클러스터가 하나도 없는 사용자에게 "어디서 권한을 요청하나" — 대시보드·Settings의
  # "접근 가능한 클러스터 없음" 아래에 보인다. 한 줄 문구 + http(s) 링크(사내 요청 양식 등).
  # #이 들어가면 따옴표로 감싼다(YAML 주석). 비우면 일반 문구만
  accessHelp:
    text: ""
    url: ""

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

# 노드 셸(특권 디버그 파드) — 기본 off. 켜면 전용 네임스페이스 + 이미지 허용 목록(첫 항목이 기본).
# 이미지는 IfNotPresent로 받으므로 버전을 고정(또는 사내 미러 주소) — 이미 받은 노드는 레지스트리에 안 감
nodeShell:
  enabled: false
  images:
    - docker.io/library/busybox:1.38.0

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
  claudeCodeOAuthToken: ""  # Claude 구독 setup-token(provider claude-code, 개인용 — "4. AI 활성화" 참고)
  apiKeysSecret: ""
  model: "gpt-4o-mini"
  baseUrlAllowedHosts: []  # 모델 설정 base_url이 사설 주소(클러스터 안 Ollama·사내 LLM 게이트웨이)면 여기 등록. api_key_env는 OPENAI/ANTHROPIC/GEMINI_API_KEY, CLAUDE_CODE_OAUTH_TOKEN(claude-code 전용) 또는 KUBEAST_AI_KEY_*
  providers:
    claudeCode: { enabled: false, maxConcurrent: 1, turnTimeoutSeconds: 300, maxTurns: 10 }

# 내장 PostgreSQL(false 면 외부 DB) / Redis(false 면 k8s-service가 메모리 캐시 — Redis를 쓰는 곳은 그 하나)
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

전체 옵션은 [helm/kubeast/values.yaml](../helm/kubeast/values.yaml) 참고.
