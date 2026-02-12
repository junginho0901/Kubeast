import axios from 'axios'
import { getAccessToken } from './auth'

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

export interface NamespaceDescribe {
  name: string
  status?: string
  created_at?: string
  labels: Record<string, string>
  annotations: Record<string, string>
  events: Array<{
    type?: string
    reason?: string
    message?: string
    count?: number
    first_timestamp?: string
    last_timestamp?: string
  }>
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
  hosts: string[]
  class?: string | null
  backends: string[]
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
  address_type?: string | null
  endpoints_total: number
  endpoints_ready: number
  ports: Array<{
    name?: string | null
    port?: number | null
    protocol?: string | null
  }>
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
  created_at?: string | null
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

export interface PodInfo {
  name: string
  namespace: string
  status: string
  phase: string
  node_name?: string
  pod_ip?: string
  containers: Array<any>
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

export interface Member {
  id: string
  name: string
  email?: string
  hq?: string
  team?: string
  role: string
  created_at: string
  updated_at: string
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

  me: async (): Promise<Member> => {
    const { data } = await client.get('/auth/me')
    return data
  },

  changePassword: async (request: { current_password: string; new_password: string }): Promise<Member> => {
    const { data } = await client.post('/auth/change-password', request)
    return data
  },

  adminListUsers: async (params?: { limit?: number; offset?: number }): Promise<Member[]> => {
    const { data } = await client.get('/auth/admin/users', { params })
    if (!Array.isArray(data)) throw new Error('Invalid users response')
    return data as Member[]
  },

  adminUpdateUserRole: async (userId: string, role: 'admin' | 'user'): Promise<Member> => {
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

  // Members
  getMembers: async (params?: { limit?: number; offset?: number }): Promise<Member[]> => {
    const { data } = await client.get('/members', { params })
    if (!Array.isArray(data)) {
      throw new Error('Invalid members response')
    }
    return data as Member[]
  },

  createMember: async (request: { name: string; email: string; password: string; role?: 'admin' | 'user' }): Promise<Member> => {
    const { data } = await client.post('/members', request)
    return data
  },

  updateMember: async (memberId: string, patch: { name?: string; email?: string; password?: string; role?: 'admin' | 'user' }): Promise<Member> => {
    const { data } = await client.patch(`/members/${memberId}`, patch)
    return data
  },

  deleteMember: async (memberId: string): Promise<void> => {
    await client.delete(`/members/${memberId}`)
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

  getServices: async (namespace: string, forceRefresh = false): Promise<ServiceInfo[]> => {
    const { data } = await client.get(`/cluster/namespaces/${namespace}/services`, {
      params: { force_refresh: forceRefresh },
    })
    return data
  },

  getIngresses: async (namespace: string, forceRefresh = false): Promise<IngressInfo[]> => {
    const { data } = await client.get(`/cluster/namespaces/${namespace}/ingresses`, {
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

  getEndpoints: async (namespace: string, forceRefresh = false): Promise<EndpointInfo[]> => {
    const { data } = await client.get(`/cluster/namespaces/${namespace}/endpoints`, {
      params: { force_refresh: forceRefresh },
    })
    return data
  },

  getEndpointSlices: async (namespace: string, forceRefresh = false): Promise<EndpointSliceInfo[]> => {
    const { data } = await client.get(`/cluster/namespaces/${namespace}/endpointslices`, {
      params: { force_refresh: forceRefresh },
    })
    return data
  },

  getNetworkPolicies: async (namespace: string, forceRefresh = false): Promise<NetworkPolicyInfo[]> => {
    const { data } = await client.get(`/cluster/namespaces/${namespace}/networkpolicies`, {
      params: { force_refresh: forceRefresh },
    })
    return data
  },

  getDeployments: async (namespace: string, forceRefresh = false): Promise<DeploymentInfo[]> => {
    const { data } = await client.get(`/cluster/namespaces/${namespace}/deployments`, {
      params: { force_refresh: forceRefresh },
    })
    return data
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
    return data.logs
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

  getPVs: async (): Promise<PVInfo[]> => {
    const { data } = await client.get('/cluster/pvs')
    return data
  },

  getPV: async (name: string): Promise<PVInfo> => {
    const { data } = await client.get(`/cluster/pvs/${name}`)
    return data
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

  getVolumeAttachments: async (forceRefresh = false): Promise<VolumeAttachmentInfo[]> => {
    const { data } = await client.get('/cluster/volumeattachments', {
      params: { force_refresh: forceRefresh },
    })
    return data
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

  getResourceYaml: async (namespace: string, resourceType: string, name: string): Promise<{ yaml: string }> => {
    const { data } = await client.get(`/cluster/namespaces/${namespace}/${resourceType}s/${name}/yaml`)
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
    const { data } = await client.get('/cluster/metrics/nodes', {
      // 메트릭 수집은 최대 수 초 이상 걸릴 수 있으므로 일반 API보다 여유 있게 설정
      timeout: 20000,
    })
    return data
  },

  getPodMetrics: async (namespace?: string): Promise<any[]> => {
    const { data } = await client.get('/cluster/metrics/pods', {
      params: { namespace },
      timeout: 20000,
    })
    return data
  },

  getTopResources: async (podLimit: number = 5, nodeLimit: number = 3): Promise<TopResources> => {
    const { data } = await client.get('/cluster/metrics/top-resources', {
      params: { pod_limit: podLimit, node_limit: nodeLimit },
    })
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
}
