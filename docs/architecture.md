**English** | [한국어](ko/architecture.md)

# Architecture


The NGINX gateway receives every request and routes it to each microservice. PostgreSQL holds persistent state, and Redis holds cache/session context.

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

**AI Tool-calling flow**: `ai-service` orchestrates the chat and dispatches allowlisted tools to `tool-server` → `tool-server` calls the K8s API of the selected cluster → the results are streamed to the chat.

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
| `postgres` | — | 5432 | Main DB (durable state) — PostgreSQL 18 |
| `redis` | — | 6379 | k8s-service cache — Valkey 9.1 (Redis protocol). With `redis.enabled: false`, k8s-service caches in memory |

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

> Release: pushing a `v*` tag makes GitHub Actions (`.github/workflows/release.yaml`) automatically build and publish the 7 images to ghcr and package the Helm chart.

## Resource usage

Measured with `scripts/kind-footprint.sh` (2026-10-20, single kind node, container memory working set every minute — the same basis as `kubectl top` — and CPU). "Idle" is the 90th percentile over 30 minutes (15 minutes for the default install) of nobody using it right after install, and "busy" is the maximum while 9 list APIs of the UI were called continuously, 4 at a time, for 2 minutes. The cleanup job that runs once a day also runs once when the server starts, so it falls within this window.

| Install | Pods | Total requests (CPU / memory) | Idle memory | Busy maximum | Idle CPU / busy |
| --- | --- | --- | --- | --- | --- |
| Minimal (`-f helm/kubeast/values-minimal.yaml`) | 6 | 140m / 376Mi | 138 MiB | 202 MiB | 3m / 483m |
| Default (chart as is) | 10 | 530m / 992Mi | 295 MiB | 353 MiB | 10m / 537m |

Per pod (default install, MiB): ai-service 106 · postgres 64 (133 on dev with accumulated data) · controller 33 → 16 · k8s-service 28 (84 when busy) · auth-service 16 (24 when busy) · tool-server 14 · frontend 11 · session-service 9 · redis 9 · gateway 6. Busy CPU is almost all k8s-service (reading lists from the Kubernetes API and organizing them). The requests of the minimal install are: memory = the larger of the idle 90th percentile and the busy maximum + 15% (memory above the request is evicted first under node pressure), CPU = idle + 15%, minimum 25m; limits are the chart defaults.

| Turned on | Added pods | Idle memory | Background work |
| --- | --- | --- | --- |
| `ai.enabled` (on by default) | 3 — ai-service · tool-server · ModelConfig controller | +about 155 MiB | The controller watches ModelConfigs. ai-service and tool-server only when requests come in |
| `redis.enabled` (on by default) | 1 | +9 MiB | None — when off, k8s-service caches in memory (it is the only user of Redis) |
| `mcp.enabled` | 0 | about +15 MiB inside ai-service (MCP SDK) | None |
| `features.alertInvestigation` | 0 | 0 | None — investigates when an alert webhook arrives |
| `sessionRecording.enabled` | 0 | 0 | Uploads chunks while exec or a node shell is open |
| `nodeShell.enabled` | 1 per node while a shell is open | 0 | None |
| `features.prometheus`·`logSearch`·`tracing`·`traceStore`·`alertStore`·`cost`·`policyReports`·`hygiene`·`inPlaceResize`·`logFiles` | 0 | 0 | None — only when the UI or the AI asks (the hygiene check is also computed when its screen opens) |

Always-running work: auth-service — audit record sealing every 10 seconds (`audit.integrity.sealSeconds`) · reverting expired access requests every minute · cleaning up records past retention every 24 hours (once at startup) · with `dormantAccounts` on, dormant account lockout every 24 hours · audit anchor (when an S3 sink is set) every 24 hours. k8s-service — health check of each registered cluster every 60 seconds (`multicluster.healthcheckIntervalSec`) · cleanup of the informer caches of clusters not used for a long time. The MCP, alert investigation, session recording, node shell and `features.*` rows are based on the code (no pods are created, so they were not measured separately; the MCP value was measured on 2026-10-13).

To measure again: `scripts/kind-footprint.sh up` → `measure <name> 30` → `load <name> 2` → `step <name> 15 --set ai.enabled=true` → `down` (creates a `kubeast-fp` cluster separate from the dev cluster).
