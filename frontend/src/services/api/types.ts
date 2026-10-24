// ===== Model Config Types =====
export interface ModelConfigCreate {
  name: string
  provider: string
  model: string
  base_url?: string
  api_key_env?: string                // ai-service env var holding the key (never stored)
  api_key_secret_name?: string
  api_key_secret_key?: string
  extra_headers?: Record<string, string>
  tls_verify?: boolean
  ca_cert?: string                    // self-signed CA (PEM) for self-hosted HTTPS
  options?: Record<string, unknown>   // generation options (temperature, top_p, num_ctx ...)
  enabled?: boolean
  is_default?: boolean
  tier?: 'default' | 'economy'        // economy: history summaries and the floating assistant
}

export interface ModelConfigResponse {
  id: number
  name: string
  provider: string
  model: string
  base_url: string | null
  api_key_env: string | null
  api_key_secret_name: string | null
  api_key_secret_key: string | null
  extra_headers: Record<string, string>
  tls_verify: boolean
  ca_cert: string | null
  options: Record<string, unknown> | null
  enabled: boolean
  is_default: boolean
  tier: 'default' | 'economy'
  created_at: string
  updated_at: string
}

// ===== Timeline Types =====
export interface TimelineEvent {
  timestamp: string
  type: 'Normal' | 'Warning'
  reason: string
  message: string
  source: string
  resource: { kind: string; name: string; namespace: string }
  involved_object: { kind: string; name: string; namespace: string }
  count: number
  first_seen: string
  last_seen: string
}

export interface RolloutRevision {
  kind: string
  name: string
  namespace: string
  revision: number
  change_cause: string | null
  created_at: string
  images: string[]
  replicas: number
}

export interface TimelineResult {
  events: TimelineEvent[]
  rollout_history: RolloutRevision[]
  summary: {
    total_events: number
    normal_count: number
    warning_count: number
    time_range: { start: string; end: string }
  }
}

// Types
export interface ClusterOverview {
  total_namespaces: number
  total_pods: number
  total_services: number
  total_deployments: number
  total_pvcs: number
  total_pvs: number
  pod_status: Record<string, number>
  node_count: number
  /** counted within a namespace-scoped grant: cluster-wide numbers (nodes, PVs) are not counted */
  scoped?: boolean
  cluster_version?: string
}

export interface NamespaceInfo {
  name: string
  status: string
  created_at: string
  labels: Record<string, string>
  resource_count: Record<string, number>
}

export interface NamespaceCondition {
  type?: string
  status?: string
  last_transition_time?: string
  reason?: string
  message?: string
}

export interface NamespaceDescribe {
  name: string
  status?: string
  created_at?: string
  uid?: string
  resource_version?: string
  deletion_timestamp?: string | null
  finalizers?: string[]
  owner_references?: Array<{
    kind?: string | null
    name?: string | null
    uid?: string | null
    controller?: boolean | null
  }>
  labels: Record<string, string>
  annotations: Record<string, string>
  conditions: NamespaceCondition[]
  events: Array<{
    type?: string
    reason?: string
    message?: string
    count?: number
    first_timestamp?: string
    last_timestamp?: string
  }>
}

export interface NamespaceResourceQuota {
  name: string
  namespace: string
  created_at?: string
  spec_hard: Record<string, string>
  status_hard: Record<string, string>
  status_used: Record<string, string>
}

export interface NamespaceLimitRange {
  name: string
  namespace: string
  created_at?: string
  limits: Array<{
    type?: string
    default: Record<string, string>
    default_request: Record<string, string>
    max: Record<string, string>
    min: Record<string, string>
  }>
}

export interface NamespacePod {
  name: string
  namespace: string
  status: string
  ready: string
  restarts: number
  node?: string
  created_at?: string
}

export interface ServiceInfo {
  name: string
  namespace: string
  type: string
  cluster_ip?: string
  external_ip?: string
  ports: Array<{
    name?: string
    port: number
    target_port: string
    node_port?: number | null
    protocol: string
  }>
  selector: Record<string, string>
  created_at: string
}

export interface IngressInfo {
  name: string
  namespace: string
  hosts: string[]
  class?: string | null
  class_source?: 'spec' | 'annotation' | 'default' | null
  class_controller?: string | null
  class_is_default?: boolean | null
  addresses?: Array<{ ip?: string | null; hostname?: string | null }>
  tls?: Array<{ secret_name?: string | null; hosts: string[] }>
  default_backend?: any
  rules?: Array<{
    host?: string | null
    paths: Array<{
      path?: string | null
      path_type?: string | null
      backend?: any
    }>
  }>
  backends: string[]
  labels?: Record<string, string>
  annotations?: Record<string, string>
  created_at?: string | null
}

export interface IngressClassInfo {
  name: string
  controller?: string | null
  is_default: boolean
  parameters?: {
    api_group?: string | null
    kind?: string | null
    name?: string | null
    scope?: string | null
    namespace?: string | null
  } | null
  labels?: Record<string, string>
  annotations?: Record<string, string>
  finalizers?: string[]
  created_at?: string | null
}

export interface EndpointInfo {
  name: string
  namespace: string
  ready_count: number
  not_ready_count: number
  ready_addresses: string[]
  not_ready_addresses: string[]
  ready_targets?: Array<{
    ip?: string | null
    node_name?: string | null
    target_ref?: {
      kind?: string | null
      name?: string | null
      namespace?: string | null
      uid?: string | null
    } | null
  }>
  not_ready_targets?: Array<{
    ip?: string | null
    node_name?: string | null
    target_ref?: {
      kind?: string | null
      name?: string | null
      namespace?: string | null
      uid?: string | null
    } | null
  }>
  ports: Array<{
    name?: string | null
    port?: number | null
    protocol?: string | null
  }>
  created_at?: string | null
}

