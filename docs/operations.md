**English** | [한국어](ko/operations.md)

# Operations features

## Policy reports

Collects and shows the `wgpolicyk8s.io/v1alpha2` `PolicyReport` (namespaced) and `ClusterPolicyReport` (cluster-scoped) objects that policy engines such as Kyverno and Trivy Operator write per resource, **reading only**. Kubeast does not create policies or store the data.

- **Screen** — Security → Policy Reports: totals of fail, warn, error, pass and skip; by-policy (category, severity, source, Namespace count) and by-Namespace tabs; a results tab (result, severity, policy, Namespace and search filters; clicking a row opens that resource's drawer). The "Policy violations" section of workload and Pod drawers lists that resource's fail/warn/error rows, and a workload also shows its pods' rows (most policies look at Pods). A cluster without the CRD shows "is not installed", and the drawer section is hidden.
- **API** — `GET /api/v1/cluster/policyreports/status` (enabled, CRD present) · `…/summary?namespace=` (by-policy and by-Namespace totals — counting result rows, not the reports' `summary`) · `…/results?namespace=&policy=&result=fail,warn&severity=&kind=&search=&limit=` (default fail, warn, error; at most 2,000 rows; `total` is the count before truncation) · `GET /api/v1/cluster/namespaces/{ns}/policyreports/resource?kind=&name=`. Without the CRD, the data routes return an empty list + `X-Kubeast-Not-Installed`.
- **Identity and scope** — reports are read **as the signed-in user**, so cluster RBAC is the ceiling. The Kyverno chart default (`rbac.roles.aggregate.view: true`) adds report reads to `view`, so Read (`kubeast:viewer`) can read them too. A Namespace-scoped grant reads only the reports of those Namespaces, one Namespace at a time (no full list), and ClusterPolicyReports appear only in the whole-cluster view.
- **Load** — reads only when opened and keeps the result for 60 seconds per cluster, Namespace and user (`force_refresh=true` = the screen's refresh skips that cache, reads again and replaces the cache — Kyverno writes a new object's report after about 20 seconds for Pods and Deployments, about 40 seconds for ReplicaSets). Reading stops at 5,000 reports or 50,000 result rows with `truncated: true` (the screen says so — narrow by Namespace or policy). Fetched in pages of 500.
- Permission `resource.policyreport.read` (included in the Read role's `resource.*.read`), chart `features.policyReports.enabled` (default on; off = 404, menu and section hidden), no audit (plain read). The Kyverno install and policies of the dev second cluster are in `deploy/kind/kyverno-*.yaml`.

## Cluster hygiene check

Gathers the **configuration risks** of what is running in a cluster right now on one page and records a sign-off that the monthly check was done (ISMS-P 2.10.2 security configuration monitoring, 2.11.2 periodic inspection). Where Check issues is about "problems that broke just now", this is about risky settings even while everything works. No external scanner is installed: pick a cluster in Admin → Cluster hygiene, and k8s-service reads Pods, Namespaces, NetworkPolicies, RBAC and `kubernetes.io/tls` Secrets **as the viewer's identity** (impersonation) and judges on the spot (no background job). Lists it could not read are not hidden; they are shown as "skipped checks".

| Check | Basis | Severity |
|---|---|---|
| privileged · host namespaces (hostNetwork/PID/IPC) | Pod Security Standards baseline · CIS 5.2.2~5.2.5 | Critical |
| hostPath · hostPort · capabilities outside baseline · other baseline items (HostProcess, probe host, AppArmor, SELinux, /proc, seccomp Unconfined, sysctl) | PSS baseline (the allowed values of the v1.37 table as they are) · CIS 5.2.8~5.2.12 | Warning |
| restricted not met (privilege escalation, non-root, seccomp, drop ALL, volume types) | PSS restricted · CIS 5.2.6/5.2.7 | Info |
| `:latest` and untagged images (digest-pinned passes) · no memory limit | Kubernetes Images · security checklist | Warning |
| no CPU/memory requests | security checklist | Info |
| Namespaces without a PSS `enforce` label · Namespaces without a NetworkPolicy | security checklist · CIS 5.2.1/5.3.2 | Warning |
| use of the `default` Namespace · default ServiceAccount token mounted | CIS 5.6.4 · 5.1.5/5.1.6 | Info |
| cluster-admin bindings (except the default `cluster-admin`, `kubeadm:cluster-admins`, `system:`, `eks:`) · Roles/ClusterRoles with `*` verbs/resources | CIS 5.1.1 · 5.1.3 | Warning |
| TLS certificate expiry (expired or within `tlsCriticalDays` = critical, within `tlsWarnDays` = warning) — the server parses only `tls.crt`, and the response carries only the expiry date and the target name | security checklist · cert-manager renews at 2/3 of the lifetime | Critical/Warning |
| **Upgrade readiness** (target = current minor + 1, shown at the top of the screen) — removed APIs left in Helm release manifests (the next `helm upgrade` breaks) · CRD storedVersions that are not served · clients still calling deprecated APIs (`apiserver_requested_deprecated_apis`, with `/metrics` permission) · fail-closed webhooks (no backend/0 ready endpoints = critical, match-all or no caBundle = warning) · PDBs that block drains (`disruptionsAllowed 0`) · kubelet version skew (higher than the server = critical, more than 3 minors below the target = warning) · kube-proxy ipvs (deprecated in 1.35) · gitRepo volumes (disabled by default in 1.36) · Service `externalIPs` (deprecated in 1.36) · `scheduling.k8s.io/v1alpha2` objects (removed in 1.37) · cgroup v1 node OSes (deprecated in 1.35, check on the node with `stat -fc %T /sys/fs/cgroup/`) | [Deprecated API Migration Guide](https://kubernetes.io/docs/reference/using-api/deprecation-guide/) · release changelogs 1.35~1.37 · [Version Skew Policy](https://kubernetes.io/releases/version-skew-policy/) · for EKS, also the console's Upgrade insights | Critical/Warning/Info |

- Pods of the same workload are grouped into one row (Deployment, StatefulSet, DaemonSet, Job, with the pod count). System Namespaces (`excludeNamespaces`, default kube-system, kube-public, kube-node-lease) are left out of the workload, Namespace, Role and TLS checks.
- **Exemptions**: put `kubeast.io/hygiene-exempt: "image.latest,pss.hostpath"` (or `*`) and `kubeast.io/hygiene-exempt-reason: <reason>` on the object (the template, for pods) or its Namespace, and the finding stays as "Exempt: <reason>" and is counted separately. Without a reason it is not treated as exempt, and the finding says so. The `kubeast:admin` binding the chart creates is already exempt this way.
- **Export and sign-off**: download CSV (BOM, CRLF, formula characters neutralized) or JSON; signing off per cluster with a note saves the report of that moment as a snapshot (`hygiene_reviews`, kept for `retention.reviewDays`). The screen shows the last sign-off and the next due date (`intervalDays`, default 30 days). Automation such as n8n can fetch `GET /api/v1/cluster/hygiene?cluster=<id>&format=json` with an API key. A finding's `message` is an English sentence (also in the CSV and snapshot), and the screen receives the same content as `message_key` and `message_args` and shows it in the screen language.
- Permissions: `admin.hygiene.read` (view, history) · `admin.hygiene.export` · `admin.hygiene.signoff` (included in Admin). Audit: the scan `k8s.hygiene.scan` (a sensitive read because it reads Secrets — 503 when it cannot be recorded), `admin.hygiene.export` · `admin.hygiene.signoff` · `admin.hygiene.read` (snapshot). The report only reads and fixes nothing — fixes go through gitops.

```yaml
features:
  hygiene:
    enabled: true            # false = menu and API 404
    intervalDays: 30
    excludeNamespaces: [kube-system, kube-public, kube-node-lease]
    tlsWarnDays: 30
    tlsCriticalDays: 7
```

## Argo CD guard (GitOps)

Objects deployed by Argo CD carry a tracking annotation (`argocd.argoproj.io/tracking-id`, value `<app>:<group>/<Kind>:<ns>/<name>`). With `gitops.argocd.enabled: true`, the console reads that mark and puts an "Argo CD · <app>" badge on the drawer header (linked to the Argo CD app page when `url` is set), and when someone tries to change that object from the console:

- `mode: warn` (default) — the confirmation window says "a change made here is reverted on the next sync. Change it in Git instead" and then proceeds.
- `mode: block` — k8s-service refuses write requests with 409 (`managed by Argo CD application <app>; change it in Git`), and the AI write tools (apply, delete, patch, scale, rollout) are refused for the same reason. The drawer's delete and YAML apply buttons are disabled.

The annotation counts only when it points to the object itself (annotations copied along through a pod template are ignored). Installations that still use the label method (`app.kubernetes.io/instance` or `application.instanceLabelKey` in `argocd-cm`) set that key in `instanceLabel`. Helm release operations, node cordon/drain and creating new objects are not covered.

## Dashboard quick actions (issues · optimization · storage)

All three cards show read-only results computed by k8s-service (the same numbers as the AI tools).

- **Check issues** — `GET /api/v1/cluster/issues?window=<minutes>`: pods (Phase, Ready, waiting/terminated reasons such as CrashLoopBackOff, restarts), workloads (Deployment `ProgressDeadlineExceeded`/unavailable, StatefulSet and DaemonSet not ready, Job failed, CronJob last run failed, HPA at its maximum), nodes (Ready≠True, pressure conditions) and PVCs (unbound), with the Warning events of the last `window` minutes attached to the same object row to show "why, when, how many times".
  - The default range is `features.issues.eventWindowMinutes` (60); the screen can switch it to 1h/6h/24h.
  - Clicking a row opens that object's drawer.
- **Optimization suggestions** — `GET /api/v1/cluster/optimization?namespace=…&window=<hours>`: a table of the per-container requests/limits of running pods and their usage (with Prometheus, the CPU 95th percentile and memory maximum over the last `window` hours; otherwise the metrics-server instant value; with neither, shown as "None"), recommended values (CPU = p95, memory = max + 15%, minimum 10m/100Mi — the simple strategy of Robusta KRR) and flags (`cpu_over` · `cpu_under` · `mem_over` · `mem_under` · `no_cpu_request` · `no_mem_request` · `no_mem_limit`).
  - The default range is `features.optimization.windowHours` (24).
  - The "Explain with AI" button sends this table as is to the model and gets an explanation of why the numbers are what they are and what to change first — the model does not change the numbers.
- **Apply without restart** — `POST /api/v1/cluster/namespaces/{ns}/optimization/resize` with body `{kind, name, container, cpu_request_m?, mem_request_bytes?}` (the optimization row as is): changes the container requests of every running pod of that workload through the Pod `resize` subresource (GA in Kubernetes 1.35+, chart `features.inPlaceResize.enabled` default on; on an older server the button is hidden and the API returns 409).
  - The QoS class is kept — Guaranteed changes the limits too, Burstable raises only limits lower than the new request, BestEffort is skipped. Resources whose `resizePolicy` requires a restart and containers with no change are skipped too, and the answer per pod is `resized`/`pending` (kubelet's `PodResizePending`: Infeasible, Deferred)/`skipped`/`error`.
  - The workload template is not changed, so the next rollout restores the original values.
  - Permission `resource.pod.edit`, the Argo CD guard applies by workload, audit `k8s.pod.resize` (one row per call, with per-pod results).
  - "Adjust resources" on the container card of the Pod drawer sends the same call with `kind: Pod` and changes the container requests (CPU m, memory MiB) of that one pod — same permission, switch and rules.
- **Cost (Cost menu)** — `GET /api/v1/cluster/cost?window=1h|6h|12h|24h|48h|7d|14d|30d&aggregate=namespace|controller`: returns as rows the `/allocation/compute` (one accumulated interval, idle excluded) of the OpenCost inside the target cluster (a port-9003 Service with `opencost` in its name, looked for in the `opencost`, `kubecost`, `monitoring` and `cost` namespaces and checked with `/healthz`, queried through the API server proxy — the same way as Prometheus): name, Namespace, kind (for workloads), CPU/memory/GPU/PV/network/LB/total cost, core-hours, byte-hours, efficiency. The workload aggregation asks OpenCost for `namespace,controller` so each row knows its Namespace, and **users with a Namespace-scoped grant get only those Namespaces' rows** (totals from those rows only) (`scoped: true`).
  - Allocations are **read by impersonating the signed-in user, so the target cluster's RBAC is the ceiling** — the default `kubeast:viewer` (Read) has only `view` + `kubeast:cluster-reader`, without `services/proxy`, so the cluster refuses with 403 (the Prometheus proxy too), and reads work from `kubeast:operator` (Write, `edit`) up; to open it to Read, list that cluster's OpenCost and Prometheus Services in the chart value `auth.impersonation.viewerProxyServices`, then render and apply the Role (only GET on `<service>:<port>` in that Namespace).
  - The response cache is 60 seconds **per user (identity)**; OpenCost discovery (which Service) is done with the overview cache identity and kept for 10 minutes (5 minutes when nothing was found).
  - `GET /api/v1/cluster/cost/status` gives whether it was found and its address. Permission `resource.cost.read` (included in the Read role's `resource.*.read`), chart `features.cost.enabled` (default on; off = 404 and the menu hidden), no audit (plain read).
  - OpenCost sets the prices — the pricing API on a cloud, OpenCost's default prices on kind and on-prem (CPU 0.031611/core-h, RAM 0.004237/GB-h).
  - When OpenCost is there, the **optimization table** derives unit prices (cost ÷ hours) from the same Namespace's allocation and adds `cost_month_usd` (requests × 730h × pod count) and `saving_month_usd` (the difference from the recommended value, 0 if negative) to each row, and `pricing` to the response.
  - Kubeast does not install OpenCost itself (the dev second cluster's manifest is `deploy/kind/second-cluster.yaml`).
- **Storage analysis** — adds to the PVC list (`?usage=true`) the usage and capacity from Prometheus's `kubelet_volume_stats_*` and a "Full in <n>d" estimate computed from the 6-hour trend (requires `features.prometheus.enabled` on and Prometheus scraping the kubelet's `/metrics`). When the CSI driver does not report volume stats (hostPath, local-path, etc.), it shows N/A. The 85%/97% color thresholds and "full within 4 days" match kube-prometheus's `KubePersistentVolumeFillingUp` rule.
- **Prometheus source (per cluster)** — by default, Kubeast finds a Prometheus Service inside the target cluster and queries it through the API server proxy: by label across all Namespaces (`kubeast.io/prometheus=true` → the prometheus chart's server → the Operator's `prometheus-operated`), or else a port-9090 Service with `prometheus` in its name in a fixed set of Namespaces. When it cannot be found automatically, name it directly in **Service in the cluster** under Admin → Clusters → Edit (`namespace/service:port`, with `…/path` when the API sits under a path — for a VictoriaMetrics cluster, `monitoring/vmselect-<name>:8481/select/0/prometheus`; `prometheus_service` in `PATCH`) or in the chart's `features.prometheus.service` (order: cluster URL → cluster Service → chart URL → chart Service → auto-discovery).
  - Discovery (which Service, remembered for 10 minutes per cluster) runs as the overview cache identity (`kubeast:cache`, group `kubeast:viewer`) and counts a 403 from `/-/healthy` as "present" — so the result is the same whoever opened it first.
  - The queries themselves go out as the signed-in person, so Read (`kubeast:viewer`) can read only when that Prometheus Service is listed in `auth.impersonation.viewerProxyServices` (otherwise the cluster refuses; see the Read row of [Roles and permissions](features.md#roles-and-permissions--what-the-built-in-roles-can-do-and-who-they-act-as-in-the-cluster)).
  - Without Prometheus, a single-node VictoriaMetrics (VM operator `vmsingle` or `victoria-metrics-single` chart labels, port 8428 with a name like `*vmsingle*` or `*victoria-metrics*`) is found the same way, and the status API reports the store type (`flavor`) — how VictoriaMetrics differs (rules through `-vmalert.proxyURL`, targets from `up`, metadata v1.137+) is in [docs/cluster-requirements.md](cluster-requirements.md) §3 VictoriaMetrics. With a central store (a Prometheus-compatible API such as Thanos, Mimir or VictoriaMetrics), enter the **URL, authentication (bearer/basic, kept in the `cluster-prometheus-<id>` Secret) and cluster label value** in Admin → Clusters → Edit (`prometheus_url` · `prometheus_auth` · `prometheus_cluster_label` of `PATCH /api/v1/clusters/{id}`).
  - With a label value, a parser injects `cluster="<value>"` (the name from `features.prometheus.clusterLabel`) into the vector selectors of every PromQL query, so only that cluster's series are seen.
  - Where the store is exposed only as a Grafana data source, enter the Grafana data source proxy (`https://<Grafana>/api/datasources/proxy/uid/<data source UID>`) as the URL and a Grafana service account token (Viewer, bearer) as the authentication — the log store works the same way ([docs/cluster-requirements.md](cluster-requirements.md) §3 and §14, dev `scripts/kind-grafana.sh`).
  - Node values (the dashboard's CPU, memory and disk, the node drawer cards and 24-hour trends) read the node-exporter names, or else the OpenTelemetry Collector `hostmetrics` names (`system_*`, nodes by the `k8s_node_name` label) — there is no setting to choose between them; what to align (turning on `system.memory.limit`, etc.) is in [docs/cluster-requirements.md](cluster-requirements.md) §3. The chart's `features.prometheus.url` and `auth.existingSecret` (key `authorization`) are the default for clusters without their own URL, `discover: false` turns off in-cluster auto-discovery, and `egressCIDRs` is the list (`{cidr, port}`) that opens k8s-service egress to stores on ports other than 443 and 6443 in installs with NetworkPolicy on.
  - `GET /api/v1/cluster/prometheus/status?cluster=<id>` answers with `source` (external/proxy/none), URL, whether auth is set, label, `configured` (whether a Service was named), store type (`flavor`) and connection state, and adds the reason (`reason`: `not_found` · `discover_off`) when nothing was found — the edit window's Check connection uses these values to pick text in the screen language and, for VictoriaMetrics, names the type at the end of the result.

## Log files inside containers

For **apps that write their logs to files** instead of stdout, nothing shows in `kubectl logs`, nor in Kubeast's Logs tab or AI log tools (the kubelet collects only stdout/stderr). When on (`features.logFiles.enabled`, default off), the Logs tab of Pod details and the Logs area of the Pod drawer get a **Container output | Log files** switch, where you pick a file in the allowed paths and read its last N lines or follow it live.

- **Fixed commands, no shell**: k8s-service runs only `ls` and `tail` through `pods/exec` as the user's identity — list `ls -1p -- <directory>`, read `tail -n N -- <file>`, live `ls -lindL -- <file>` (size, inode) + `tail -c +<offset> -- <file>` (arguments are passed as an array and never go through a shell). Only files matching the `paths` patterns (absolute paths, `*` and `?` in the file name only — e.g. `/var/log/app/*.log`) can be read, and paths containing `..`, `.` or doubled `/` are refused. An invalid pattern keeps k8s-service from starting.
- **Where**: with `namespaces` set, it works only on pods in those namespaces (403 elsewhere).
  - With impersonation on, the chart creates the ClusterRole `kubeast:logfile-reader` (`pods/exec` create, get) and binds the Read and Write groups (`kubeast:viewer` · `kubeast:operator`) to it with RoleBindings **in those namespaces only** — the Admin group is already cluster-admin, and the Write group can already exec through the default `edit`.
  - Apply the same rendering to the other registered clusters: `helm template kubeast helm/kubeast -s templates/logfiles-rbac.yaml -f <values> | kubectl --context <cluster> apply -f -`.
- **Permission and audit**: `resource.pod.logfile` (included in Read and Write, per cluster). Each file content read and each live connection records `k8s.pod.logfile.read` (a sensitive read — 503 when it cannot be recorded; `after` = container, path, line count, follow); file listings are names only and are not recorded. Attempts with the permission but outside the paths or namespaces, or whose execution failed, are recorded as failure rows too.
- **When it does not work**: an image without `tail` or `ls` (distroless) gets 422 "cannot be viewed in this container", a file the container user cannot read gets 422, and a missing file 404. File contents are not masked (the screen says so) — if secret values are printed in logs, the app has to stop that.
- **Live view = 2-second polling**: no single long-running `tail -F` is started — the container runtime does not stop that process when the exec client disconnects, so every closed tab would leave a `tail` behind in the app container (measured). Instead, every 2 seconds it reads only what follows the last byte read with `tail -c +<offset>` (a seek, so independent of file size), and now and then checks size and inode with `ls -lindL` to follow truncation and replacement (log rotation). Each command ends right away. An SSE comment every 20 seconds keeps the proxy from closing an idle connection (nginx 60 seconds), and when the connection drops, the browser does not reconnect by itself (a reconnect would read the last lines again and add another audit row). One read returns at most `maxLines` (default 2000) lines.

```yaml
features:
  logFiles:
    enabled: true
    paths: [/var/log/app/*.log, /srv/app/log/production.log]
    namespaces: [apps]       # empty = all namespaces (then no RoleBinding is created, so the cluster refuses the Read group)
    maxLines: 2000
```

## Log search (Loki)

`pods/log` gives only the current logs of live pods. When on (`features.logSearch.enabled`, default off), log search finds lines in the log store (Loki) by text and time range, **including restarted and deleted pods** — Loki and the collector are set up separately ([docs/cluster-requirements.md §14](cluster-requirements.md#14-log-store-log-search)).

- **Screen**: "Search history" in the source switch of the Pod drawer's Logs area and the Cluster View Logs tab (that pod and container), and a "Log search" section in Deployment, StatefulSet, DaemonSet, ReplicaSet, Job and CronJob drawers (that workload's pods, searched only when expanded). Text, time range (15 minutes up to the maximum), regular expression (`.*`), match case (`Aa`), highlighting of matches, "Load older". A search runs only once on opening and from the search button (each search is audited). Hidden when the cluster has no configuration or the user lacks `resource.pod.read`.
- **API**: `GET /api/v1/namespaces/{ns}/logsearch` (one Namespace) · `GET /api/v1/cluster/logsearch` (all).
  - Conditions `q` (up to 256 characters) · `match=contains|regex` · `ignore_case` · `pod` or `workload_kind`+`workload_name` (Deployment, StatefulSet, DaemonSet, ReplicaSet, Job, CronJob → the names of the pods that controller creates) · `container` · `since` or `start` and `end` (RFC 3339) · `limit` · `direction`.
  - Response = lines, newest first (`ts` · `namespace` · `pod` · `container` · `line`); when `truncated`, query again with `oldest` as `end`.
- **The server builds the query**: users do not write LogQL, and every value goes in only as a quoted string. The cluster label matcher (the value from `clusters`) is always added, so several clusters can share one Loki without mixing.
- **Permission**: `resource.pod.read` (on that cluster) + only when `get pods/log`, asked as the user's identity, is allowed — cluster RBAC decides. A cluster-wide search gets 403 when the user has a Namespace-scoped grant on that cluster (pick a Namespace).
- **Limits**: default 1 hour, at most `maxRange` (24h) · lines `maxLines` (1,000) · query `timeout` (15s, 504 past it) · per user per minute `perUserPerMinute` (20, per k8s-service replica).
- **Audit**: every search records `k8s.pod.logs.search` (a sensitive read — 503 when it cannot be recorded). `after` = conditions, range, line count, bytes processed; line contents are not kept. Cluster refusals (403), limit exceeded (429) and store errors (502, 504) are failure rows too.
- **A different Loki per cluster**: when a cluster's logs live in another store, enter in "Log search" under Admin → Clusters → Edit that store's URL, authentication (Bearer/Basic, the value in the `cluster-logsearch-<id>` Secret), tenant (`X-Scope-OrgID`) and the label value this cluster has in that store (empty = "the store holds only this cluster") — that cluster then uses that store instead of `url`.
  - When every cluster names its own store, `url` and `clusters` can both stay empty.
  - The label **name** and the limits stay the deployment-wide values. "Check connection" (`GET /api/v1/cluster/logsearch/status`) shows which store is used and whether it answers with the authentication and tenant.
  - With `networkPolicy` on, add that store's host and port to `egressCIDRs` too.
- **Direct LogQL input**: with `features.logSearch.logql: true` (default off), everyone who can use log search gets a "LogQL" toggle next to the search box (no separate permission — the readable scope is the same as structured search, as below).
  - The server does not parse the query; it skips strings and comments with the same rules as the Loki lexer and **adds the cluster (+Namespace) matcher to every stream selector** before sending — even if the user writes `k8s_cluster_name="other"`, it is ANDed, so anything outside the cluster gives an empty result. Log queries only (metric queries get 400), up to 4 KB; 400 when there is no selector or a literal, comment or selector is not closed. The response and the screen show the query actually sent (`effectiveQuery`), and the audit is `k8s.pod.logs.logql` (the query written, the query sent, the line count).
  - API `GET /api/v1/namespaces/{ns}/logsearch/query?q=…` · `GET /api/v1/cluster/logsearch/query?q=…` (all NS, only without a scoped grant).
  - The gate (Pod read + `get pods/log` as the user's identity + the per-minute limit) and the audit readiness check are the same as structured search.
  - The former permission `admin.logsearch.query` is gone (DB migration 00019 removes it from roles).
- **The AI's LogQL** (`loki_query` · `loki_labels` · `loki_patterns`): on clusters with log search on, **the AI of anyone who can use structured search** uses them (independent of the screen's `logql` switch) — the same injector as above adds the cluster (+Namespace) matcher to every selector, so it cannot read more widely than structured search; what it gains is only expressiveness such as counting, grouping and `| json`.
  - Metric queries (`count_over_time` · `rate` · `topk`) answer with series, which are also drawn as a chart under the answer (`chart=true`).
  - API `GET /api/v1/[cluster/namespaces/{ns}/]logsearch/logql?q=&step=` · `…/logsearch/labels[?label=]` · `…/logsearch/patterns?q=<selector>` — the same gate (Pod read + `get pods/log` + per-minute limit), audit `k8s.pod.logs.logql` (`kind`); label lists are not audited.
  - Patterns need Loki's `pattern_ingester.enabled: true` (without it, the AI gets "no patterns" and counts with `loki_query`), and Loki returns only patterns that appear in 30 or more lines within the window (a fixed value in 3.7).

```yaml
features:
  logSearch:
    enabled: true
    url: https://loki.example.com
    auth:
      existingSecret: loki-auth        # key authorization = "Bearer …" or "Basic …"
    tenant: ""                         # X-Scope-OrgID (multi-tenant Loki)
    clusters:                          # Kubeast cluster ID: k8s_cluster_name value
      prod-1: prod-1
      alpha: eks-alpha
```

For development (kind): `scripts/kind-logsearch.sh up` — one Loki in the second cluster, an OpenTelemetry Collector in both clusters, and the Kubeast values (`down` undoes it).

## Trace links

Kubeast does not store traces; it builds links to the trace store (Jaeger, Tempo, APM) (`features.tracing.enabled`, default off). The AI reading traces directly is `features.traceStore` ([Reading traces](ai-alerts.md#reading-traces-ai-tempo)).

- **Log line → trace**: in log search results, a "Trace" link at the end of lines that have a trace ID (`traceUrl`). The trace ID is looked for first in the line's labels (`traceIdLabels`, default `trace_id` etc. — Loki returns an OTLP log's trace ID along with the line as the structured metadata `trace_id`), then in the line text (`traceIdPattern`, default `trace_id=…` · `traceID=…` · `"traceId":"…"`). Only 16- or 32-character hex IDs are used.
- **Pod → that service's traces**: "Traces" in the Pod drawer header (`searchUrl`). `{{service}}` = the OpenTelemetry order (annotation `resource.opentelemetry.io/service.name` → `app.kubernetes.io/instance` → `app.kubernetes.io/name` → owning workload → Pod name).
- **Templates**: `{{traceId}}` `{{cluster}}` (Kubeast cluster ID) `{{namespace}}` `{{pod}}` `{{container}}` `{{service}}` — filled values are URL-encoded, and no link is built when a placeholder is empty. Both must start with `http(s)://` to render. Links open in a new tab (`noopener noreferrer`); this is not a server action, so there is no audit entry (log search itself is `k8s.pod.logs.search`).

```yaml
features:
  tracing:
    enabled: true
    traceUrl: https://jaeger.example.com/trace/{{traceId}}
    searchUrl: https://jaeger.example.com/search?service={{service}}
```

For development (kind): `scripts/kind-logsearch.sh up`, then `scripts/kind-tracing.sh up` — Jaeger 2.22 in the second cluster; the links open at `localhost:16686` after `kubectl port-forward -n tracing svc/jaeger 16686` (kubeast-b).

## Adding trusted CAs (private CAs, TLS-intercepting proxies)

For outbound TLS (Loki, external Prometheus, OIDC issuer, Google API, audit sinks, LLM endpoints), Kubeast services trust only the public CAs in the image. For endpoints served with a private CA (AWS Private CA, a corporate root, self-signed) or when behind a corporate proxy that intercepts TLS, list that CA in `customCAs` — it is added, and the public CAs stay.

```yaml
customCAs:
  - secret: corp-root-ca      # a PEM certificate per key (several allowed); key names must not collide across entries
  - configMap: proxy-ca
```

- **Where**: mounted at `/etc/kubeast/ca` in the six services that open outbound TLS (auth, k8s, session, tool-server, model-config-controller, ai-service). Go services use `SSL_CERT_DIR` (the default bundle file is still read), ai-service uses `CUSTOM_CA_DIR` — given `SSL_CERT_*`, httpx replaces its own bundle, so the code adds the CAs on top of certifi. A per-model CA (Admin → AI Models) is added on top of that for that model only, and the model connection test and the model list are verified with the same CAs.
- **When it is read**: at startup. After changing a CA, restart the services. If a listed Secret or ConfigMap does not exist, new pods wait for the volume and do not start, and the previous pods keep answering.
- **Certificate requirements**: the CA must be a proper CA (`basicConstraints CA:TRUE`, `keyUsage keyCertSign`), and server certificates need the key identifier extensions — Python 3.13+ verifies strictly (`VERIFY_X509_STRICT`), so hand-made certificates without them are refused, in ai-service only.
- **docker-compose**: this value exists only in the chart. In a compose install, the place that needs a private CA is usually the LLM endpoint, so set it in the "CA certificate (PEM)" field of the AI model settings (per model).

For development (kind): `scripts/kind-private-ca.sh up` — puts an HTTPS front signed by a throwaway CA in the second cluster (the log search Loki path, a fixed model list) and makes Kubeast trust that CA (after `scripts/kind-logsearch.sh up`; `down` undoes it).
