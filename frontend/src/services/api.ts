import axios from 'axios'

const client = axios.create({
  baseURL: '/api/v1',
  headers: {
    'Content-Type': 'application/json',
  },
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
    protocol: string
  }>
  selector: Record<string, string>
  created_at: string
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

export interface PVCInfo {
  name: string
  namespace: string
  status: string
  volume_name?: string
  storage_class?: string
  capacity?: string
  access_modes: string[]
  created_at: string
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

  getServices: async (namespace: string, forceRefresh = false): Promise<ServiceInfo[]> => {
    const { data } = await client.get(`/cluster/namespaces/${namespace}/services`, {
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

  getPVCs: async (namespace?: string, forceRefresh: boolean = false): Promise<PVCInfo[]> => {
    const { data } = await client.get('/cluster/pvcs', {
      params: { namespace, force_refresh: forceRefresh },
    })
    return data
  },

  // Topology
  getNamespaceTopology: async (namespace: string): Promise<TopologyGraph> => {
    const { data } = await client.get(`/topology/namespace/${namespace}`)
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

  // Sessions
  getSessions: async (): Promise<Session[]> => {
    const { data } = await client.get('/sessions')
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
    const { data } = await client.get('/cluster/metrics/nodes')
    return data
  },

  getPodMetrics: async (namespace?: string): Promise<any[]> => {
    const { data } = await client.get('/cluster/metrics/pods', {
      params: { namespace },
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
}