export interface EndpointSliceInfo {
  name: string
  namespace: string
  service_name?: string | null
  managed_by?: string | null
  address_type?: string | null
  endpoints_total: number
  endpoints_ready: number
  endpoints_not_ready?: number
  ports: Array<{
    name?: string | null
    port?: number | null
    protocol?: string | null
    app_protocol?: string | null
  }>
  endpoints?: Array<{
    addresses: string[]
    hostname?: string | null
    node_name?: string | null
    zone?: string | null
    conditions?: {
      ready?: boolean | null
      serving?: boolean | null
      terminating?: boolean | null
    }
    target_ref?: {
      kind?: string | null
      name?: string | null
      namespace?: string | null
      uid?: string | null
    } | null
  }>
  labels?: Record<string, string>
  annotations?: Record<string, string>
  created_at?: string | null
}

export interface NetworkPolicyInfo {
  name: string
  namespace: string
  pod_selector: {
    match_labels: Record<string, string>
    match_expressions: Array<{
      key?: string | null
      operator?: string | null
      values?: string[] | null
    }>
  }
  selects_all_pods?: boolean
  policy_types: string[]
  default_deny_ingress?: boolean
  default_deny_egress?: boolean
  ingress_rules: number
  egress_rules: number
  ingress?: Array<{
    from: Array<{
      ip_block?: { cidr?: string | null; except?: string[] } | null
      namespace_selector?: {
        match_labels: Record<string, string>
        match_expressions: Array<{
          key?: string | null
          operator?: string | null
          values?: string[] | null
        }>
      } | null
      pod_selector?: {
        match_labels: Record<string, string>
        match_expressions: Array<{
          key?: string | null
          operator?: string | null
          values?: string[] | null
        }>
      } | null
    }>
    ports: Array<{
      protocol?: string | null
      port?: string | null
      end_port?: number | null
    }>
  }>
  egress?: Array<{
    to: Array<{
      ip_block?: { cidr?: string | null; except?: string[] } | null
      namespace_selector?: {
        match_labels: Record<string, string>
        match_expressions: Array<{
          key?: string | null
          operator?: string | null
          values?: string[] | null
        }>
      } | null
      pod_selector?: {
        match_labels: Record<string, string>
        match_expressions: Array<{
          key?: string | null
          operator?: string | null
          values?: string[] | null
        }>
      } | null
    }>
    ports: Array<{
      protocol?: string | null
      port?: string | null
      end_port?: number | null
    }>
  }>
  labels?: Record<string, string>
  annotations?: Record<string, string>
  finalizers?: string[]
  created_at?: string | null
}

export interface GatewayInfo {
  name: string
  namespace: string
  gateway_class_name?: string | null
  listeners_count: number
  attached_routes: number
  addresses_count: number
  status?: string | null
  programmed?: boolean
  accepted?: boolean
  listeners?: Array<Record<string, any>>
  status_listeners?: Array<Record<string, any>>
  addresses?: Array<Record<string, any>>
  conditions?: Array<Record<string, any>>
  labels?: Record<string, string>
  annotations?: Record<string, string>
  finalizers?: string[]
  created_at?: string | null
  api_version?: string | null
}

export interface GatewayClassInfo {
  name: string
  controller_name?: string | null
  description?: string | null
  accepted?: boolean
  status?: string | null
  parameters_ref?: Record<string, any> | null
  conditions?: Array<Record<string, any>>
  labels?: Record<string, string>
  annotations?: Record<string, string>
  finalizers?: string[]
  created_at?: string | null
  api_version?: string | null
}

export interface HTTPRouteInfo {
  name: string
  namespace: string
  hostnames?: string[]
  parent_refs?: Array<Record<string, any>>
  rules?: Array<Record<string, any>>
  parents?: Array<Record<string, any>>
  rule_count?: number
  parent_refs_count?: number
  backend_refs_count?: number
  status?: string | null
  accepted?: boolean
  resolved_refs?: boolean
  conditions?: Array<Record<string, any>>
  labels?: Record<string, string>
  annotations?: Record<string, string>
  finalizers?: string[]
  created_at?: string | null
  api_version?: string | null
}

export interface GRPCRouteInfo {
  name: string
  namespace: string
  hostnames?: string[]
  parent_refs?: Array<Record<string, any>>
  rules?: Array<Record<string, any>>
  parents?: Array<Record<string, any>>
  rule_count?: number
  parent_refs_count?: number
  backend_refs_count?: number
  status?: string | null
  accepted?: boolean
  resolved_refs?: boolean
  conditions?: Array<Record<string, any>>
  labels?: Record<string, string>
  annotations?: Record<string, string>
  finalizers?: string[]
  created_at?: string | null
  api_version?: string | null
}

export interface ReferenceGrantInfo {
  name: string
  namespace: string
  from?: Array<Record<string, any>>
  to?: Array<Record<string, any>>
  labels?: Record<string, string>
  annotations?: Record<string, string>
  created_at?: string | null
  api_version?: string | null
}

export interface BackendTLSPolicyInfo {
  name: string
  namespace: string
  target_refs?: Array<Record<string, any>>
  conditions?: Array<Record<string, any>>
  labels?: Record<string, string>
  annotations?: Record<string, string>
  created_at?: string | null
}

// Gateway → Policies (every implementation's policy kinds in one list)
export interface GatewayPolicyTarget {
  kind: string       // GEP-713 target kind, or "selector" / "host" for Istio-style attachment
  name: string
  namespace?: string
  group?: string
  section?: string
}

export interface GatewayPolicyItem {
  name: string
  namespace: string
  kind: string
  group: string
  version: string
  plural: string
  scope: string
  source: 'label' | 'builtin' | 'configured' | string
  labels?: Record<string, string>
  created_at?: string | null
  targets: GatewayPolicyTarget[]
  accepted?: boolean
}

export interface GatewayPolicyKindInfo {
  group: string
  version: string
  plural: string
  kind: string
  scope: string
  source: string
  count: number
  error?: string
}

export interface GatewayPoliciesResponse {
  namespace: string
  kinds: GatewayPolicyKindInfo[]
  items: GatewayPolicyItem[]
}

// GPU / DRA types
export interface GPUNodeInfo {
  name: string
  gpu_model?: string | null
  gpu_memory?: string | null
  gpu_capacity: number
  gpu_allocatable: number
  status: string
  mig_strategy?: string | null
  driver_version?: string | null
}

