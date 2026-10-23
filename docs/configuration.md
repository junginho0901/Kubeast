**English** | [한국어](ko/configuration.md)

# Configuration (values.yaml)


Frequently used values:

```yaml
global:
  imageTag: "v0.1.0"

# Initial admin account — leave password empty to generate a random one at install
admin:
  email: admin
  password: ""          # generated automatically when empty (look it up in the secret)

# JWT signing key. When empty, it is generated at install, kept in a Secret (kubeast-auth-keys) and reused on upgrade.
# Set this if you manage your own Secret (key name jwt_private.pem).
# Tokens last 15 minutes (the UI renews them automatically while you are active).
# Self sign-up and demo accounts are off by default.
auth:
  signingKey:
    existingSecret: ""
  tokenTTLMinutes: 15
  allowRegistration: false
  bootstrapDemoUsers: false
  passwordMinLength: 12
  # Session cookie Secure flag (the cookie is sent only over HTTPS). Keep true behind TLS (Ingress or Gateway API).
  # Set false only when you use a non-localhost address over plain http; otherwise the login cookie is dropped.
  cookieSecure: true
  # Impersonates the logged-in user (email) on the cluster. The cluster RBAC makes
  # the final decision, and the user shows up in the K8s audit log.
  # Apply the RBAC below to every cluster you register:
  #   helm template kubeast helm/kubeast -s templates/impersonation-rbac.yaml | kubectl --context <cluster> apply -f -
  # Or apply it together with the custom roles, Read proxy and log file permissions below in one go
  # (unused templates are skipped, docs/cluster-requirements.md §1):
  #   scripts/render-target-rbac.sh -f values.yaml -f <that cluster's values> | kubectl --context <cluster> apply -f -
  # Kubeast credentials need only the ClusterRole kubeast-impersonator. The k8s-service and tool-server
  # ServiceAccounts in the cluster Kubeast is installed in also get only this, plus a Role to read the
  # kubeconfig Secret. When false, they get cluster-admin as before.
  # A custom role (other than Read/Write/Admin) granted on a cluster acts as the group kubeast:role:<slug>.
  # The RBAC above allows impersonating only the 4 fixed groups, so list the role in customRoles:
  # that group is then allowed and bound to the listed ClusterRoles.
  # Apply the same render on each registered cluster:
  #   helm template kubeast helm/kubeast -s templates/impersonation-custom-roles.yaml -f values.yaml | kubectl --context <cluster> apply -f -
  # Namespace-scoped grants (group kubeast:role:<slug>, whether Read/Write/Admin or custom)
  # are bound with a RoleBinding in each namespace when you list namespaces in the entry.
  # Read (kubeast:viewer) is plain view with no proxy access, so the Prometheus and OpenCost screens are refused.
  # Listing that cluster's Services in viewerProxyServices creates a Role in that Namespace that
  # allows only GET on "<service>:<port>". Other Services, POST and NS-scoped grants are still refused.
  # Apply it per cluster, with that cluster's values:
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
  # Temporary access requests (off by default). When on:
  # - In Settings → Cluster access, users request a higher role (up to Write by default) on a cluster
  #   they already have access to, for up to maxHours, with a reason.
  # - An admin (other than the requester) approves or rejects it in Admin → Access requests.
  # - Once approved, the requester logs in again and comes in with that role. When the time is up,
  #   it automatically goes back to the previous role (audit log access.request.* / access.grant.expire).
  # It takes effect only on clusters whose RBAC binds that role's group: on a production cluster
  # that binds only viewer, the user still gets 403 after elevation.
  accessRequests:
    enabled: false
    maxHours: 8
    roles: [Write]
  # "Where do I request access" for users with no cluster at all, shown under "No accessible cluster"
  # on the dashboard and in Settings: one line of text and an http(s) link (an internal request form, etc.).
  # Quote the text if it contains # (a YAML comment). When empty, only the generic text is shown.
  accessHelp:
    text: ""
    url: ""

# EKS: the IRSA role the k8s-service and tool-server pods use to run aws-iam-authenticator, and the STS region
aws:
  irsaRoleArn: ""
  region: ""
# Per-service annotations for the service's own role (IRSA) or another cloud's workload identity.
# The audit S3 sink uses authService, and S3 session recording uses k8sService (overrides aws.irsaRoleArn).
serviceAccounts:
  authService:
    annotations: {}   # eks.amazonaws.com/role-arn: arn:aws:iam::<account>:role/kubeast-audit-sink
  k8sService:
    annotations: {}

# The console's own metrics. The 5 backends each expose Prometheus metrics at /metrics on their own port:
# request count, latency, requests in flight, audit store status and WebSocket subscriptions (docs/metrics.md).
# The gateway does not proxy /metrics. With prometheus-operator, use a ServiceMonitor.
# With networkPolicy.enabled, list the scraper in from to open the port. The 5 alerts are in prometheusRule.
metrics:
  enabled: true
  serviceMonitor:
    enabled: false
    interval: 30s
    labels: {}            # kube-prometheus-stack: {release: <that release name>}
  networkPolicy:
    from: []
  prometheusRule:
    enabled: false

# Service-to-service token. k8s-service's /internal routes (tool-server's kubeconfig lookup,
# auth-service's validate and invalidate) require, besides the user JWT, INTERNAL_API_TOKEN from the
# Secret kubeast-secrets as X-Internal-Token. The chart generates and keeps it.
# To rotate it, replace the value, then roll out auth-service, k8s-service and tool-server.
# If you use secrets.existingSecret, put it in that Secret.

# Node shell (privileged debug pod), off by default. When on, it uses a dedicated namespace and an image
# allow list (the first entry is the default). Images are pulled with IfNotPresent, so pin the version
# (or use an internal mirror address): nodes that already have the image do not go to the registry.
nodeShell:
  enabled: false
  images:
    - docker.io/library/busybox:1.38.0

# Pod security (Pod Security Standards restricted by default). On clusters that do not support
# user namespaces (kernel below 6.3), set hostUsers: true
podSecurity:
  enabled: true
  hostUsers: false
  readOnlyRootFilesystem: true

# Availability: set pdb.enabled: true when you raise replicas to 2 or more
replicas:
  gateway: 1
pdb:
  enabled: false
topologySpread:
  enabled: true
resources:               # per-container requests / memory limit (the full list is in values.yaml)
  aiService:
    requests: { cpu: 100m, memory: 256Mi }
    limits: { memory: 1Gi }

# AI keys: injected only as ai-service environment variables and not stored in the DB.
# Model settings (UI/CRD) point only to the variable name (api_key_env).
# If you have a Secret created by ESO or the like, set it in apiKeysSecret.
ai:
  openaiApiKey: ""
  anthropicApiKey: ""
  geminiApiKey: ""
  claudeCodeOAuthToken: ""  # Claude subscription setup-token (provider claude-code, personal use; see "4. Enable AI")
  apiKeysSecret: ""
  model: "gpt-4o-mini"
  baseUrlAllowedHosts: []  # register a host here when a model setting's base_url is a private address
                           # (in-cluster Ollama, internal LLM gateway).
                           # api_key_env is OPENAI/ANTHROPIC/GEMINI_API_KEY, CLAUDE_CODE_OAUTH_TOKEN (claude-code only) or KUBEAST_AI_KEY_*
  providers:
    claudeCode: { enabled: false, maxConcurrent: 1, turnTimeoutSeconds: 300, maxTurns: 10 }

# Built-in PostgreSQL (false = external DB) and Redis (false = k8s-service caches in memory; it is the only user of Redis)
postgresql:
  enabled: true
  user: kubeast
  password: ""          # when empty, generated at install and kept across upgrades (look it up in the secret). Required for an external DB (enabled: false)
  database: kubeast
redis:
  enabled: true
  password: ""          # requirepass — generated when empty (REDIS_PASSWORD)
networkPolicy:
  enabled: true         # default deny, plus only the flows the services use. Harmless on CNIs that do not enforce NetworkPolicy (kindnet, etc.)

# Gateway exposure
gateway:
  service:
    type: NodePort        # NodePort | ClusterIP | LoadBalancer
    nodePort: 30333
  trustedProxies: []      # CIDRs of front proxies (Ingress controller, LB) — the client address in the audit log is read from behind them
  allowedOrigins: []      # browser origins to open the API and WebSocket to besides the gateway's own host and the Ingress host (none = same host only)

# Ingress (optional)
ingress:
  enabled: false
  className: ""
  host: kubeast.example.com
  tls: false

# Multi-cluster load/failure isolation tuning
multicluster:
  maxClusters: 20
  healthcheckIntervalSec: 60
  rateLimitQPS: 0           # 0 = off
  breakerConsecutiveFails: 5
```

See [helm/kubeast/values.yaml](../helm/kubeast/values.yaml) for all options.
