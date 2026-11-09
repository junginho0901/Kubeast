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

### Many different people on a large cluster

Measured again on 2026-11-08 with the v0.7.6 code, the same way: one k8s-service at the chart's 512 Mi (the Go collector's limit is 90 % of it, 461 MiB), a laptop kind cluster, a KWOK cluster of 1 000 nodes, 50 000 pods and 100 000 events, requests from inside the kind network. This time each person signed in as an account of its own: 500 accounts, a fifth of them limited to 5 or 20 namespaces. One account's identical reads are shared (`handler.Shared`), so different accounts are the harder case. Before each run k8s-service was started fresh and the KWOK cluster warmed up.

| What | Result |
| --- | --- |
| 100, then 300 different people opening a ConfigMap drawer within 10 s in the namespace of 50 000 pods and 76 000 events, and keeping it open for 2 minutes | 0 errors, no restart · opening p95 1.4 s (100) and 1.2 s (300) · while open p95 6 ms · the API server answered none of Kubeast's requests with 429 · k8s-service at most 150 MiB |
| 100 different people following a Deployment of 500 pods, then a DaemonSet of 1 000 pods, in their drawers through a rollout (3 minutes each) | 0 errors, no restart · k8s-service at most 300 MiB · every change reached every drawer · a drawer's describe read again p95 12.0 s (Deployment) and 7.2 s (DaemonSet), a change on screen p95 22 s and 17 s |
| 500 different people keeping the Dashboard, Pods and Cluster View open for 6 minutes, then 100 of them opening those screens at the same instant | while open p95 16 ms, no restart, no 429 · k8s-service at most 440 MiB · of the 100, half got their last answer only at the load's 60 s timeout, and 263 requests failed |
| 20 people using the AI's read tools at once for 2 minutes (one account, 407 calls) | no restart · tool-server at most 162 MiB of 256 Mi · 8 calls failed, all reading events (`k8s_get_events`, `timeline`) |

Sizing:

