**English** | [한국어](ko/architecture.md)

# Architecture


The NGINX gateway receives every request and routes it to the microservices. PostgreSQL holds persistent state, and Redis holds cache/session context.

```
                         ┌──────────────────────────┐
                         │  Frontend (React + Vite) │
                         └────────────┬─────────────┘
                                      │
                         ┌────────────▼─────────────┐
                         │  Gateway (NGINX, :8000)  │  routing · CORS · SSE/WS proxy
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
   │ Postgres │        │  Redis   │               │ K8s API  │ (multi-cluster)
   └──────────┘        └──────────┘               └──────────┘

   model-config-controller (controller-runtime) — watches the ModelConfig CRD
```

**AI tool-calling flow**:

1. `ai-service` orchestrates the chat and dispatches allowlisted tools to `tool-server`.
2. `tool-server` calls the K8s API of the selected cluster.
3. The results are streamed to the chat.

## Services

| Service | Language | Port | Role |
| --- | --- | --- | --- |
| `gateway` | NGINX | 8000 | API routing, CORS, SSE/WebSocket proxy (no image build, config only) |
| `auth-service` | Go | 8004 | Authentication, JWT/JWKS, organizations/teams/RBAC, cluster registry |
| `ai-service` | Python (FastAPI) | 8001 | LLM integration, streaming chatbot, optimization suggestions, Tool calling |
| `k8s-service` | Go | 8002 | K8s resource CRUD, WS logs/exec, topology, Helm, GPU/DRA, multi-cluster pool |
| `session-service` | Go | 8003 | Chat sessions / message history |
| `tool-server` | Go | — | AI Tool call backend (runs kubectl) |
| `model-config-controller` | Go (controller-runtime) | — | `ModelConfig` CRD controller |
| `frontend` | React + Vite + TS | 5173 | UI (static build in prod, served by nginx) |
| `postgres` | — | 5432 | Main DB (durable state), PostgreSQL 18 |
| `redis` | — | 6379 | k8s-service cache, Valkey 9.1 (Redis protocol). With `redis.enabled: false`, k8s-service caches in memory |

## Container images

All are published as public packages on ghcr.io.

```
ghcr.io/junginho0901/kubeast-frontend
ghcr.io/junginho0901/kubeast-auth-service
ghcr.io/junginho0901/kubeast-ai-service
ghcr.io/junginho0901/kubeast-k8s-service
ghcr.io/junginho0901/kubeast-session-service
ghcr.io/junginho0901/kubeast-tool-server
ghcr.io/junginho0901/kubeast-model-config-controller-go
```

> Release: pushing a `v*` tag starts GitHub Actions (`.github/workflows/release.yaml`), which builds the 7 images, publishes them to ghcr and packages the Helm chart.

## Resource usage

Measured with `scripts/kind-footprint.sh` on 2026-10-20, on a single kind node. Container memory (working set, the same basis as `kubectl top`) and CPU were sampled every minute.

- "Idle" is the 90th percentile over 30 minutes right after install, with nobody using it (15 minutes for the default install).
- "Busy" is the maximum while 9 list APIs of the UI were called continuously, 4 at a time, for 2 minutes.

The cleanup job that runs once a day also runs once when the server starts, so it falls within this window.

| Install | Pods | Total requests (CPU / memory) | Idle memory | Busy maximum | Idle CPU / busy |
| --- | --- | --- | --- | --- | --- |
| Minimal (`-f helm/kubeast/values-minimal.yaml`) | 6 | 140m / 376Mi | 138 MiB | 202 MiB | 3m / 483m |
| Default (chart as is) | 10 | 530m / 992Mi | 295 MiB | 353 MiB | 10m / 537m |

Per pod in the default install (MiB):

- ai-service 106
- postgres 64 (133 on dev, with accumulated data)
- controller 33 → 16
- k8s-service 28 (84 when busy)
- auth-service 16 (24 when busy)
- tool-server 14
- frontend 11
- session-service 9
- redis 9
- gateway 6

Busy CPU is almost all k8s-service, which reads lists from the Kubernetes API and organizes them.

The requests of the minimal install are set as follows:

- Memory: the larger of the idle 90th percentile and the busy maximum, plus 15%. Memory above the request is evicted first under node pressure.
- CPU: idle plus 15%, minimum 25m.
- Limits: the chart defaults.

| Turned on | Added pods | Idle memory | Background work |
| --- | --- | --- | --- |
| `ai.enabled` (on by default) | 3: ai-service, tool-server, ModelConfig controller | +about 155 MiB | The controller watches ModelConfigs. ai-service and tool-server work only when requests come in |
| `redis.enabled` (on by default) | 1 | +9 MiB | None. When off, k8s-service caches in memory (it is the only user of Redis) |
| `mcp.enabled` | 0 | about +15 MiB inside ai-service (MCP SDK) | None |
| `features.alertInvestigation` | 0 | 0 | None; it investigates when an alert webhook arrives |
| `sessionRecording.enabled` | 0 | 0 | Uploads chunks while exec or a node shell is open |
| `nodeShell.enabled` | 1 per node while a shell is open | 0 | None |
| `features.prometheus`, `logSearch`, `tracing`, `traceStore`, `alertStore`, `networkFlows`, `networkFlowMonitor`, `cost`, `policyReports`, `hygiene`, `inPlaceResize`, `logFiles` | 0 | 0 | None; works only when the UI or the AI asks (the hygiene check is also computed when its screen opens) |