export interface GPUPodInfo {
  name: string
  namespace: string
  node_name?: string | null
  gpu_requested: number
  status: string
  created_at?: string | null
}

export interface GPUDashboardData {
  total_gpu_capacity: number
  total_gpu_allocatable: number
  total_gpu_used: number
  gpu_nodes: GPUNodeInfo[]
  gpu_pods: GPUPodInfo[]
  device_plugin_status: {
    name?: string | null
    namespace?: string | null
    desired: number
    ready: number
    available: number
  } | null
  mig_enabled: boolean
  time_slicing_enabled: boolean
  time_slicing_config: Record<string, any> | null
}

export interface GPUDeviceMetric {
  uuid: string
  gpu: string
  hostname: string
  model_name: string
  gpu_util: number
  memory_used_mb: number
  memory_free_mb: number
  memory_total_mb: number
  memory_util_percent: number
  memory_temp: number
  exported_pod?: string
  exported_namespace?: string
}

export interface GPUMetricsData {
  available: boolean
  gpu_count: number
  avg_gpu_util: number
  avg_memory_util: number
  total_memory_used_mb: number
  total_memory_free_mb: number
  total_memory_mb: number
  gpus: GPUDeviceMetric[]
}

export interface PrometheusQueryResult {
  metric: Record<string, string>
  value: number
}

// GET /cluster/prometheus/status — where the cluster's metrics come from.
export interface PrometheusStatus {
  available: boolean
  source?: 'external' | 'proxy' | 'none'
  endpoint?: string
  auth?: boolean
  cluster_label?: string
  label_name?: string
  // proxy: the Service was named in the settings (true) or found by discovery.
  configured?: boolean
  message?: string
  // source none: why, as a catalog key for message (not_found, discover_off)
  reason?: string
  // what answered: prometheus or victoriametrics
  flavor?: string
}

export interface PrometheusQueryResponse {
  available: boolean
  results: PrometheusQueryResult[]
}

// GET /cluster/logsearch/status — where the cluster's log search reads from.
export interface LogSearchStatus {
  available: boolean
  source?: 'cluster' | 'global' | 'none'
  endpoint?: string
  auth?: boolean
  tenant?: string
  cluster_label?: string
  label_name?: string
  message?: string
}

// Range query — one (t, v) per sample, points ordered chronologically.
export interface PrometheusRangePoint {
  t: number // unix seconds
  v: number
}

export interface PrometheusRangeSeries {
  metric: Record<string, string>
  points: PrometheusRangePoint[]
}

export interface PrometheusRangeResponse {
  available: boolean
  results: PrometheusRangeSeries[]
}

// /api/v1/cluster/features — operator-opt-in toggles, read once at boot
// and cached on the React Query client. See helm values.yaml `features.*`.
export interface ClusterFeatures {
  prometheus: { enabled: boolean }
  gitops?: {
    argocd: { enabled: boolean; mode: 'warn' | 'block'; url: string; trackingAnnotation: string; instanceLabel: string }
  }
  issues?: { eventWindowMinutes: number }
  optimization?: { windowHours: number }
  // Log files inside containers; namespaces empty = every namespace.
  logFiles?: { enabled: boolean; maxLines: number; namespaces: string[] }
  // Log store search (Loki): the clusters it is configured for, and its limits.
  logSearch?: { enabled: boolean; clusters: string[]; logql?: boolean; defaultRangeMinutes?: number; maxRangeMinutes?: number; maxLines?: number }
  // Trace links: URL templates with {{traceId}} {{cluster}} {{namespace}} {{pod}} {{container}} {{service}}.
  tracing?: { enabled: boolean; traceUrl?: string; searchUrl?: string }
  // Optimization → apply without restart (pod resize subresource, server 1.35+).
  inPlaceResize?: { enabled: boolean; serverSupports: boolean }
  // Validating/Mutating admission policies and bindings: YAML apply (and the AI write tools) refused while on.
  admissionPolicies?: { readOnly: boolean }
  // Chart ai.enabled: off = no AI services in the installation; the screens hide the AI entry points.
  ai?: { enabled: boolean }
  // Cost page and the optimization table's cost columns (OpenCost in the cluster, features.cost).
  cost?: { enabled: boolean }
  // Security → Policy Reports and the drawer's "Policy violations" section (wgpolicyk8s.io, features.policyReports).
  policyReports?: { enabled: boolean }
  // Admin → Investigations: alert → AI investigation reports (ai-service, features.alertInvestigation, needs AI).
  alertInvestigation?: { enabled: boolean }
  // Chart features.alertStore: the clusters whose alerts and silences an Alertmanager-compatible store holds.
  alertStore?: { enabled: boolean; clusters: string[]; clusterLabel?: string; silences?: boolean; silenceMaxHours?: number }
  // Chart features.networkFlows: the clusters whose Hubble Relay Kubeast reads.
  networkFlows?: { enabled: boolean; clusters: string[] }
}

// Policy reports (wgpolicyk8s.io/v1alpha2 PolicyReport / ClusterPolicyReport as Kyverno and others write them).
export type PolicyReportResultValue = 'pass' | 'fail' | 'warn' | 'error' | 'skip'

export interface PolicyReportCounts {
  pass: number
  fail: number
  warn: number
  error: number
  skip: number
}

// One row of a report: what one policy rule said about one resource.
export interface PolicyReportResult {
  namespace: string
  kind: string
  name: string
  policy: string
  rule?: string
  result: PolicyReportResultValue
  severity?: string
  category?: string
  message?: string
  source?: string
  timestamp?: string
  report: string
}

export interface PolicyReportPolicyRow extends PolicyReportCounts {
  policy: string
  category?: string
  severity?: string
  source?: string
  namespaces: string[]
}

export interface PolicyReportNamespaceRow extends PolicyReportCounts {
  namespace: string
  policies: number
}

