// Multi-cluster registry CRUD (step 07 backend). Distinct from cluster.ts,
// which serves cluster *resources* (nodes/overview). These land on
// /api/v1/clusters* + /api/v1/system/deployment-mode → auth-service.
// Registration is rollout-free: a new cluster is usable the moment it's added.

import { client } from './client'

export type ClusterMode = 'external' | 'self' | 'in_cluster'

export interface ClusterMeta {
  id: string
  display_name: string
  mode: ClusterMode
  api_server_url?: string
  is_self_cluster: boolean
  health_status: string
  last_healthcheck_at?: string
  created_by: string
  created_at: string
  updated_at: string
}

export interface RegisterClusterInput {
  mode: 'external' | 'self'
  display_name: string
  kubeconfig?: string
  api_server_url?: string
}

export interface ConnectionResult {
  healthy: boolean
  server_version?: string
  error?: string
}

export type DeploymentMode = 'k8s' | 'docker'

export const clustersApi = {
  listClusters: async (accessibleOnly = false): Promise<ClusterMeta[]> => {
    const { data } = await client.get('/clusters', {
      params: accessibleOnly ? { accessibleOnly: 'true' } : undefined,
    })
    return Array.isArray(data?.items) ? data.items : []
  },

  registerCluster: async (input: RegisterClusterInput): Promise<ClusterMeta> => {
    const { data } = await client.post('/clusters', input)
    return data
  },

  deleteCluster: async (id: string): Promise<void> => {
    await client.delete(`/clusters/${id}`)
  },

  updateCluster: async (
    id: string,
    patch: { display_name?: string; kubeconfig?: string },
  ): Promise<ClusterMeta> => {
    const { data } = await client.patch(`/clusters/${id}`, patch)
    return data
  },

  // Validate a kubeconfig BEFORE registering (external dialog "연결 테스트").
  validateCluster: async (kubeconfig: string): Promise<ConnectionResult> => {
    const { data } = await client.post('/clusters/validate', { mode: 'external', kubeconfig })
    return data
  },

  // Re-test an already-registered cluster's connectivity.
  testCluster: async (id: string): Promise<ConnectionResult> => {
    const { data } = await client.post(`/clusters/${id}/test`)
    return data
  },

  getDeploymentMode: async (): Promise<DeploymentMode> => {
    const { data } = await client.get('/system/deployment-mode')
    return data?.mode === 'docker' ? 'docker' : 'k8s'
  },
}
