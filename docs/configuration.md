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
    # A screen served from kubeast:cache asks whether the person may list or get what it shows. On, that read check
    # goes out once per group set as kubeast:group-check:<made at each start> and its allow stands for everyone with
    # those groups up to a minute; a refusal is asked again as the person. The cluster's audit log then names that
    # name for those checks. It relies on every authorizer allowing a person what it allows that name with the
    # person's groups: list a cluster with an authorizer that answers by user name (ahead of RBAC or after it), or
    # that limits the user names Kubeast may act as, and never bind the name (cluster-requirements §1).
    sharedReadChecks:
      enabled: false
      excludeClusters: []  # registered cluster ids that keep asking each person
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

# Availability: a Deployment you raise to 2 or more replicas, or whose autoscaling keeps minReplicas 2 or more, gets a PodDisruptionBudget (pdb.maxUnavailable, 1; pdb.enabled: false leaves them out), and every rollout starts the new pod and stops an old one only once the new one is ready (the old postgres and redis pods start stopping first)
# Probes: liveness asks /livez, which reads nothing else; readiness asks /readyz, which answers 503 from SIGTERM on and never asks the database (a shared database down would take every pod out at once); the database's state is in auth-service's and session-service's /health and k8s-service's kubeast_audit_store_up
# podShutdown.preStopSeconds: a pod behind a Service (not the bundled PostgreSQL and Redis, which have no preStop wait and the Kubernetes default grace period of 30 s) answers that long after it is told to stop (preStop sleep, Kubernetes 1.30 or later), then has 30 s to shut down (a server holding terminals: the drain's wait and close wait more); behind a load balancer that sends to pod IPs, longer than the load balancer takes to stop sending new requests to a leaving pod (behind an AWS Application Load Balancer the default 5 s was enough)
replicas:
  gateway: 1
# One HPA per service, off by default; k8sService and toolServer above 1 pod need redis.enabled (docs/high-availability.md)
autoscaling:
  gateway: { enabled: false, minReplicas: 2, maxReplicas: 3, targetCPUUtilizationPercentage: 80, behavior: {} }
pdb:
  enabled: true
  maxUnavailable: 1
# Terminals and followed logs on a server of their own, off by default (docs/operations.md
# "Terminals and followed logs on their own server")
streams:
  enabled: false
  replicas: 1            # stays 1: more than one stream server is not supported yet
  drainSeconds: 60       # how long open terminals get to end when their server is replaced (k8s-service when off)
  preStopSeconds: 10     # k8s-service-stream leaves the Service's endpoints this long before the drain starts
topologySpread:
  enabled: true
podShutdown:
  preStopSeconds: 5
resources:               # per-container requests / memory limit (the full list is in values.yaml)
  aiService:
    requests: { cpu: 100m, memory: 256Mi }
    limits: { memory: 1Gi }
  k8sServiceStream:      # streams.enabled only; k8sService's numbers for a start, not measured yet
    requests: { cpu: 100m, memory: 128Mi }
    limits: { memory: 512Mi }

# AI keys: injected only as ai-service environment variables and not stored in the DB.
# Model settings (UI/CRD) point only to the variable name (api_key_env).
# If you have a Secret created by ESO or the like, set it in apiKeysSecret.
ai:
  openaiApiKey: ""
  anthropicApiKey: ""
  geminiApiKey: ""
  claudeCodeOAuthToken: ""  # Claude subscription setup-token (provider claude-code, personal use; see "4. Enable AI")
  apiKeysSecret: ""
  model: "gpt-6-luna"
  baseUrlAllowedHosts: []  # register a host here when a model setting's base_url is a private address
                           # (in-cluster Ollama, internal LLM gateway).
                           # api_key_env is OPENAI/ANTHROPIC/GEMINI_API_KEY, CLAUDE_CODE_OAUTH_TOKEN (claude-code only) or KUBEAST_AI_KEY_*
  timelineChanges: false   # offer the AI tool timeline's changes view (what changed in a window, no value read) and the chat's instruction to read it first
  providers:
    claudeCode: { enabled: false, maxConcurrent: 2, maxConcurrentTotal: 0, memoryLimit: 2Gi, queueWaitSeconds: 60, turnTimeoutSeconds: 300, maxTurns: 10 }
    # maxConcurrent: Claude Code runs per ai-service server (memory); maxConcurrentTotal: across every replica
    # (0 = maxConcurrent); queueWaitSeconds: how long a turn waits for a slot before it ends as busy;
    # memoryLimit: ai-service's memory limit while the provider is on, if larger than resources.aiService.limits.memory

