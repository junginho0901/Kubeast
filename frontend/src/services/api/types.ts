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
  hq?: string
  team?: string
  role: AuthRoleInfo | null
  created_at: string
  updated_at: string
}

// AdminResetPassword 응답: Member 필드 + 1회용 평문 비밀번호
export interface AdminResetPasswordResponse extends Member {
  temporary_password: string
}

export interface Organization {
  id: number
  type: 'hq' | 'team'
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

export interface AuthResponse {
  access_token: string
  token_type: string
  member?: Member
  user?: Member
}

export interface OptimizationSuggestionsResponse {
  suggestions: string[]
}

export type OptimizationStreamHandlers = {
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