// GET /api/v1/cluster/policyreports/summary?namespace= — scoped says the caller's grant narrowed it.
export interface PolicyReportSummary {
  generated_at: string
  namespace?: string
  reports: number
  truncated: boolean
  scoped: boolean
  totals: PolicyReportCounts
  policies: PolicyReportPolicyRow[]
  namespaces: PolicyReportNamespaceRow[]
}

// GET /api/v1/cluster/policyreports/results — total counts the matches before the limit.
export interface PolicyReportResults {
  generated_at: string
  truncated: boolean
  scoped: boolean
  total: number
  rows: PolicyReportResult[]
}

// GET /api/v1/cluster/namespaces/{ns}/networkpolicies/effective?kind=&name= — the NetworkPolicies that
// select a pod or a workload's pods. A selector is label-selector text: "" selects everything,
// absent means the peer does not use it.
export interface NetpolPeerSummary {
  pod_selector?: string
  namespace_selector?: string
  cidr?: string
  except?: string[]
}

export interface NetpolPortSummary {
  protocol: string
  port?: string
  end_port?: number
}

export interface NetpolDirection {
  isolated: boolean
  policies: { name: string; rules: { peers: NetpolPeerSummary[]; ports: NetpolPortSummary[] }[] }[]
}

// Policy kinds of a plugin (Cilium, Calico) or of network-policy-api that the check does not evaluate;
// count -1 when they could not be listed.
export interface NetpolUnevaluated {
  kind: string
  group: string
  count: number
}

export interface NetpolEffective {
  kind: string
  namespace: string
  name: string
  host_network: boolean
  ingress: NetpolDirection
  egress: NetpolDirection
  unevaluated: NetpolUnevaluated[]
}

// GET /api/v1/cluster/namespaces/{ns}/networkflows?kind=&name=&since=&verdict=&limit= — recent flows from the
// cluster's Hubble Relay. A peer outside a namespace-limited reader's namespaces has its namespace and address only.
export interface NetflowEnd {
  namespace?: string
  pod?: string
  workload?: { kind: string; name: string }
  ip?: string
  port?: number
  names?: string[]
  service?: string
}

export interface NetflowPolicyRef {
  kind?: string
  namespace?: string
  name: string
}

// One connection: its flows from source to destination (count), the replies, where they were seen.
export interface NetflowGroup {
  source: NetflowEnd
  destination: NetflowEnd
  protocol?: string
  observed: string[]
  verdict: string
  drop_reason?: string
  policies?: { egress_allowed_by?: NetflowPolicyRef[]; ingress_allowed_by?: NetflowPolicyRef[]; egress_denied_by?: NetflowPolicyRef[]; ingress_denied_by?: NetflowPolicyRef[] }
  count: number
  replies: number
  first: string
  last: string
}

export interface NetflowResult {
  cluster: string
  mode: string
  relay: string
  namespace: string
  kind?: string
  name?: string
  since: string
  groups: NetflowGroup[]
  flows: unknown[]
  lost_events?: number
  truncated: boolean
  redacted?: boolean
}

// GET /api/v1/cluster/namespaces/{ns}/networkdrops?kind=&name=&range= — drops counted by the Hubble agents
// (Prometheus hubble_drop_total). incoming: the target is the destination; outgoing: the source.
export interface NetdropPeer {
  namespace?: string
  workload?: string
  kind?: string
  pod?: string
  reason: string
  count: number
}

export interface NetdropSide {
  total: number
  reasons: { reason: string; count: number }[] | null
  peers: NetdropPeer[] | null
}

export interface NetdropResult {
  available: boolean
  reason?: 'no_prometheus' | 'no_metrics' | 'no_context_labels'
  source?: string
  style?: 'labels' | 'pod'
  namespace: string
  kind?: string
  name?: string
  workload?: { kind: string; name: string }
  range: string
  incoming: NetdropSide
  outgoing: NetdropSide
  notes?: string[]
  redacted?: boolean
}

// GET /api/v1/cluster/networkpolicies/check?src=&dst=&port=&protocol= — an end is
// <kind>/<namespace>/<name> or an IP address; dst may be service/<namespace>/<name>.
export type NetpolResult = 'allowed' | 'denied' | 'unknown'

export interface NetpolRuleMiss {
  policy: string
  rule: number
  reason: string
}

export interface NetpolSide {
  isolated: boolean
  policies: string[]
  result: NetpolResult
  allowed_by: { policy: string; rule: number }[]
  undecided: NetpolRuleMiss[]
  misses: NetpolRuleMiss[]
}

export interface NetpolCheck {
  pods?: string[]
  port: number
  protocol: string
  service_port?: string
  result: NetpolResult
  egress?: NetpolSide
  ingress?: NetpolSide
  notes: string[]
}

export interface NetpolEnd {
  ref: string
  kind: string
  namespace?: string
  name?: string
  ips: string[]
  pods?: string[]
  namespace_labels_known: boolean
}

export interface NetpolCheckResult {
  source: NetpolEnd
  destination: NetpolEnd
  result: NetpolResult | 'mixed'
  checks: NetpolCheck[]
  unevaluated: NetpolUnevaluated[]
  notes: string[]
  truncated?: boolean
}

// GET /api/v1/cluster/namespaces/{ns}/policyreports/resource?kind=&name= — a workload includes its pods.
export interface PolicyReportResource {
  generated_at: string
  kind: string
  name: string
  namespace: string
  totals: PolicyReportCounts
  rows: PolicyReportResult[]
}

export interface PolicyReportStatus {
  enabled: boolean
  installed: boolean
  group: string
}

// POST /api/v1/cluster/namespaces/{ns}/optimization/resize — one optimization
// row's values applied to the workload's running pods, outcome per pod.
export interface ResizeRequest {
  kind: string
  name: string
  container: string
  cpu_request_m?: number
  mem_request_bytes?: number
}

export interface PodResizeResult {
  pod: string
  result: 'resized' | 'pending' | 'skipped' | 'error'
  reason?: string
}

export interface ResizeResult {
  kind: string
  namespace: string
  name: string
  container: string
  pods: PodResizeResult[]
  resized: number
  pending: number
  skipped: number
  failed: number
}

