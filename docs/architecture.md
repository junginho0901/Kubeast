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
| `features.prometheus`, `logSearch`, `tracing`, `traceStore`, `alertStore`, `cost`, `policyReports`, `hygiene`, `inPlaceResize`, `logFiles` | 0 | 0 | None; works only when the UI or the AI asks (the hygiene check is also computed when its screen opens) |

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