# Built-in PostgreSQL (false = external DB) and Redis (false = k8s-service caches in memory; tool-server only listens there for cluster changes)
postgresql:
  enabled: true
  user: kubeast
  password: ""          # when empty, generated at install and kept across upgrades (look it up in the secret). Required for an external DB (enabled: false)
  database: kubeast
  sessionLimits: { statementTimeoutMs: 30000, lockTimeoutMs: 15000, idleInTransactionTimeoutMs: 300000 }  # PostgreSQL statement_timeout, lock_timeout and idle_in_transaction_session_timeout each service SETs on its connections once connected (migrations always run without the first two, also when the role sets them); 0 sets nothing. Behind RDS Proxy a SET pins the session: set 0 and put them in the proxy's initialization query or on the database role. Through PgBouncer use session pooling only: transaction pooling hands a server connection to other clients between transactions, so a SET or a session advisory lock (the migrations', the audit dispatcher's) does not stay with its client
  pool: { authService: { maxConns: 20 }, sessionService: { maxConns: 20 }, k8sService: { maxConns: 10 }, aiService: { maxConns: 15 }, modelConfigController: { maxConns: 4 } }  # connections per pod; with the chart's PostgreSQL the install stops when the pods (a rollout's extra pod and autoscaling's maxReplicas counted) could open more than maxConnections, for an external database NOTES prints the sum to compare with its max_connections
  maxConnections: 300   # the chart's PostgreSQL max_connections
# An upgrade starts stopping Redis before its new pod is made (maxSurge 0): the new pod starts with an empty cache, and for the few seconds the old one takes to end both may exist, sharing no data (emptyDir).
redis:
  enabled: true
  password: ""          # requirepass while the Redis users are off — generated when empty (REDIS_PASSWORD)
  acl:
    enabled: true       # one Redis user per service ("Redis users" below); false = one password as before
    existingSecretHasKeys: false  # with secrets.existingSecret: true once that Secret holds the users' passwords
    existingSecret: ""            # a Secret of the users' keys alone; each service then reads only its own key
networkPolicy:
  enabled: true         # default deny, plus only the flows the services use. Harmless on CNIs that do not enforce NetworkPolicy (Flannel, etc.); kind's kindnet enforces it since kind 0.24

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
  breakerConsecutiveFails: 5  # requests in a row that could not reach the API server (no response to any call) that open a cluster's breaker; 0 = off, no request fails fast
  breakerOpenSec: 30        # an open breaker answers 503 this long, then lets one request try the cluster (0 = 30)
  clientQPS: 100            # client-go's rate to each cluster's API server
  clientBurst: 200
  reviewQPS: 0              # 0 = the access checks share clientQPS; see architecture.md "Many users"
  reviewBurst: 0
  wsWatchOpeningConcurrency: 8  # live lists of every cluster receiving their first objects at once, one cluster half of them while another waits; see architecture.md "Many users"
  wsWatchStreamWindowKiB: 1024  # HTTP/2 window of each live list's stream: memory a slow browser's watch holds against how fast a list comes over a long round trip; see architecture.md "Many users"
