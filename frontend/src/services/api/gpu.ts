// GPU + DRA (Dynamic Resource Allocation) + Prometheus API.
// Mixes three related but distinct concerns because they all back the
// GPU dashboard page. DeviceClasses / ResourceClaims / ResourceSlices
// are upstream DRA objects (alpha/beta in recent k8s).

import { client } from './client'
import type {
  ClusterFeatures,
  DeviceClassItem,
  GPUDashboardData,
  GPUMetricsData,
  PrometheusQueryResponse,
  PrometheusRangeResponse,
  ResourceClaimItem,
  ResourceClaimTemplateItem,
  ResourceSliceItem,
} from './types'

export const gpuApi = {
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

  // Range query — Prometheus /api/v1/query_range. start/end are unix seconds;
  // step is the resolution in seconds. Defaults backend-side: 24h window, 5m step.
  prometheusQueryRange: async (
    query: string,
    opts?: { start?: number; end?: number; step?: number },
  ): Promise<PrometheusRangeResponse> => {
    const params: Record<string, string | number> = { query }
    if (opts?.start != null) params.start = opts.start
    if (opts?.end != null) params.end = opts.end
    if (opts?.step != null) params.step = opts.step
    const { data } = await client.get('/cluster/prometheus/query_range', { params })
    return data
  },

  // Operator-opt-in feature flags, read once at app boot.
  getClusterFeatures: async (): Promise<ClusterFeatures> => {
    const { data } = await client.get('/cluster/features')
    return data
  },

  // DeviceClasses (DRA)
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

  // ResourceClaims (DRA)
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

  // ResourceClaimTemplates (DRA)
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

  // ResourceSlices (DRA)
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
}
