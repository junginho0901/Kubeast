**English** | [한국어](ko/configuration.md)

# Configuration (values.yaml)


Frequently used values:

```yaml
global:
  # The released chart already holds its own version. Set this only to run another build.
  imageTag: "vX.Y.Z"

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
  # kubeconfig Secret. When false, they get cluster-admin as before. auth-service may get the kube-system
  # namespace of that cluster (its UID, so a kubeconfig of the same cluster is not registered twice).
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
    userPrefix: ""  # e.g. kubeast:user: — before a person's address; moves User bindings to a new name (cluster-requirements §1)
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
  # roles names each role exactly; an entry that is a built-in's name in other capitals (WRITE) stands for the built-in.
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
# user namespaces (kernel below 6.3), set hostUsers: true. enabled: false sets no securityContext, leaving
# the uids and fsGroup to the platform, and Secret files then mount 0444 instead of 0440. A PVC you give
# audit.fileSinkVolume or sessionRecording.spoolVolume / fileVolume must then be writable by uid 65532
# by itself, unless the platform adds an fsGroup (OpenShift's restricted SCCs do)
podSecurity:
  enabled: true
  hostUsers: false
  readOnlyRootFilesystem: true

# Availability: set pdb.enabled: true when you raise replicas to 2 or more
# podShutdown.preStopSeconds: a pod behind a Service answers that long after it is told to stop (preStop sleep, Kubernetes 1.30 or later), then has 30 s to shut down (a server holding terminals: the drain's wait and close wait more); behind a load balancer that sends to pod IPs, set its deregistration delay plus a few seconds
replicas:
  gateway: 1
pdb:
  enabled: false
# Terminals and followed logs on a server of their own, off by default (docs/operations.md
# "Terminals and followed logs on their own server")
streams:
  enabled: false
  drainSeconds: 60       # how long open terminals get to end when their server is replaced (k8s-service when off)
topologySpread:
  enabled: true
podShutdown:
  preStopSeconds: 5
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

# Built-in PostgreSQL (false = external DB) and Redis (false = k8s-service caches in memory; tool-server only listens there for cluster changes)
postgresql:
  enabled: true
  user: kubeast
  password: ""          # when empty, generated at install and kept across upgrades (look it up in the secret). Required for an external DB (enabled: false)
  database: kubeast
redis:
  enabled: true
  password: ""          # requirepass while the Redis users are off — generated when empty (REDIS_PASSWORD)
  acl:
    enabled: true       # one Redis user per service ("Redis users" below); false = one password as before
    existingSecretHasKeys: false  # with secrets.existingSecret: true once that Secret holds the users' passwords
    existingSecret: ""            # a Secret of the users' keys alone; each service then reads only its own key
networkPolicy:
  enabled: true         # default deny, plus only the flows the services use. Harmless on CNIs that do not enforce NetworkPolicy (kindnet, etc.)

# Gateway exposure
gateway:
  service:
    type: NodePort        # NodePort | ClusterIP | LoadBalancer
    nodePort: 30333
  trustedProxies: []      # CIDRs of front proxies (Ingress controller, LB) — the client address in the audit log is read from behind them
  allowedOrigins: []      # browser origins to open the API and WebSocket to besides the gateway's own host and the Ingress host (none = same host only)
  accessLog:
    upstreamTimes: false  # true: each access log line also gives the request's time, the service's connect, header and response times (s), its address and the client's port

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
  clientQPS: 100            # client-go's rate to each cluster's API server
  clientBurst: 200
  reviewQPS: 0              # 0 = the access checks share clientQPS; see architecture.md "Many users"
  reviewBurst: 0
```

## Redis users

The chart's Redis (Valkey) gives each service that uses it a user of its own (`redis.acl.enabled`, on by default).

With `secrets.existingSecret`, Redis keeps one password (`REDIS_PASSWORD`) for every service until you turn the users on: put `REDIS_K8S_SERVICE_PASSWORD`, `REDIS_PROBE_PASSWORD` and, with the AI on, `REDIS_TOOL_SERVER_PASSWORD` in that Secret, then set `redis.acl.existingSecretHasKeys: true`. Until then the install notes say so.

| User | Can | Cannot |
|---|---|---|
| `k8s-service` | Keys and channels whose names start with `kubeast:`. Reads, writes and deletes of single keys, `SCAN` for the deletes by pattern, `PUBLISH`/`SUBSCRIBE` (the cluster change notices), `PING`, `SELECT` (`REDIS_DB`) | Any other key or channel. `FLUSHALL`, `FLUSHDB`, `KEYS`, `CONFIG`, `DEBUG`, `ACL`, `MONITOR`, `EVAL`, `SCRIPT` and every command not listed |
| `tool-server` (with the AI on) | The cluster change notice channel (`kubeast:clusters:changed:*`): `SUBSCRIBE`, `PING`, `SELECT` | Any key. Publishing. Every other command |
| `probe` | `PING`, for the readiness and liveness probes | Everything else |
| `default` | Nothing: it is off | A connection that has not signed in as a user above gets `NOAUTH` for every command |