Work that always runs:

- auth-service:
  - seals audit records every 10 seconds (`audit.integrity.sealSeconds`)
  - reverts expired access requests every minute
  - cleans up records past retention every 24 hours, and once at startup
  - with `dormantAccounts` on, locks dormant accounts every 24 hours
  - when an S3 sink is set, writes the audit anchor every 24 hours
- k8s-service:
  - checks the health of each registered cluster every 60 seconds (`multicluster.healthcheckIntervalSec`)
  - cleans up the informer caches of clusters not used for a long time

The MCP, alert investigation, session recording, node shell and `features.*` rows are based on the code. They create no pods, so they were not measured separately. The MCP value was measured on 2026-10-13.

To measure again, run these steps. They create a `kubeast-fp` cluster, separate from the dev cluster.

1. `scripts/kind-footprint.sh up`
2. `measure <name> 30`
3. `load <name> 2`
4. `step <name> 15 --set ai.enabled=true`
5. `down`

## Many users

Measured on 2026-10-30 with one k8s-service at the chart's limits (512 Mi; gateway 256 Mi), on a laptop kind cluster, against a KWOK cluster of 1 001 nodes and 50 000 pods. The requests were sent from inside the kind network; the laptop's Docker port forwarding drops connections under a crowd and was not used for these numbers.

| What | Result |
| --- | --- |
| 500 people keeping the Pods page or Cluster View open (polls every 2 s, 8 node boxes each — 2 000 live watches), pods restarted during the run | 0 errors · p95 325 ms · every socket got the changes · k8s-service at most 427 MiB, CPU 1.9 cores on average |
| 300, 400, 500 people opening the Pods page and Cluster View at the same instant (11 requests each) | 0 errors, no restart · k8s-service at most 413 MiB · gateway at most 103 MiB · the last answer after 17, 30 and 29 s |

What sets these limits:

- `multicluster.wsMaxSubscriptions` (2 000): every live watch on a screen is one watch on the cluster as the user. Past the limit, a screen loads but does not update, says so and asks again by itself, spread over half a minute and more. A drawer shares the list watch of the page behind it instead of opening its own, and most drawers follow their object on the read they already make every 10 s, which costs no watch.
- The node boxes of Cluster View are read once per node for everyone asking at that moment, as `kubeast:cache`, and each person keeps the namespaces its own identity may list pods in (a SelfSubjectAccessReview, 60 s); a namespace that check refuses is listed as that person, so the cluster decides there. The namespace list comes from what k8s-service keeps for a caller the cluster lets list namespaces.
- What different people still ask as themselves is one access check per kind a screen shows, remembered for a minute: about eight for one person's Dashboard, Pods and Cluster View, about 4 × N with a grant limited to N namespaces, plus that grant's namespace reads (counted from the code, `TestFirstScreensOfOnePersonListNoPodsAsThatPerson`). They queue on the client's rate to that cluster, `multicluster.clientQPS` (100 a second) and `clientBurst` (200). Raising that rate on 2026-10-30, when the node boxes were still read as each user, moved the queue to the test cluster's API Priority and Fairness and the node boxes waited longer. `multicluster.reviewQPS` and `reviewBurst` give the access checks a rate of their own and leave the reads' rate as it is; a check reads nothing from the API server's storage. For K different people opening their first screens at the same moment, a burst of about 8 × K checks lets none of them wait on the rate.
- The Pods page, the node map and the node list are answered from what k8s-service keeps (measured up to 500 people at once). Their work on the rows runs on as many at once as there are CPUs.
- The gateway holds proxy buffers for every request in flight, about 30–90 KB each.
- One person's identical reads at one moment are at most two reads of the cluster: the drawers, the access checks and the reads of a namespace's pods (`handler.Shared`, `internal/flight`). A read started before a request came does not answer it, and an answer never crosses to other claims.
- `multicluster.bigReadConcurrency` (2): reads of more than one page (pods, ReplicaSets, ControllerRevisions) that run at once in one k8s-service; the others wait, and a read of one page waits for none. One read of a 50 000-pod namespace asks 39 to 78 pages a second and holds up to about 110 MiB.
- `multicluster.wsWatchStartConcurrency` (16): watches of one cluster starting at once, since client-go does not rate limit watches. A wait past 10 s tells the page its list is not following.
- `multicluster.toolServerKubectlConcurrency` (3): kubectl processes in tool-server, about 40 MiB each in one container of 256 Mi; the others wait inside their call's 60 s, and the Go collector's limit is lowered by that memory.
