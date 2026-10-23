**English** | [한국어](ko/development.md)

# Development

## Directory layout

```
.
├── services/
│   ├── ai-service/                  # Python · FastAPI · LLM integration / Tool calling
│   ├── auth-service-go/             # Go · auth / RBAC / cluster registry
│   ├── k8s-service-go/              # Go · K8s resource API / Helm / multi-cluster
│   ├── session-service-go/          # Go · chat sessions
│   ├── tool-server/                 # Go · AI Tool backend (kubectl)
│   ├── model-config-controller-go/  # Go · ModelConfig CRD controller
│   └── pkg/                         # Go shared code (audit / auth / cluster / config …)
├── frontend/                        # React + TS + Tailwind
├── helm/kubeast/                    # Helm chart — the single manifest source for every install path (canonical nginx.conf = files/nginx.conf)
├── deploy/kind/                     # local kind dev install values (values.yaml; personal values in values.local.yaml, git-ignored)
├── deploy/examples/target-cluster/   # example values for target-cluster prerequisites (Prometheus·OpenCost charts, per-cluster RBAC values — docs/cluster-requirements.md)
├── docs/                            # operations docs (cluster prerequisites·SSO·metrics·audit·backup·supply chain)
├── e2e/                             # Playwright E2E (against a live cluster)
│   ├── actions/                     # opt-in action suite — 92 UI actions + kubectl checks (E2E_ACTIONS=1 --project=actions)
│   └── demo/                        # scripts that record the project site's clips (E2E_DEMO=1 --project=demo, scripts/site-media.sh)
├── scripts/                         # build/deploy/dev scripts
├── site/                            # project site (GitHub Pages, .github/workflows/pages.yaml)
├── install.sh                       # K8s one-line install
├── install-docker.sh                # Docker one-line install
└── docker-compose.yml               # (+ docker-compose.build.yml build override)
```

---

## kind dev loop

The local dev loop is based on kind, and the dev cluster is installed from **the same Helm chart**. `deploy/kind/values.yaml` holds only the dev differences, such as NodePort 30080, a localhost origin, demo accounts and a 60-minute token.

Builds and deploys **always go through `scripts/rebuild-kind.sh`**, not direct docker or kubectl commands.

```bash
scripts/kind-deploy.sh                        # first time: create kind + build·load images + helm install
scripts/rebuild-kind.sh ai-service frontend   # rebuild+deploy specific services
scripts/rebuild-kind.sh --all                 # everything
scripts/rebuild-kind.sh gateway               # nginx.conf only: helm upgrade with the release's values (no image build)
scripts/reset-and-deploy.sh [--keep|--db]     # recreate everything / reinstall only the release and DB / only empty the DB
```

kind nodes pull the postgres, redis and nginx images from the registry. When that fails behind a proxy, `kind-deploy.sh` puts the same images from the host's docker into the nodes, so `docker pull` them beforehand.

AI chat and the AI e2e specs need one default model registered:

- **Ollama on your laptop**: register it with `kubectl apply -f deploy/kind/modelconfig-ollama.yaml` (model `granite4.1:3b`, `host.docker.internal:11434`).
  - The dev values allow that address in `ai.baseUrlAllowedHosts` and the NetworkPolicy.
  - Apply it again after a reset.
- **All of e2e without inference on the laptop**: `scripts/kind-model-haiku.sh up <key-file>` makes Anthropic Claude Haiku (`claude-haiku-5-5`, the cheapest model) the default model for that run.
  - The key goes from the file only into the Secret `kubeast-ai-keys` and is never printed.
  - Afterwards, `down` restores the Ollama default and removes the key.
- **AI specs with the Claude subscription provider**: first build ai-service with `WITH_CLAUDE_CODE=true`. Then use `scripts/kind-model-subscription.sh up <token-file>` and `down` the same way.
  - The token is the `claude setup-token` value.

The scripts run helm upgrade with the chart of the checkout they sit in, so while working on a branch, run them from that worktree.

### E2E tests (Playwright)

`e2e/` runs against **the dev kind cluster's gateway** (`E2E_BASE_URL`, default `http://localhost:30080`), not a dev server. It runs one test at a time (`workers: 1`) because it changes shared cluster state. Visual comparison specs compare against baseline images taken on main.

```bash
export KUBECONFIG=$PWD/.kubeconfig-kind      # so specs that call kubectl see only dev kind (no default kubeconfig)
export E2E_USER_EMAIL=admin E2E_USER_PASSWORD="$(kubectl -n kubeast get secret kubeast-secrets -o jsonpath='{.data.DEFAULT_ADMIN_PASSWORD}' | base64 -d)"
cd e2e && npx playwright test                 # all
npx playwright test cluster-hygiene.spec.ts   # one spec
```

Prerequisites (without them, the spec does not fail but skips and records the reason):

- **Second cluster `default`** — created with `scripts/add-kind-cluster.sh default --addons`. It is a kind cluster with no `kubeast` namespace. It has:
  - metrics-server, kube-state-metrics, node-exporter and a small Prometheus
  - an OpenCost that reads that Prometheus and is scraped by it (`deploy/kind/second-cluster.yaml`)
  - Kyverno 1.19 with two Audit policies (`deploy/kind/kyverno-values.yaml` and `kyverno-policies.yaml`), the source of the PolicyReports that `policy-reports.spec.ts` reads
    - Kyverno is chart 3.9.2 rendered with `helm template --no-hooks` and applied server-side.
    - `default` must have no Helm release for the empty-list baseline of `helm.spec.ts` to hold.
  - Screens opened without `?cluster=` show this cluster, so drawer specs that need objects pin `?cluster=self`.
