**English** | [한국어](ko/cluster-requirements.md)

# Cluster requirements — what Kubeast does not create

Kubeast installs nothing on the clusters you register. The node shell pod is the one exception (§9).
Each feature needs something to be on the cluster beforehand. Without it, that feature shows "none", "not installed" or "no permission", or its area is hidden.

For each feature, this document lists:

- what must be there
- how Kubeast finds it
- how it looks when it is missing
- how to check it
- an example

The example files are in [`deploy/examples/target-cluster/`](../deploy/examples/target-cluster/).

A "target cluster" is a cluster Kubeast manages, including the cluster it is installed on. The requirements for the cluster Kubeast is installed on are in §15.

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
| NetworkPolicy view and check | A network plugin that enforces NetworkPolicy, read permission on the namespaces involved — §7 | — | The answer is what the policies say, not what the cluster does; "unknown" where a rule needs namespace labels the user cannot read |
| Recent flows (drawers, AI `network_flows`) | Cilium Hubble Relay serving TLS, `create` on `services/proxy` for the Relay Service — §16 | `features.networkFlows.enabled` (off) | The section and the tool are left out and the API returns 404; without the cluster permission, 403 |
| Network drops (drawers, AI `network_drops`) | The Hubble drop metric with workload labels in the cluster's Prometheus — §17 | Prometheus (§3) | The section is not shown; the tool says the metric is missing |
| Resource Graph traffic lines | Recent flows (§16), or the Hubble TCP and drop metrics with workload labels in the cluster's Prometheus — §18 | `features.networkFlows` or Prometheus | The switch is not shown; a missing metric is named in the graph |
| Top talkers (drawers, AI `network_top_flows`) | An Amazon CloudWatch Network Flow Monitor monitor for the EKS cluster, Kubeast's AWS identity allowed to query it, the user's `list` on pods — §19 | `features.networkFlowMonitor.enabled` (off) | The section and the tool are left out and the API returns 404; without `list` on pods, 403; when AWS refuses Kubeast's identity, 502 |

## 1. Permissions (RBAC) — every target cluster

Kubeast sends requests to the cluster **as the signed-in person** (impersonation), and the cluster RBAC is the final ceiling. So every target cluster needs the following.

| What | Why | Where |
| --- | --- | --- |
| ClusterRole `kubeast-impersonator` + binding (group `kubeast:impersonator`) | So that Kubeast's credentials impersonate only users and the fixed groups | [`helm/kubeast/files/impersonation-rbac.yaml`](../helm/kubeast/files/impersonation-rbac.yaml) |
| Group bindings `kubeast:viewer` (view + `kubeast:cluster-reader`), `kubeast:operator` (edit) and `kubeast:admin` (cluster-admin) | What the Read, Write and Admin roles can do on the cluster | Same file |
| Custom role groups `kubeast:role:<name>`, namespace-scoped grants | When you use custom roles or namespace-limited grants | `auth.impersonation.customRoles` → `templates/impersonation-custom-roles.yaml` |
| Prometheus and OpenCost proxy GET for Read | When Read views cost and graphs | `auth.impersonation.viewerProxyServices` → `templates/impersonation-viewer-proxy.yaml` |
| Admin's `nodes/proxy` get, for the AI tools `nodes_stats_summary` and `nodes_log` | When reading a node's kubelet stats summary and running log queries through the API server proxy. `kubeast:admin` (cluster-admin) already has it. To use the Admin tools with a custom role, add `nodes` get and `nodes/proxy` get. `nodes_log` also needs the kubelet settings `enableSystemLogHandler: true` and `enableSystemLogQuery: true` (NodeLogQuery, GA in 1.36). When they are off, the tool answers unavailable; kind's default has query off | Chart `impersonation-rbac` (cluster-admin), kubelet settings |
| `pods/exec` in the log file namespaces | When you turn on log file viewing (§10) | `features.logFiles` → `templates/logfiles-rbac.yaml` |
| Alert investigator identity `kubeast:investigator`: impersonation allowed, plus a read-only ClusterRole (get, list and watch; no Secrets, exec, proxy or writes) | When you turn on alerts → AI investigation. Kubeast runs the read tools as this identity instead of a person. If the investigation also has to read CRDs such as Kyverno PolicyReport or Argo Rollout, add read rules in `features.alertInvestigation.extraRules`. The render refuses verbs other than get, list and watch, `apiGroups "*"`, Secrets, exec, proxy and tokens | `features.alertInvestigation` → `templates/impersonation-investigator.yaml` (the render fails when impersonation is off) |

**Write = the Kubernetes default `edit`.** This is the same scope as someone given `edit` for kubectl. It includes:

- reading and writing Secrets
- `pods/exec` and `pods/portforward`
- proxying to every Service (`services/proxy`)

The shell in the Kubeast UI opens only for Admin, but the cluster permissions allow it.
Give people who need a narrower scope a custom role (`auth.impersonation.customRoles`) instead of Write. A custom role can be namespace-scoped.

**On the cluster where Kubeast is installed**, the chart creates all of this. Change the values and run `helm upgrade`.
Do not use the script below on this cluster: it puts kubectl annotations on objects the chart owns.

**On other registered clusters**, Kubeast does not create RBAC, so apply the same render yourself.
Render once with the install values, overlaid with that cluster's own values, such as its Prometheus and OpenCost Service names (see [`cluster-values.yaml`](../deploy/examples/target-cluster/cluster-values.yaml)).
If you do not use a feature, its template is empty and is skipped. Helm stops on an empty `--show-only`, so the script renders each template separately.

```bash
scripts/render-target-rbac.sh -f values.yaml -f cluster-b-values.yaml | kubectl --context cluster-b apply -f -
# If you installed from the OCI chart: KUBEAST_CHART=oci://<registry>/kubeast scripts/render-target-rbac.sh --version <version> -f ...
```