// admissionregistration.k8s.io/v1 ValidatingAdmissionPolicy / MutatingAdmissionPolicy list row
export interface AdmissionPolicyInfo {
  name: string
  failure_policy: string
  param_kind: string
  bindings_count: number
  bindings: string[]
  labels?: Record<string, string>
  created_at: string
  validations_count?: number
  mutations_count?: number
  reinvocation_policy?: string
}

// /api/v1/namespaces/{ns}/pods/{name}/logfiles — files only, no content.
export interface LogFileList {
  files: Array<{ path: string }>
  patterns: string[]
  max_lines: number
}

// …/logfiles/content — the last `lines` lines of one file.
export interface LogFileContent {
  container: string
  path: string
  lines: number
  content: string
  truncated: boolean
}

// /api/v1/cluster/namespaces/{ns}/logsearch — lines from the log store, newest first.
export interface LogSearchLine {
  ts: string
  namespace: string
  pod: string
  container: string
  line: string
  // OpenTelemetry service name and trace ID, when the store has them (trace ID only with features.tracing).
  service?: string
  traceId?: string
}

export interface LogSearchResult {
  lines: LogSearchLine[]
  // More lines in the range: ask again with end = oldest.
  truncated: boolean
  oldest?: string
  newest?: string
  bytes: number
  // A LogQL query as sent: the one written with the cluster and namespace matchers added.
  effectiveQuery?: string
}

// GET /cluster/namespaces/{ns}/logsearch/query — LogQL written by hand (features.logSearch.logql).
export interface LogQLParams {
  namespace: string
  q: string
  since?: string
  start?: string
  end?: string
  limit?: number
}

export interface LogSearchParams {
  namespace: string
  q?: string
  match?: 'contains' | 'regex'
  ignore_case?: boolean
  pod?: string
  container?: string
  workload_kind?: string
  workload_name?: string
  since?: string
  start?: string
  end?: string
  limit?: number
}

// /api/v1/cluster/issues — the dashboard's "Check issues": pods, workloads,
// nodes, PVCs and the Warning events of the last window, one row per object.
export interface ClusterIssue {
  id: string
  kind: string
  namespace?: string
  name: string
  severity: 'critical' | 'warning' | 'info'
  reason?: string
  message?: string
  last_seen?: string
  count?: number
}

export interface ClusterIssuesResponse {
  window_minutes: number
  generated_at: string
  issues: ClusterIssue[]
}

// /api/v1/cluster/optimization — requests and limits of each workload
// container against its usage over the window; recommendations are CPU p95
// and memory peak + 15%. Usage fields are absent when source is "none".
export interface OptimizationRow {
  kind: string
  namespace: string
  name: string
  container: string
  pods: number
  cpu_request_m: number
  cpu_limit_m: number
  cpu_usage_m?: number
  cpu_recommend_m?: number
  mem_request_bytes: number
  mem_limit_bytes: number
  mem_usage_bytes?: number
  mem_recommend_bytes?: number
  flags: string[]
  // With an OpenCost in the cluster (response.pricing): the row's requests a month, and what its recommendation saves.
  cost_month_usd?: number
  saving_month_usd?: number
}

// Hourly unit prices read back from OpenCost's allocation (cost ÷ hours over every namespace).
export interface CostUnitPrices {
  cpu_core_hour_usd: number
  ram_byte_hour_usd: number
  window: string
  source: 'opencost'
}

// GET /api/v1/cluster/cost/status
export interface CostStatus {
  available: boolean
  source: 'proxy' | 'none'
  endpoint?: string
  message?: string
}

export type CostWindow = '1h' | '6h' | '12h' | '24h' | '48h' | '7d' | '14d' | '30d'
export type CostAggregate = 'namespace' | 'controller'

// One allocation: a namespace, or a workload (controller) inside one. Costs are the window's total.
export interface CostRow {
  name: string
  namespace: string
  kind?: string
  cpu_cost: number
  ram_cost: number
  gpu_cost: number
  pv_cost: number
  network_cost: number
  load_balancer_cost: number
  total_cost: number
  cpu_core_hours: number
  ram_byte_hours: number
  cpu_efficiency: number
  ram_efficiency: number
  total_efficiency: number
  minutes: number
}

// GET /api/v1/cluster/cost?window=&aggregate= — scoped says the caller's namespace grant narrowed rows and totals.
export interface CostResponse {
  window: CostWindow
  aggregate: CostAggregate
  currency: string
  start?: string
  end?: string
  source: { namespace: string; service: string; port: number }
  scoped: boolean
  generated_at: string
  rows: CostRow[]
  totals: {
    cpu_cost: number
    ram_cost: number
    gpu_cost: number
    pv_cost: number
    network_cost: number
    load_balancer_cost: number
    total_cost: number
    cpu_core_hours: number
    ram_byte_hours: number
  }
}

export interface OptimizationResponse {
  namespace: string
  window_hours: number
  source: 'prometheus' | 'metrics-server' | 'none'
  generated_at: string
  rows: OptimizationRow[]
  totals: {
    pods: number
    cpu_request_m: number
    cpu_recommend_m: number
    mem_request_bytes: number
    mem_recommend_bytes: number
    cost_month_usd?: number
    saving_month_usd?: number
  }
  // Set when the cluster has an OpenCost: the rows then carry cost_month_usd / saving_month_usd.
  pricing?: CostUnitPrices
}

// kubelet_volume_stats_* via Prometheus; null when the driver reports no
// stats or Prometheus does not scrape the kubelet.
export interface PVCUsage {
  used_bytes: number
  capacity_bytes: number
  percent: number
  fills_in_days?: number
  source: string
}

export interface DeviceClassItem {
  name: string
  labels?: Record<string, string>
  created_at?: string | null
  selector_count?: number
  conditions?: Array<Record<string, any>>
}

export interface ResourceClaimItem {
  name: string
  namespace: string
  labels?: Record<string, string>
  created_at?: string | null
  request_count?: number
  allocation_status?: string | null
}

export interface ResourceClaimTemplateItem {
  name: string
  namespace: string
  labels?: Record<string, string>
  created_at?: string | null
  request_count?: number
}

