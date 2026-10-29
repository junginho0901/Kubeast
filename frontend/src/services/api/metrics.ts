// Metrics API — wraps the metrics-server top endpoints.
// Each call detects metrics_unavailable and re-throws as a structured
// 'metrics_unavailable' Error so callers can flip the
// `metricsDisabled` flag (in client.ts) instead of retrying forever.

import { client, isMetricsUnavailableResponse } from './client'
import type { TopResources } from './types'

export const metricsApi = {
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

  /** withLimits: each row with its pod's cpu_limit_millicores and memory_limit_bytes (null without a limit) */
  getPodMetrics: async (namespace?: string, withLimits = false): Promise<any[]> => {
    try {
      const { data } = await client.get('/cluster/metrics/pods', {
        params: { namespace, with_limits: withLimits ? '1' : undefined },
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
}