**EKS**: the IRSA role of the Kubeast pod assumes the target role (AssumeRole). See [Installation and first setup — Connect your cluster](getting-started.md#3-log-in-and-connect-a-cluster-connect-your-cluster).
The target cluster's **access entry must map that role to the Kubernetes group `kubeast:impersonator`** (`kubernetesGroups`).

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

The node list, the Monitoring screen and the node drawer read their usage from `metrics.k8s.io`.
So does the optimization table when there is no Prometheus (point-in-time values).

- Install: [metrics-server chart](https://artifacthub.io/packages/helm/metrics-server/metrics-server) `3.14.0` (app 0.9.0), with `helm install metrics-server metrics-server/metrics-server --version 3.14.0 -n kube-system`.
  - On EKS the metrics-server add-on also works.
  - If the kubelet certificate is self-signed, as on kind, `--kubelet-insecure-tls` is needed (local only).
- Check: `kubectl --context <cluster> top nodes`

## 3. Prometheus

These read Prometheus:

- the graphs in the drawers (Pod, workload, Service, Namespace, node, HPA, Ingress)
- the dashboard metrics
- CPU p95 and memory max in the optimization table
- storage analysis

**You must turn on `features.prometheus.enabled: true` on the Kubeast side.** The chart default is off.

### How Kubeast finds it

- **Order**: URL set on the cluster → Service set on the cluster → chart `features.prometheus.url` → chart `features.prometheus.service` → auto-discovery.
- **Naming a Service**: in Admin → Clusters → Edit "Service in the cluster", or in the chart's `features.prometheus.service`.
  - The format is `namespace/service:port`, the same as Lens and Headlamp.
  - If the API sits under a path, include the path: `namespace/service:port/path`. For example, a VictoriaMetrics cluster: `monitoring/vmselect-main:8481/select/0/prometheus`.
  - Kubeast reads it through the API server proxy.
  - The status API reports whether `/-/healthy` is reachable, and the store type (`flavor`: prometheus or victoriametrics). The type comes from the text of the `/-/healthy` answer.
- **Auto-discovery in the cluster** has two steps:
  - ① By label, in all namespaces, in this order:
    - `kubeast.io/prometheus=true`
    - the prometheus chart server (`app.kubernetes.io/name=prometheus,app.kubernetes.io/component=server`, port 80)
    - Prometheus Operator's `prometheus-operated` (`operated-prometheus=true`), trying every port of the Service
  - ② If none is found, Services with `prometheus` in the name on **port 9090**, in the namespaces `monitoring` → `prometheus` → `jupyterhub` → `kube-system` → `gpu-operator` → `observability` → `default`.
  - Kubeast uses a Service if `/-/healthy` answers, and remembers the result for 10 minutes per cluster.
  - Discovery runs as the overview cache identity (`kubeast:cache`, `view`), so it must be able to read the Service list of every namespace (as in §1).
- **Central store** (a Prometheus-compatible API such as Thanos, Mimir or VictoriaMetrics): enter the URL, authentication and cluster label value in Admin → Clusters → Edit.
  The metrics below must then carry that cluster label.
  See [Operations — "Prometheus source" in dashboard quick actions](operations.md#dashboard-quick-actions-issues--optimization--storage).
- **Through Grafana**: use this when the store's query API is not exposed and exists only as a Grafana data source.
  - URL: Grafana's data source proxy, `https://<Grafana>/api/datasources/proxy/uid/<data source UID>`.
  - Authentication: a Grafana service account token (Viewer, bearer).
  - Kubeast queries are all GET, so they do not hit the limit of Grafana's Prometheus proxy, which allows only some POSTs.
  - Query time is also bounded by Grafana's `dataproxy.timeout` (default 30 seconds).
  - Grafana OSS has no per-data-source permissions, so that token can read every data source. Handle it as a secret.
  - The log store (§14) works the same way.
- For installs that auto-discovery cannot find (other names or labels), put `kubeast.io/prometheus=true` on the Service or name the Service directly.

### VictoriaMetrics

VictoriaMetrics serves the Prometheus query API as is, so the screens and the AI tools read it with the same queries (verified: v1.154.1 single-node and cluster versions, which return the same values as cluster 2's Prometheus).
The list below covers only the differences.

- **Discovery**: when there is no Prometheus, Kubeast finds the single-node version automatically. If there is a Prometheus, Prometheus comes first.
  - It looks first for the VM operator's `app.kubernetes.io/name=vmsingle` and the Helm chart's `app.kubernetes.io/name=victoria-metrics-single` labels, then for Services on port 8428 with `vmsingle` or `victoria-metrics` in the name.
  - The cluster version needs a tenant path, so it is not found automatically. Name the Service with its path (`monitoring/vmselect-<name>:8481/select/<tenant>/prometheus`), or use a central store URL (`http://vmselect-<name>.<ns>.svc:8481/select/0/prometheus`) with the cluster label value.
- **Alerting rules** (AI `prometheus_rules`): the rules live in vmalert. `/api/v1/rules` returns them only when the single-node version or vmselect has `-vmalert.proxyURL=<vmalert URL>`.
  Without it, VM returns an empty list. Kubeast then looks at the store type and answers "this store does not serve rules", so that it does not wrongly say "no rules".
- **Scrape targets** (AI `prometheus_targets`): when the single-node version scrapes by itself (`-promscrape.config`), Kubeast uses that list.
  - When it receives data through vmagent or remote write, the list is empty.
  - vmselect does not have that API and returns 400 `unsupported path requested`.
  - Both of these cases fall back to the `up` metric.
- **Metadata** (types and descriptions in AI `prometheus_metrics`): stored by default from v1.137 (`-enableMetadata`). It is kept in memory only, so after a restart there are only names until it builds up again.
- **Cluster label injection**: for a store shared by several clusters, Kubeast inserts `cluster="<value>"` with the Prometheus parser. So MetricsQL-only syntax, such as `WITH` or `rate(x)` without `[d]`, is refused with 400.
  A store that holds a single cluster (no label value) gets the query as is, so MetricsQL works too.
- **When receiving OTLP**: VM stores dotted names as they are, so sending hostmetrics over OTLP needs `-opentelemetry.usePrometheusNaming`. With remote write, the collector already converts them.
- **Read users**: when reading through a Service in the cluster, put `<ns>/<service>:<port>` (without the path) in `auth.impersonation.viewerProxyServices`, the same as for Prometheus.

### Required metrics

| Metric | Produced by | Used by |
| --- | --- | --- |
| `container_cpu_usage_seconds_total`, `container_memory_working_set_bytes` (labels `namespace`, `pod`, `container`) | The kubelet's cAdvisor (`/metrics/cadvisor`) | Optimization table, Pod, workload, Service and Namespace drawers |
| `node_cpu_seconds_total`, `node_memory_MemAvailable_bytes`/`MemTotal_bytes`, `node_filesystem_avail_bytes`/`size_bytes` (`mountpoint="/"`), `node_load1`, `node_network_*_bytes_total`, `node_disk_*_bytes_total`, or the hostmetrics names below | node-exporter or OpenTelemetry Collector `hostmetrics` | Dashboard, node drawer |
| `kube_pod_info`, `kube_pod_container_status_restarts_total`, `kube_horizontalpodautoscaler_status_current_replicas` | kube-state-metrics | Dashboard, Namespace, workload and HPA drawers |
| `kubelet_volume_stats_used_bytes`/`capacity_bytes`/`available_bytes` | kubelet `/metrics`. The CSI driver must report volume stats; hostPath and local-path do not (N/A) | Storage analysis |
| `DCGM_FI_DEV_GPU_UTIL`, `DCGM_FI_DEV_FB_USED`/`FB_FREE`, `DCGM_FI_DEV_MEMORY_TEMP` | NVIDIA DCGM exporter | GPU screens |
| `nginx_ingress_controller_request_duration_seconds_bucket` | ingress-nginx controller | Ingress drawer latency (P50/P95/P99) |
| Metrics OpenCost exports | OpenCost (§4) | Cost |

**Per-node values in the node drawer**: the drawer picks a node's values only when the `instance` of the node-exporter series is **the node name or a node address (InternalIP, ExternalIP)**, with or without a port.

- The default `instance=<node IP>:9100` of the two charts below matches as is.
- With any other format, for example the node-exporter pod IP, the node drawer's cards and 24-hour trend look empty. They are not filled with another node's values.
  In that case, change `instance` to the node name (`__meta_kubernetes_pod_node_name`) with `relabelings` in the scrape config.
- Disk and network I/O are the sum over that node's devices (`device!="lo"`), the same way as node-exporter's node-mixin.
- Values that add up the whole cluster, as on the dashboard, are not affected.

**OpenTelemetry `hostmetrics` instead of node-exporter**: every node query is "node-exporter expression `or` hostmetrics expression", so Kubeast shows whichever is in the store. If both are, node-exporter wins. There is no setting to choose.
What to match when you use hostmetrics:

- **Names**, as the Prometheus-style name conversion writes them:
  - `system_cpu_time_seconds_total{state}` and `system_cpu_logical_count`. CPU utilization = 1 − idle seconds ÷ logical CPU count, the same calculation as node-exporter.
  - `system_memory_usage_bytes{state="used"}` and `system_memory_limit_bytes`
  - `system_filesystem_usage_bytes{mountpoint="/",state}`
  - `system_cpu_load_average_1m`
  - `system_network_io_bytes_total{direction,device}`
  - `system_disk_io_bytes_total{direction,device}`
  - The OTel `prometheus_remote_write` exporter (named `prometheusremotewrite` before 0.162) and Prometheus's OTLP receiver use these names by default. When sending OTLP to VictoriaMetrics, pass `-opentelemetry.usePrometheusNaming`; by default VictoriaMetrics keeps dotted names.
- **Turn on `system.memory.limit`** (off by default): memory utilization = `used ÷ limit`.
  With the receiver's MemAvailable gate (on by default from 0.137), `used` = total − MemAvailable. This is the same value as node-exporter's `1 − MemAvailable/MemTotal`.
  The states do not add up to the total, so do not divide by their sum.
- **Node label `k8s_node_name`** = node name: turn the resource attribute `k8s.node.name` (downward API `spec.nodeName`) into a label.
  Use `resource_constant_labels.included: [k8s.node.name]` of `prometheus_remote_write`, or `promote_resource_attributes` for Prometheus OTLP.
- **Right after upgrading the collector**: the collector version goes into the label `otel_scope_version`, and a stopped collector sends no end marker.
  So for a few minutes after the upgrade (the lookback window, default 5 minutes), the same series exists twice.
  Kubeast's node queries count only one with `max without (otel_scope_name, otel_scope_version)`. Do the same in dashboards and alerting rules that use `sum` directly. On dev, 0.162.0 → 0.163.1 showed the sum doubled for 7 minutes.
- **Host reads**: mount the host `/` read-only at `root_path: /hostfs`, the same as the hostMetrics preset of the opentelemetry-collector chart.
  - Network values are the node interfaces' only with `hostNetwork: true`. Otherwise they are the collector pod's own traffic, so turn off the `network` scraper in that case. Kubeast then hides that cell.
  - Disk leaves out the same devices as node-exporter's default exclusions (partitions, loop, ram).
- **Example**: [`deploy/kind/hostmetrics-collector.yaml`](../deploy/kind/hostmetrics-collector.yaml) (contrib 0.163.1, `scripts/kind-hostmetrics.sh`).

**Additional paths the AI tools read**: the Prometheus discovery tools use the same store and the same cluster scope as the queries.
All are GET, so they can also be read through the Grafana data source proxy.

- `/api/v1/label/__name__/values`, `/api/v1/labels` and `/api/v1/label/<name>/values`. These always go with `start` and `end`, such as the last hour. For a store shared by several clusters, the cluster label goes in `match[]`.
- `/api/v1/metadata`. When it is absent, the tools return names only.
- `/api/v1/rules`. On VictoriaMetrics, only when the query side has `-vmalert.proxyURL`. Otherwise the answer is "this store does not serve rules" (see the VictoriaMetrics section above).
- `/api/v1/targets`, only for the cluster's own store. A store shared by several clusters, a store with an empty list, or a store without that API uses the `up` metric instead.

### Examples

- **prometheus-community/prometheus chart**: [`prometheus-values.yaml`](../deploy/examples/target-cluster/prometheus-values.yaml).
  The server Service is found by label, so the namespace and port (default 80) do not matter. The example sets 9090 to match the Read proxy value (`viewerProxyServices` in `cluster-values.yaml`).
  It adds OpenCost to the default scrape jobs (cAdvisor, kubelet, kube-state-metrics, node-exporter).

  ```bash
  helm install prometheus prometheus-community/prometheus --version 29.37.0 \
    -n monitoring --create-namespace -f deploy/examples/target-cluster/prometheus-values.yaml
  ```

- **kube-prometheus-stack** `92.3.0`: the operator creates the `prometheus-operated` Service (label `operated-prometheus=true`, port 9090; checked in the Prometheus Operator v0.94.1 source).
  Kubeast finds it by label, so it is found whichever namespace it is installed in. The default ServiceMonitors also collect all the metrics (checked by render only).

### Check

```bash
kubectl --context <cluster> get svc -A | grep -i prometheus      # prometheus in the name, 9090
kubectl --context <cluster> get --raw "/api/v1/namespaces/monitoring/services/prometheus-server:9090/proxy/-/healthy"
kubectl --context <cluster> get --raw "/api/v1/namespaces/monitoring/services/prometheus-server:9090/proxy/api/v1/query?query=count(container_cpu_usage_seconds_total)"
```

In Kubeast, Admin → Clusters → Edit → Prometheus "Check connection" shows `Found inside the cluster: <ns>/<service>:<port>`. To open it to Read users, put this address in `viewerProxyServices` from §1.

## 4. OpenCost (cost)

- **How Kubeast finds it**: it looks for Services with `opencost` in the name on **port 9003** in the `opencost`, `kubecost`, `monitoring` and `cost` namespaces and checks them with `/healthz`. A found Service is remembered for 10 minutes, a miss for 5 minutes.
- **Requirement**: OpenCost reads Prometheus, and Prometheus must scrape OpenCost's `/metrics` back (the price and cluster metrics OpenCost exports are used in the allocation calculation).
- **Example**: [`opencost-values.yaml`](../deploy/examples/target-cluster/opencost-values.yaml) — values that make it read the Prometheus of the §3 example.

  ```bash
  helm install opencost opencost/opencost --version 2.5.33 \
    -n opencost --create-namespace -f deploy/examples/target-cluster/opencost-values.yaml
  ```

- **Check**: `up{job="opencost"}` is 1 in Prometheus, and the Kubeast cost page header shows `OpenCost <ns>/<service>:<port>`. OpenCost sets the prices: from the pricing API on a cloud, default prices elsewhere.

## 5. Policy reports (PolicyReport)

The PolicyReport and ClusterPolicyReport CRDs of `wgpolicyk8s.io/v1alpha2` and a tool that creates the reports must be present. Kubeast only reads the reports.

- **Kyverno**: the [Kyverno chart](https://kyverno.io/docs/installation/methods/) `3.9.2` (Kyverno 1.19.2) creates the CRDs and the reports.
  It aggregates report read access into the default `view` role, so Read can read them too.
  Reports appear only when there are policies, so start with a few Audit policies.
  Development values and example policies: [`deploy/kind/kyverno-values.yaml`](../deploy/kind/kyverno-values.yaml), [`kyverno-policies.yaml`](../deploy/kind/kyverno-policies.yaml).
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
| Gateway policies | CRDs labelled `gateway.networking.k8s.io/policy` (GEP-713), or the default list: BackendTLSPolicy; Envoy Gateway (BackendTraffic, ClientTraffic, Security, EnvoyPatch and EnvoyExtension Policy of `gateway.envoyproxy.io`); Istio (AuthorizationPolicy, RequestAuthentication, PeerAuthentication, Telemetry, WasmPlugin, EnvoyFilter, DestinationRule) |
| Admission Policies | ValidatingAdmissionPolicy (`admissionregistration.k8s.io/v1`) and MutatingAdmissionPolicy (`admissionregistration.k8s.io/v1`). Clusters that do not serve them show "not installed". The Read group reads policies and bindings through `kubeast:cluster-reader`, which `view` does not have. It was added 2026-10-22, so re-apply the RBAC on clusters where it was applied before that |
| Ingress drawer latency | The ingress-nginx controller and scraping of `nginx_ingress_controller_*` from §3 |
| NetworkPolicy view and check (Pod and workload drawers, AI tool `network_policy_check`) | Nothing to install: it reads NetworkPolicies, pods, Services, workloads and Namespaces as the user. Whether policies are enforced is up to the network plugin (kind's kindnet, Calico and Cilium do; check yours). A rule that selects namespaces by labels needs `get` on those Namespaces; without it the answer is unknown. Cilium (`cilium.io`), Calico (`projectcalico.org`, or `crd.projectcalico.org` without its API server) and network-policy-api (`policy.networking.k8s.io`) policies are found through discovery and counted with `list` (count unknown without it), not evaluated |
| AI tool `gitops_status` | The `applications.argoproj.io` CRD (Argo CD). It exists only on clusters where Argo CD is installed, so with a central Argo CD, call it on the management cluster. Otherwise the tool answers unavailable. The reader's RBAC (`applications.argoproj.io` get/list) is the ceiling |

## 8. Kubernetes version requirements

| Feature | Requirement |
| --- | --- |
| Apply without restart (Pod `resize` subresource) | API server 1.35 or later |
| DRA screens | 1.31 or later (§6) |
| Upgrade readiness check | Target = server minor + 1 (no requirement) |

## 9. Node shell

When the node shell is on (`nodeShell.enabled`, Admin only), Kubeast creates the namespace `kubeast-node-shell` on the target cluster, with the Pod Security `privileged` label.
It then starts a privileged pod on the chosen node, with hostPID, hostIPC, hostNetwork and the host `/` mounted.

- If a policy (Kyverno, Gatekeeper, etc.) blocks privileged pods in that namespace, it needs an exception.
- The node must be able to pull the image (`nodeShell.images`, default `docker.io/library/busybox:1.38.0`). On an air-gapped network, enter your internal mirror address.
- The user must be an Admin (cluster-admin) of that cluster.

## 10. Log files inside containers

Kubeast runs only `ls` and `tail`, through `pods/exec` as the user's identity.

- The container image must have `ls` and `tail` (distroless gives 422).
- For the Read group to use it, each namespace in `features.logFiles.namespaces` needs a `pods/exec` binding. It is part of the §1 render (`templates/logfiles-rbac.yaml`).

## 11. Deprecated API item of the hygiene and upgrade checks

The "Clients still calling deprecated APIs" item reads the API server's `/metrics` (`apiserver_requested_deprecated_apis`).
This needs a non-resource URL permission (`nonResourceURLs: ["/metrics"]`, `get`), so the item is filled only when the check runs as cluster-admin (Kubeast Admin). Without the permission, only that item shows a collection failure.

The kube-proxy settings check reads the ConfigMaps `kube-proxy` and `kube-proxy-config` in `kube-system`.

## 12. Argo CD guard

Badges and warnings appear only when objects Argo CD deployed carry the tracking annotation `argocd.argoproj.io/tracking-id`. This is the default tracking method of Argo CD 3.x.
For installs that use the label method (`app.kubernetes.io/instance`, etc.), put that key in `gitops.argocd.instanceLabel`.
Argo CD itself does not have to be on the target cluster.

- **Verification** (e2e `argocd-real.spec.ts`): a Deployment actually synced by an Argo CD 3.5.6 core install (`scripts/kind-argocd.sh`, podinfo chart 6.15.0) carries the annotation `<app>:apps/Deployment:<NS>/<name>`. On that object:
  - Kubeast blocks deleting and rolling back with 409, and writes a `k8s.gitops.refuse` row.
  - The drawer shows a badge.
  - `gitops_status` reads that Application the same as kubectl does.

## 13. Alertmanager or Grafana alerting (Alerts inbox · alerts → AI investigation)

The inbox and investigations start with a webhook sent by Alertmanager or Grafana alerting. Kubeast does not install an alerting engine and does not create alerting rules.

- **Where to send**: `POST <Kubeast URL>/api/v1/alerts/webhook?cluster=<Kubeast cluster ID>`. The cluster ID is the ID in Admin → Clusters. Use a separate receiver (or `cluster` value) for each cluster.
- **Authentication**: `Authorization: Bearer <ALERT_WEBHOOK_TOKEN of kubeast-secrets>`. The chart creates the token and keeps it on upgrade. With `secrets.existingSecret`, you must put it in that Secret.
- **Inbox**: received alerts, whatever their severity, firing or resolved, stay in the Alerts menu as one row per alert (same cluster, fingerprint and `startsAt`).
  - Resolution notices are needed, so keep `send_resolved: true` (the webhook default).
  - Alertmanager does not send the `endsAt` of firing alerts in the webhook. So an alert that receives nothing for `features.alertInvestigation.inbox.staleAfterHours` after the last receipt shows as "Status unknown". The default is 8, twice `repeat_interval`.
  - When the alert store of §14 (`features.alertStore`) is set for that cluster, the screen also shows Alertmanager's current state (firing, silenced, inhibited, absent).
- **Alerts that are investigated**: those with `status=firing` and a `severity` label in `features.alertInvestigation.severities` (default critical, warning).
  - The same cluster and fingerprint is not investigated again within `dedupeHours` (default 24). Alertmanager resends every `repeat_interval` (default 4h).
  - Resolved alerts are not investigated. They are used only for the inbox's resolved mark.
- **`namespace` label**: when present, the investigation is limited to that namespace (the token's `ns`). Without it, the investigation reads the whole cluster.
- **Kubeast side**:
  - `features.alertInvestigation.enabled: true`. `auth.impersonation.enabled` and `ai.enabled` must also be on, or the chart render fails.
  - One model: the default model or `model`.
  - The investigator identity RBAC of §1 on the target cluster.

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

- **Grafana alerting**: create a webhook contact point (Contact point → Webhook) with the URL as above, Authorization header scheme `Bearer`, and the token as credentials.
  - Grafana 13's webhook body (`version` "1") also has the fields Kubeast reads, under the same names, so it is accepted as is. The fields are `status`, `labels`, `annotations`, `startsAt` and `fingerprint` of `alerts[]`, and `externalURL`.
  - Use notification policies to send each cluster to its contact point.
  - Put `severity` (and `namespace` if needed) in the rule labels.
- **Check** whether the alert appears in the Kubeast Alerts menu, and whether an investigation row appears in Admin → Investigations. If the severity filter drops the alert, there is no investigation row.
  - The webhook response `{accepted, duplicate, filtered, skipped, resolved, dropped, stored}` is left in the Alertmanager log.
  - The full development example is [`deploy/kind/alertmanager.yaml`](../deploy/kind/alertmanager.yaml).
  - For Grafana, see `scripts/kind-grafana.sh` and e2e `grafana.spec.ts`, where an alert sent by a contact point test is investigated.

## 14. Log store (log search)

Kubeast only reads these Loki APIs, all with GET, so the Grafana data source proxy works too:

- `query_range`, also for metric queries from the AI's `loki_query`
- `labels`
- `label/<name>/values`
- `patterns`

It does not install Loki or a collector.

Patterns (`loki_patterns`) need `pattern_ingester: enabled: true` in Loki. Without it, only that tool answers "none".
Loki returns only patterns with 30 or more lines in the window, for the last 3 hours.

- **Collector**: something that sends the target cluster's container logs to Loki.
  - The label names must match `features.logSearch.labels`. The defaults are `k8s_cluster_name`, `k8s_namespace_name`, `k8s_pod_name` and `k8s_container_name`, which Loki puts on logs it receives over OTLP.
    With the OpenTelemetry Collector, that is `file_log` with the `container` parser or `k8sattributes`, then `otlp_http` → Loki `/otlp`. The pre-0.162 names `filelog` and `otlphttp` still work, with a warning.
  - With Promtail or Alloy Kubernetes discovery, change them to `namespace`, `pod` and `container`.
- **Cluster label**: when several clusters go into one Loki, attach a different `k8s.cluster.name` per cluster with the collector's resource processor.
  Pair those values with Kubeast cluster IDs in `features.logSearch.clusters`. Clusters that are not listed have no search.
- **Per-cluster store**: for a cluster whose logs are in a different Loki, enter that store's URL, authentication, tenant and label value in Admin → Clusters → Edit. This is used before `features.logSearch.url`.
  - The label names must be the same as the deployment-wide values, so that store's collector must also send with the same label names.
  - Add that store's host and port to the network policy (below) too.
- **Permissions**: Kubeast asks for `get pods/log` as the user's identity, in that namespace, or in all namespaces for a cluster-wide search.
  It is part of `view` and `edit`, so the Read and Write groups of §1 are enough. A namespace-scoped grant needs a binding in that namespace.
- **Network**: from k8s-service to Loki. If `networkPolicy` is on and the port is not 443, set `features.logSearch.egressCIDRs`.
- **Through Grafana** (as in §3):
  - URL: `https://<Grafana>/api/datasources/proxy/uid/<Loki data source UID>`
  - Authentication: a service account token.
  - **Leave the tenant empty.** Grafana adds the `X-Scope-OrgID` set on the data source. Kubeast does not send that header when the tenant field is empty.
- **AI trace reading** (`features.traceStore`, when used): Kubeast only reads Tempo's `/api/search`, `/api/v2/traces/<id>`, `/api/v2/search/tags`, `/api/v2/search/tag/<t>/values` and `/api/metrics/query_range`.
  All are GET, so the Grafana data source proxy works too.
  - To filter by cluster and namespace, the spans' **resource attributes** must carry the cluster value and the namespace.
    The cluster value is `k8s.cluster.name`, set by the collector's resource processor (value = `features.traceStore.clusters`). The namespace is `k8s.namespace.name`, set by `k8sattributes`.
  - TraceQL metrics (`traces_metrics`) are built in on Tempo 3.x. Tempo 2.x needs the metrics-generator `local-blocks`.
  - Metrics leave out the most recent part of the range, by Tempo's `query_frontend.query_end_cutoff` (default 30 seconds) and the step. To check, see that value in `/status/config`.
  - Read permission is the same as for log search: `get pods/log` as the user's identity.
- **AI alert reading** (`features.alertStore`, when used): Kubeast reads the alert store's `/api/v2/alerts` (matcher `filter`) and `/api/v2/silences` with GET. When silence writing is on, it also writes (next item).
  - The store can be Alertmanager API v2, an Alertmanager through the Grafana data source proxy, or Grafana alerting's Alertmanager-compatible API (`/api/alertmanager/grafana/api/v2/…`).
  - On Grafana 13.2.4, that API was confirmed to answer 200 with Viewer. `…/status` is 403 for Viewer, so it is not used.
  - For a store shared by several clusters, each alert needs a **cluster label** so that only that cluster's alerts are selected.
    The default label is `cluster`, set with Prometheus `external_labels` or Grafana alert rule labels (value = `features.alertStore.clusters`).
  - Check: `curl -G <url>/api/v2/alerts --data-urlencode 'filter=cluster="<value>"'`.
- **Silence writing** (`features.alertStore.silences: true`, when used): when someone with `resource.alert.silence` creates a silence on the Alerts screen, Kubeast sends `POST /api/v2/silences`. Ending one sends `DELETE /api/v2/silence/<id>`.
  This works with Alertmanager API v2, the Grafana data source proxy and Grafana alerting's compatible API.
  - So those credentials need permission to write silences. For Grafana, that is a service account of Editor or above. Viewer gets 403, and the screen shows "the alert store refused the write".
  - Every silence gets the condition `<clusterLabel>="<value>"`, so it mutes only that cluster's alerts. Its duration goes up to `silenceMaxHours` (168).
- **Trace links** (`features.tracing`, when used): the trace ID of a line is read from Loki labels first.
  - When an app sends its logs over OTLP, Loki returns the trace ID with the line as the structured metadata `trace_id` (Loki 3.x, measured on kind 10-14). Nothing else is needed.
  - A collector that reads container logs from files, as above, does not know the trace ID. Kubeast then looks for it in the line text (`trace_id=…`, etc.).
    Have the app write the trace ID in its log lines, or parse JSON lines in the collector and move the value into the trace field.
  - The trace store (Jaeger, Tempo) is a place the browser opens through a link, so Kubeast does not talk to it.

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

- **Check** whether the value shows in `/loki/api/v1/label/k8s_cluster_name/values` in Loki, and whether Pod log search for that cluster returns lines in Kubeast.
  The full development example is `scripts/kind-logsearch.sh` (`deploy/kind/logsearch-*.yaml`).

## 15. The cluster Kubeast is installed on

| What | Requirement |
| --- | --- |
| User namespaces | `podSecurity.hostUsers: false` (default) needs Kubernetes 1.33 or later and a node kernel that supports it (6.3 or later). Otherwise `true` |
| Storage | With the built-in PostgreSQL, a PVC — the default StorageClass or `postgresql.storageClassName` |
| Exposure | NodePort (default), LoadBalancer, or an Ingress controller (`ingress.enabled`) |
| NetworkPolicy | `networkPolicy.enabled` (default on) takes effect only on a CNI that supports NetworkPolicy (Calico, Cilium, EKS VPC CNI network policy) |
| Console metrics scraping | Turning on `metrics.serviceMonitor` or `metrics.prometheusRule` needs the prometheus-operator CRDs ([metrics.md](metrics.md)) |
| EKS external clusters, S3 | IRSA role (`aws.irsaRoleArn`, etc.) |
| Private CA, TLS-intercepting proxy | The Secrets and ConfigMaps listed in `customCAs` must exist in the release namespace first (otherwise new pods wait for the volume and do not start, while the previous pods keep answering) |

## 16. Hubble Relay (network flows)

For the drawers' "Recent Flows" and the AI tool `network_flows` (`features.networkFlows`, off by default), each cluster listed in `features.networkFlows.clusters` needs the following.

- **Hubble Relay**: Cilium with Hubble and Hubble Relay on (`hubble.relay.enabled=true`).
  - Kubeast calls only the Relay's `observer.Observer/GetFlows`.
  - The flows are what Hubble keeps in memory on each node. A busy node keeps a shorter past, and the answer says so when Hubble reports lost events.
- **Microsoft Retina's Hubble control plane** (1.3.0, chart `oci://ghcr.io/microsoft/retina/charts/retina-hubble`) serves the same Relay API:
  - The chart's Relay requires client certificates by default. Set `hubble.relay.tls.server.enabled=true` and `hubble.relay.tls.server.mtls=false` for `proxy` mode, and `hubble.tls.auto.method=cronJob` (`helm` does not render in 1.3.0).
  - Retina's flows name the pod but not its workload. Kubeast names it as Cilium does (the Deployment of a ReplicaSet's pods, the CronJob of a Job's), from the pods it lists as the user (`list` on `pods`, which `view` has). For a workload's flows it also asks the Relay for the workload's current pods by name.
  - Retina sees a pod's packet to a Service before kube-proxy sends it on, so the destination is the Service's cluster IP. Kubeast lists the Services as the user and marks that end (`service_address`).
  - A NetworkPolicy drop is DROPPED only where Retina sees the drop. On kind's kindnet, which decides policy in user space, a refused connection is FORWARDED where it leaves the client and gets no reply.
- **Calico** (3.33.0, Tigera operator 1.44.0, with the operator's `Goldmane` and `Whisker` resources): an entry `calico` (or `calico:<namespace>/<service>:<port>`) reads Whisker's flow list, `GET /api/v1/namespaces/calico-system/services/https:whisker:8443/proxy/whisker-backend/flows`, as the signed-in user. Goldmane itself requires client certificates, so Kubeast does not call it.
  - **Let the API server reach Whisker.** The operator's policy `calico-system.whisker` admits nothing, and Whisker has no authentication of its own, so do not open it wider than the API server. One Calico policy in the `calico-system` tier admits the endpoints of `default/kubernetes` (`deploy/kind/calico-whisker-apiserver.yaml`):

    ```yaml
    apiVersion: projectcalico.org/v3
    kind: NetworkPolicy
    metadata:
      name: calico-system.kubeast-whisker-apiserver
      namespace: calico-system
    spec:
      tier: calico-system
      order: 0
      selector: k8s-app == 'whisker'
      types: [Ingress]
      ingress:
        - action: Allow
          protocol: TCP
          source:
            services: {name: kubernetes, namespace: default}
          destination:
            ports: [8443]
    ```

    Without it the read gives 502 with the API server's timeout. On a single-node cluster it may work anyway, because Calico always lets a node reach its own pods.
  - **Permission**: `get` on `services/proxy` named `https:whisker:8443` in `calico-system`. Render `templates/impersonation-viewer-whisker.yaml` with `features.networkFlows.whisker=calico-system/whisker:8443` for each such cluster. The template renders nothing while that value is empty.
  - Calico reports flows aggregated over the window, per pair of pod sets (`client-7bc956576c-*`: the pods of one GenerateName), port, action and the side that reported. Kubeast counts packets, names each set's workload from the pods it lists as the user, and shows a Pod drawer the flows of its set.
  - A denied connection is DROPPED (`POLICY_DENIED`) where Calico reports it. The policy that allowed or denied it is named when it has a name; a deny at the end of a tier has none.
- **`proxy` mode (default)**: Kubeast sends `POST /api/v1/namespaces/<ns>/services/https:<service>:<port>/proxy/observer.Observer/GetFlows` to that cluster's API server as the signed-in user. Nothing new is opened on the network.
  - The Relay Service is `features.networkFlows.relay` (default `kube-system/hubble-relay:443`), or the one an entry names (`proxy:<namespace>/<service>:<port>`).
  - **The Relay must serve TLS** (`hubble.relay.tls.server.enabled=true`): the API server speaks HTTP/2 to a backend only over TLS, and gRPC needs HTTP/2. A plaintext Relay gives 502 or 503, and the message names that setting.
  - The API server does not check the Relay's certificate (it proxies by IP) and sends no client certificate, so a Relay that requires client certificates (`hubble.relay.tls.server.mtls=true`) needs the address mode.
- **Address mode** (`https://<host>:<port>`): Kubeast connects to the Relay itself over TLS.
  - `tls.existingSecret` holds `ca.crt`, and with `tls.clientCertificate: true` also `tls.crt` and `tls.key` for mTLS. `tls.serverName` overrides the name checked on the certificate.
  - The Relay must be reachable from k8s-service: add the address to `features.networkFlows.egressCIDRs` when `networkPolicy` is on.
  - Kubeast asks the cluster the same permission as below (SelfSubjectAccessReview) before each read, so the same people read in both modes.
- **Permission**: the user needs `resource.networkflow.read` in Kubeast (in the Read role) and, in the cluster, `create` on `services/proxy` for the Relay Service, named exactly `https:<service>:<port>`.
  - `view` and `edit` do not include `services/proxy`, so render the Role for each cluster:
    `helm template kubeast helm/kubeast -s templates/impersonation-viewer-hubble.yaml -f <values> | kubectl --context <cluster> apply -f -`
  - It binds `kubeast:viewer` (and `kubeast:investigator` while `features.alertInvestigation` is on) to `get` and `create` on that one name in the Relay's namespace.
  - Namespace-limited grants (`kubeast:role:*`) are not bound, so those users get 403 with the permission named. A namespace-limited user who is bound sees peers outside their namespaces by namespace and address only.
- **Check**: as a Read user, open a Pod drawer → Recent Flows → Show flows.
  Or, with the user's identity: `kubectl auth can-i create services/https:hubble-relay:443 --subresource=proxy -n kube-system --as=<user> --as-group=kubeast:viewer`.
  The full development example is `scripts/kind-cilium.sh` (`deploy/kind/cilium-*.yaml`, `deploy/kind/networkflows-values.yaml`).

## 17. Hubble metrics (network drops)

For the drawers' "Network Drops" and the AI tool `network_drops`, the cluster's Prometheus (§3) needs the Hubble drop metric `hubble_drop_total`. There is no Kubeast switch: the section and the tool read it wherever Prometheus is set up.

- **The metric**: Hubble's `drop` metric, off by default in Cilium, with labels that name both ends. Kubeast reads one of two shapes.
  - **Separate labels (recommended)**: `labelsContext` with at least `source_namespace`, `source_workload`, `destination_namespace` and `destination_workload`.
    - With `source_workload_kind` and `destination_workload_kind`, Kubeast also matches the kind.
    - With `source_pod` and `destination_pod`, a pod's drops are its own; without them, a pod shows its workload's. Pod labels add many series.
  - **One label per end**: `sourceContext=pod` and `destinationContext=pod` give `source`/`destination` = `<namespace>/<pod>`. Retina's chart default writes this shape for the pod's own end only (`sourceEgressContext=pod;destinationIngressContext=pod`).
  - Retina's drop metric on kind's kindnet names no pod at all (`DROP_REASON_UNKNOWN`), so the drawer reports no labels there.
  - A metric with neither shape is reported as having no pod or workload labels.
- **Cilium Helm values** (1.20.4):

  ```yaml
  hubble:
    metrics:
      enabled:
        - drop:labelsContext=source_namespace,source_workload,source_workload_kind,destination_namespace,destination_workload,destination_workload_kind,traffic_direction
  ```

- **Changing the labels later**: the agents read the metric settings when they start. After a Helm change, restart them (`kubectl -n kube-system rollout restart ds/cilium`) or set `rollOutCiliumPods: true`.
- **Scraping**: Prometheus scrapes each agent's metrics port (Service `kube-system/hubble-metrics`, port `hubble-metrics`, 9965). On a shared store the cluster label applies as for every other metric (§3).
- **Retention**: the drawer offers up to a day. Shorter retention shows what is kept.
- **Permission**: as for every Prometheus read (§3): the user's GET through the API server proxy, or the store's own credentials. Kubeast also asks `resource.networkflow.read`.
- **What a count is**: one dropped packet (each a Hubble event), so a refused connection that retries counts several times. `reason` is the drop reason name, such as `POLICY_DENIED`.
- **Check**: `count by (source_workload, destination_workload, reason) (hubble_drop_total)` in Prometheus, or a Pod drawer → Network Drops.

## 18. Resource Graph traffic lines

The Resource Graph's Traffic and Both views draw lines from one of two sources. The switch is shown when the cluster has at least one and the user has `resource.networkflow.read`.

- **Recent flows**: the Hubble Relay of §16, with the same permission. One read covers all the chosen namespaces (Hubble's pod filter takes several `<namespace>/` prefixes). On Calico it is Whisker (§16): two lists, one per side, and the numbers are packets.
  - A connection is allowed where it arrived: seen at the destination's ingress, answered, or going outside the pods. One seen only leaving towards a pod is not drawn as allowed; when NetworkPolicy dropped it at the destination, that drop draws the line.
  - Up to `features.networkFlows.graphMaxFlows` flows (2,000, at most 10,000) from the last `defaultRange` (15 minutes). The Relay keeps a ring of flows on each node (Cilium `hubble.eventBufferCapacity`, 4,095 by default), so a busy cluster shows a shorter past; the graph says when the read reached the limit.
  - Measured on the development cluster: a read of 200 flows took about 12 ms and 100 KB; the Relay used 31 MiB.
- **Metrics**: the cluster's Prometheus (§3) with these Hubble metrics, in either label shape of §17:
  - `hubble_tcp_flags_total` (Hubble's `tcp` metric): Kubeast counts `flag="SYN"`, the packet a client sends to open a connection, so a line points from client to server. With `traffic_direction`, a connection counts once, where it arrived: at the destination pod's ingress, or leaving towards an address outside the pods. Hubble's verdict is per observation point, so a SYN that NetworkPolicy drops at the destination is FORWARDED where it left the client; counted where it arrived, it is not an opened connection. Without `traffic_direction`, both sides add up and the graph says so.
  - `hubble_drop_total` (§17) for the dropped packets and their reasons.
  - UDP traffic such as DNS has no SYN and is not drawn from the metrics. Recent flows show it.
  - **Why not `hubble_flows_processed_total`**: Hubble's `flow` metric counts every flow, replies too, and has no label to tell them apart, so every connection would also draw a line back. Leaving replies out takes an `excludeFilters` entry, which only the dynamic metrics exporter has, and Cilium refuses static and dynamic metrics together ("cannot configure both static and dynamic Hubble metrics", 1.20.4).
- **Cilium Helm values** (1.20.4), next to the `drop` metric of §17:

  ```yaml
  hubble:
    metrics:
      enabled:
        - drop:labelsContext=source_namespace,source_workload,source_workload_kind,destination_namespace,destination_workload,destination_workload_kind,traffic_direction
        - tcp:labelsContext=source_namespace,source_workload,source_workload_kind,destination_namespace,destination_workload,destination_workload_kind,traffic_direction
  ```

  Restart the agents after the change, as in §17.
- **Retina**:
  - Recent flows: a connection to a Service is seen leaving the client towards the Service's cluster IP (§16). It counts where it arrives, at the pod's ingress, not as a line to an address outside the pods.
  - Metrics: Retina leaves the workload labels empty, so add `source_pod` and `destination_pod` to `labelsContext` (`deploy/kind/retina-values.yaml`). Kubeast then names the pods' workloads as in §16.
  - The SYNs leaving a client towards a Service carry no destination in the metrics, like those leaving the pods. With pod labels only, Kubeast does not draw connections towards an unnamed address, and the graph says so. Recent flows show them.
- **Check**: `sum by (source_workload, destination_workload) (increase(hubble_tcp_flags_total{flag="SYN"}[1h]))` in Prometheus, or Resource Graph → Traffic.

## 19. Network Flow Monitor (top talkers, EKS)

For the drawers' "Top Talkers" and the AI tool `network_top_flows` (`features.networkFlowMonitor`, off by default), Kubeast reads the top contributors of an Amazon CloudWatch Network Flow Monitor (NFM) monitor: what EKS Container Network Observability shows in the console's flow table. Nothing is read through the cluster. Kubeast asks AWS with its own identity, and the cluster only decides who may see the rows.

- **On AWS**: turn on Container Network Observability for the cluster in the EKS console, or create an NFM scope, a monitor whose local resource is the cluster and the add-on `aws-network-flow-monitoring-agent` 1.1.0 or later (Terraform AWS provider 6.21.0 or later). The console names the monitor `<cluster>-monitor`.
  - The agent names only pods that have their own network namespace; a host-network pod shows as its node's address.
- **Settings**: `features.networkFlowMonitor.region` (the monitors' Region) and `clusters` (`<Kubeast cluster ID>: <monitor name>`).
- **What Kubeast reads**: one top contributors query per category of the chosen view: start it, ask its status until it has succeeded, read its rows. A query that has not finished within `timeout` (15 seconds) is stopped.
  - Views, as in the console: within the cluster (`INTRA_AZ`, `INTER_AZ`), AWS services (`AMAZON_S3`, `AMAZON_DYNAMODB`), outside AWS (`UNCLASSIFIED`, the internet or on-premises).
  - Metrics: `DATA_TRANSFERRED` (bytes), `RETRANSMISSIONS`, `TIMEOUTS` (retransmission timeouts). The EKS agent's flows carry these three.
  - NFM takes no namespace or pod: each query returns up to `limit` rows (500, NFM's maximum) for the whole monitor. Kubeast keeps the rows with the namespace, pod or workload at either end and names the pods' workloads as the user lists them. The same question in the same minute is answered from memory.
  - The range is `defaultRange` (1 hour), at most `maxRange` (2 hours) — the console reads 1 and 2 hours.
  - A connection between two pods can be listed once from each end, since each node's agent reports what it measured.
- **Kubeast's AWS identity** (k8s-service): the `aws.irsaRoleArn` role, a role in `serviceAccounts.k8sService.annotations` (IRSA), or `existingSecret` with `accessKeyId` and `secretAccessKey`. It needs these four actions on the monitors (IAM lists the start and stop actions as Write; they start and stop a query, the monitor is not changed):

  ```json
  {
    "Version": "2012-10-17",
    "Statement": [
      {
        "Effect": "Allow",
        "Action": [
          "networkflowmonitor:StartQueryMonitorTopContributors",
          "networkflowmonitor:GetQueryStatusMonitorTopContributors",
          "networkflowmonitor:GetQueryResultsMonitorTopContributors",
          "networkflowmonitor:StopQueryMonitorTopContributors"
        ],
        "Resource": "arn:aws:networkflowmonitor:<region>:<account>:monitor/<monitor name>"
      }
    ]
  }
  ```

  AWS on port 443 is open in Kubeast's NetworkPolicy. A refusal by AWS is the install's configuration, so the API answers 502 with AWS's error code.
- **Who may read**: holders of `resource.networkflow.read` whom the cluster lets `list` pods in the namespace (Kubeast asks with a SelfSubjectAccessReview as the user). A peer in a namespace whose pods the user cannot list, or outside a namespace-limited grant, shows its namespace and address only. Each read is recorded as `k8s.networkflows.query` with `provider: nfm`.
- **Check**: `aws networkflowmonitor list-monitors --region <region>` shows the monitor, and a Pod drawer → Top Talkers → Show top talkers lists rows.
- **Verified**: against a stand-in of the API in the development cluster (`deploy/kind/devtools.yaml`, e2e `network-top-flows.spec.ts`) with the AWS SDK for Go v2 client; not yet against a real monitor.

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
| Loki · OpenTelemetry Collector contrib | 3.7.9 · 0.163.1 | 10-14 (3.7.8 · 0.162.0), raised 10-21. Collectors of two clusters write to one Loki in development cluster 2: Job logs found by text and by workload, 0 lines from the other cluster, and still found after the Job was deleted (e2e `log-search.spec.ts`) |
| OpenTelemetry Collector contrib `host_metrics` | 0.163.1 | 10-17 (0.162.0), raised 10-21. Development cluster 1 (no node-exporter, `scripts/kind-hostmetrics.sh`) remote-writes to cluster 2's Prometheus. Compared with cluster 2's node-exporter, which sees the same kernel: memory 70.6% / 70.7%, the same total memory bytes, Load 6.72 / 6.66, CPU 13.3% / 13.5%; the node drawer and dashboard filled (e2e `node-hostmetrics.spec.ts`). In 0.162 the names `hostmetrics` and `prometheusremotewrite` are deprecated aliases, so `host_metrics` and `prometheus_remote_write` are used |
| VictoriaMetrics | v1.154.1 (single-node, cluster, vmagent) | 10-20 (v1.154.0), raised 10-21. Development cluster 2 (`scripts/kind-victoriametrics.sh`, with the same scrape config as cluster 2's Prometheus): node memory total is the same bytes in Prometheus and in the single-node and cluster versions; `/-/healthy` is 200 on the single-node version and on vmselect with its path; rules and alerts are empty placeholders; the vmselect targets API gives 400 → `up`; metadata types and descriptions are present (e2e `victoriametrics.spec.ts`) |
| Grafana | 13.2.4 | 10-17, development cluster 2 (`scripts/kind-grafana.sh`). Metrics and logs read through the data source proxy equal the values read directly, and the dashboard and node drawer fill. A wrong token gives 401 in the status. An alert sent by a webhook contact point test is investigated (e2e `grafana.spec.ts`) |
| Argo CD | 3.5.6 (core install) | 10-21, development cluster 2 (`scripts/kind-argocd.sh`). An Application syncs the podinfo chart. Checked: tracking annotation, 409, audit row, drawer badge, `gitops_status` (e2e `argocd-real.spec.ts`) |
| Cilium (Hubble Relay) | 1.20.4 | 10-24, a kind cluster of its own without the default CNI (`scripts/kind-cilium.sh`, Relay TLS on). Read in `proxy` mode as a Read user: client → web on port 80 is FORWARDED with the NetworkPolicy `web-only-client` in `ingress_allowed_by` and the replies folded in, and stranger → web is DROPPED with `POLICY_DENIED` at ingress, as the policy says. A namespace-limited user gets 403 from the cluster; the drawer's "Why?" names the rule; MCP gives the same groups (e2e `network-flows.spec.ts`). 10-25: the `drop` metric with the labels of §17, scraped by Prometheus v3.15.0 on that cluster (`deploy/kind/cilium-prometheus.yaml`): the drawer and `network_drops` give the peers, reasons and counts of a direct query, and a namespace-limited user gets 403 from the cluster (e2e `network-drops.spec.ts`) |
| Microsoft Retina (Hubble control plane) | 1.3.0 | 10-25, a kind cluster with kindnet (`scripts/kind-retina.sh`, `deploy/kind/retina-values.yaml`; the 1.3.1 images were not published). Read in `proxy` mode: a Deployment's recent flows find its pods by name, with the workloads named from the pods; client → web is one line, counted at web's ingress, not at the Service's cluster IP; with the pod labels, the metric lines equal a direct query of the SYNs at web's ingress (e2e `network-retina.spec.ts`). Policy drops were not reported as drops there (kindnet) |
| Calico (Goldmane, Whisker) | 3.33.0 (Tigera operator 1.44.0) | 10-25, a kind cluster of a control plane and a worker (`scripts/kind-calico.sh`), Whisker on the worker. Without the policy above the API server proxy timed out; with it, read in `proxy` mode: client → web allowed by the NetworkPolicy `web-only-client`, stranger → web denied at web, a Pod drawer showing its set, the Resource Graph's lines with stranger → web dropped; a pod in another namespace still could not reach Whisker (e2e `network-calico.spec.ts`) |
| GPU, DRA, VPA, Gateway API, ingress-nginx | — | Based on the code, not verified on a real cluster |

On kind nodes the root filesystem is not picked up as `mountpoint="/"`, so disk utilization is empty, and local-path volumes have no volume stats. Real nodes and CSI drivers do produce these values.