export interface ResourceSliceItem {
  name: string
  labels?: Record<string, string>
  created_at?: string | null
  node_name?: string | null
  driver_name?: string | null
  pool_name?: string | null
  device_count?: number
}

export interface DeploymentInfo {
  name: string
  namespace: string
  replicas: number
  ready_replicas: number
  available_replicas: number
  updated_replicas: number
  image: string
  labels: Record<string, string>
  selector: Record<string, string>
  created_at: string
  status: string
  progressing_reason?: string
}

export interface ReplicaSetInfo {
  name: string
  namespace: string
  current_replicas: number
  replicas: number
  ready_replicas: number
  available_replicas: number
  image: string
  images?: string[]
  containers?: string[]
  owner_deployment?: string
  owner_references?: Array<{
    kind?: string | null
    name?: string | null
    uid?: string | null
    controller?: boolean | null
  }>
  labels: Record<string, string>
  selector: Record<string, string>
  created_at: string
  status: string
}

export interface StatefulSetInfo {
  name: string
  namespace: string
  replicas: number
  ready_replicas: number
  current_replicas: number
  updated_replicas: number
  available_replicas: number
  service_name?: string | null
  images?: string[]
  status: string
  created_at?: string | null
}

export interface DaemonSetInfo {
  name: string
  namespace: string
  desired: number
  current: number
  ready: number
  updated: number
  available: number
  misscheduled: number
  unavailable: number
  node_selector?: Record<string, string>
  images?: string[]
  status: string
  created_at?: string | null
}

export interface JobInfo {
  name: string
  namespace: string
  completions?: number | null
  parallelism?: number | null
  active: number
  succeeded: number
  failed: number
  status: string
  containers?: string[]
  images?: string[]
  start_time?: string | null
  completion_time?: string | null
  // list rows carry a Go duration string ("3s", "1m30s"); the describe view carries seconds
  duration?: string | null
  duration_seconds?: number | null
  created_at?: string | null
  owner_references?: Array<{
    kind?: string | null
    name?: string | null
    uid?: string | null
    controller?: boolean | null
  }>
}

export interface CronJobInfo {
  name: string
  namespace: string
  schedule: string
  suspend: boolean
  concurrency_policy?: string | null
  active: number
  last_schedule_time?: string | null
  last_successful_time?: string | null
  /** spec.timeZone (IANA name); absent = the kube-controller-manager's zone */
  time_zone?: string | null
  containers?: string[]
  images?: string[]
  created_at?: string | null
}

export interface HPAInfo {
  name: string
  namespace: string
  target_ref: string
  min_replicas?: number | null
  max_replicas: number
  current_replicas?: number | null
  desired_replicas?: number | null
  scaling_active?: boolean
  metrics: Array<Record<string, any>>
  conditions: Array<Record<string, any>>
  last_scale_time?: string | null
  created_at: string
}

export interface VPAInfo {
  name: string
  namespace: string
  target_ref: string
  target_ref_kind: string
  target_ref_name: string
  update_mode: string
  container_policies?: Array<Record<string, any>>
  conditions?: Array<Record<string, any>>
  recommendations?: Array<Record<string, any>>
  cpu_target: string
  memory_target: string
  provided: string
  labels?: Record<string, string>
  created_at: string
}

export interface PDBInfo {
  name: string
  namespace: string
  min_available?: string | null
  max_unavailable?: string | null
  current_healthy: number
  desired_healthy: number
  disruptions_allowed: number
  expected_pods: number
  selector: Record<string, string>
  created_at: string
}

export interface PriorityClassInfo {
  name: string
  value: number
  global_default: boolean
  preemption_policy: string
  description: string
  labels?: Record<string, string>
  created_at: string
}

export interface RuntimeClassInfo {
  name: string
  handler: string
  overhead?: Record<string, string>
  scheduling?: Record<string, unknown>
  labels?: Record<string, string>
  created_at: string
}

export interface LeaseInfo {
  name: string
  namespace: string
  holder_identity?: string
  lease_duration_seconds?: number
  lease_transitions?: number
  renew_time?: string
  acquire_time?: string
  labels?: Record<string, string>
  created_at: string
}

export interface ResourceQuotaInfo {
  name: string
  namespace: string
  status_hard: Record<string, string>
  status_used: Record<string, string>
  labels?: Record<string, string>
  created_at: string
}

export interface LimitRangeInfo {
  name: string
  namespace: string
  limits: Array<{
    type?: string
    default?: Record<string, string>
    default_request?: Record<string, string>
    max?: Record<string, string>
    min?: Record<string, string>
  }>
  labels?: Record<string, string>
  created_at: string
}

export interface WebhookConfigInfo {
  name: string
  webhooks_count: number
  labels?: Record<string, string>
  created_at: string
}

export interface WebhookConfigInfo {
  name: string
  webhooks_count: number
  labels?: Record<string, string>
  created_at: string
}

export interface PodInfo {
  name: string
  namespace: string
  status: string
  phase: string
  status_reason?: string | null
  status_message?: string | null
  node_name?: string
  pod_ip?: string
  containers: Array<any>
  init_containers?: Array<any>
  labels: Record<string, string>
  created_at: string
  restart_count: number
  ready: string
  owner_references?: Array<{
    kind?: string | null
    name?: string | null
    uid?: string | null
    controller?: boolean | null
  }>
  deletion_timestamp?: string | null
  service_account_name?: string
  config_map_refs?: string[]
  secret_refs?: string[]
  priority_class_name?: string
  runtime_class_name?: string
  resource_claims?: string[]
  resource_claim_templates?: string[]
}

export interface PodRbacRule {
  verbs: string[]
  api_groups: string[]
  resources: string[]
  resource_names: string[]
  non_resource_urls: string[]
}

export interface PodRbacSubject {
  kind?: string | null
  api_group?: string | null
  name?: string | null
  namespace?: string | null
}

export interface PodRbacRoleRef {
  api_group?: string | null
  kind?: string | null
  name?: string | null
}

