**English** | [한국어](ko/cluster-requirements.md)

# Cluster requirements — what Kubeast does not create

Kubeast installs nothing on the clusters you register (the node shell pod is the one exception, §9). Each feature needs something to be on the cluster beforehand; without it, that feature shows "none", "not installed" or "no permission", or its area is hidden. For each feature, this document lists **what must be there · how Kubeast finds it · how it looks when it is missing · how to check it · an example**. The example files are in [`deploy/examples/target-cluster/`](../deploy/examples/target-cluster/).

A "target cluster" is a cluster Kubeast manages (including the cluster it is installed on); the requirements for the cluster Kubeast is installed on are in §15.

## At a glance

| Feature | What the target cluster needs | Kubeast switch (default) | Without it |
| --- | --- | --- | --- |
| All | Kubeast permissions (RBAC) — §1 | `auth.impersonation.enabled` (on) | User requests get 403 from the cluster |
| Alerts → AI investigation | Investigator identity RBAC — §1, Alertmanager or Grafana alerting that sends webhooks to Kubeast — §13 | `features.alertInvestigation.enabled` (off) | Alerts do not arrive, or the investigation's read tools get 403 from the cluster |
| Node and pod usage, Monitoring, optimization (fallback) | metrics-server — §2 | — | Usage cells are empty and optimization shows "none" |
| Drawer and dashboard graphs, optimization, storage analysis | Prometheus + metric collectors — §3 | `features.prometheus.enabled` (**off**) | Graph areas are hidden and optimization uses metrics-server point-in-time values |
| Cost, optimization cost column | OpenCost — §4 | `features.cost.enabled` (on) | "OpenCost is not installed on this cluster" notice, no cost column |
| Policy reports | The PolicyReport CRD and a tool that creates reports — §5 | `features.policyReports.enabled` (on) | "Not installed" notice |
| GPU and DRA | NVIDIA device plugin, GFD labels, DCGM exporter, DRA API — §6 | — | GPU counts and utilization are empty, or DRA shows "unavailable" |
| VPA, Gateway API, Admission Policy, Ingress latency | The matching CRDs and controllers — §7 | — | Lists are empty with "not installed" |
| Apply without restart (resize) | Kubernetes 1.35 or later — §8 | `features.inPlaceResize.enabled` (on) | The button is hidden and the API returns 409 |
| Node shell | Privileged pods allowed, and the image — §9 | `nodeShell.enabled` (off) | Pod creation fails |
| Log files inside containers | `ls` and `tail` in the image, exec permission — §10 | `features.logFiles.enabled` (off) | 422 "cannot be read" |
| Log search | A collector that sends logs to Loki, `pods/log` read permission — §14 | `features.logSearch.enabled` (off) | Search is not shown and the API returns 404 |
| AI alert reading | Alertmanager or Grafana alerting that puts a cluster label (default `cluster`) on alerts — end of §14 | `features.alertStore.enabled` (off) | `alerts_list` is left out and the API returns 404 |
| AI trace reading | A collector that sends spans to Tempo (resource attributes `k8s.cluster.name`, `k8s.namespace.name`), `pods/log` read permission — end of §14 | `features.traceStore.enabled` (off) | The `traces_*` tools are left out and the API returns 404 |
| Deprecated API item of the hygiene and upgrade checks | Read permission on the API server's `/metrics` — §11 | `features.hygiene.enabled` (on) | Only that item shows "collection failed" |
| Argo CD guard | Argo CD tracking annotation — §12 | `gitops.argocd.enabled` (off) | No badge or warning |

## 1. Permissions (RBAC) — every target cluster

Kubeast sends requests to the cluster **as the signed-in person** (impersonation), and the cluster RBAC is the final ceiling. So every target cluster needs the following.

