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
  const params = (config.params ?? {}) as Record<string, unknown>
  config.sentUnder = { cluster: cid, namesCluster: params.cluster !== undefined }
  if (cid && params.cluster === undefined) {
    config.params = { ...params, cluster: cid }
  }
  return config
})

declare module 'axios' {
  interface AxiosRequestConfig {
    // false on a read beside a screen's list (the GPU metrics next to the GPU lists, a drawer's Prometheus sums): its
    // answer, failure or refusal is not the list's, so it does not go into the list status or forbidden state of its API segment
    listStatus?: false
    // set by the client as the request goes out: the cluster selected then, and whether the call named a cluster of its own
    sentUnder?: { cluster: string; namesCluster: boolean }
  }
}

// The services whose answers are not a cluster's: they take the cluster the client adds and answer the same.
const CLUSTER_FREE_PATHS = ['/auth/', '/clusters', '/sessions', '/ai/', '/system/', '/audit/']

/** The message of the cancel a read of the cluster selected before ends with (axios.isCancel is true for it). */
export const CLUSTER_LEFT = 'another cluster was selected while this read was on its way'

// A read of the selected cluster that answers once another one is selected: the screen has moved on, so its answer,
// failure or refusal reaches nothing — not a Refresh writing the old cluster's rows into the cache, nor a status
// store — as a watch frame of another cluster reaches nothing (watchMultiplexer.dispatch).
const leftBehind = (config: { method?: string; url?: string; sentUnder?: { cluster: string; namesCluster: boolean } } | undefined): boolean => {
  const sent = config?.sentUnder
  if (!sent || sent.namesCluster || sent.cluster === getCurrentClusterID()) return false
  const url = String(config?.url || '')
  return String(config?.method || 'get').toLowerCase() === 'get' && !CLUSTER_FREE_PATHS.some((p) => url.startsWith(p))
}

/** False for a status event of a request sent while another cluster was selected: the stores drop it. */
export const ofSelectedCluster = (detail: { cluster?: string } | null | undefined): boolean =>
  detail?.cluster === undefined || detail.cluster === getCurrentClusterID()

// A cluster read whose outcome is the list status of its segment (services/listStatusStore): every GET under
// /cluster/ but the reads that say `listStatus: false`.
const isListRead = (config: { method?: string; url?: string; listStatus?: false } | undefined): boolean =>
  config?.listStatus !== false && String(config?.method || 'get').toLowerCase() === 'get' && String(config?.url || '').startsWith('/cluster/')

const dispatchListStatus = (detail: ListStatusDetail) => {
  try {
    window.dispatchEvent(new CustomEvent(LIST_STATUS_EVENT, { detail }))
  } catch { /* non-browser */ }
}

client.interceptors.response.use(
  (response) => {
    if (leftBehind(response.config)) return Promise.reject(new axios.CanceledError(CLUSTER_LEFT, response.config, response.request))
    // A cluster read that answered: "not installed" when the server says the
    // cluster does not serve the kind, otherwise it clears an earlier failure.
    if (isListRead(response.config)) {
      const url = String(response.config.url)
      const cluster = response.config.sentUnder?.cluster
      dispatchListStatus(response.headers?.['x-kubeast-not-installed'] ? { url, state: 'notInstalled', cluster } : { url, state: 'ok', cluster })
    }
    return response
  },
  (error) => {
    const status = error?.response?.status
    const url = String(error?.config?.url || '')
    const cluster: string | undefined = error?.config?.sentUnder?.cluster
    // /auth/me is the session probe: RequireAuth turns its 401 into an in-app
    // redirect to /login, so it must not trigger the page reload below.
    const isAuthRequest =
      url.startsWith('/auth/login') || url.startsWith('/auth/register') || url.startsWith('/auth/me')
    if (status === 401 && !isAuthRequest) {
      handleUnauthorized()
    }
    if (leftBehind(error?.config) && !axios.isCancel(error)) {
      return Promise.reject(new axios.CanceledError(CLUSTER_LEFT, error.config, error.request))
    }
    // A 403 on a cluster read means the signed-in user's cluster role does not
    // cover that kind. Pages render an empty list in that case; the banner in
    // Layout listens for this event so the page says "no permission" instead of
    // "nothing here". A read saying `listStatus: false` is named in the banner but refuses no list (`list: false`).
    if (status === 403 && String(error?.config?.method || 'get').toLowerCase() === 'get' && url.startsWith('/cluster/')) {
      const detail: ForbiddenDetail = { url, detail: error?.response?.data?.detail, list: isListRead(error?.config), cluster }
      try {
        window.dispatchEvent(new CustomEvent(FORBIDDEN_EVENT, { detail }))
      } catch { /* non-browser */ }
    }
    // A cluster read that failed on the server or on the way (5xx, timeout):
    // the table says "could not load" instead of "no … found". metrics-server
    // missing is a known state with its own notices, not a failure.
    if (isListRead(error?.config) && (status === undefined || status >= 500) && !axios.isCancel(error) &&
        !isMetricsUnavailableResponse(error)) {
      // the server's own reason when it wrote one (a 5xx of k8s-service carries `detail`), not the client's "status code"
      const detail = error?.response?.data?.detail
      dispatchListStatus({ url, state: 'error', code: status, reason: typeof detail === 'string' && detail.trim() ? detail.trim() : undefined, cluster })
    }
    return Promise.reject(error)
  },
)

/** Dispatched on window for every 403 on a GET /cluster/... request (detail: ForbiddenDetail). */
export const FORBIDDEN_EVENT = 'kubeast:forbidden'
/** `list` is false for a read saying `listStatus: false`: its refusal is not the list's. `cluster`: the one selected when the request went out. */
export type ForbiddenDetail = { url: string; detail?: unknown; list: boolean; cluster?: string }

/** Dispatched on window for every GET /cluster/... outcome other than 403 (a read saying `listStatus: false` aside): ok, not installed, failed (5xx / network). */
export const LIST_STATUS_EVENT = 'kubeast:list-status'
export type ListStatusDetail = { url: string; state: 'ok' | 'notInstalled' | 'error'; code?: number; reason?: string; cluster?: string }

const METRICS_UNAVAILABLE = 'metrics_unavailable'

// Internal — used by domain files that want to fall through to a
// "metrics-server unavailable" branch instead of bubbling the error.
export const isMetricsUnavailableResponse = (error: any): boolean => {
  if (error?.response?.status !== 503) return false
  const data = error.response.data
  return data?.detail === METRICS_UNAVAILABLE || data?.detail?.code === METRICS_UNAVAILABLE || data?.code === METRICS_UNAVAILABLE
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

/** The request answered 403: the section says "no permission", not that the cluster has nothing. */
export const isForbiddenError = (err: any): boolean => err?.response?.status === 403

/** metrics-server is missing: an answer that says so or the metrics calls' error for it. A 503 alone is a gateway or an unreachable cluster, which pass. */
export const isMetricsUnavailableError = (err: any): boolean =>
  err?.code === METRICS_UNAVAILABLE || isMetricsUnavailableResponse(err)