export interface PodRbacResolvedRole {
  api_group?: string | null
  kind?: string | null
  name?: string | null
  rules: PodRbacRule[]
  error?: string | null
}

export interface PodRbacBinding {
  name: string
  namespace?: string | null
  subjects: PodRbacSubject[]
  matched_by?: Array<{
    reason?: string | null
    broad?: boolean | null
    subject?: PodRbacSubject | null
  }>
  is_broad?: boolean | null
  role_ref: PodRbacRoleRef
  resolved_role: PodRbacResolvedRole
  created_at?: string | null
}

export interface PodRbacResponse {
  pod: { name: string; namespace: string }
  service_account: { name: string; namespace: string }
  role_bindings: PodRbacBinding[]
  cluster_role_bindings: PodRbacBinding[]
  errors: string[]
}

export interface PVCInfo {
  name: string
  namespace: string
  status: string
  volume_name?: string
  storage_class?: string
  capacity?: string
  requested?: string
  access_modes: string[]
  created_at: string
  usage?: PVCUsage | null // only with getPVCs(..., usage = true)
}

export interface PVInfo {
  name: string
  status: string
  capacity: string
  access_modes: string[]
  storage_class?: string
  reclaim_policy: string
  claim_ref?: {
    namespace?: string
    name?: string
  }
  volume_mode?: string | null
  source?: string | null
  driver?: string | null
  volume_handle?: string | null
  node_affinity?: string | null
  created_at: string
}

export interface StorageClassInfo {
  name: string
  provisioner: string
  reclaim_policy?: string | null
  volume_binding_mode?: string | null
  allow_volume_expansion?: boolean | null
  is_default: boolean
  parameters: Record<string, any>
  mount_options?: string[] | null
  allowed_topologies?: string[] | null
  labels?: Record<string, string>
  annotations?: Record<string, string>
  finalizers?: string[]
  created_at?: string | null
}

export interface VolumeAttachmentInfo {
  name: string
  attacher?: string | null
  node_name?: string | null
  persistent_volume_name?: string | null
  attached?: boolean | null
  attach_error?: { time?: string | null; message?: string | null } | null
  detach_error?: { time?: string | null; message?: string | null } | null
  created_at?: string | null
}

export interface ServiceAccountInfo {
  name: string
  namespace: string
  secrets: number
  secrets_list?: string[]
  image_pull_secrets?: string[]
  created_at?: string | null
  labels?: Record<string, string> | null
  annotations?: Record<string, string> | null
}

export interface RoleInfo {
  name: string
  namespace: string
  rules_count: number
  created_at?: string | null
  labels?: Record<string, string> | null
  annotations?: Record<string, string> | null
}

export interface RoleBindingSubject {
  kind?: string | null
  name?: string | null
  namespace?: string | null
  apiGroup?: string | null
}

export interface RoleBindingInfo {
  name: string
  namespace: string
  role_ref_kind: string
  role_ref_name: string
  subjects_count: number
  subjects?: RoleBindingSubject[]
  created_at?: string | null
  labels?: Record<string, string> | null
  annotations?: Record<string, string> | null
}

export interface ClusterRoleInfo {
  name: string
  rules_count: number
  created_at?: string | null
  labels?: Record<string, string> | null
  annotations?: Record<string, string> | null
}

export interface ClusterRoleBindingInfo {
  name: string
  role_ref_kind: string
  role_ref_name: string
  subjects_count: number
  subjects?: RoleBindingSubject[]
  created_at?: string | null
  labels?: Record<string, string> | null
  annotations?: Record<string, string> | null
}

export interface ConfigMapInfo {
  name: string
  namespace: string
  data_count: number
  data_keys?: string[] | null
  binary_keys?: string[] | null
  labels?: Record<string, string> | null
  created_at?: string | null
}

export interface SecretInfo {
  name: string
  namespace: string
  type: string
  data_count: number
  data_keys?: string[] | null
  labels?: Record<string, string> | null
  created_at?: string | null
}

export interface CRDInfo {
  name: string
  group: string
  version: string
  scope: string
  kind: string
  created_at?: string | null
  labels?: Record<string, string> | null
  annotations?: Record<string, string> | null
}

export interface CustomResourceInstanceInfo {
  name: string
  namespace: string
  kind: string
  group: string
  version: string
  scope: string
  crd_name: string
  created_at?: string | null
  labels?: Record<string, string> | null
}

export interface TopologyGraph {
  nodes: Array<{
    id: string
    type: string
    name: string
    namespace?: string
    status: string
    metadata: Record<string, any>
  }>
  edges: Array<{
    id: string
    source: string
    target: string
    type: string
    label?: string
  }>
  metadata: Record<string, any>
}

// Resource Graph types
export type ResourceGraphEdgeType =
  | 'owns' | 'selects' | 'mounts' | 'routes' | 'binds'
  | 'bound_to' | 'provisions' | 'hpa_targets' | 'network_policy'
  | 'endpoint_of' | 'sa_used_by'

export interface ResourceGraphNode {
  id: string
  kind: string
  name: string
  namespace: string
  status: string
  ready?: string
  labels?: Record<string, string>
  nodeName?: string
  ownerKind?: string
  instanceLabel?: string
}

export interface ResourceGraphEdge {
  source: string
  target: string
  type: ResourceGraphEdgeType
}

export interface ResourceGraphResponse {
  nodes: ResourceGraphNode[]
  edges: ResourceGraphEdge[]
  // kinds the user may not list in this cluster, left out of the graph
  forbidden_kinds?: string[]
}

export interface TopResources {
  // set by k8s-service when the metrics API call failed (e.g. no metrics-server)
  pod_metrics_error?: string
  node_metrics_error?: string
  top_pods: Array<{
    namespace: string
    name: string
    cpu: string
    memory: string
  }>
  top_nodes: Array<{
    name: string
    cpu: string
    cpu_percent: string
    memory: string
    memory_percent: string
  }>
  pod_error?: boolean
  node_error?: boolean
}


export type UserRole = 'admin' | 'read' | 'write' | 'pending'

export interface AuthRoleInfo {
  id: number
  name: string
  permissions: string[]
}