- The chart's 512 Mi for k8s-service held every v0.7.6 run above, on 50 000 pods. Keep it unless many people use a large cluster at once.
- When many people use a large cluster at once — hundreds of accounts, tens of thousands of pods — set `resources.k8sService.limits.memory` to `1Gi` (the collector's limit follows). The crowd of 100 above came within 21 MiB of the collector's limit, and on 2026-11-07, before the changes this page describes, the same crowd took k8s-service to 611 MiB with a limit of 1 Gi.
- More memory does not make a crowd faster: the 1 Gi run of 2026-11-07 had the same 60 s answers. It keeps k8s-service from restarting when a crowd and a large namespace meet.

Known limits of v0.7.6, from these runs:

- The 100 people arriving at once above. k8s-service had answered their requests: on an earlier run the same day its sockets to the gateway held 46 MB unsent with retransmissions, and at quiet times k8s-service and auth-service retransmitted some 4 200 segments in 6 minutes too. That points at the laptop's kind network rather than Kubeast, but it has not yet been measured on a real cluster.
- A drawer that follows its object reads its describe again as the object changes, and each person's read waits on the client's rate to the cluster (`multicluster.clientQPS`). During a rollout followed by 100 different people that read takes seconds (above), where a quiet drawer answers in milliseconds.
- A drawer that follows its object, and a workload's pod table up to 300 pods, each hold one watch on the cluster as that person. They are not shared between people.
- The AI's event reads (`k8s_get_events`, `timeline`) read pages of events outside `multicluster.eventListConcurrency`.

What sets these limits:

- `multicluster.wsMaxSubscriptions` (2 000): every live watch on a screen is one watch on the cluster as the user. Past the limit, a screen loads but does not update, says so and asks again by itself, spread over half a minute and more. A drawer shares the list watch of the page behind it instead of opening its own, and most drawers follow their object on the read they already make every 10 s, which costs no watch. The Helm pages' stream counts here too, one watch or one per namespace of a grant limited to them; past the limit the same notice says so and the stream asks again after half a minute to five.
- A drawer's table of a selector's or a workload's pods (Service, PodDisruptionBudget, Deployment, DaemonSet, StatefulSet, ReplicaSet, Job) follows them by a watch of its own up to 300 pods; past that it reads the server's page with its revision every 3 s (10 s in a namespace of more than 10 000 pods) and says so above the table. On 2026-11-08, with that line at 2 000, 100 different people following a Deployment of 500 pods, then a DaemonSet of 1 000, through a rollout took k8s-service past 512 Mi and it restarted. The tables that pick from a namespace's pods (ConfigMap, Secret, ServiceAccount, RoleBinding, NetworkPolicy) keep 2 000.
- The node boxes of Cluster View, and a Node drawer's pod table and Allocated Resources, are read once per node for everyone asking at that moment, as `kubeast:cache`, and each person keeps the namespaces its own identity may list pods in (a SelfSubjectAccessReview, 60 s); a namespace that check refuses is listed as that person, so the cluster decides there. At most 16 nodes of one cluster are read at once and the others wait: a node of 40 pods holds about 0.7 MiB while it is read, and on 2026-11-08 k8s-service went from 316 to 492 MiB in the second a crowd opened 400 nodes, as many at once as the client's burst of 200 let through. The lists made as the person take the same places: a namespace that check refuses, and the whole node before the informers have synced after a restart or while `kubeast:cache` is refused. The namespace list comes from what k8s-service keeps for a caller the cluster lets list namespaces.
- What different people still ask as themselves is one access check per kind a screen shows, remembered for a minute: about eight for one person's Dashboard, Pods and Cluster View, about 4 × N with a grant limited to N namespaces, plus that grant's namespace reads (counted from the code, `TestFirstScreensOfOnePersonListNoPodsAsThatPerson`). They queue on the client's rate to that cluster, `multicluster.clientQPS` (100 a second) and `clientBurst` (200). Raising that rate on 2026-10-30, when the node boxes were still read as each user, moved the queue to the test cluster's API Priority and Fairness and the node boxes waited longer. `multicluster.reviewQPS` and `reviewBurst` give the access checks a rate of their own and leave the reads' rate as it is; a check reads nothing from the API server's storage. For K different people opening their first screens at the same moment, a burst of about 8 × K checks lets none of them wait on the rate. Without it, a check asked for the first time goes before the checks that open screens ask again once their minute ran out; one asked again lets the others go first for at most 10 s, then takes its place by arrival. The rate and the number of checks stay the same. Played through the limiter with 100 people arriving at once while 500 screens ask again at 59 a second (`TestACrowdsFirstChecksFinishSoonerAndChecksAskedAgainWaitAtMostTheBound`, the calls counted from the code, eight side by side per person, no API server time), the last of the 100 got its last turn after 12.2 s instead of 23.7 s for 1 290 calls, and after 27.8 s instead of 39.6 s for 1 930 (nothing remembered); a check asked again waited up to 10 s instead of 3.7 to 6 s.
- The Pods page, the node map and the node list are answered from what k8s-service keeps (measured up to 500 people at once). Their work on the rows runs on as many at once as there are CPUs, at most eight: the chart sets no CPU limit, so Go counts every CPU of the node, and each of these holds about 2 MB of rows on 50 000 pods. `POD_ROW_CONCURRENCY` in k8s-service's environment sets another number.
- The gateway holds proxy buffers for every request in flight, about 30–90 KB each.
- One person's identical reads at one moment are at most two reads of the cluster: the drawers, the access checks and the reads of a namespace's pods (`handler.Shared`, `internal/flight`). A read started before a request came does not answer it, and an answer never crosses to other claims.
- `multicluster.bigReadConcurrency` (2): reads of more than one page (pods, ReplicaSets, ControllerRevisions) that run at once in one k8s-service; the others wait, and a read of one page waits for none. One read of a 50 000-pod namespace asks 39 to 78 pages a second and holds up to about 110 MiB. A read waiting for its place holds where to go on, not the page it read; before 2026-11-08 each waiting read held its page, 16 MiB for 256 pods of 64 KiB (`TestAReadWaitingForItsNextPageHoldsNoPageItAlreadyRead`).
- `multicluster.wsWatchStartConcurrency` (16): watches of one cluster waiting for the API server's first answer at once, the Helm pages' stream's too, since client-go does not rate limit watches; the others wait their turn. A start the API server has not answered in 5 s gives its place to the next one and stays open, so a slow API server can have more than 16 starts unanswered at once: the limit spreads the starts, it does not cap them. A wait past 10 s tells the page its list is not following.
- `multicluster.eventListConcurrency` (4): lists of one object's events, which every drawer's Events section needs, that one cluster gets at once; the others wait. The API server's Priority and Fairness counts such a list as up to 10 seats of its global-default level, about 49 by default; on 2026-11-08, with each drawer listing at once, 300 different people opening a ConfigMap drawer in a namespace of 76 000 events had the test cluster answer 430 of Kubeast's requests with 429. With these four places alone 44 of 216 such drawers then waited past 60 s, so an object's events are now read once for everyone asking at that moment, as `kubeast:cache`, by those whose identity may list events there (a SelfSubjectAccessReview, 60 s; across the cluster for a Node or another object of the cluster); a refusal of that check or of `kubeast:cache` lists them as the person.
- `multicluster.toolServerKubectlConcurrency` (3): kubectl processes in tool-server, about 40 MiB each in one container of 256 Mi; the others wait inside their call's 50 s, and the Go collector's limit is lowered by that memory. A `k8s_jq_query` program runs in a child process of tool-server that takes one of these places too, and one such child runs at a time (`jqRuns`): the others wait inside their call's 50 s, then their caller gets a 503 saying tool-server was busy and to ask again. The child ends itself past its memory budget (32 MiB and 8 bytes for each byte of the list, so 40 MiB at the 1 MiB output cap), is ended at 5 s, and, built as the image is (Linux, without cgo), cannot map more than 80 MiB past what it had mapped when it started (`RLIMIT_AS`, `jq_limit_linux.go`), so one step that asks for more at once, which the budget's look every 2 ms can miss, is refused when it asks. The 80 MiB are one 64 MiB heap arena, since Go starts the heap at a random place in its first arena, and room for the runtime's own maps: on 2026-11-09 in a Linux container (Go 1.27.3), 64 MiB failed 6 of 80 ordinary programs over a 908 KB list and 80 MiB none of 480, while a 200 MB string was refused every time. With nothing else stopping it, one child grew to about 124 MiB before the limit stopped it, more than its place's 40 MiB; ordinary programs stayed under 41 MiB, and one child at a time keeps that excess to one. macOS refuses the limit, and a build with cgo leaves it unset, since the stacks of the threads it starts count against it, so there the budget alone holds. On a laptop it adds about 20 ms to a call over a 1 MiB list (an ordinary program there ran within 16 MiB). An answer past 256 KiB is masked and written holding one of three places, and never without one: masking a 1 MiB kubectl list allocates about 7 MiB, and on 2026-11-08, with nothing bounding that step, twenty AI users at once took tool-server from 72 to 254 MiB in four seconds. It waits for its place past its call's 50 s, until 2 s before the server's 55 s write limit; with no place by then its caller gets a short error saying tool-server was busy and to ask again, and nothing at all once its caller has gone.
