import axios from 'axios'
import { getAccessToken, handleUnauthorized } from './auth'

const client = axios.create({
  baseURL: '/api/v1',
  headers: {
    'Content-Type': 'application/json',
  },
  timeout: 10000, // 10초 타임아웃 (백엔드 재시도 시간 고려)
})

client.interceptors.request.use((config) => {
  config.headers = config.headers ?? {}
  const token = getAccessToken()
  if (token) {
    (config.headers as any).Authorization = `Bearer ${token}`
  }
  return config
})

client.interceptors.response.use(
  (response) => response,
  (error) => {
    const status = error?.response?.status
    const url = String(error?.config?.url || '')
    const isAuthRequest = url.startsWith('/auth/login') || url.startsWith('/auth/register')
    if (status === 401 && !isAuthRequest) {
      handleUnauthorized()
    }
    return Promise.reject(error)
  }
)

const isMetricsUnavailableResponse = (error: any) => {
  const status = error?.response?.status
  const detail = error?.response?.data?.detail
  return status === 503 && detail === 'metrics_unavailable'
}

// ===== Model Config Types =====
export interface ModelConfigCreate {
  name: string
  provider: string
  model: string
  base_url?: string
  api_key?: string                    // actual API key (stored in DB)
  api_key_env?: string                // env var name (fallback)
  api_key_secret_name?: string
  api_key_secret_key?: string
  extra_headers?: Record<string, string>
  tls_verify?: boolean
  enabled?: boolean
  is_default?: boolean
}

