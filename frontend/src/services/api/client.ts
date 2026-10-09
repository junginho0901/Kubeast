// Shared axios client + cross-cutting helpers used by every domain
// sub-file (auth, cluster, workloads, ...). Extracted from the
// original services/api.ts so each domain can import a single
// `client` rather than duplicating the axios setup.

import axios from 'axios'
import { CSRF_HEADER, handleUnauthorized } from '../auth'
import { getCurrentClusterID } from '../clusterRef'

// Authentication is the HttpOnly session cookie (sent by the browser on every
// same-origin call); the CSRF header goes on every request, see services/auth.
export const client = axios.create({
  baseURL: '/api/v1',
  headers: {
    'Content-Type': 'application/json',
    ...CSRF_HEADER,
  },
  timeout: 10000, // 10초 타임아웃 (백엔드 재시도 시간 고려)
})

client.interceptors.request.use((config) => {
  config.headers = config.headers ?? {}
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

const isClusterRead = (config: { method?: string; url?: string } | undefined): boolean =>
  String(config?.method || 'get').toLowerCase() === 'get' && String(config?.url || '').startsWith('/cluster/')

const dispatchListStatus = (detail: ListStatusDetail) => {
  try {
    window.dispatchEvent(new CustomEvent(LIST_STATUS_EVENT, { detail }))
  } catch { /* non-browser */ }
}

client.interceptors.response.use(
  (response) => {
    // A cluster read that answered: "not installed" when the server says the
    // cluster does not serve the kind, otherwise it clears an earlier failure.
    if (isClusterRead(response.config)) {
      const url = String(response.config.url)
      dispatchListStatus(response.headers?.['x-kubeast-not-installed'] ? { url, state: 'notInstalled' } : { url, state: 'ok' })
    }
    return response
  },
  (error) => {
    const status = error?.response?.status
    const url = String(error?.config?.url || '')
    // /auth/me is the session probe: RequireAuth turns its 401 into an in-app
    // redirect to /login, so it must not trigger the page reload below.
    const isAuthRequest =
      url.startsWith('/auth/login') || url.startsWith('/auth/register') || url.startsWith('/auth/me')
    if (status === 401 && !isAuthRequest) {
      handleUnauthorized()
    }
    // A 403 on a cluster read means the signed-in user's cluster role does not
    // cover that kind. Pages render an empty list in that case; the banner in
    // Layout listens for this event so the page says "no permission" instead of
    // "nothing here".
    if (status === 403 && String(error?.config?.method || 'get').toLowerCase() === 'get' && url.startsWith('/cluster/')) {
      try {
        window.dispatchEvent(new CustomEvent(FORBIDDEN_EVENT, { detail: { url, detail: error?.response?.data?.detail } }))
      } catch { /* non-browser */ }
    }
    // A cluster read that failed on the server or on the way (5xx, timeout):
    // the table says "could not load" instead of "no … found". metrics-server
    // missing is a known state with its own notices, not a failure.
    if (isClusterRead(error?.config) && (status === undefined || status >= 500) && !axios.isCancel(error) &&
        !isMetricsUnavailableResponse(error)) {
      dispatchListStatus({ url, state: 'error', code: status })
    }
    return Promise.reject(error)
  },
)

/** Dispatched on window for every 403 on a GET /cluster/... request (detail: { url, detail }). */
export const FORBIDDEN_EVENT = 'kubeast:forbidden'

/** Dispatched on window for every GET /cluster/... outcome other than 403: ok, not installed, failed (5xx / network). */
export const LIST_STATUS_EVENT = 'kubeast:list-status'
export type ListStatusDetail = { url: string; state: 'ok' | 'notInstalled' | 'error'; code?: number }

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