```

## Stages of new values

Each value this release adds, or whose meaning it changes, has a stage, written here and in its `values.yaml` comment:

- **alpha**: new. Its key or behaviour may change or go in a later release, which that release's notes say.
- **beta**: the feature stays. A key or a detail may change, with a release's notice and how to move.
- **stable**: the key and the behaviour stay. A renamed key is still read, with a warning, for one release.

A value that an install with the chart's defaults reads is beta; a value used only once you set it, or turn on the feature that reads it, is alpha. `pdb.*` makes no PodDisruptionBudget until a service runs two pods, and is beta from the node drain in its last column; the Redis users of `redis.acl.*` stay off in an install with `secrets.existingSecret` until `redis.acl.existingSecretHasKeys` or `redis.acl.existingSecret` is set. The last column says what has not been run with each value yet, or, after "Tested:", what has been run since.

| Value | Default | Stage | Not run yet, or Tested |
| --- | --- | --- | --- |
| `podShutdown.preStopSeconds` | 5 | beta | Tested: a server-side dry run of the default install on Kubernetes 1.29.14 (kind, the `PodLifecycleSleepAction` feature gate off), where the API server refused the seven Deployments with a preStop wait (`spec.template.spec.containers[0].lifecycle.preStop: Required value: must specify a handler type`) and took all 58 objects with `0` |
| `redis.acl.enabled`, `redis.acl.existingSecretHasKeys`, `redis.acl.existingSecret` | true, false, "" | beta | The users turned off in a test install |
| `replicas.k8sService` and `replicas.toolServer` above 1 | 1 | alpha | The sizes for 2 and 3 k8s-service pods |
| `autoscaling.<service>` | off | alpha | Tested: on EKS 1.35, HPAs on k8s-service and the gateway went from 2 to 3 pods and back, and were turned on and off, with no request through the load balancer failing |
| `postgresql.sessionLimits.*`, `postgresql.pool.<service>.maxConns`, `postgresql.maxConnections` | on, 20 · 20 · 10 · 15 · 4, 300 | beta | A long database outage |
| `pdb.enabled`, `pdb.maxUnavailable` | true, 1 | beta | Tested: on EKS 1.35, with two pods of each service, a node drained and replaced with no eviction held back and no request through the load balancer failing |
| `streams.*` | off | alpha | Any run on the kind dev install |
| `ai.providers.claudeCode.maxConcurrentTotal`, `queueWaitSeconds`, `memoryLimit` | 0, 60, 2Gi | alpha | A test install with the provider on |
| `gateway.accessLog.upstreamTimes` | false | alpha | Tested: 100 people opening the screens at once on the kind dev install with it on (2026-11-17), every access log line carrying the six fields |
| `multicluster.breakerConsecutiveFails` (`0` turns the breaker off from 0.7.8), `multicluster.breakerOpenSec` (read from 0.7.8) | 5, 30 | beta | A cluster cut off on the kind dev install |
| `multicluster.wsWatchOpeningConcurrency`, `multicluster.wsWatchStreamWindowKiB` | 8, 1024 | beta | Tested: upgrade rehearsals from 0.7.7 on kind (the default install, an existing Secret, an external database, AI off, 2 and 3 replicas) and on EKS 1.35, where a live list closed once and was back within 1.1 s when a node was drained, closed once and was back within 1.2 s when turning HPAs on took k8s-service from two pods to one, and did not close while the HPAs added and removed pods |
| `sharedReadChecks.enabled`, `sharedReadChecks.excludeClusters`, in the `auth` settings beside `customRoles` | false, [] | alpha | Tested: the whole e2e with it on, twice on the kind dev install with no failure, and 100 people opening the screens at once with no error |

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
- A new k8s-service pod that comes up before the new Redis answers (on an upgrade the old Redis pod starts stopping before the new one is made, maxSurge 0) keeps its cache in memory until Redis answers; it asks again every 5 s. It answers the same; only the cache is not shared meanwhile.
- With `secrets.existingSecret`, nothing changes on upgrade: Redis keeps the one password until `redis.acl.existingSecretHasKeys` is true.
- With that set, an upgrade that can read the Secret stops when a key is missing or empty, and names it. `helm template` and Argo CD cannot read it: there the `acl` container stops and says which key is missing, and k8s-service keeps its cache in memory.
- `redis.acl.enabled: false` renders Redis as before, with the memory cap.
- `helm rollback` to 0.7.7 brings back its Redis with the one password, which `kubeast-secrets` still holds, and its k8s-service signs in with it. A 0.7.7 k8s-service pod that comes up before that Redis answers keeps its cache in memory until it restarts. `kubeast-redis-users` stays, and the next upgrade uses its passwords again.

**Later.** TLS to an external Redis is not in this chart yet. The chart cannot point at an external Redis today: `REDIS_HOST` is the chart's `redis`, or empty.

See [helm/kubeast/values.yaml](../helm/kubeast/values.yaml) for all options.