export interface ModelConfigResponse {
  id: number
  name: string
  provider: string
  model: string
  base_url: string | null
  api_key_set: boolean                // true if api_key is stored in DB
  api_key_env: string | null
  api_key_secret_name: string | null
  api_key_secret_key: string | null
  extra_headers: Record<string, string>
  tls_verify: boolean
  enabled: boolean
  is_default: boolean
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

export interface IngressDetail {
  name: string
  namespace: string
  class?: string | null
  class_source?: 'spec' | 'annotation' | 'default' | null
  class_controller?: string | null
  class_is_default?: boolean | null
  addresses: Array<{ ip?: string | null; hostname?: string | null }>
  tls: Array<{ secret_name?: string | null; hosts: string[] }>
  default_backend?: any
  rules: Array<{
    host?: string | null
    paths: Array<{
      path?: string | null
      path_type?: string | null
      backend?: any
    }>
  }>
  events: Array<{
    type?: string | null
    reason?: string | null
    message?: string | null
    count?: number | null
    first_timestamp?: string | null
    last_timestamp?: string | null
  }>
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

export interface BackendTrafficPolicyInfo {
  name: string
  namespace: string
  target_refs?: Array<Record<string, any>>
  conditions?: Array<Record<string, any>>
  labels?: Record<string, string>
  annotations?: Record<string, string>
  created_at?: string | null
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

export interface PrometheusQueryResponse {
  available: boolean
  results: PrometheusQueryResult[]
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
  container_names?: string[]
  owner?: string | null
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
  duration_seconds?: number | null
  created_at?: string | null
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

export interface RoleBindingInfo {
  name: string
  namespace: string
  role_ref_kind: string
  role_ref_name: string
  subjects_count: number
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
}

export interface TopResources {
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

export interface LogAnalysisResponse {
  summary: string
  errors: Array<{
    pattern: string
    severity: string
    occurrences: number
  }>
  root_cause?: string
  recommendations: string[]
  related_issues: string[]
}

export interface ChatResponse {
  message: string
  suggestions: string[]
  actions: Array<any>
}

export type UserRole = 'admin' | 'read' | 'write' | 'pending'

export interface Member {
  id: string
  name: string
  email?: string
  hq?: string
  team?: string
  role: UserRole | string
  created_at: string
  updated_at: string
}

export interface Organization {
  id: number
  type: 'hq' | 'team'
  name: string
  created_at: string
}

export interface AuthResponse {
  access_token: string
  token_type: string
  member?: Member
  user?: Member
}

export interface OptimizationSuggestionsResponse {
  suggestions: string[]
}

type OptimizationStreamHandlers = {
  onObserved?: (content: string) => void
  onContent?: (chunk: string) => void
  onUsage?: (usage: { prompt_tokens: number; completion_tokens: number; total_tokens: number }) => void
  onMeta?: (meta: { finish_reason?: string | null; max_tokens?: number | null }) => void
  onError?: (message: string) => void
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
    created_at: string
  }>
}

// API Functions
export const api = {
  // Auth
  register: async (request: { name: string; email: string; password: string; hq?: string; team?: string }): Promise<Member> => {
    const { data } = await client.post('/auth/register', request)
    return data
  },

  login: async (request: { email: string; password: string }): Promise<AuthResponse> => {
    const { data } = await client.post('/auth/login', request)
    // auth-service 는 user 필드로 내려줌. 기존 session-service(member) 호환 유지.
    if (data?.user && !data?.member) {
      data.member = data.user
    }
    return data
  },

  logout: async (): Promise<void> => {
    await client.post('/auth/logout')
  },

  listOrganizations: async (type: 'hq' | 'team'): Promise<Organization[]> => {
    const { data } = await client.get('/auth/organizations', { params: { type } })
    return Array.isArray(data) ? data : []
  },

  adminCreateOrganization: async (type: 'hq' | 'team', name: string): Promise<Organization> => {
    const { data } = await client.post('/auth/admin/organizations', { type, name })
    return data
  },

  adminDeleteOrganization: async (id: number): Promise<void> => {
    await client.delete(`/auth/admin/organizations/${id}`)
  },

  me: async (): Promise<Member> => {
    const { data } = await client.get('/auth/me')
    return data
  },

  changePassword: async (request: { current_password: string; new_password: string }): Promise<Member> => {
    const { data } = await client.post('/auth/change-password', request)
    return data
  },

  adminCreateUser: async (request: { name: string; email: string; password: string; role: UserRole; hq?: string; team?: string }): Promise<Member> => {
    const { data } = await client.post('/auth/admin/users', request)
    return data
  },

  adminBulkUpdateRole: async (userIds: string[], role: UserRole): Promise<Member[]> => {
    const { data } = await client.patch('/auth/admin/users/bulk-role', { user_ids: userIds, role })
    return data
  },

  adminBulkCreateUsers: async (users: Array<{ name: string; email: string; password: string; role: string; hq?: string; team?: string }>): Promise<{ created: Member[]; errors: Array<{ email: string; message: string }> }> => {
    const { data } = await client.post('/auth/admin/users/bulk', { users })
    return data
  },

  adminListUsers: async (params?: { limit?: number; offset?: number }): Promise<Member[]> => {
    const { data } = await client.get('/auth/admin/users', { params })
    if (!Array.isArray(data)) throw new Error('Invalid users response')
    return data as Member[]
  },

  adminUpdateUserRole: async (userId: string, role: UserRole): Promise<Member> => {
    const { data } = await client.patch(`/auth/admin/users/${userId}`, { role })
    return data
  },

  adminResetUserPassword: async (userId: string): Promise<Member> => {
    const { data } = await client.post(`/auth/admin/users/${userId}/reset-password`)
    return data
  },

  adminDeleteUser: async (userId: string): Promise<void> => {
    await client.delete(`/auth/admin/users/${userId}`)
  },

  // Cluster
  getClusterOverview: async (forceRefresh = false): Promise<ClusterOverview> => {
    const { data } = await client.get('/cluster/overview', {
      params: { force_refresh: forceRefresh }
    })
    return data
  },

  getNamespaces: async (forceRefresh = false): Promise<NamespaceInfo[]> => {
    const { data } = await client.get('/cluster/namespaces', {
      params: { force_refresh: forceRefresh }
    })
    return data
  },

  describeNamespace: async (namespace: string): Promise<NamespaceDescribe> => {
    const { data } = await client.get(`/cluster/namespaces/${namespace}/describe`)
    return data
  },

  getNamespaceYaml: async (name: string, forceRefresh: boolean = false): Promise<{ yaml: string }> => {
    const { data } = await client.get(`/cluster/namespaces/${name}/yaml`, {
      params: { force_refresh: forceRefresh },
    })
    return data
  },

  applyNamespaceYaml: async (name: string, yaml: string): Promise<{ status: string }> => {
    const { data } = await client.post(`/cluster/namespaces/${name}/yaml/apply`, { yaml })
    return data
  },

  getNamespaceResourceQuotas: async (namespace: string): Promise<NamespaceResourceQuota[]> => {
    const { data } = await client.get(`/cluster/namespaces/${namespace}/resource-quotas`)
    return data
  },

  getNamespaceLimitRanges: async (namespace: string): Promise<NamespaceLimitRange[]> => {
    const { data } = await client.get(`/cluster/namespaces/${namespace}/limit-ranges`)
    return data
  },

  getNamespacePods: async (namespace: string): Promise<NamespacePod[]> => {
    const { data } = await client.get(`/cluster/namespaces/${namespace}/owned-pods`)
    return data
  },

  createNamespace: async (name: string): Promise<{ status: string; name: string }> => {
    const { data } = await client.post('/cluster/namespaces', { name })
    return data
  },

  deleteNamespace: async (name: string): Promise<{ status: string; name: string }> => {
    const { data } = await client.delete(`/cluster/namespaces/${name}`)
    return data
  },

  getServices: async (namespace: string, forceRefresh = false): Promise<ServiceInfo[]> => {
    const { data } = await client.get(`/cluster/namespaces/${namespace}/services`, {
      params: { force_refresh: forceRefresh },
    })
    return data
  },

  getAllServices: async (forceRefresh = false): Promise<ServiceInfo[]> => {
    const { data } = await client.get('/cluster/services/all', {
      params: { force_refresh: forceRefresh },
    })
    return data
  },

  describeService: async (namespace: string, name: string): Promise<any> => {
    const { data } = await client.get(`/cluster/namespaces/${namespace}/services/${name}/describe`)
    return data
  },

  deleteService: async (namespace: string, name: string): Promise<void> => {
    await client.delete(`/cluster/namespaces/${namespace}/services/${name}`)
  },

  getIngresses: async (namespace: string, forceRefresh = false): Promise<IngressInfo[]> => {
    const { data } = await client.get(`/cluster/namespaces/${namespace}/ingresses`, {
      params: { force_refresh: forceRefresh },
    })
    return data
  },

  getAllIngresses: async (forceRefresh = false): Promise<IngressInfo[]> => {
    const { data } = await client.get('/cluster/ingresses/all', {
      params: { force_refresh: forceRefresh },
    })
    return data
  },

  getIngressClasses: async (forceRefresh = false): Promise<IngressClassInfo[]> => {
    const { data } = await client.get('/cluster/ingressclasses', {
      params: { force_refresh: forceRefresh },
    })
    return data
  },

  getIngressDetail: async (namespace: string, name: string): Promise<IngressDetail> => {
    const { data } = await client.get(`/cluster/namespaces/${namespace}/ingresses/${name}/detail`)
    return data
  },

  describeIngressClass: async (name: string): Promise<IngressClassInfo> => {
    const { data } = await client.get(`/cluster/ingressclasses/${name}/describe`)
    return data
  },

  deleteIngress: async (namespace: string, name: string): Promise<void> => {
    await client.delete(`/cluster/namespaces/${namespace}/ingresses/${name}`)
  },

  deleteIngressClass: async (name: string): Promise<void> => {
    await client.delete(`/cluster/ingressclasses/${name}`)
  },

  getEndpoints: async (namespace: string, forceRefresh = false): Promise<EndpointInfo[]> => {
    const { data } = await client.get(`/cluster/namespaces/${namespace}/endpoints`, {
      params: { force_refresh: forceRefresh },
    })
    return data
  },

  getAllEndpoints: async (forceRefresh = false): Promise<EndpointInfo[]> => {
    const { data } = await client.get('/cluster/endpoints/all', {
      params: { force_refresh: forceRefresh },
    })
    return data
  },

  describeEndpoint: async (namespace: string, name: string): Promise<any> => {
    const { data } = await client.get(`/cluster/namespaces/${namespace}/endpoints/${name}/describe`)
    return data
  },

  deleteEndpoint: async (namespace: string, name: string): Promise<void> => {
    await client.delete(`/cluster/namespaces/${namespace}/endpoints/${name}`)
  },

  getEndpointSlices: async (namespace: string, forceRefresh = false): Promise<EndpointSliceInfo[]> => {
    const { data } = await client.get(`/cluster/namespaces/${namespace}/endpointslices`, {
      params: { force_refresh: forceRefresh },
    })
    return data
  },

  getAllEndpointSlices: async (forceRefresh = false): Promise<EndpointSliceInfo[]> => {
    const { data } = await client.get('/cluster/endpointslices/all', {
      params: { force_refresh: forceRefresh },
    })
    return data
  },

  describeEndpointSlice: async (namespace: string, name: string): Promise<any> => {
    const { data } = await client.get(`/cluster/namespaces/${namespace}/endpointslices/${name}/describe`)
    return data
  },

  deleteEndpointSlice: async (namespace: string, name: string): Promise<void> => {
    await client.delete(`/cluster/namespaces/${namespace}/endpointslices/${name}`)
  },

  getNetworkPolicies: async (namespace: string, forceRefresh = false): Promise<NetworkPolicyInfo[]> => {
    const { data } = await client.get(`/cluster/namespaces/${namespace}/networkpolicies`, {
      params: { force_refresh: forceRefresh },
    })
    return data
  },

  getAllNetworkPolicies: async (forceRefresh = false): Promise<NetworkPolicyInfo[]> => {
    const { data } = await client.get('/cluster/networkpolicies/all', {
      params: { force_refresh: forceRefresh },
    })
    return data
  },

  describeNetworkPolicy: async (namespace: string, name: string): Promise<any> => {
    const { data } = await client.get(`/cluster/namespaces/${namespace}/networkpolicies/${name}/describe`)
    return data
  },

  deleteNetworkPolicy: async (namespace: string, name: string): Promise<void> => {
    await client.delete(`/cluster/namespaces/${namespace}/networkpolicies/${name}`)
  },

  getGateways: async (namespace: string, forceRefresh = false): Promise<GatewayInfo[]> => {
    const { data } = await client.get(`/cluster/namespaces/${namespace}/gateways`, {
      params: { force_refresh: forceRefresh },
    })
    return data
  },

  getAllGateways: async (forceRefresh = false): Promise<GatewayInfo[]> => {
    const { data } = await client.get('/cluster/gateways/all', {
      params: { force_refresh: forceRefresh },
    })
    return data
  },

  describeGateway: async (namespace: string, name: string): Promise<any> => {
    const { data } = await client.get(`/cluster/namespaces/${namespace}/gateways/${name}/describe`)
    return data
  },

  deleteGateway: async (namespace: string, name: string): Promise<void> => {
    await client.delete(`/cluster/namespaces/${namespace}/gateways/${name}`)
  },

  getGatewayClasses: async (forceRefresh = false): Promise<GatewayClassInfo[]> => {
    const { data } = await client.get('/cluster/gatewayclasses', {
      params: { force_refresh: forceRefresh },
    })
    return data
  },

  describeGatewayClass: async (name: string): Promise<any> => {
    const { data } = await client.get(`/cluster/gatewayclasses/${name}/describe`)
    return data
  },

  deleteGatewayClass: async (name: string): Promise<void> => {
    await client.delete(`/cluster/gatewayclasses/${name}`)
  },

  getHTTPRoutes: async (namespace: string, forceRefresh = false): Promise<HTTPRouteInfo[]> => {
    const { data } = await client.get(`/cluster/namespaces/${namespace}/httproutes`, {
      params: { force_refresh: forceRefresh },
    })
    return data
  },

  getAllHTTPRoutes: async (forceRefresh = false): Promise<HTTPRouteInfo[]> => {
    const { data } = await client.get('/cluster/httproutes/all', {
      params: { force_refresh: forceRefresh },
    })
    return data
  },

  describeHTTPRoute: async (namespace: string, name: string): Promise<any> => {
    const { data } = await client.get(`/cluster/namespaces/${namespace}/httproutes/${name}/describe`)
    return data
  },

  deleteHTTPRoute: async (namespace: string, name: string): Promise<void> => {
    await client.delete(`/cluster/namespaces/${namespace}/httproutes/${name}`)
  },

  getGRPCRoutes: async (namespace: string, forceRefresh = false): Promise<GRPCRouteInfo[]> => {
    const { data } = await client.get(`/cluster/namespaces/${namespace}/grpcroutes`, {
      params: { force_refresh: forceRefresh },
    })
    return data
  },

  getAllGRPCRoutes: async (forceRefresh = false): Promise<GRPCRouteInfo[]> => {
    const { data } = await client.get('/cluster/grpcroutes/all', {
      params: { force_refresh: forceRefresh },
    })
    return data
  },

  describeGRPCRoute: async (namespace: string, name: string): Promise<any> => {
    const { data } = await client.get(`/cluster/namespaces/${namespace}/grpcroutes/${name}/describe`)
    return data
  },

  deleteGRPCRoute: async (namespace: string, name: string): Promise<void> => {
    await client.delete(`/cluster/namespaces/${namespace}/grpcroutes/${name}`)
  },

  getReferenceGrants: async (namespace: string, forceRefresh = false): Promise<ReferenceGrantInfo[]> => {
    const { data } = await client.get(`/cluster/namespaces/${namespace}/referencegrants`, {
      params: { force_refresh: forceRefresh },
    })
    return data
  },

  getAllReferenceGrants: async (forceRefresh = false): Promise<ReferenceGrantInfo[]> => {
    const { data } = await client.get('/cluster/referencegrants/all', {
      params: { force_refresh: forceRefresh },
    })
    return data
  },

  describeReferenceGrant: async (namespace: string, name: string): Promise<any> => {
    const { data } = await client.get(`/cluster/namespaces/${namespace}/referencegrants/${name}/describe`)
    return data
  },

  deleteReferenceGrant: async (namespace: string, name: string): Promise<void> => {
    await client.delete(`/cluster/namespaces/${namespace}/referencegrants/${name}`)
  },

  // BackendTLSPolicies
  getBackendTLSPolicies: async (namespace: string, forceRefresh = false): Promise<BackendTLSPolicyInfo[]> => {
    const { data } = await client.get(`/cluster/namespaces/${namespace}/backendtlspolicies`, {
      params: { force_refresh: forceRefresh },
    })
    return data
  },

  getAllBackendTLSPolicies: async (forceRefresh = false): Promise<BackendTLSPolicyInfo[]> => {
    const { data } = await client.get('/cluster/backendtlspolicies/all', {
      params: { force_refresh: forceRefresh },
    })
    return data
  },

  describeBackendTLSPolicy: async (namespace: string, name: string): Promise<any> => {
    const { data } = await client.get(`/cluster/namespaces/${namespace}/backendtlspolicies/${name}/describe`)
    return data
  },

  deleteBackendTLSPolicy: async (namespace: string, name: string): Promise<void> => {
    await client.delete(`/cluster/namespaces/${namespace}/backendtlspolicies/${name}`)
  },

  // BackendTrafficPolicies
  getBackendTrafficPolicies: async (namespace: string, forceRefresh = false): Promise<BackendTrafficPolicyInfo[]> => {
    const { data } = await client.get(`/cluster/namespaces/${namespace}/backendtrafficpolicies`, {
      params: { force_refresh: forceRefresh },
    })
    return data
  },

  getAllBackendTrafficPolicies: async (forceRefresh = false): Promise<BackendTrafficPolicyInfo[]> => {
    const { data } = await client.get('/cluster/backendtrafficpolicies/all', {
      params: { force_refresh: forceRefresh },
    })
    return data
  },

  describeBackendTrafficPolicy: async (namespace: string, name: string): Promise<any> => {
    const { data } = await client.get(`/cluster/namespaces/${namespace}/backendtrafficpolicies/${name}/describe`)
    return data
  },

  deleteBackendTrafficPolicy: async (namespace: string, name: string): Promise<void> => {
    await client.delete(`/cluster/namespaces/${namespace}/backendtrafficpolicies/${name}`)
  },

  // GPU Dashboard
  getGPUDashboard: async (): Promise<GPUDashboardData> => {
    const { data } = await client.get('/cluster/gpu/dashboard')
    return data
  },

  // GPU Metrics (Prometheus / DCGM)
  getGPUMetrics: async (): Promise<GPUMetricsData> => {
    const { data } = await client.get('/cluster/gpu/metrics')
    return data
  },

  // Prometheus (generic)
  getPrometheusStatus: async (): Promise<{ available: boolean; endpoint?: string; message?: string }> => {
    const { data } = await client.get('/cluster/prometheus/status')
    return data
  },

  prometheusQuery: async (query: string): Promise<PrometheusQueryResponse> => {
    const { data } = await client.get('/cluster/prometheus/query', { params: { query } })
    return data
  },

  // DeviceClasses
  getDeviceClasses: async (forceRefresh = false): Promise<DeviceClassItem[]> => {
    const { data } = await client.get('/cluster/deviceclasses', {
      params: { force_refresh: forceRefresh },
    })
    return data
  },

  describeDeviceClass: async (name: string): Promise<any> => {
    const { data } = await client.get(`/cluster/deviceclasses/${name}/describe`)
    return data
  },

  deleteDeviceClass: async (name: string): Promise<void> => {
    await client.delete(`/cluster/deviceclasses/${name}`)
  },

  // ResourceClaims
  getAllResourceClaims: async (forceRefresh = false): Promise<ResourceClaimItem[]> => {
    const { data } = await client.get('/cluster/resourceclaims/all', {
      params: { force_refresh: forceRefresh },
    })
    return data
  },

  getResourceClaims: async (namespace: string, forceRefresh = false): Promise<ResourceClaimItem[]> => {
    const { data } = await client.get(`/cluster/namespaces/${namespace}/resourceclaims`, {
      params: { force_refresh: forceRefresh },
    })
    return data
  },

  describeResourceClaim: async (namespace: string, name: string): Promise<any> => {
    const { data } = await client.get(`/cluster/namespaces/${namespace}/resourceclaims/${name}/describe`)
    return data
  },

  deleteResourceClaim: async (namespace: string, name: string): Promise<void> => {
    await client.delete(`/cluster/namespaces/${namespace}/resourceclaims/${name}`)
  },

  // ResourceClaimTemplates
  getAllResourceClaimTemplates: async (forceRefresh = false): Promise<ResourceClaimTemplateItem[]> => {
    const { data } = await client.get('/cluster/resourceclaimtemplates/all', {
      params: { force_refresh: forceRefresh },
    })
    return data
  },

  getResourceClaimTemplates: async (namespace: string, forceRefresh = false): Promise<ResourceClaimTemplateItem[]> => {
    const { data } = await client.get(`/cluster/namespaces/${namespace}/resourceclaimtemplates`, {
      params: { force_refresh: forceRefresh },
    })
    return data
  },

  describeResourceClaimTemplate: async (namespace: string, name: string): Promise<any> => {
    const { data } = await client.get(`/cluster/namespaces/${namespace}/resourceclaimtemplates/${name}/describe`)
    return data
  },

  deleteResourceClaimTemplate: async (namespace: string, name: string): Promise<void> => {
    await client.delete(`/cluster/namespaces/${namespace}/resourceclaimtemplates/${name}`)
  },

  // ResourceSlices
  getResourceSlices: async (forceRefresh = false): Promise<ResourceSliceItem[]> => {
    const { data } = await client.get('/cluster/resourceslices', {
      params: { force_refresh: forceRefresh },
    })
    return data
  },

  describeResourceSlice: async (name: string): Promise<any> => {
    const { data } = await client.get(`/cluster/resourceslices/${name}/describe`)
    return data
  },

  deleteResourceSlice: async (name: string): Promise<void> => {
    await client.delete(`/cluster/resourceslices/${name}`)
  },

  getDeployments: async (namespace: string, forceRefresh = false): Promise<DeploymentInfo[]> => {
    const { data } = await client.get(`/cluster/namespaces/${namespace}/deployments`, {
      params: { force_refresh: forceRefresh },
    })
    return data
  },

  getAllDeployments: async (forceRefresh = false): Promise<DeploymentInfo[]> => {
    const { data } = await client.get('/cluster/deployments/all', {
      params: { force_refresh: forceRefresh },
    })
    return data
  },

  describeDeployment: async (namespace: string, name: string): Promise<any> => {
    const { data } = await client.get(`/cluster/namespaces/${namespace}/deployments/${name}/describe`)
    return data
  },

  getStatefulSets: async (namespace: string, forceRefresh = false): Promise<StatefulSetInfo[]> => {
    const { data } = await client.get(`/cluster/namespaces/${namespace}/statefulsets`, {
      params: { force_refresh: forceRefresh },
    })
    return data
  },

  getAllStatefulSets: async (forceRefresh = false): Promise<StatefulSetInfo[]> => {
    const { data } = await client.get('/cluster/statefulsets/all', {
      params: { force_refresh: forceRefresh },
    })
    return data
  },

  getDaemonSets: async (namespace: string, forceRefresh = false): Promise<DaemonSetInfo[]> => {
    const { data } = await client.get(`/cluster/namespaces/${namespace}/daemonsets`, {
      params: { force_refresh: forceRefresh },
    })
    return data
  },

  getAllDaemonSets: async (forceRefresh = false): Promise<DaemonSetInfo[]> => {
    const { data } = await client.get('/cluster/daemonsets/all', {
      params: { force_refresh: forceRefresh },
    })
    return data
  },

  getJobs: async (namespace: string, forceRefresh = false): Promise<JobInfo[]> => {
    const { data } = await client.get(`/cluster/namespaces/${namespace}/jobs`, {
      params: { force_refresh: forceRefresh },
    })
    return data
  },

  getAllJobs: async (forceRefresh = false): Promise<JobInfo[]> => {
    const { data } = await client.get('/cluster/jobs/all', {
      params: { force_refresh: forceRefresh },
    })
    return data
  },

  getCronJobs: async (namespace: string, forceRefresh = false): Promise<CronJobInfo[]> => {
    const { data } = await client.get(`/cluster/namespaces/${namespace}/cronjobs`, {
      params: { force_refresh: forceRefresh },
    })
    return data
  },

  getAllCronJobs: async (forceRefresh = false): Promise<CronJobInfo[]> => {
    const { data } = await client.get('/cluster/cronjobs/all', {
      params: { force_refresh: forceRefresh },
    })
    return data
  },

  deleteDeployment: async (namespace: string, deploymentName: string): Promise<void> => {
    await client.delete(`/cluster/namespaces/${namespace}/deployments/${deploymentName}`)
  },

  getWorkloadRevisions: async (namespace: string, name: string, kind: string): Promise<any[]> => {
    const plural = kind === 'Deployment' ? 'deployments' : kind === 'DaemonSet' ? 'daemonsets' : 'statefulsets'
    const { data } = await client.get(`/cluster/namespaces/${namespace}/${plural}/${name}/revisions`)
    return data
  },

  rollbackWorkload: async (namespace: string, name: string, kind: string, revision: number): Promise<void> => {
    const plural = kind === 'Deployment' ? 'deployments' : kind === 'DaemonSet' ? 'daemonsets' : 'statefulsets'
    await client.post(`/cluster/namespaces/${namespace}/${plural}/${name}/rollback`, { revision })
  },

  getReplicaSets: async (namespace: string, forceRefresh = false): Promise<ReplicaSetInfo[]> => {
    const { data } = await client.get(`/cluster/namespaces/${namespace}/replicasets`, {
      params: { force_refresh: forceRefresh },
    })
    return data
  },

  getAllReplicaSets: async (forceRefresh = false): Promise<ReplicaSetInfo[]> => {
    const { data } = await client.get('/cluster/replicasets/all', {
      params: { force_refresh: forceRefresh },
    })
    return data
  },

  getHPAs: async (namespace: string, forceRefresh = false): Promise<HPAInfo[]> => {
    const { data } = await client.get(`/cluster/namespaces/${namespace}/hpas`, {
      params: { force_refresh: forceRefresh },
    })
    return data
  },

  getAllHPAs: async (forceRefresh = false): Promise<HPAInfo[]> => {
    const { data } = await client.get('/cluster/hpas/all', {
      params: { force_refresh: forceRefresh },
    })
    return data
  },

  describeHPA: async (namespace: string, name: string): Promise<any> => {
    const { data } = await client.get(`/cluster/namespaces/${namespace}/hpas/${name}/describe`)
    return data
  },

  deleteHPA: async (namespace: string, name: string): Promise<void> => {
    await client.delete(`/cluster/namespaces/${namespace}/hpas/${name}`)
  },

  getVPAs: async (namespace: string, forceRefresh = false): Promise<VPAInfo[]> => {
    const { data } = await client.get(`/cluster/namespaces/${namespace}/vpas`, {
      params: { force_refresh: forceRefresh },
    })
    return data
  },

  getAllVPAs: async (forceRefresh = false): Promise<VPAInfo[]> => {
    const { data } = await client.get('/cluster/vpas/all', {
      params: { force_refresh: forceRefresh },
    })
    return data
  },

  describeVPA: async (namespace: string, name: string): Promise<any> => {
    const { data } = await client.get(`/cluster/namespaces/${namespace}/vpas/${name}/describe`)
    return data
  },

  deleteVPA: async (namespace: string, name: string): Promise<void> => {
    await client.delete(`/cluster/namespaces/${namespace}/vpas/${name}`)
  },

  getPDBs: async (namespace: string, forceRefresh = false): Promise<PDBInfo[]> => {
    const { data } = await client.get(`/cluster/namespaces/${namespace}/pdbs`, {
      params: { force_refresh: forceRefresh },
    })
    return data
  },

  getAllPDBs: async (forceRefresh = false): Promise<PDBInfo[]> => {
    const { data } = await client.get('/cluster/pdbs/all', {
      params: { force_refresh: forceRefresh },
    })
    return data
  },

  describePDB: async (namespace: string, name: string): Promise<any> => {
    const { data } = await client.get(`/cluster/namespaces/${namespace}/pdbs/${name}/describe`)
    return data
  },

  deletePDB: async (namespace: string, name: string): Promise<void> => {
    await client.delete(`/cluster/namespaces/${namespace}/pdbs/${name}`)
  },

  getPriorityClasses: async (forceRefresh = false): Promise<PriorityClassInfo[]> => {
    const { data } = await client.get('/cluster/priorityclasses', {
      params: { force_refresh: forceRefresh },
    })
    return data
  },

  describePriorityClass: async (name: string): Promise<any> => {
    const { data } = await client.get(`/cluster/priorityclasses/${name}/describe`)
    return data
  },

  deletePriorityClass: async (name: string): Promise<void> => {
    await client.delete(`/cluster/priorityclasses/${name}`)
  },

  getRuntimeClasses: async (forceRefresh = false): Promise<RuntimeClassInfo[]> => {
    const { data } = await client.get('/cluster/runtimeclasses', {
      params: { force_refresh: forceRefresh },
    })
    return data
  },

  describeRuntimeClass: async (name: string): Promise<any> => {
    const { data } = await client.get(`/cluster/runtimeclasses/${name}/describe`)
    return data
  },

  deleteRuntimeClass: async (name: string): Promise<void> => {
    await client.delete(`/cluster/runtimeclasses/${name}`)
  },

  getAllLeases: async (forceRefresh = false): Promise<LeaseInfo[]> => {
    const { data } = await client.get('/cluster/leases/all', {
      params: { force_refresh: forceRefresh },
    })
    return data
  },

  getLeases: async (namespace: string, forceRefresh = false): Promise<LeaseInfo[]> => {
    const { data } = await client.get(`/cluster/namespaces/${namespace}/leases`, {
      params: { force_refresh: forceRefresh },
    })
    return data
  },

  describeLease: async (namespace: string, name: string): Promise<any> => {
    const { data } = await client.get(`/cluster/namespaces/${namespace}/leases/${name}/describe`)
    return data
  },

  deleteLease: async (namespace: string, name: string): Promise<void> => {
    await client.delete(`/cluster/namespaces/${namespace}/leases/${name}`)
  },

  // ResourceQuotas
  getAllResourceQuotas: async (forceRefresh = false): Promise<ResourceQuotaInfo[]> => {
    const { data } = await client.get('/cluster/resourcequotas/all', {
      params: { force_refresh: forceRefresh },
    })
    return data
  },

  getResourceQuotas: async (namespace: string, forceRefresh = false): Promise<ResourceQuotaInfo[]> => {
    const { data } = await client.get(`/cluster/namespaces/${namespace}/resourcequotas`, {
      params: { force_refresh: forceRefresh },
    })
    return data
  },

  describeResourceQuota: async (namespace: string, name: string): Promise<any> => {
    const { data } = await client.get(`/cluster/namespaces/${namespace}/resourcequotas/${name}/describe`)
    return data
  },

  deleteResourceQuota: async (namespace: string, name: string): Promise<void> => {
    await client.delete(`/cluster/namespaces/${namespace}/resourcequotas/${name}`)
  },

  // LimitRanges
  getAllLimitRanges: async (forceRefresh = false): Promise<LimitRangeInfo[]> => {
    const { data } = await client.get('/cluster/limitranges/all', {
      params: { force_refresh: forceRefresh },
    })
    return data
  },

  getLimitRanges: async (namespace: string, forceRefresh = false): Promise<LimitRangeInfo[]> => {
    const { data } = await client.get(`/cluster/namespaces/${namespace}/limitranges`, {
      params: { force_refresh: forceRefresh },
    })
    return data
  },

  describeLimitRange: async (namespace: string, name: string): Promise<any> => {
    const { data } = await client.get(`/cluster/namespaces/${namespace}/limitranges/${name}/describe`)
    return data
  },

  deleteLimitRange: async (namespace: string, name: string): Promise<void> => {
    await client.delete(`/cluster/namespaces/${namespace}/limitranges/${name}`)
  },

  // MutatingWebhookConfigurations
  getMutatingWebhookConfigurations: async (forceRefresh = false): Promise<WebhookConfigInfo[]> => {
    const { data } = await client.get('/cluster/mutatingwebhookconfigurations', {
      params: { force_refresh: forceRefresh },
    })
    return data
  },

  describeMutatingWebhookConfiguration: async (name: string): Promise<any> => {
    const { data } = await client.get(`/cluster/mutatingwebhookconfigurations/${name}/describe`)
    return data
  },

  deleteMutatingWebhookConfiguration: async (name: string): Promise<void> => {
    await client.delete(`/cluster/mutatingwebhookconfigurations/${name}`)
  },

  // ValidatingWebhookConfigurations
  getValidatingWebhookConfigurations: async (forceRefresh = false): Promise<WebhookConfigInfo[]> => {
    const { data } = await client.get('/cluster/validatingwebhookconfigurations', {
      params: { force_refresh: forceRefresh },
    })
    return data
  },

  describeValidatingWebhookConfiguration: async (name: string): Promise<any> => {
    const { data } = await client.get(`/cluster/validatingwebhookconfigurations/${name}/describe`)
    return data
  },

  deleteValidatingWebhookConfiguration: async (name: string): Promise<void> => {
    await client.delete(`/cluster/validatingwebhookconfigurations/${name}`)
  },

  getPods: async (namespace: string, labelSelector?: string, forceRefresh = false): Promise<PodInfo[]> => {
    const { data} = await client.get(`/cluster/namespaces/${namespace}/pods`, {
      params: { label_selector: labelSelector, force_refresh: forceRefresh },
    })
    return data
  },

  getPodLogs: async (
    namespace: string,
    podName: string,
    container?: string,
    tailLines: number = 100
  ): Promise<string> => {
    const { data } = await client.get(
      `/cluster/namespaces/${namespace}/pods/${podName}/logs`,
      {
        params: { container, tail_lines: tailLines },
      }
    )
    return typeof data === 'string' ? data : (data.logs ?? data.data ?? '')
  },

  deletePod: async (namespace: string, podName: string, force: boolean = false): Promise<void> => {
    await client.delete(`/cluster/namespaces/${namespace}/pods/${podName}`, {
      params: { force },
    })
  },

  describeStatefulSet: async (namespace: string, name: string): Promise<any> => {
    const { data } = await client.get(`/cluster/namespaces/${namespace}/statefulsets/${name}/describe`)
    return data
  },

  deleteStatefulSet: async (namespace: string, name: string): Promise<void> => {
    await client.delete(`/cluster/namespaces/${namespace}/statefulsets/${name}`)
  },

  describeReplicaSet: async (namespace: string, name: string): Promise<any> => {
    const { data } = await client.get(`/cluster/namespaces/${namespace}/replicasets/${name}/describe`)
    return data
  },

  deleteReplicaSet: async (namespace: string, name: string): Promise<void> => {
    await client.delete(`/cluster/namespaces/${namespace}/replicasets/${name}`)
  },

  describeDaemonSet: async (namespace: string, name: string): Promise<any> => {
    const { data } = await client.get(`/cluster/namespaces/${namespace}/daemonsets/${name}/describe`)
    return data
  },

  deleteDaemonSet: async (namespace: string, name: string): Promise<void> => {
    await client.delete(`/cluster/namespaces/${namespace}/daemonsets/${name}`)
  },

  describeJob: async (namespace: string, name: string): Promise<any> => {
    const { data } = await client.get(`/cluster/namespaces/${namespace}/jobs/${name}/describe`)
    return data
  },

  deleteJob: async (namespace: string, name: string): Promise<void> => {
    await client.delete(`/cluster/namespaces/${namespace}/jobs/${name}`)
  },

  describeCronJob: async (namespace: string, name: string): Promise<any> => {
    const { data } = await client.get(`/cluster/namespaces/${namespace}/cronjobs/${name}/describe`)
    return data
  },

  deleteCronJob: async (namespace: string, name: string): Promise<void> => {
    await client.delete(`/cluster/namespaces/${namespace}/cronjobs/${name}`)
  },

  suspendCronJob: async (namespace: string, name: string, suspend: boolean): Promise<void> => {
    await client.patch(`/cluster/namespaces/${namespace}/cronjobs/${name}/suspend`, { suspend })
  },

  triggerCronJob: async (namespace: string, name: string): Promise<{ job_name: string }> => {
    const { data } = await client.post(`/cluster/namespaces/${namespace}/cronjobs/${name}/trigger`)
    return data
  },

  getCronJobOwnedJobs: async (namespace: string, name: string): Promise<any[]> => {
    const { data } = await client.get(`/cluster/namespaces/${namespace}/cronjobs/${name}/jobs`)
    return data
  },

  getPodRbac: async (
    namespace: string,
    podName: string,
    params?: { include_authenticated?: boolean }
  ): Promise<PodRbacResponse> => {
    const { data } = await client.get(`/cluster/namespaces/${namespace}/pods/${podName}/rbac`, { params })
    return data
  },

  getPVCs: async (namespace?: string, forceRefresh: boolean = false): Promise<PVCInfo[]> => {
    const { data } = await client.get('/cluster/pvcs', {
      params: { namespace, force_refresh: forceRefresh },
    })
    return data
  },

  describePVC: async (namespace: string, name: string): Promise<any> => {
    const { data } = await client.get(`/cluster/namespaces/${namespace}/pvcs/${name}/describe`)
    return data
  },

  deletePVC: async (namespace: string, name: string): Promise<void> => {
    await client.delete(`/cluster/namespaces/${namespace}/pvcs/${name}`)
  },

  getPVs: async (): Promise<PVInfo[]> => {
    const { data } = await client.get('/cluster/pvs')
    return data
  },

  getPV: async (name: string): Promise<PVInfo> => {
    const { data } = await client.get(`/cluster/pvs/${name}`)
    return data
  },

  describePV: async (name: string): Promise<any> => {
    const { data } = await client.get(`/cluster/pvs/${name}/describe`)
    return data
  },

  deletePV: async (name: string): Promise<void> => {
    await client.delete(`/cluster/pvs/${name}`)
  },

  getStorageClasses: async (forceRefresh = false): Promise<StorageClassInfo[]> => {
    const { data } = await client.get('/cluster/storageclasses', {
      params: { force_refresh: forceRefresh },
    })
    return data
  },

  getStorageClass: async (name: string): Promise<StorageClassInfo> => {
    const { data } = await client.get(`/cluster/storageclasses/${name}`)
    return data
  },

  describeStorageClass: async (name: string): Promise<any> => {
    const { data } = await client.get(`/cluster/storageclasses/${name}/describe`)
    return data
  },

  deleteStorageClass: async (name: string): Promise<void> => {
    await client.delete(`/cluster/storageclasses/${name}`)
  },

  getVolumeAttachments: async (forceRefresh = false): Promise<VolumeAttachmentInfo[]> => {
    const { data } = await client.get('/cluster/volumeattachments', {
      params: { force_refresh: forceRefresh },
    })
    return data
  },

  describeVolumeAttachment: async (name: string): Promise<any> => {
    const { data } = await client.get(`/cluster/volumeattachments/${name}/describe`)
    return data
  },

  deleteVolumeAttachment: async (name: string): Promise<void> => {
    await client.delete(`/cluster/volumeattachments/${name}`)
  },

  // Topology
  getNamespaceTopology: async (namespace: string): Promise<TopologyGraph> => {
    const { data } = await client.get(`/topology/namespace/${namespace}`)
    return data
  },

  getStorageTopology: async (): Promise<TopologyGraph> => {
    const { data } = await client.get('/topology/storage')
    return data
  },

  // AI
  analyzeLogs: async (request: {
    logs: string
    namespace: string
    pod_name: string
    container?: string
  }): Promise<LogAnalysisResponse> => {
    const { data } = await client.post('/ai/analyze-logs', request)
    return data
  },

  chat: async (messages: Array<{ role: string; content: string }>): Promise<ChatResponse> => {
    const { data } = await client.post('/ai/chat', { messages })
    return data
  },

  suggestOptimization: async (namespace: string): Promise<OptimizationSuggestionsResponse> => {
    const { data } = await client.post(
      '/ai/suggest-optimization',
      null,
      {
        params: { namespace },
        timeout: 60000,
      }
    )
    return data
  },

  suggestOptimizationStream: async (namespace: string, handlers: OptimizationStreamHandlers = {}): Promise<void> => {
    const { onObserved, onContent, onUsage, onMeta, onError, onDone, signal } = handlers

    const headers: Record<string, string> = { Accept: 'text/event-stream' }
    const token = getAccessToken()
    if (token) headers.Authorization = `Bearer ${token}`

	    const response = await fetch(`/api/v1/ai/suggest-optimization/stream?namespace=${encodeURIComponent(namespace)}`, {
	      method: 'GET',
	      headers,
	      signal,
	    })

	    if (response.status === 401) {
	      const message = 'Unauthorized'
	      onError?.(message)
	      handleUnauthorized()
	      throw new Error(message)
	    }

	    if (!response.ok) {
	      const message = `HTTP ${response.status}`
	      onError?.(message)
	      throw new Error(message)
	    }

    if (!response.body) {
      const message = 'No response body'
      onError?.(message)
      throw new Error(message)
    }

    const reader = response.body.getReader()
    const decoder = new TextDecoder('utf-8')
    let buffer = ''
    let aborted = false
    let sawDone = false

    const processEventBlock = (block: string) => {
      const lines = block.split('\n')
      let didEmit = false
      for (const rawLine of lines) {
        const line = rawLine.trimEnd()
        if (!line.startsWith('data:')) continue
        const payload = line.slice('data:'.length).trim()
        if (!payload) continue
        if (payload === '[DONE]') {
          sawDone = true
          onDone?.()
          return { status: 'done' as const, didEmit }
        }
        try {
          const parsed = JSON.parse(payload) as any
          const kind = typeof parsed?.kind === 'string' ? parsed.kind : undefined
          if (kind === 'usage' && parsed?.usage) {
            onUsage?.(parsed.usage)
            didEmit = true
            continue
          }
          if (kind === 'meta') {
            onMeta?.({ finish_reason: parsed?.finish_reason, max_tokens: parsed?.max_tokens })
            didEmit = true
            continue
          }
          if (parsed?.error != null) {
            onError?.(String(parsed.error))
          }
          if (typeof parsed?.content === 'string') {
            const contentKind = kind ?? 'answer'
            if (contentKind === 'observed') {
              onObserved?.(parsed.content)
            } else {
              onContent?.(parsed.content)
            }
            didEmit = true
          }
        } catch {
          // ignore non-json payload
        }
      }
      return { status: 'continue' as const, didEmit }
    }

    try {
      for (;;) {
        const { value, done } = await reader.read()
        if (done) break
        buffer += decoder.decode(value, { stream: true })

        for (;;) {
          const sepIndex = buffer.indexOf('\n\n')
          if (sepIndex === -1) break
          const eventBlock = buffer.slice(0, sepIndex)
          buffer = buffer.slice(sepIndex + 2)
          const result = processEventBlock(eventBlock)
          if (result.status === 'done') return
          if (result.didEmit) await new Promise((resolve) => setTimeout(resolve, 0))
        }
      }
    } catch (error) {
      if ((error as any)?.name !== 'AbortError') {
        onError?.(error instanceof Error ? error.message : String(error))
        throw error
      }
      aborted = true
    } finally {
      try {
        reader.releaseLock()
      } catch {
        // ignore
      }
    }

    if (aborted) return
    if (!sawDone) {
      const message = 'Stream ended unexpectedly (missing [DONE])'
      onError?.(message)
      throw new Error(message)
    }
  },

  // Sessions
  getSessions: async (params?: {
    limit?: number
    offset?: number
    before_updated_at?: string
    before_id?: string
  }): Promise<Session[]> => {
    const { data } = await client.get('/sessions', { params })
    return data
  },

  createSession: async (title?: string): Promise<Session> => {
    const { data } = await client.post('/sessions', { title })
    return data
  },

  getSession: async (sessionId: string): Promise<SessionDetail> => {
    const { data } = await client.get(`/sessions/${sessionId}`)
    return data
  },

  updateSession: async (sessionId: string, title: string): Promise<Session> => {
    const { data } = await client.patch(`/sessions/${sessionId}`, { title })
    return data
  },

  deleteSession: async (sessionId: string): Promise<void> => {
    await client.delete(`/sessions/${sessionId}`)
  },

  getResourceYaml: async (resourceType: string, name: string, namespace?: string): Promise<{ yaml: string }> => {
    const { data } = await client.get('/cluster/resources/yaml', {
      params: {
        resource_type: resourceType,
        resource_name: name,
        ...(namespace && namespace !== '-' ? { namespace } : {}),
      },
    })
    return typeof data === 'string' ? { yaml: data } : data
  },

  applyResourceYaml: async (resourceType: string, name: string, yaml: string, namespace?: string): Promise<{ status: string }> => {
    const { data } = await client.post('/cluster/resources/yaml/apply', {
      resource_type: resourceType,
      resource_name: name,
      namespace: namespace && namespace !== '-' ? namespace : undefined,
      yaml,
    })
    return data
  },

  createResourcesFromYaml: async (
    yaml: string,
    namespace?: string
  ): Promise<{
    status: string
    count: number
    created: Array<{ apiVersion: string; kind: string; name: string; namespace?: string | null }>
  }> => {
    const { data } = await client.post('/cluster/resources/yaml/create', {
      yaml,
      namespace: namespace && namespace !== '-' ? namespace : undefined,
    })
    return data
  },

  // Cluster View
  getAllPods: async (forceRefresh: boolean = false): Promise<PodInfo[]> => {
    const { data } = await client.get('/cluster/pods/all', {
      params: { force_refresh: forceRefresh },
    })
    return data
  },

  getNodes: async (forceRefresh: boolean = false): Promise<any[]> => {
    const { data} = await client.get('/cluster/nodes', {
      params: { force_refresh: forceRefresh },
    })
    return data
  },

  describePod: async (namespace: string, name: string): Promise<any> => {
    const { data } = await client.get(`/cluster/namespaces/${namespace}/pods/${name}/describe`)
    return data
  },

  describeNode: async (name: string): Promise<any> => {
    const { data } = await client.get(`/cluster/nodes/${name}/describe`)
    return data
  },

  getComponentStatuses: async (): Promise<any[]> => {
    const { data } = await client.get('/cluster/componentstatuses')
    return data
  },

  getNodeMetrics: async (): Promise<any[]> => {
    try {
      const { data } = await client.get('/cluster/metrics/nodes', {
        // 메트릭 수집은 최대 수 초 이상 걸릴 수 있으므로 일반 API보다 여유 있게 설정
        timeout: 20000,
      })
      return data
    } catch (error: any) {
      if (isMetricsUnavailableResponse(error)) {
        const err = new Error('metrics_unavailable')
        ;(err as any).code = 'metrics_unavailable'
        throw err
      }
      throw error
    }
  },

  getNodePods: async (name: string): Promise<PodInfo[]> => {
    const { data } = await client.get(`/cluster/nodes/${name}/pods`)
    return data
  },

  getNodeEvents: async (name: string): Promise<any[]> => {
    const { data } = await client.get(`/cluster/nodes/${name}/events`)
    return data
  },

  getNodeYaml: async (name: string, forceRefresh: boolean = false): Promise<{ yaml: string }> => {
    const { data } = await client.get(`/cluster/nodes/${name}/yaml`, {
      params: { force_refresh: forceRefresh },
    })
    return data
  },

  applyNodeYaml: async (name: string, yaml: string): Promise<{ status: string }> => {
    const { data } = await client.post(`/cluster/nodes/${name}/yaml/apply`, { yaml })
    return data
  },

  deleteNode: async (name: string): Promise<void> => {
    await client.delete(`/cluster/nodes/${name}`)
  },

  cordonNode: async (name: string): Promise<{ status: string; unschedulable: boolean }> => {
    const { data } = await client.post(`/cluster/nodes/${name}/cordon`)
    return data
  },

  uncordonNode: async (name: string): Promise<{ status: string; unschedulable: boolean }> => {
    const { data } = await client.post(`/cluster/nodes/${name}/uncordon`)
    return data
  },

  drainNode: async (name: string): Promise<{ status: string; drain_id: string }> => {
    const { data } = await client.post(`/cluster/nodes/${name}/drain`)
    return data
  },

  getNodeDrainStatus: async (
    name: string,
    drainId: string
  ): Promise<{ id: string; node: string; status: string; message?: string | null }> => {
    const { data } = await client.get(`/cluster/nodes/${name}/drain/status`, {
      params: { drain_id: drainId },
    })
    return data
  },

  getPodMetrics: async (namespace?: string): Promise<any[]> => {
    try {
      const { data } = await client.get('/cluster/metrics/pods', {
        params: { namespace },
        timeout: 20000,
      })
      return data
    } catch (error: any) {
      if (isMetricsUnavailableResponse(error)) {
        const err = new Error('metrics_unavailable')
        ;(err as any).code = 'metrics_unavailable'
        throw err
      }
      throw error
    }
  },

  getTopResources: async (podLimit: number = 5, nodeLimit: number = 3): Promise<TopResources> => {
    try {
      const { data } = await client.get('/cluster/metrics/top-resources', {
        params: { pod_limit: podLimit, node_limit: nodeLimit },
      })
      return data
    } catch (error: any) {
      if (isMetricsUnavailableResponse(error)) {
        const err = new Error('metrics_unavailable')
        ;(err as any).code = 'metrics_unavailable'
        throw err
      }
      throw error
    }
  },

  // Cluster Setup
  getSetupStatus: async (): Promise<{ configured: boolean; mode?: string; secret_name?: string }> => {
    const { data } = await client.get('/auth/setup')
    return data
  },

  submitSetup: async (payload: { mode: 'in_cluster' | 'external'; kubeconfig?: string }) => {
    const { data } = await client.post('/auth/setup', payload)
    return data
  },

  /** 롤아웃 상태 확인 — Setup에서 서비스 재시작 완료 여부 확인 */
  getRolloutStatus: async (): Promise<{ ready: boolean; deployments: Record<string, any> }> => {
    const { data } = await client.get('/auth/setup/rollout-status')
    return data
  },

  // Health check
  getHealth: async (): Promise<{ status: string; kubernetes: string; openai: string }> => {
    // /health는 /api/v1가 아닌 루트에 있음
    const { data } = await axios.get('/health', {
      baseURL: '', // baseURL 무시하고 상대 경로 사용
    })
    return data
  },

  // AI Config
  getAIConfig: async (): Promise<{ model: string; app_name: string; version: string }> => {
    const { data } = await client.get('/ai/config')
    return data
  },

  // ===== Model Configs =====
  listModelConfigs: async (enabledOnly = false): Promise<ModelConfigResponse[]> => {
    const { data } = await client.get('/ai/model-configs', { params: { enabled_only: enabledOnly } })
    return data
  },

  getActiveModelConfig: async (): Promise<ModelConfigResponse | null> => {
    const { data } = await client.get('/ai/model-configs/active')
    return data
  },

  createModelConfig: async (payload: ModelConfigCreate): Promise<ModelConfigResponse> => {
    const { data } = await client.post('/ai/model-configs', payload)
    return data
  },

  /** Setup 전용 — 인증 없이 모델 등록 (로그인 전 Setup 화면에서 사용) */
  createModelConfigSetup: async (payload: ModelConfigCreate): Promise<any> => {
    const { data } = await client.post('/ai/model-configs/setup', payload)
    return data
  },

  updateModelConfig: async (id: number, payload: Partial<ModelConfigCreate>): Promise<ModelConfigResponse> => {
    const { data } = await client.patch(`/ai/model-configs/${id}`, payload)
    return data
  },

  deleteModelConfig: async (id: number): Promise<void> => {
    await client.delete(`/ai/model-configs/${id}`)
  },

  testModelConnection: async (payload: {
    provider: string
    model: string
    base_url?: string
    api_key?: string
    tls_verify?: boolean
    azure_api_version?: string
  }): Promise<{ success: boolean; model?: string; message: string }> => {
    const { data } = await client.post('/ai/model-configs/test', payload)
    return data
  },

  // Advanced Search
  searchResources: async (resourceType: string, namespace?: string, signal?: AbortSignal): Promise<any> => {
    const { data } = await client.get('/cluster/resources', {
      params: {
        resource_type: resourceType,
        all_namespaces: !namespace,
        namespace: namespace || undefined,
        output: 'json',
      },
      timeout: 30000,
      signal,
    })
    return data
  },

  searchMultiResources: async (resourceTypes: string[], namespace?: string): Promise<{ items: any[]; total: number; errors: any[] }> => {
    const { data } = await client.post('/cluster/search', {
      resource_types: resourceTypes,
      namespace: namespace || undefined,
    }, { timeout: 60000 })
    return data
  },

  getApiResources: async (forceRefresh = false): Promise<any[]> => {
    const { data } = await client.get('/cluster/api-resources', {
      params: { force_refresh: forceRefresh },
    })
    return data
  },

  // ===== ServiceAccounts =====
  getServiceAccounts: async (namespace: string, forceRefresh = false): Promise<ServiceAccountInfo[]> => {
    const { data } = await client.get(`/cluster/namespaces/${namespace}/serviceaccounts`, {
      params: { force_refresh: forceRefresh },
    })
    return data
  },

  getAllServiceAccounts: async (forceRefresh = false): Promise<ServiceAccountInfo[]> => {
    const { data } = await client.get('/cluster/serviceaccounts/all', {
      params: { force_refresh: forceRefresh },
    })
    return data
  },

  describeServiceAccount: async (namespace: string, name: string): Promise<any> => {
    const { data } = await client.get(`/cluster/namespaces/${namespace}/serviceaccounts/${name}/describe`)
    return data
  },

  deleteServiceAccount: async (namespace: string, name: string): Promise<void> => {
    await client.delete(`/cluster/namespaces/${namespace}/serviceaccounts/${name}`)
  },

  // ===== Roles =====
  getRoles: async (namespace: string, forceRefresh = false): Promise<RoleInfo[]> => {
    const { data } = await client.get(`/cluster/namespaces/${namespace}/roles`, {
      params: { force_refresh: forceRefresh },
    })
    return data
  },

  getAllRoles: async (forceRefresh = false): Promise<RoleInfo[]> => {
    const { data } = await client.get('/cluster/roles/all', {
      params: { force_refresh: forceRefresh },
    })
    return data
  },

  describeRole: async (namespace: string, name: string): Promise<any> => {
    const { data } = await client.get(`/cluster/namespaces/${namespace}/roles/${name}/describe`)
    return data
  },

  deleteRole: async (namespace: string, name: string): Promise<void> => {
    await client.delete(`/cluster/namespaces/${namespace}/roles/${name}`)
  },

  // ===== RoleBindings =====
  getRoleBindings: async (namespace: string, forceRefresh = false): Promise<RoleBindingInfo[]> => {
    const { data } = await client.get(`/cluster/namespaces/${namespace}/rolebindings`, {
      params: { force_refresh: forceRefresh },
    })
    return data
  },

  getAllRoleBindings: async (forceRefresh = false): Promise<RoleBindingInfo[]> => {
    const { data } = await client.get('/cluster/rolebindings/all', {
      params: { force_refresh: forceRefresh },
    })
    return data
  },

  describeRoleBinding: async (namespace: string, name: string): Promise<any> => {
    const { data } = await client.get(`/cluster/namespaces/${namespace}/rolebindings/${name}/describe`)
    return data
  },

  deleteRoleBinding: async (namespace: string, name: string): Promise<void> => {
    await client.delete(`/cluster/namespaces/${namespace}/rolebindings/${name}`)
  },

  // ===== ClusterRoles =====
  getClusterRoles: async (forceRefresh = false): Promise<ClusterRoleInfo[]> => {
    const { data } = await client.get('/cluster/clusterroles', {
      params: { force_refresh: forceRefresh },
    })
    return data
  },

  describeClusterRole: async (name: string): Promise<any> => {
    const { data } = await client.get(`/cluster/clusterroles/${name}/describe`)
    return data
  },

  deleteClusterRole: async (name: string): Promise<void> => {
    await client.delete(`/cluster/clusterroles/${name}`)
  },

  // ===== ClusterRoleBindings =====
  getClusterRoleBindings: async (forceRefresh = false): Promise<ClusterRoleBindingInfo[]> => {
    const { data } = await client.get('/cluster/clusterrolebindings', {
      params: { force_refresh: forceRefresh },
    })
    return data
  },

  describeClusterRoleBinding: async (name: string): Promise<any> => {
    const { data } = await client.get(`/cluster/clusterrolebindings/${name}/describe`)
    return data
  },

  deleteClusterRoleBinding: async (name: string): Promise<void> => {
    await client.delete(`/cluster/clusterrolebindings/${name}`)
  },

  // ===== ConfigMaps =====
  getConfigMaps: async (namespace: string, forceRefresh = false): Promise<ConfigMapInfo[]> => {
    const { data } = await client.get(`/cluster/namespaces/${namespace}/configmaps`, {
      params: { force_refresh: forceRefresh },
    })
    return data
  },

  getAllConfigMaps: async (forceRefresh = false): Promise<ConfigMapInfo[]> => {
    const { data } = await client.get('/cluster/configmaps/all', {
      params: { force_refresh: forceRefresh },
    })
    return data
  },

  describeConfigMap: async (namespace: string, name: string): Promise<any> => {
    const { data } = await client.get(`/cluster/namespaces/${namespace}/configmaps/${name}/describe`)
    return data
  },

  deleteConfigMap: async (namespace: string, name: string): Promise<void> => {
    await client.delete(`/cluster/namespaces/${namespace}/configmaps/${name}`)
  },

  // ===== Secrets =====
  getSecrets: async (namespace: string, forceRefresh = false): Promise<SecretInfo[]> => {
    const { data } = await client.get(`/cluster/namespaces/${namespace}/secrets`, {
      params: { force_refresh: forceRefresh },
    })
    return data
  },

  getAllSecrets: async (forceRefresh = false): Promise<SecretInfo[]> => {
    const { data } = await client.get('/cluster/secrets/all', {
      params: { force_refresh: forceRefresh },
    })
    return data
  },

  describeSecret: async (namespace: string, name: string): Promise<any> => {
    const { data } = await client.get(`/cluster/namespaces/${namespace}/secrets/${name}/describe`)
    return data
  },

  getSecretYaml: async (namespace: string, name: string): Promise<{ yaml: string }> => {
    const { data } = await client.get(`/cluster/namespaces/${namespace}/secrets/${name}/yaml`)
    return typeof data === 'string' ? { yaml: data } : data
  },

  deleteSecret: async (namespace: string, name: string): Promise<void> => {
    await client.delete(`/cluster/namespaces/${namespace}/secrets/${name}`)
  },

  // ===== Custom Resource Definitions =====
  getCRDs: async (forceRefresh = false): Promise<CRDInfo[]> => {
    const { data } = await client.get('/cluster/crds', {
      params: { force_refresh: forceRefresh },
    })
    return data
  },

  describeCRD: async (name: string): Promise<any> => {
    const { data } = await client.get(`/cluster/crds/${name}/describe`)
    return data
  },

  deleteCRD: async (name: string): Promise<void> => {
    await client.delete(`/cluster/crds/${name}`)
  },

  // ===== Custom Resource Instances =====
  getAllCustomResourceInstances: async (forceRefresh = false): Promise<CustomResourceInstanceInfo[]> => {
    const { data } = await client.get('/cluster/custom-resources/all', {
      params: { force_refresh: forceRefresh },
    })
    return data
  },

  getCustomResourceInstances: async (group: string, version: string, plural: string): Promise<any[]> => {
    const { data } = await client.get(`/cluster/custom-resources/${group}/${version}/${plural}`)
    return data
  },

  describeCustomResourceInstance: async (group: string, version: string, plural: string, namespace: string, name: string): Promise<any> => {
    const { data } = await client.get(`/cluster/custom-resources/${group}/${version}/${plural}/${namespace}/${name}/describe`)
    return data
  },

  deleteCustomResourceInstance: async (group: string, version: string, plural: string, namespace: string, name: string): Promise<void> => {
    await client.delete(`/cluster/custom-resources/${group}/${version}/${plural}/${namespace}/${name}`)
  },

  // ===== Timeline =====
  getNamespaceTimeline: async (namespace: string, hours: number = 24, limit: number = 500): Promise<TimelineResult> => {
    const { data } = await client.get(`/cluster/namespaces/${namespace}/timeline`, {
      params: { hours, limit }
    })
    return data
  },

  getResourceTimeline: async (namespace: string, kind: string, name: string, hours: number = 24, limit: number = 500): Promise<TimelineResult> => {
    const { data } = await client.get(`/cluster/namespaces/${namespace}/timeline/${kind}/${name}`, {
      params: { hours, limit }
    })
    return data
  },

  // ===== Dependency Graph (legacy) =====
  getDependencyGraph: async (namespace: string): Promise<{
    nodes: Array<{
      id: string
      kind: string
      name: string
      namespace: string
      status: string
      ready?: string
      labels?: Record<string, string>
    }>
    edges: Array<{
      source: string
      target: string
      type: 'owns' | 'selects' | 'mounts' | 'routes' | 'binds'
    }>
  }> => {
    const { data } = await client.get(`/cluster/namespaces/${namespace}/dependency-graph`)
    return data
  },

  // ===== Resource Graph (upgraded) =====
  getResourceGraph: async (namespaces?: string[]): Promise<ResourceGraphResponse> => {
    const params = namespaces?.length ? `?namespaces=${namespaces.join(',')}` : ''
    const { data } = await client.get(`/resource-graph${params}`)
    return data
  },

  getNamespaceResourceGraph: async (namespace: string): Promise<ResourceGraphResponse> => {
    const { data } = await client.get(`/cluster/namespaces/${namespace}/resource-graph`)
    return data
  },
}

let metricsDisabled = false

export const disableMetrics = (): void => {
  metricsDisabled = true
}

export const isMetricsDisabled = (): boolean => metricsDisabled

export const isMetricsUnavailableError = (err: any): boolean => {
  const status = err?.response?.status
  if (status === 503) return true
  const code =
    err?.response?.data?.detail?.code ||
    err?.response?.data?.code
  return status === 503 && code === 'metrics_unavailable'
}
