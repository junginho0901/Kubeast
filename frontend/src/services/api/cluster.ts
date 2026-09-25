// Cluster API — overview / namespaces / nodes / api-resources /
// component statuses / generic resource (yaml/json) / search.
// Pod / workload / network / storage etc. live in their own
// domain files even though the gateway URL is rooted at /cluster.

import axios from 'axios'

import { client } from './client'
import type {
  ClusterOverview,
  NamespaceDescribe,
  NamespaceInfo,
  NamespaceLimitRange,
  NamespacePod,
  NamespaceResourceQuota,
  PodInfo,
} from './types'

export const clusterApi = {
  getClusterOverview: async (forceRefresh = false): Promise<ClusterOverview> => {
    const { data } = await client.get('/cluster/overview', {
      params: { force_refresh: forceRefresh },
    })
    return data
  },

  getNamespaces: async (forceRefresh = false): Promise<NamespaceInfo[]> => {
    const { data } = await client.get('/cluster/namespaces', {
      params: { force_refresh: forceRefresh },
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

  // Generic resource (yaml / json / apply / multi-create) — shared
  // pathway used by ResourceDetailDrawer / yaml editors. Stays here
  // because the URL surface is /cluster/resources/*.
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

  getResourceJson: async (resourceType: string, name: string, namespace?: string): Promise<Record<string, unknown>> => {
    const { data } = await client.get('/cluster/resources/json', {
      params: {
        resource_type: resourceType,
        resource_name: name,
        ...(namespace && namespace !== '-' ? { namespace } : {}),
      },
    })
    return data
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
    namespace?: string,
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

  // Cluster View — node + cluster-wide
  getNodes: async (forceRefresh: boolean = false): Promise<any[]> => {
    const { data } = await client.get('/cluster/nodes', {
      params: { force_refresh: forceRefresh },
    })
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
    drainId: string,
  ): Promise<{ id: string; node: string; status: string; message?: string | null }> => {
    const { data } = await client.get(`/cluster/nodes/${name}/drain/status`, {
      params: { drain_id: drainId },
    })
    return data
  },

  // Cluster Setup — public: only whether a cluster is registered yet.
  getSetupStatus: async (): Promise<{ configured: boolean }> => {
    const { data } = await client.get('/auth/setup')
    return data
  },

  // Admin: mode + connection status for the wizard.
  getSetupStatusFull: async (): Promise<{
    configured: boolean
    mode?: string
    connection_status?: string
    connection_message?: string | null
  }> => {
    const { data } = await client.get('/auth/setup/status')
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

  // Health check — /health는 /api/v1가 아닌 루트에 있음
  getHealth: async (): Promise<{ status: string; kubernetes: string; openai: string }> => {
    const { data } = await axios.get('/health', {
      baseURL: '',
    })
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
}