- The rules are `kubeast.redisUsersAcl` in `helm/kubeast/templates/_helpers.tpl`. A command k8s-service starts to use goes there.
- go-redis sends `CLIENT SETINFO` and `CLIENT MAINT_NOTIFICATIONS` when it connects. Redis refuses both, and go-redis goes on.
- The rules need Valkey, or Redis 6.2 or later, in `images.redis`. A command the image does not know stops Valkey at start.
- tool-server listens to k8s-service's cluster change notices and drops that cluster's kubeconfigs, so every tool-server replica drops them at once, not only the one auth-service calls.
- A notice names the cluster and the k8s-service process that sent it, nothing else (`services/pkg/clusternotice`). The next tool call reads the kubeconfig from k8s-service again, which checks the person's access again, so a notice that is not genuine costs one read.
- A notice lost, or Redis down, costs at most the 10 s tool-server keeps a kubeconfig.

**Passwords.**

- Each user's password is generated at install, 32 characters, in the Secret `kubeast-redis-users` (`REDIS_K8S_SERVICE_PASSWORD`, `REDIS_PROBE_PASSWORD`, `REDIS_TOOL_SERVER_PASSWORD`).
- It is kept across upgrades and stays after `helm uninstall`, like `kubeast-secrets`.
- It is not in `kubeast-secrets`, which every service reads whole as its environment. The redis pod reads them, and k8s-service and tool-server each read their own.
- With `secrets.existingSecret` and `redis.acl.existingSecretHasKeys: true`, the keys are read from that Secret. Every backend reads that Secret whole as its environment, so each then holds every Redis user's password, and the install notes say so.
- To give each service its own key only, put the keys in a Secret of their own and set `redis.acl.existingSecret` to it. The users are on, the redis pod and each service read their key from it, and the main Secret need not hold them.
- To change one, write the new value into the Secret, then restart `redis` and the service it belongs to.

**How Valkey reads them.**

- The redis pod's first container, `acl`, reads the passwords from the Secret as files.
- It writes their SHA-256 into the ACL file, on a volume in memory, and makes the file read-only. Valkey starts with `--aclfile`.
- No password is in the pod spec or in Valkey's arguments. The probes read theirs from `REDISCLI_AUTH`.
- A change to the rules restarts Valkey (`checksum/redis-users` on the pod, a hash of the rules without the passwords).

**Network.** With `networkPolicy.enabled`, Redis takes connections only from k8s-service and tool-server pods in the release namespace, on port 6379. The probes run inside the redis container and need no rule.

**Memory.**

- Valkey evicts at 80% of `resources.redis.limits.memory` (`maxmemory`, 107374182 bytes for the default 128Mi), so it evicts before the container reaches its limit.
- Without a limit it stops at 80% of 128Mi.
- The policy is `volatile-lru`: only keys with a TTL are evicted. The cache's keys all have one. A key without one is never evicted.

**Upgrading from 0.7.7 or earlier**, which had one password (`REDIS_PASSWORD`):

- The upgrade adds `kubeast-redis-users` and keeps every value of `kubeast-secrets`, `REDIS_PASSWORD` included.
- Redis and k8s-service restart. The cache starts empty, as on any restart of Redis.
- Until the old k8s-service pod has gone, its requests to the new Redis are refused and read as cache misses.
- A new k8s-service pod that comes up while only the old Redis answers keeps its cache in memory until it restarts. It answers the same; only the cache is not shared.
- With `secrets.existingSecret`, nothing changes on upgrade: Redis keeps the one password until `redis.acl.existingSecretHasKeys` is true.
- With that set, an upgrade that can read the Secret stops when a key is missing or empty, and names it. `helm template` and Argo CD cannot read it: there the `acl` container stops and says which key is missing, and k8s-service keeps its cache in memory.
- `redis.acl.enabled: false` renders Redis as before, with the memory cap.
- `helm rollback` to 0.7.7 brings back its Redis with the one password, which `kubeast-secrets` still holds, and its k8s-service signs in with it. A 0.7.7 k8s-service pod that comes up before that Redis answers keeps its cache in memory until it restarts. `kubeast-redis-users` stays, and the next upgrade uses its passwords again.

**Later.** TLS to an external Redis is not in this chart yet. The chart cannot point at an external Redis today: `REDIS_HOST` is the chart's `redis`, or empty.

See [helm/kubeast/values.yaml](../helm/kubeast/values.yaml) for all options.