| What | Why | Where |
| --- | --- | --- |
| ClusterRole `kubeast-impersonator` + binding (group `kubeast:impersonator`) | So that Kubeast's credentials impersonate only users and the fixed groups | [`helm/kubeast/files/impersonation-rbac.yaml`](../helm/kubeast/files/impersonation-rbac.yaml) |
| Group bindings `kubeast:viewer` (view + `kubeast:cluster-reader`) · `kubeast:operator` (edit) · `kubeast:admin` (cluster-admin) | What the Read, Write and Admin roles can do on the cluster | Same file |
| Custom role groups `kubeast:role:<name>`, namespace-scoped grants | When you use custom roles or namespace-limited grants | `auth.impersonation.customRoles` → `templates/impersonation-custom-roles.yaml` |
| Prometheus and OpenCost proxy GET for Read | When Read views cost and graphs | `auth.impersonation.viewerProxyServices` → `templates/impersonation-viewer-proxy.yaml` |
| Admin's `nodes/proxy` get — AI tools `nodes_stats_summary`, `nodes_log` | When reading a node's kubelet stats summary and log queries through the API server proxy. `kubeast:admin` (cluster-admin) already has it; to use the Admin tools with a custom role, add `nodes` get + `nodes/proxy` get. `nodes_log` also needs the kubelet settings `enableSystemLogHandler: true` + `enableSystemLogQuery: true` (NodeLogQuery, GA in 1.36) — when they are off the tool answers unavailable (kind's default has query off) | Chart `impersonation-rbac` (cluster-admin) · kubelet settings |
| `pods/exec` in the log file namespaces | When you turn on log file viewing (§10) | `features.logFiles` → `templates/logfiles-rbac.yaml` |
| Alert investigator identity `kubeast:investigator` — impersonate allowed + a read-only ClusterRole (get, list, watch; no Secrets, exec, proxy or writes) | When you turn on alerts → AI investigation. Kubeast runs the read tools as this identity instead of a person. If the investigation also has to read CRDs (Kyverno PolicyReport, Argo Rollout, etc.), add read rules in `features.alertInvestigation.extraRules` — the render refuses verbs other than get, list and watch, `apiGroups "*"`, Secrets, exec, proxy and tokens | `features.alertInvestigation` → `templates/impersonation-investigator.yaml` (the render fails when impersonation is off) |

**Write = the Kubernetes default `edit`**: it includes reading and writing Secrets, `pods/exec` and `pods/portforward`, and proxying to every Service (`services/proxy`) (the same scope as someone given `edit` for kubectl). The shell in the Kubeast UI opens only for Admin, but the cluster permissions allow it, so give people who need a narrower scope a custom role (`auth.impersonation.customRoles`, can be namespace-scoped) instead of Write.

**On the cluster where Kubeast is installed**, the chart creates all of this. Change the values and run `helm upgrade` (do not use the script below on this cluster — it puts kubectl annotations on objects the chart owns).

**On other registered clusters** Kubeast does not create RBAC, so apply the same render yourself. Render once with the install values overlaid with that cluster's own values (Prometheus and OpenCost Service names, etc., [`cluster-values.yaml`](../deploy/examples/target-cluster/cluster-values.yaml)). If you do not use a feature, its template is empty and is skipped (helm stops on an empty `--show-only`, so the script renders each template separately).

```bash
scripts/render-target-rbac.sh -f values.yaml -f cluster-b-values.yaml | kubectl --context cluster-b apply -f -
# If you installed from the OCI chart: KUBEAST_CHART=oci://<registry>/kubeast scripts/render-target-rbac.sh --version <version> -f ...
```

**EKS**: the IRSA role of the Kubeast pod assumes the target role (AssumeRole, [Installation and first setup — Connect your cluster](getting-started.md#3-log-in-and-connect-a-cluster-connect-your-cluster)), and the target cluster's **access entry must map that role to the Kubernetes group `kubeast:impersonator`** (`kubernetesGroups`).

**Check**

```bash
kubectl --context <cluster> get clusterrole kubeast-impersonator kubeast:cluster-reader
kubectl --context <cluster> auth can-i list pods -A --as=check --as-group=kubeast:viewer --as-group=system:authenticated   # yes
kubectl --context <cluster> auth can-i get secrets -A --as=check --as-group=kubeast:viewer --as-group=system:authenticated # no
# If alert investigation is on
kubectl --context <cluster> auth can-i get pods --subresource=log -A --as=kubeast:investigator --as-group=kubeast:investigator # yes
kubectl --context <cluster> auth can-i get secrets -A --as=kubeast:investigator --as-group=kubeast:investigator                  # no
```

## 2. metrics-server

The usage in the node list, the Monitoring screen and the node drawer, and the usage (point-in-time values) in the optimization table when there is no Prometheus, read `metrics.k8s.io`.

- Install: [metrics-server chart](https://artifacthub.io/packages/helm/metrics-server/metrics-server) `3.14.0` (app 0.9.0) — `helm install metrics-server metrics-server/metrics-server --version 3.14.0 -n kube-system`. On EKS the metrics-server add-on also works. If the kubelet certificate is self-signed, as on kind, `--kubelet-insecure-tls` is needed (local only).
- Check: `kubectl --context <cluster> top nodes`

## 3. Prometheus

The graphs in the drawers (Pod, workload, Service, Namespace, node, HPA, Ingress), the dashboard metrics, CPU p95 and memory max in the optimization table, and storage analysis read Prometheus. **You must turn on `features.prometheus.enabled: true` on the Kubeast side** (chart default off).

### How Kubeast finds it

- **Order**: URL set on the cluster → Service set on the cluster → chart `features.prometheus.url` → chart `features.prometheus.service` → auto-discovery.
- **Naming a Service** (Admin → Clusters → Edit "Service in the cluster", or chart `features.prometheus.service`): `namespace/service:port` (the same format as Lens and Headlamp); if the API sits under a path, include the path — `namespace/service:port/path` (for example a VictoriaMetrics cluster: `monitoring/vmselect-main:8481/select/0/prometheus`). It is read through the API server proxy, and the status API reports whether `/-/healthy` is reachable and the store type (`flavor`: prometheus, victoriametrics — from the text of the `/-/healthy` answer).
- **Auto-discovery in the cluster**: ① by label in all namespaces — `kubeast.io/prometheus=true` → the prometheus chart server (`app.kubernetes.io/name=prometheus,app.kubernetes.io/component=server`, port 80) → Prometheus Operator's `prometheus-operated` (`operated-prometheus=true`), trying every port of the Service ② if none, Services with `prometheus` in the name on **port 9090**, in the order `monitoring` → `prometheus` → `jupyterhub` → `kube-system` → `gpu-operator` → `observability` → `default`. It uses one if `/-/healthy` answers, and remembers the result for 10 minutes per cluster.
  - Discovery runs as the overview cache identity (`kubeast:cache`, `view`), so it must be able to read the Service list of every namespace (as in §1).
- **Central store** (a Prometheus-compatible API such as Thanos, Mimir or VictoriaMetrics): enter the URL, authentication and cluster label value in Admin → Clusters → Edit ([Operations — "Prometheus source" in dashboard quick actions](operations.md#dashboard-quick-actions-issues--optimization--storage)). The metrics below must then carry that cluster label.
- **Through Grafana**: where the store's query API is not exposed and exists only as a Grafana data source, enter Grafana's data source proxy `https://<Grafana>/api/datasources/proxy/uid/<data source UID>` as the URL and a Grafana service account token (Viewer, bearer) as authentication. Kubeast queries are all GET, so they do not hit the limit of Grafana's Prometheus proxy (only some POSTs are allowed), and query time is also bounded by Grafana's `dataproxy.timeout` (default 30 seconds). Grafana OSS has no per-data-source permissions, so that token can read every data source; handle it as a secret. The log store (§14) works the same way.
- For installs that auto-discovery cannot find (other names or labels), put `kubeast.io/prometheus=true` on the Service or name the Service directly.

### VictoriaMetrics

It serves the Prometheus query API as is, so the screens and the AI tools read it with the same queries (verified: v1.154.1 single-node and cluster versions, same values as cluster 2's Prometheus). Only the differences:

- **Discovery**: when there is no Prometheus, the single-node version is found automatically — by the VM operator's `app.kubernetes.io/name=vmsingle` and the Helm chart's `app.kubernetes.io/name=victoria-metrics-single` labels, then by 8428 Services with `vmsingle` or `victoria-metrics` in the name. If there is a Prometheus, Prometheus comes first.
  - The cluster version needs a tenant path, so it is not found automatically — name the Service with its path (`monitoring/vmselect-<name>:8481/select/<tenant>/prometheus`) or use a central store URL (`http://vmselect-<name>.<ns>.svc:8481/select/0/prometheus`, with the cluster label value).
- **Alerting rules** (AI `prometheus_rules`): the rules live in vmalert, and `/api/v1/rules` returns them only when the single-node version or vmselect has `-vmalert.proxyURL=<vmalert URL>`. Without it VM returns an empty list, so Kubeast looks at the store type and answers "this store does not serve rules" instead (so that it does not wrongly say "no rules").
- **Scrape targets** (AI `prometheus_targets`): when the single-node version scrapes by itself (`-promscrape.config`), that list; when it receives through vmagent or remote write the list is empty, and vmselect does not have that API and returns 400 `unsupported path requested` — both fall back to the `up` metric.
- **Metadata** (types and descriptions in AI `prometheus_metrics`): stored by default from v1.137 (`-enableMetadata`, in memory only — after a restart, names only until it builds up again).
- **Cluster label injection**: for a store shared by several clusters, Kubeast inserts `cluster="<value>"` with the Prometheus parser, so MetricsQL-only syntax (`WITH`, `rate(x)` without `[d]`, etc.) is refused with 400. A store that holds a single cluster (no label value) gets the query as is, so MetricsQL works too.
- **When receiving OTLP**: VM stores dotted names as they are, so sending hostmetrics over OTLP needs `-opentelemetry.usePrometheusNaming` (with remote write the collector already converts them).
- **Read users**: when reading through a Service in the cluster, put `<ns>/<service>:<port>` (without the path) in `auth.impersonation.viewerProxyServices` — the same as Prometheus.

### Required metrics

| Metric | Produced by | Used by |
| --- | --- | --- |
| `container_cpu_usage_seconds_total`, `container_memory_working_set_bytes` (labels `namespace`, `pod`, `container`) | The kubelet's cAdvisor (`/metrics/cadvisor`) | Optimization table, Pod, workload, Service and Namespace drawers |
| `node_cpu_seconds_total`, `node_memory_MemAvailable_bytes`·`MemTotal_bytes`, `node_filesystem_avail_bytes`·`size_bytes` (`mountpoint="/"`), `node_load1`, `node_network_*_bytes_total`, `node_disk_*_bytes_total` — or the hostmetrics names below | node-exporter or OpenTelemetry Collector `hostmetrics` | Dashboard, node drawer |
| `kube_pod_info`, `kube_pod_container_status_restarts_total`, `kube_horizontalpodautoscaler_status_current_replicas` | kube-state-metrics | Dashboard, Namespace, workload and HPA drawers |
| `kubelet_volume_stats_used_bytes`·`capacity_bytes`·`available_bytes` | kubelet `/metrics` — the CSI driver must report volume stats (hostPath and local-path do not → N/A) | Storage analysis |
| `DCGM_FI_DEV_GPU_UTIL`, `DCGM_FI_DEV_FB_USED`·`FB_FREE`, `DCGM_FI_DEV_MEMORY_TEMP` | NVIDIA DCGM exporter | GPU screens |
| `nginx_ingress_controller_request_duration_seconds_bucket` | ingress-nginx controller | Ingress drawer latency (P50/P95/P99) |
| Metrics OpenCost exports | OpenCost (§4) | Cost |

**Per-node values in the node drawer**: the drawer picks a node's values only when the `instance` of the node-exporter series is **the node name or a node address (InternalIP, ExternalIP)** (with or without a port). The default `instance=<node IP>:9100` of the two charts below matches as is. With any other format (for example the node-exporter pod IP), the node drawer's cards and 24-hour trend look empty — they are not filled with another node's values. In that case, change `instance` to the node name (`__meta_kubernetes_pod_node_name`) with `relabelings` in the scrape config. Disk and network I/O are the sum over that node's devices (`device!="lo"`, the same way as node-exporter's node-mixin). Values that add up the whole cluster, as on the dashboard, are not affected.

**OpenTelemetry `hostmetrics` instead of node-exporter**: every node query is "node-exporter expression `or` hostmetrics expression", so whichever is in the store comes out (node-exporter if both are). There is no setting to choose. What to match when you go with hostmetrics:

- **Names**: as the Prometheus-style name conversion writes them — `system_cpu_time_seconds_total{state}` and `system_cpu_logical_count` (CPU utilization = 1 − idle seconds ÷ logical CPU count, the same calculation as node-exporter), `system_memory_usage_bytes{state="used"}` and `system_memory_limit_bytes`, `system_filesystem_usage_bytes{mountpoint="/",state}`, `system_cpu_load_average_1m`, `system_network_io_bytes_total{direction,device}`, `system_disk_io_bytes_total{direction,device}`.
  - The OTel `prometheus_remote_write` exporter (named `prometheusremotewrite` before 0.162) and Prometheus's OTLP receiver use these names by default; when sending OTLP to VictoriaMetrics, pass `-opentelemetry.usePrometheusNaming` (the default keeps dotted names).
- **Turn on `system.memory.limit`** (off by default): memory utilization = `used ÷ limit`. With the receiver's MemAvailable gate (on by default from 0.137), `used` = total − MemAvailable, the same value as node-exporter's `1 − MemAvailable/MemTotal`. The states do not add up to the total, so do not divide by their sum.
- **Node label `k8s_node_name`** = node name: turn the resource attribute `k8s.node.name` (downward API `spec.nodeName`) into a label — `resource_constant_labels.included: [k8s.node.name]` of `prometheus_remote_write`, or `promote_resource_attributes` for Prometheus OTLP.
- **Right after upgrading the collector**: the collector version goes into the label `otel_scope_version`, and a stopped collector sends no end marker, so for a few minutes after the upgrade (the lookback window, default 5 minutes) the same series exists twice. Kubeast's node queries count only one with `max without (otel_scope_name, otel_scope_version)` — do the same in dashboards and alerting rules that use `sum` directly (dev 0.162.0 → 0.163.1 showed the sum doubled for 7 minutes).
- **Host reads**: mount the host `/` read-only at `root_path: /hostfs` (the same as the hostMetrics preset of the opentelemetry-collector chart). Network values are the node interfaces' only with `hostNetwork: true` — otherwise they are the collector pod's own traffic, so turn off the `network` scraper then (Kubeast hides that cell). Disk leaves out the same devices as node-exporter's default exclusions (partitions, loop, ram).
- **Example**: [`deploy/kind/hostmetrics-collector.yaml`](../deploy/kind/hostmetrics-collector.yaml) (contrib 0.163.1, `scripts/kind-hostmetrics.sh`).

**Additional paths the AI tools read** (the Prometheus discovery tools, same store and same cluster scope as the queries): `/api/v1/label/__name__/values`, `/api/v1/labels`, `/api/v1/label/<name>/values` (always with `start` and `end`, such as the last hour; for a store shared by several clusters, the cluster label in `match[]`), `/api/v1/metadata` (names only when absent), `/api/v1/rules` (VictoriaMetrics only when the query side has `-vmalert.proxyURL` — otherwise the answer is "this store does not serve rules", see the VictoriaMetrics section above), `/api/v1/targets` (only for the cluster's own store — a store shared by several clusters, a store with an empty list, or a store without that API uses the `up` metric instead). All are GET, so they can also be read through the Grafana data source proxy.

### Examples

- **prometheus-community/prometheus chart** — [`prometheus-values.yaml`](../deploy/examples/target-cluster/prometheus-values.yaml). The server Service is found by label, so the namespace and port (default 80) do not matter — the example sets 9090 to match the Read proxy value (`viewerProxyServices` in `cluster-values.yaml`). It adds OpenCost to the default scrape jobs (cAdvisor, kubelet, kube-state-metrics, node-exporter).

  ```bash
  helm install prometheus prometheus-community/prometheus --version 29.37.0 \
    -n monitoring --create-namespace -f deploy/examples/target-cluster/prometheus-values.yaml
  ```

- **kube-prometheus-stack** `92.3.0`: the `prometheus-operated` Service the operator creates (label `operated-prometheus=true`, 9090 — checked in the Prometheus Operator v0.94.1 source) is found by label, so it is found whichever namespace it is installed in. The metrics are all collected by the default ServiceMonitors too (checked by render only).

### Check

```bash
kubectl --context <cluster> get svc -A | grep -i prometheus      # prometheus in the name, 9090
kubectl --context <cluster> get --raw "/api/v1/namespaces/monitoring/services/prometheus-server:9090/proxy/-/healthy"
kubectl --context <cluster> get --raw "/api/v1/namespaces/monitoring/services/prometheus-server:9090/proxy/api/v1/query?query=count(container_cpu_usage_seconds_total)"
```

In Kubeast, Admin → Clusters → Edit → Prometheus "Check connection" shows `Found inside the cluster: <ns>/<service>:<port>`. To open it to Read users, put this address in `viewerProxyServices` from §1.

## 4. OpenCost (cost)

- **How Kubeast finds it**: it looks for Services with `opencost` in the name on **port 9003** in the `opencost`, `kubecost`, `monitoring` and `cost` namespaces and checks them with `/healthz`. A discovery is remembered for 10 minutes (a miss for 5 minutes).
- **Requirement**: OpenCost reads Prometheus, and Prometheus must scrape OpenCost's `/metrics` back (the price and cluster metrics OpenCost exports are used in the allocation calculation).
- **Example**: [`opencost-values.yaml`](../deploy/examples/target-cluster/opencost-values.yaml) — values that make it read the Prometheus of the §3 example.

  ```bash
  helm install opencost opencost/opencost --version 2.5.33 \
    -n opencost --create-namespace -f deploy/examples/target-cluster/opencost-values.yaml
  ```

- **Check**: `up{job="opencost"}` is 1 in Prometheus, and the Kubeast cost page header shows `OpenCost <ns>/<service>:<port>`. OpenCost sets the prices (the pricing API on a cloud, default prices elsewhere).

## 5. Policy reports (PolicyReport)

The PolicyReport and ClusterPolicyReport CRDs of `wgpolicyk8s.io/v1alpha2` and a tool that creates the reports must be present. Kubeast only reads the reports.

- **Kyverno**: the [Kyverno chart](https://kyverno.io/docs/installation/methods/) `3.9.2` (Kyverno 1.19.2) creates the CRDs and the reports, and aggregates report read access into the default `view` role, so Read can read them too. Reports appear only when there are policies, so start with a few Audit policies. Development values and example policies: [`deploy/kind/kyverno-values.yaml`](../deploy/kind/kyverno-values.yaml), [`kyverno-policies.yaml`](../deploy/kind/kyverno-policies.yaml).
- Reports from other tools that use the same CRDs are read too, but only Kyverno has been verified.
- **Check**: `kubectl --context <cluster> get policyreports -A`

## 6. GPU and DRA

| What | What Kubeast looks at | Used by |
| --- | --- | --- |
| NVIDIA device plugin | The node resources `nvidia.com/gpu`, `nvidia.com/mig-*`, the DaemonSet `nvidia-device-plugin-daemonset` (`kube-system`, `gpu-operator`, `nvidia-gpu-operator`) or `kube-system/nvidia-device-plugin` | GPU count and allocation, plugin status |
| GPU Feature Discovery | Node labels `nvidia.com/gpu.product`, `gpu.memory`, `mig.strategy`, `cuda.driver.*` | GPU model and memory |
| time-slicing settings | ConfigMaps `time-slicing-config`, `nvidia-plugin-configs`, `time-slicing` (in the namespaces above) | Time-slicing settings |
| DCGM exporter | The `DCGM_FI_DEV_*` metrics in the §3 table | Utilization, memory, temperature |
| DRA | `resource.k8s.io` (v1 on 1.34+, v1beta2/v1beta1 on 1.32–1.33, v1alpha3 on 1.31), chosen through API discovery | DeviceClass, ResourceClaim, ResourceSlice |

With the NVIDIA GPU Operator, all of the above comes in at once. This section is based on the code and has not been verified on a real GPU cluster.

## 7. APIs shown when present

Without the CRD, Kubeast answers with an empty list and "not installed" (`X-Kubeast-Not-Installed`).

| Screen | What must be present |
| --- | --- |
| VerticalPodAutoscalers | The `autoscaling.k8s.io/v1` CRD. The VPA recommender fills in the recommendations |
| Gateway API | The `gateway.networking.k8s.io/v1` CRDs (GatewayClass, Gateway, HTTPRoute, etc.) and an implementation |
| Gateway policies | CRDs labelled `gateway.networking.k8s.io/policy` (GEP-713), or the default list — BackendTLSPolicy, Envoy Gateway (BackendTraffic, ClientTraffic, Security, EnvoyPatch and EnvoyExtension Policy of `gateway.envoyproxy.io`), Istio (AuthorizationPolicy, RequestAuthentication, PeerAuthentication, Telemetry, WasmPlugin, EnvoyFilter, DestinationRule) |
| Admission Policies | ValidatingAdmissionPolicy (`admissionregistration.k8s.io/v1`), MutatingAdmissionPolicy (`admissionregistration.k8s.io/v1`) — clusters that do not serve them show "not installed". The Read group reads policies and bindings through `kubeast:cluster-reader` (added 2026-10-22 — re-apply on clusters where the RBAC was applied before that; `view` does not have it) |
| Ingress drawer latency | The ingress-nginx controller and scraping of `nginx_ingress_controller_*` from §3 |
| AI tool `gitops_status` | The `applications.argoproj.io` CRD (Argo CD). It exists only on clusters where Argo CD is installed, so with a central Argo CD, call it on the management cluster — otherwise the tool answers unavailable. The reader's RBAC (`applications.argoproj.io` get/list) is the ceiling |

## 8. Kubernetes version requirements

| Feature | Requirement |
| --- | --- |
| Apply without restart (Pod `resize` subresource) | API server 1.35 or later |
| DRA screens | 1.31 or later (§6) |
| Upgrade readiness check | Target = server minor + 1 (no requirement) |

## 9. Node shell

When it is on (`nodeShell.enabled`, Admin only), Kubeast creates the namespace `kubeast-node-shell` (Pod Security `privileged` label) on the target cluster and starts a privileged pod (hostPID, hostIPC, hostNetwork, host `/` mounted) on the chosen node.

- If a policy (Kyverno, Gatekeeper, etc.) blocks privileged pods in that namespace, it needs an exception.
- The node must be able to pull the image (`nodeShell.images`, default `docker.io/library/busybox:1.38.0`). On an air-gapped network, enter your internal mirror address.
- The user must be an Admin (cluster-admin) of that cluster.

## 10. Log files inside containers

Kubeast runs only `ls` and `tail`, through `pods/exec` as the user's identity.

- The container image must have `ls` and `tail` (distroless gives 422).
- For the Read group to use it, each namespace in `features.logFiles.namespaces` needs a `pods/exec` binding — it is part of the §1 render (`templates/logfiles-rbac.yaml`).

## 11. Deprecated API item of the hygiene and upgrade checks

The "Clients still calling deprecated APIs" item reads the API server's `/metrics` (`apiserver_requested_deprecated_apis`). This needs a non-resource URL permission (`nonResourceURLs: ["/metrics"]`, `get`), so it is filled only when the check runs as cluster-admin (Kubeast Admin); without the permission only that item shows a collection failure. The kube-proxy settings check reads the ConfigMaps `kube-proxy` and `kube-proxy-config` in `kube-system`.

## 12. Argo CD guard

Badges and warnings appear only when objects Argo CD deployed carry the tracking annotation (`argocd.argoproj.io/tracking-id`, the default tracking method of Argo CD 3.x). For installs that use the label method (`app.kubernetes.io/instance`, etc.), put that key in `gitops.argocd.instanceLabel`. Argo CD itself does not have to be on the target cluster.

- **Verification**: a Deployment actually synced by an Argo CD 3.5.6 core install (`scripts/kind-argocd.sh`, podinfo chart 6.15.0) carries the annotation `<app>:apps/Deployment:<NS>/<name>`; Kubeast blocks deleting and rolling back that object with 409 and writes a `k8s.gitops.refuse` row, the drawer shows a badge, and `gitops_status` reads that Application the same as kubectl does (e2e `argocd-real.spec.ts`).

## 13. Alertmanager or Grafana alerting (Alerts inbox · alerts → AI investigation)

The inbox and investigations start with a webhook sent by Alertmanager or Grafana alerting. Kubeast does not install an alerting engine and does not create alerting rules.

- **Where to send**: `POST <Kubeast URL>/api/v1/alerts/webhook?cluster=<Kubeast cluster ID>` — the cluster ID is the ID in Admin → Clusters. Use a separate receiver (or `cluster` value) for each cluster.
- **Authentication**: `Authorization: Bearer <ALERT_WEBHOOK_TOKEN of kubeast-secrets>`. The chart creates it and keeps it on upgrade (with `secrets.existingSecret` you must put it in that Secret).
- **Inbox**: received alerts, whatever their severity, firing or resolved, stay in the Alerts menu as one row per alert (same cluster, fingerprint and `startsAt`).
  - Resolution notices are needed, so keep `send_resolved: true` (the webhook default).
  - Alertmanager does not send the `endsAt` of firing alerts in the webhook, so an alert that hears nothing for `features.alertInvestigation.inbox.staleAfterHours` (default 8 — twice `repeat_interval`) after the last receipt shows as "Status unknown".
  - When the alert store of §14 (`features.alertStore`) is set for that cluster, the screen also shows Alertmanager's current state (firing, silenced, inhibited, absent).
- **Alerts that are investigated**: those with `status=firing` and a `severity` label in `features.alertInvestigation.severities` (default critical, warning). The same cluster and fingerprint is not investigated again within `dedupeHours` (default 24) — Alertmanager resends every `repeat_interval` (default 4h). Resolved alerts are not investigated (they are used only for the inbox's resolved mark).
- **`namespace` label**: when present, the investigation is limited to that namespace (the token's `ns`). Without it, the investigation reads the whole cluster.
- **Kubeast side**: `features.alertInvestigation.enabled: true` (`auth.impersonation.enabled` and `ai.enabled` must also be on — otherwise the chart render fails), one model (the default model or `model`), and the investigator identity RBAC of §1 on the target cluster.

```yaml
# Alertmanager v0.34.1 — receiver example (token from a file)
receivers:
  - name: kubeast
    webhook_configs:
      - url: https://kubeast.example.com/api/v1/alerts/webhook?cluster=prod-1
        send_resolved: true
        max_alerts: 20
        http_config:
          authorization:
            type: Bearer
            credentials_file: /etc/alertmanager/kubeast/token
```

- **Grafana alerting**: a webhook contact point (Contact point → Webhook) with the URL as above, Authorization header scheme `Bearer` and the token as credentials. Grafana 13's webhook body (`version` "1") also has the fields Kubeast reads (`status`, `labels`, `annotations`, `startsAt`, `fingerprint` of `alerts[]`, and `externalURL`) under the same names, so it is accepted as is. Use notification policies to send each cluster to its contact point, and put `severity` (and `namespace` if needed) in the rule labels.
- **Check**: whether the alert appears in the Kubeast Alerts menu, and whether an investigation row appears in Admin → Investigations (if the severity filter drops it, there is no investigation row). The webhook response `{accepted, duplicate, filtered, skipped, resolved, dropped, stored}` is left in the Alertmanager log. The full development example is [`deploy/kind/alertmanager.yaml`](../deploy/kind/alertmanager.yaml); for Grafana, `scripts/kind-grafana.sh` and e2e `grafana.spec.ts` (an alert sent by a contact point test is investigated).

## 14. Log store (log search)

Kubeast only reads Loki's `query_range` (also metric queries for the AI's `loki_query`), `labels`, `label/<name>/values` and `patterns` (all GET — the Grafana data source proxy works too). It does not install Loki or a collector. Patterns (`loki_patterns`) need `pattern_ingester: enabled: true` in Loki; without it only that tool answers "none" (Loki returns only patterns with 30 or more lines in the window, for the last 3 hours).

- **Collector**: something that sends the target cluster's container logs to Loki.
  - The label names must match `features.logSearch.labels` — the defaults are `k8s_cluster_name`, `k8s_namespace_name`, `k8s_pod_name` and `k8s_container_name`, which Loki puts on logs it receives over OTLP (OpenTelemetry Collector `file_log` + the `container` parser or `k8sattributes`, `otlp_http` → Loki `/otlp`; the pre-0.162 names `filelog` and `otlphttp` still work, with a warning).
  - With Promtail or Alloy Kubernetes discovery, change them to `namespace`, `pod` and `container`.
- **Cluster label**: when several clusters go into one Loki, attach a different `k8s.cluster.name` per cluster (the collector's resource processor), and pair those values with Kubeast cluster IDs in `features.logSearch.clusters`. Clusters that are not listed have no search.
- **Per-cluster store**: for a cluster whose logs are in a different Loki, enter that store's URL, authentication, tenant and label value in Admin → Clusters → Edit (used before `features.logSearch.url`). The label names must be the same as the deployment-wide values, so that store's collector must also send with the same label names. Add that store's host and port to the network policy (below) too.
- **Permissions**: it asks for `get pods/log` (in that namespace, or in all namespaces for a cluster-wide search) as the user's identity. It is part of `view` and `edit`, so the Read and Write groups of §1 are enough. A namespace-scoped grant needs a binding in that namespace.
- **Network**: from k8s-service to Loki. If `networkPolicy` is on and the port is not 443, `features.logSearch.egressCIDRs`.
- **Through Grafana** (as in §3): URL = `https://<Grafana>/api/datasources/proxy/uid/<Loki data source UID>`, authentication = a service account token, **leave the tenant empty** — Grafana adds the `X-Scope-OrgID` set on the data source (Kubeast does not send that header when the tenant field is empty).
- **AI trace reading** (`features.traceStore`, when used): Kubeast only reads Tempo's `/api/search`, `/api/v2/traces/<id>`, `/api/v2/search/tags`, `/api/v2/search/tag/<t>/values` and `/api/metrics/query_range` (all GET — the Grafana data source proxy works too).
  - The spans' **resource attributes** must carry the cluster value (`k8s.cluster.name` — the collector's resource processor) and the namespace (`k8s.namespace.name` — `k8sattributes`) for filtering by that cluster and namespace (value = `features.traceStore.clusters`).
  - TraceQL metrics (`traces_metrics`) are built in on Tempo 3.x (2.x needs the metrics-generator `local-blocks`).
  - Metrics leave out the most recent part of the range by Tempo's `query_frontend.query_end_cutoff` (default 30 seconds) and the step — check: that value in `/status/config`. Read permission is the same as for log search: `get pods/log` as the user's identity.
- **AI alert reading** (`features.alertStore`, when used): Kubeast reads the alert store's `/api/v2/alerts` (matcher `filter`) and `/api/v2/silences` with GET (one more line below when silence writing is on) — Alertmanager API v2, an Alertmanager through the Grafana data source proxy, and Grafana alerting's Alertmanager-compatible API (`/api/alertmanager/grafana/api/v2/…`, 200 with Viewer confirmed on Grafana 13.2.4 — `…/status` is 403 for Viewer, so it is not used).
  - For a store shared by several clusters, each alert needs a **cluster label** (default `cluster` — Prometheus `external_labels` or Grafana alert rule labels) so that only that cluster's alerts are selected (value = `features.alertStore.clusters`).
  - Check: `curl -G <url>/api/v2/alerts --data-urlencode 'filter=cluster="<value>"'`.
- **Silence writing** (`features.alertStore.silences: true`, when used): when someone with `resource.alert.silence` creates a silence on the Alerts screen, Kubeast sends `POST /api/v2/silences`, and ending one sends `DELETE /api/v2/silence/<id>` (Alertmanager API v2 · Grafana data source proxy · Grafana alerting's compatible API).
  - So those credentials need permission to write silences — for Grafana, a service account of Editor or above (Viewer gets 403, and the screen shows "the alert store refused the write").
  - Every silence gets the condition `<clusterLabel>="<value>"`, so it mutes only that cluster's alerts, and its duration goes up to `silenceMaxHours` (168).
- **Trace links** (`features.tracing`, when used): the trace ID of a line is read from Loki labels first. When an app sends its logs over OTLP, Loki returns the trace ID with the line as the structured metadata `trace_id` (Loki 3.x, measured on kind 10-14), so nothing else is needed. A collector that reads container logs from files, as above, does not know the trace ID, so it is looked for in the line text (`trace_id=…`, etc.) — have the app write the trace ID in its log lines, or parse JSON lines in the collector and move the value into the trace field. The trace store (Jaeger, Tempo) is a place the browser opens through a link, so Kubeast does not talk to it.

```yaml
# OpenTelemetry Collector contrib 0.163.1 — the node's container logs to Loki (DaemonSet, /var/log/pods mounted read-only)
receivers:
  file_log:
    include: [/var/log/pods/*/*/*.log]
    include_file_path: true
    operators:
      - type: container          # k8s.namespace.name, k8s.pod.name, k8s.container.name from the path
processors:
  resource:
    attributes:
      - {key: k8s.cluster.name, value: prod-1, action: upsert}
exporters:
  otlp_http:
    endpoint: https://loki.example.com/otlp
service:
  pipelines:
    logs: {receivers: [file_log], processors: [resource], exporters: [otlp_http]}
```

- **Check**: whether the value shows in `/loki/api/v1/label/k8s_cluster_name/values` in Loki, and whether Pod log search for that cluster returns lines in Kubeast. The full development example is `scripts/kind-logsearch.sh` (`deploy/kind/logsearch-*.yaml`).

## 15. The cluster Kubeast is installed on

| What | Requirement |
| --- | --- |
| User namespaces | `podSecurity.hostUsers: false` (default) needs Kubernetes 1.33 or later and a node kernel that supports it (6.3 or later). Otherwise `true` |
| Storage | With the built-in PostgreSQL, a PVC — the default StorageClass or `postgresql.storageClassName` |
| Exposure | NodePort (default), LoadBalancer, or an Ingress controller (`ingress.enabled`) |
| NetworkPolicy | `networkPolicy.enabled` (default on) takes effect only on a CNI that supports NetworkPolicy (Calico, Cilium, EKS VPC CNI network policy) |
| Console metrics scraping | Turning on `metrics.serviceMonitor` or `metrics.prometheusRule` needs the prometheus-operator CRDs ([metrics.md](metrics.md)) |
| EKS external clusters, S3 | IRSA role (`aws.irsaRoleArn`, etc.) |
| Private CA, TLS-intercepting proxy | The Secrets and ConfigMaps listed in `customCAs` must exist in the release namespace first (otherwise new pods wait for the volume and do not start — the previous pods keep answering) |

## Verified versions (2026-10-13)

| Component | Version | How |
| --- | --- | --- |
| prometheus-community/prometheus | chart 29.37.0 (Prometheus v3.15.0) | Installed on kind with the example values as is (29.36.1) → Kubeast discovered `monitoring/prometheus-server:9090`, queried cAdvisor, node-exporter and kube-state-metrics metrics, optimization source `prometheus`. With 29.37.0 the render of the example values differs only in chart labels |
| opencost/opencost | chart 2.5.33 (OpenCost 1.121.3) | Installed with the example values as is (2.5.32) → discovered `opencost/opencost:9003`, cost rows per namespace. With 2.5.33 the render of the example values differs only in chart labels |
| `scripts/render-target-rbac.sh` + `cluster-values.yaml` | — | Before applying, Read cost and Prometheus queries got 403 → after applying, 200 |
| kube-prometheus-stack | 92.3.0 | Only the Service name and port, checked by render |
| metrics-server | 0.9.0 | Development cluster 2 (`deploy/kind/second-cluster.yaml`) |
| Kyverno | 1.19.2 (chart 3.9.2) | Development cluster 2 |
| Alertmanager | v0.34.1 | Development cluster 2 — an alert added with `amtool alert add` came in through the webhook and was investigated (e2e `alert-investigation.spec.ts`) |
| Loki · OpenTelemetry Collector contrib | 3.7.9 · 0.163.1 | 10-14 (3.7.8 · 0.162.0), raised 10-21; collectors of two clusters writing to one Loki in development cluster 2 — Job logs found by text and by workload, 0 lines from the other cluster, still found after the Job was deleted (e2e `log-search.spec.ts`) |
| OpenTelemetry Collector contrib `host_metrics` | 0.163.1 | 10-17 (0.162.0), raised 10-21; development cluster 1 (no node-exporter, `scripts/kind-hostmetrics.sh`) → remote write to cluster 2's Prometheus — compared with cluster 2's node-exporter, which sees the same kernel: memory 70.6% / 70.7%, total memory the same bytes, Load 6.72 / 6.66, CPU 13.3% / 13.5%, node drawer and dashboard filled (e2e `node-hostmetrics.spec.ts`). In 0.162 the names `hostmetrics` and `prometheusremotewrite` are deprecated aliases, so `host_metrics` and `prometheus_remote_write` are used |
| VictoriaMetrics | v1.154.1 (single-node, cluster, vmagent) | 10-20 (v1.154.0), raised 10-21; development cluster 2 (`scripts/kind-victoriametrics.sh` — the same scrape config as cluster 2's Prometheus) — node memory total the same bytes in Prometheus and the single-node and cluster versions, `/-/healthy` 200 on the single-node version and on vmselect with its path, rules and alerts as empty placeholders, vmselect targets API 400 → `up`, metadata types and descriptions present (e2e `victoriametrics.spec.ts`) |
| Grafana | 13.2.4 | 10-17, development cluster 2 (`scripts/kind-grafana.sh`) — metrics and logs read through the data source proxy equal the values read directly and the dashboard and node drawer fill, a wrong token gives 401 in the status, an alert sent by a webhook contact point test is investigated (e2e `grafana.spec.ts`) |
| Argo CD | 3.5.6 (core install) | 10-21, development cluster 2 (`scripts/kind-argocd.sh`) — an Application syncs the podinfo chart; tracking annotation, 409, audit row, drawer badge, `gitops_status` (e2e `argocd-real.spec.ts`) |
| GPU, DRA, VPA, Gateway API, ingress-nginx | — | Based on the code, not verified on a real cluster |

On kind nodes the root filesystem is not picked up as `mountpoint="/"`, so disk utilization is empty, and local-path volumes have no volume stats — real nodes and CSI drivers do produce these values.