- **Fixtures** — `deploy/kind/fixtures.yaml`, applied by `kind-deploy.sh`, holds:
  - a CronJob, a TLS Ingress, a StatefulSet, an HPA, a RuntimeClass and an Argo CD-annotated Deployment
  - two broken objects for the issues specs: an unschedulable Deployment and a failed Job
  - `e2e-logfile-writer`, which writes its logs only to files (for `logfiles.spec.ts`)
  - The dev values also turn on `features.prometheus.enabled` and `features.logFiles` (`/var/log/app/*.log`, `default`).
- **AI specs** — one default model (the Ollama `ModelConfig` above).
- **Audit sink and session recording specs** — `deploy/kind/devtools.yaml` (S3 stand-in, Mailpit, webhook receiver) and the sinks and `sessionRecording.enabled` in the dev values.
- A reset removes all of the data above, so create it again.

`e2e/actions/` is an opt-in action suite. It runs 92 UI actions against the second cluster and checks them with `kubectl`, which takes about 12 minutes.

It is not part of the default run. Run it with `E2E_ACTIONS=1 npx playwright test --project=actions`. Prerequisites are in [e2e/actions/README.md](../e2e/actions/README.md).

### Project site (`site/`)

[https://junginho0901.github.io/Kubeast/](https://junginho0901.github.io/Kubeast/) is `site/`, a static page in English with a Korean switch: `index.html`, `style.css`, `app.js` and `particles.js`.

`.github/workflows/pages.yaml` publishes it to GitHub Pages when it changes on main. The feature clips (`site/media/<name>.mp4` and a poster `.jpg`) are recorded on the dev clusters from the scripts `e2e/demo/<name>.demo.ts`.

```bash
scripts/site-media.sh              # every clip
scripts/site-media.sh logs helm    # only these
```

- The script puts a recording shop (`e2e/demo/shop.yaml`) and a three-revision Helm release (`e2e/demo/chart`) on the second cluster and removes them after.
- The recordings are the `demo` project, which exists only with `E2E_DEMO=1`, so they are not in the default run.
- Only what a script shows between `show()` and `hide()` stays in the clip (page loads and waits such as an investigation are cut).
- `step(id)` marks where the clip's step list on the site moves on. The script writes those times to `site/media/steps.js`.
- Recording needs `ffmpeg` (`brew install ffmpeg`) and the same `E2E_USER_EMAIL` and `E2E_USER_PASSWORD` as the E2E.
- The AI clips (`ai-chat`, `floating-chat`, `alert-investigation`, `masking`) need a default model that answers well. Run `scripts/kind-model-subscription.sh up`, record, then run `down`.
- When a screen changes, record its clip again.
- Recording `floating-chat` also writes `docs/images/floating-chat.gif`, the picture at the top of both READMEs.
- The deploy adds `?v=<commit>` to the stylesheet, the scripts and the clips in `index.html`, because Pages serves files with `max-age=600` and a reload fetches only the page. The checked-in `index.html` has none.
- Check a change on phones in both engines: Playwright WebKit (every iOS browser is WebKit) and Chromium with an Android device (`devices['iPhone 15']`, `devices['iPhone SE']`, `devices['Pixel 7']`).
  - At a few moments after load, check that the page is as wide as the screen and the large view is inside it.
  - WebKit counts a video's own width as a grid item's minimum, so the grids use `minmax(0, 1fr)`.
  - Chrome on Android keeps a page width it once widened for, so the floating names are measured after placing and the first screen clips sideways.
- `site/particles.js` is the console's sign-in particle logo (`frontend/src/components/login/LoginHero.tsx`, `frontend/src/utils/particles.ts`) in plain JavaScript. Change them together.
  - On the sign-in page, the canvas is fixed to the window. On the site, the canvas covers the page's first screen and scrolls with it, because a fixed canvas redrawn on scroll trails the page by a frame.
  - The dots still come in from anywhere in the window.

### Frontend

```bash
cd frontend
npm install
npm run dev      # http://localhost:5173
npm run build    # tsc + vite build
npm run lint     # eslint (--max-warnings 0)
npm run test     # vitest
```

### Go services

```bash
cd services/k8s-service-go
go run ./cmd/server
go test ./...
```

### Python AI service

```bash
cd services/ai-service
pip install -r requirements.txt
uvicorn main:app --reload --port 8001
pytest
```

### Health check

```bash
curl http://localhost:8000/health   # Gateway
```

---

## Tech stack

**Backend**

- Go 1.26 (auth, k8s, session, tool-server, controller, pkg)
- Python 3.14 + FastAPI (ai-service)
- PostgreSQL 18, Valkey 9 (Redis-compatible cache, BSD)
- controller-runtime (CRD operator)

**Frontend**

- React 19, TypeScript, Vite, Tailwind CSS
- TanStack Query, React Router
- Monaco Editor, xterm.js
- React Flow, dagre and elkjs (graphs), three.js (3D topology)
- i18next (Korean/English)

**Infra**

- Kubernetes, Helm, NGINX
- GitHub Container Registry (ghcr.io), GitHub Actions
