// Topology API — namespace / storage topology, resource graph, and
// the per-namespace / per-resource event timeline.

import { client } from './client'
import type { ResourceGraphOptions, ResourceGraphResponse, TimelineResult, TopologyGraph } from './types'

export const topologyApi = {
  // Topology (graph)
  getNamespaceTopology: async (namespace: string): Promise<TopologyGraph> => {
    const { data } = await client.get(`/topology/namespace/${namespace}`)
    return data
  },

  getStorageTopology: async (): Promise<TopologyGraph> => {
    const { data } = await client.get('/topology/storage')
    return data
  },

  // Timeline
  getClusterTimeline: async (hours: number = 24, limit: number = 500): Promise<TimelineResult> => {
    const { data } = await client.get('/cluster/timeline', {
      params: { hours, limit },
    })
    return data
  },

  getNamespaceTimeline: async (namespace: string, hours: number = 24, limit: number = 500): Promise<TimelineResult> => {
    const { data } = await client.get(`/cluster/namespaces/${namespace}/timeline`, {
      params: { hours, limit },
    })
    return data
  },

  getResourceTimeline: async (namespace: string, kind: string, name: string, hours: number = 24, limit: number = 500): Promise<TimelineResult> => {
    const { data } = await client.get(`/cluster/namespaces/${namespace}/timeline/${kind}/${name}`, {
      params: { hours, limit },
    })
    return data
  },

  // Resource Graph
  getResourceGraph: async (namespaces?: string[], opts: ResourceGraphOptions = {}): Promise<ResourceGraphResponse> => {
    const params: Record<string, string> = {}
    if (namespaces?.length) params.namespaces = namespaces.join(',')
    if (opts.groupPods) {
      params.group_pods = '1'
      if (opts.groupBy && opts.groupBy !== 'none') params.group_by = opts.groupBy
      if (opts.expand?.length) params.expand = opts.expand.join(',')
    }
    const { data } = await client.get('/resource-graph', { params })
    return data
  },

  getNamespaceResourceGraph: async (namespace: string): Promise<ResourceGraphResponse> => {
    const { data } = await client.get(`/cluster/namespaces/${namespace}/resource-graph`)
    return data
  },
}
