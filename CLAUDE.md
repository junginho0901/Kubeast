# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

This repo is **Kubeast** — a Kubernetes operations platform combining a natural-language AI assistant with a rich multi-cluster dashboard. It is a polyglot microservice system (Go + Python + React) deployed to Kubernetes via Helm, with a kind-based local dev loop.

See [AGENTS.md](AGENTS.md) for the project-specific rules every contributor (human or AI) must follow — most importantly the **audit-log requirement** summarized below.

## Architecture

Requests enter through an NGINX **gateway** (`:8000`) that routes to backend services. Each service owns one concern and a slice of the data layer (Postgres for durable state, Redis for cache/session context).

| Service | Lang | Port | Module path / dir | Role |
| --- | --- | --- | --- | --- |
| `gateway` | NGINX | 8000 | `k8s/nginx.conf` | Routing, CORS, SSE/WebSocket proxy. No image build — ConfigMap only. |
| `auth-service` | Go | 8004 | `services/auth-service-go` | JWT issuance, JWKS, org/team/user hierarchy, RBAC |
| `ai-service` | Python/FastAPI | 8001 | `services/ai-service` | LLM integration, streaming chat, log analysis, tool calling |
| `k8s-service` | Go | 8002 | `services/k8s-service-go` | K8s resource CRUD, WebSocket logs/exec, topology, Helm, GPU/DRA |
| `session-service` | Go | 8003 | `services/session-service-go` | Chat session / message history |
| `tool-server` | Go | — | `services/tool-server` | Backend for AI tool calls |
| `model-config-controller-go` | Go | — | `services/model-config-controller-go` | controller-runtime operator for the `ModelConfig` CRD |
| `frontend` | React/Vite/TS | 5173 | `frontend` | UI |

**AI tool-calling flow**: `ai-service` (chat orchestration, provider adapters for OpenAI/Anthropic/Gemini) dispatches whitelisted tools (`app/services/tool_whitelists.py`) to `tool-server`, which calls the K8s API. Tool results stream back to the chat.

### Go module layout

Go services are **separate modules** (not a go.work workspace). Shared code lives in `services/pkg` (module `github.com/junginho0901/kubeast/services/pkg`) and is wired into each service via a `replace ... => ../pkg` directive in its `go.mod`. `services/pkg` provides:
- `audit/` — the shared audit-log API (see below)
- `auth/` — JWT verification (`jwt.go`)
- `config/`, `logger/`, `response/` — config loading, slog setup, HTTP response helpers

A Go service follows a `cmd/server/main.go` → `internal/routes` (route registration) → `internal/handler` (one file per resource kind, e.g. `pods.go`, `deployments.go`, `helm*.go`) → `internal/k8s` (client logic) layering. The `k8s-service` also has `internal/ws` (WebSocket logs/exec), `internal/helm`, and `internal/cache`.

## Audit logging — mandatory (read before touching any Go handler)

> Authoritative rules: [AGENTS.md](AGENTS.md) and [docs/audit-log-plan.md](docs/audit-log-plan.md). PRs that add/modify a write-class HTTP handler **without** an audit call are rejected.

Every **write-class HTTP handler** (create/update/delete/rollback/restart/…) and every **sensitive read** (Secret reveal, Node shell, Pod logs sensitive access, Cronjob trigger, audit-log read itself) MUST record an audit entry via `services/pkg/audit`. Plain list/get reads and health/public endpoints are excluded.

- **Action names are strict**: `<domain>.<object>.<verb>` (e.g. `k8s.pod.delete`, `helm.release.rollback`, `ai.tool.execute`, `admin.audit.read`). New actions must be added to the catalog in `docs/audit-log-plan.md §5-2` **first** (update the plan doc before the code).
- **Record both success and failure** — on failure set `rec.Result = audit.ResultFailure` and fill `rec.Error`.
- Audit writes are **best-effort**: a Postgres failure must NOT abort the underlying operation. Log with `slog.Error` and still return the normal response.
- Mask sensitive fields (password/secret/token/apikey) with `audit.MaskSensitive(...)` before storing in `Before`/`After`.
- Every new `docs/*-plan.md` must include a `## N. 감사 로그` section (record-target actions + permission/audit-action mapping table).

The handler pattern is documented in [AGENTS.md](AGENTS.md); use `audit.FromHTTPRequest(r)` to seed a record, then set `Service` (`audit.ServiceK8s` / `ServiceHelm` / `ServiceAI` / `ServiceAuth` / `ServiceAdmin`), `Action`, actor, target, and write via the handler's `auditStore`.

## Build & deploy

**Always build/deploy through `scripts/rebuild-kind.sh`** — do not run raw `docker build` / `kubectl` for deploys (per AGENTS.md). It builds the image, loads it into the kind cluster, and rollout-restarts the deployment.

```bash
scripts/rebuild-kind.sh ai-service frontend     # rebuild specific services
scripts/rebuild-kind.sh --all                   # rebuild everything
scripts/rebuild-kind.sh --list                  # list buildable services
scripts/rebuild-kind.sh --tag dev k8s-service   # custom image tag
```

The script resolves KUBECONFIG in priority order: `$KUBECONFIG_PATH` → single-file `$KUBECONFIG` → repo-local `.kubeconfig-kind` → `/tmp/kubeast-kubeconfig`. Note: the auth/k8s/session Go services share build context `services/` with explicit Dockerfiles (`<svc>-go/Dockerfile`).

Production-grade install paths: `helm/kubeast` (Helm chart), `install.sh` (one-liner for an existing cluster), `install-docker.sh` + `docker-compose.yml` (single-host, no cluster). `k8s/` holds raw manifests for reference.

## Per-component dev & test

**Go services** (run inside each `services/<svc>-go` dir):
```bash
go run ./cmd/server          # run locally
go test ./...                # all tests (standard go test; *_test.go alongside source)
go test ./internal/helm/...  # single package
```

**Python ai-service** (`services/ai-service`):
```bash
pip install -r requirements.txt          # or requirements-dev.txt for tests
uvicorn main:app --reload --port 8001
pytest                                   # config in pytest.ini (asyncio_mode=auto)
pytest tests/test_tools.py               # single file
```

**Frontend** (`frontend`):
```bash
npm install
npm run dev      # http://localhost:5173
npm run build    # tsc typecheck + vite build
npm run lint     # eslint, --max-warnings 0 (warnings fail)
npm run test     # vitest run
```

Frontend source under `frontend/src`: `pages/` (route-level, grouped by resource domain), `components/`, `hooks/`, `services/` (API clients), `i18n/` (ko/en via i18next). Heavy use of TanStack Query, Monaco editor, xterm.js (Node Shell), and React Flow / dagre / elkjs (Topology & Dependency graphs).

## E2E tests (Playwright)

`e2e/` runs **against the live kind cluster's gateway**, not a dev server. Tests are serialized (`workers: 1`, `fullyParallel: false`) because they mutate shared single-cluster K8s state. Many specs are **visual-regression baselines** — snapshots captured on `main` must match pixel-for-pixel (within `maxDiffPixels: 100`) on feature branches.

```bash
cd e2e
npx playwright test                      # run all (set E2E_BASE_URL if not :30080)
npx playwright test ai-chat.spec.ts      # single spec
npm run baseline                         # playwright test --update-snapshots (regenerate baselines)
```

`auth.setup.ts` is a setup project that logs in once and stores state in `.auth/user.json`; all chromium tests depend on it.
