// Shared axios client + cross-cutting helpers used by every domain
// sub-file (auth, cluster, workloads, ...). Extracted from the
// original services/api.ts so each domain can import a single
// `client` rather than duplicating the axios setup.

import axios from 'axios'
import { getAccessToken, handleUnauthorized } from '../auth'
import { getCurrentClusterID } from '../clusterRef'

export const client = axios.create({
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
  // Inject the selected cluster (step 09). An explicit cluster on the call wins;
  // an empty selection omits it so the server uses its default cluster.
  const cid = getCurrentClusterID()
  if (cid) {
    const params = (config.params ?? {}) as Record<string, unknown>
    if (params.cluster === undefined) {
      config.params = { ...params, cluster: cid }
    }
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
  },
)

// Internal — used by domain files that want to fall through to a
// "metrics-server unavailable" branch instead of bubbling the error.
export const isMetricsUnavailableResponse = (error: any): boolean => {
  const status = error?.response?.status
  const detail = error?.response?.data?.detail
  return status === 503 && detail === 'metrics_unavailable'
}

// Per-cluster flag — once a metrics call fails with metrics_unavailable the UI
// flips it so subsequent panels short-circuit instead of re-issuing the same
// failing requests. Keyed by cluster so a cluster WITHOUT metrics-server doesn't
// permanently disable metrics for one that HAS it (multi-cluster).
const metricsDisabledClusters = new Set<string>()
const metricsClusterKey = (): string => getCurrentClusterID() || 'default'

export const disableMetrics = (): void => {
  metricsDisabledClusters.add(metricsClusterKey())
}

export const isMetricsDisabled = (): boolean => metricsDisabledClusters.has(metricsClusterKey())

export const isMetricsUnavailableError = (err: any): boolean => {
  const status = err?.response?.status
  if (status === 503) return true
  const code =
    err?.response?.data?.detail?.code ||
    err?.response?.data?.code
  return status === 503 && code === 'metrics_unavailable'
}