export interface RoleWithDetails {
  id: number
  name: string
  description: string
  is_system: boolean
  permissions: string[]
  created_at: string
  updated_at: string
}

export interface Member {
  id: string
  name: string
  email?: string
  team?: string
  role: AuthRoleInfo | null
  created_at: string
  updated_at: string
  // GET /auth/me only: the per-cluster permission matrix the session token
  // carries ("*" = global), the cluster role names, and the token lifetime the
  // client paces its refresh on. The browser cannot read the HttpOnly cookie.
  permissions_matrix?: Record<string, string[]>
  cluster_roles?: Record<string, string>
  // Namespace-scoped grants: cluster id → the namespaces the grant there is limited to (absent = whole cluster).
  cluster_namespaces?: Record<string, string[]>
  token_ttl_minutes?: number
  // How the account was created: 'password' (form/admin) or 'oidc' (single
  // sign-on, no password).
  auth_source?: 'password' | 'oidc'
  // Account state on the admin list: last successful sign-in, the temporary
  // password lock and the dormant lock (absent when not locked).
  last_login_at?: string | null
  locked_until?: string
  dormant_locked_at?: string
}

// GET /auth/dormant-accounts/config — whether the dormant-account sweeper is
// on (Admin → Users shows "sweep now" and the lock badges either way).
export interface DormantAccountsConfig {
  enabled: boolean
  days: number
  exempt_admins: boolean
}

// GET /auth/admin/audit/integrity — the audit hash chain: how far it is
// sealed and the last digest anchored in the S3 sink (null = none yet).
export interface AuditAnchor {
  id: number
  created_at: string
  from_seq: number
  to_seq: number
  rows: number
  anchor_hash: string
  sink: string
  object_key: string
  actor: string
}

export interface AuditIntegrityStatus {
  enabled: boolean
  seal_seconds?: number
  anchor_sink?: string
  anchor_hours?: number
  oldest_seq: number
  sealed_through_seq: number
  unsealed_rows: number
  last_anchor: AuditAnchor | null
}

export interface AuditAnchorCheck {
  id: number
  to_seq: number
  object_key: string
  head_ok: boolean
  object_ok?: boolean
  reviews_ok?: boolean
  error?: string
}

// POST /auth/admin/audit/integrity/verify — one recomputation of a range.
export interface AuditVerifyReport {
  from_seq: number
  to_seq: number
  rows: number
  ok: boolean
  first_bad_seq?: number
  reason?: string // hash_mismatch | chain_break | gap | anchor_mismatch
  anchors: AuditAnchorCheck[]
}

// GET /auth/oidc/config — what the login page renders: the SSO button (when a
// provider is configured) and whether the password form is shown.
export interface OIDCLoginConfig {
  enabled: boolean
  display_name: string
  password_login: 'on' | 'admin-only' | 'off'
  /** self-service registration (ALLOW_REGISTRATION); absent on older servers = unknown, keep the link */
  registration?: boolean
  /** each sign-in takes the role from the provider's groups (syncRoles): an admin's role in Kubeast does not last */
  roles_from_groups?: boolean
}

// AdminResetPassword 응답: Member 필드 + 1회용 평문 비밀번호
export interface AdminResetPasswordResponse extends Member {
  temporary_password: string
}

export interface Organization {
  id: number
  type: 'team'
  name: string
  created_at: string
}

// Audit log types — mirror services/pkg/audit/types.go Entry & Filter.
export interface AuditLogEntry {
  ID: number
  CreatedAt: string
  Service: string
  Action: string
  ActorUserID: string
  ActorEmail: string
  TargetID: string
  TargetType: string
  TargetEmail: string
  Cluster: string
  Namespace: string
  Result: 'success' | 'failure' | string
  Error: string
  RequestIP: string
  UserAgent: string
  RequestID: string
  Path: string
  Before?: unknown
  After?: unknown
}

export interface AuditLogFilter {
  service?: string
  action?: string
  actor_email?: string
  target_id?: string
  cluster?: string
  namespace?: string
  result?: 'success' | 'failure'
  since?: string  // RFC3339
  until?: string  // RFC3339
  limit?: number
  offset?: number
}

export interface AuditLogListResponse {
  total: number
  items: AuditLogEntry[]
}

// Admin AI usage — ai.chat.complete audit records aggregated per user/model/cluster.
export type AIUsageGroup = 'user' | 'model' | 'cluster'

export interface AIUsageQuery {
  since?: string // RFC3339
  until?: string // RFC3339
  group?: AIUsageGroup
}

export interface AIUsageRow {
  key: string
  requests: number
  failures: number
  prompt_tokens: number
  cached_tokens: number
  prompt_chars: number
  completion_tokens: number
  total_tokens: number
  token_requests: number
  tool_calls: number
  avg_duration_ms: number
  last_at: string
}

export interface AIUsageResponse {
  since: string
  until: string
  group: AIUsageGroup
  rows: AIUsageRow[]
}

export interface AuthResponse {
  access_token: string
  token_type: string
  member?: Member
  user?: Member
}

export type OptimizationStreamHandlers = {
  onObserved?: (content: string) => void
  onContent?: (chunk: string) => void
  onUsage?: (usage: { prompt_tokens: number; completion_tokens: number; total_tokens: number }) => void
  onMeta?: (meta: { finish_reason?: string | null; max_tokens?: number | null }) => void
  // key and args: a refusal the server writes for the screen (aiChat.error.<key>), as in the chat
  onError?: (message: string, key?: string | null, args?: Record<string, unknown> | null) => void
  onDone?: () => void
  signal?: AbortSignal
}

export interface Session {
  id: string
  title: string
  created_at: string
  updated_at: string
  message_count: number
}

export interface SessionDetail {
  id: string
  title: string
  created_at: string
  updated_at: string
  messages: Array<{
    id: number
    role: string
    content: string
    tool_calls?: any
    usage?: { prompt_tokens: number; completion_tokens: number; cached_tokens?: number; model_calls?: number; model?: string | null } | null
    created_at: string
  }>
}

