import { isForbiddenError, isMetricsUnavailableError } from '@/services/api'

// A refresh that failed while earlier numbers are on screen. The numbers stay, so nothing flickers, and the screen and
// the floating chat say how old they are; with no numbers to keep the tab shows the failure itself. A refusal is not a
// failed refresh (metricsRefusal).
export interface MetricsRefreshFailure {
  valuesFrom: number
  detail?: string
}

const detailOf = (error: unknown): string | undefined => {
  const detail = (error as { response?: { data?: { detail?: unknown } } } | null)?.response?.data?.detail
  return typeof detail === 'string' && detail ? detail : undefined
}

export function metricsRefreshFailure(error: unknown, rows: unknown, dataUpdatedAt: number): MetricsRefreshFailure | null {
  if (!error || isForbiddenError(error) || !dataUpdatedAt || !Array.isArray(rows) || rows.length === 0) return null
  const detail = detailOf(error)
  return { valuesFrom: dataUpdatedAt, ...(detail ? { detail } : {}) }
}

export function refreshFailureForChat(failure: MetricsRefreshFailure): { values_from: string; reason?: string } {
  return { values_from: new Date(failure.valuesFrom).toISOString(), ...(failure.detail ? { reason: failure.detail } : {}) }
}

/**
 * The cluster refused the tab's read (403, with the cluster's words as `detail`): the tab shows the refusal with that
 * reason in place of the numbers, and the API client has named it in the no-permission banner.
 */
export function metricsRefusal(error: unknown): { reason?: string } | null {
  if (!isForbiddenError(error)) return null
  const reason = detailOf(error)
  return reason ? { reason } : {}
}

export const METRICS_POLL_MS = 5000

/**
 * How the Nodes and Pods tabs read: every 5 s, a failure tried twice more, and neither a refused read nor the answer that
 * says metrics-server is missing asked again. A refused read is asked again when the tab is opened again or another
 * cluster (or namespace) is chosen, which is a query of its own, as the banner forgets its refusals on the route and the
 * cluster. `off`: metrics are off for this cluster.
 */
export function metricsReadPace(off: () => boolean) {
  return {
    staleTime: METRICS_POLL_MS,
    refetchInterval: (query: { state: { error: unknown } }): number | false =>
      off() || isForbiddenError(query.state.error) ? false : METRICS_POLL_MS,
    retry: (failureCount: number, error: unknown): boolean =>
      !isMetricsUnavailableError(error) && !isForbiddenError(error) && failureCount < 2,
    retryDelay: (attemptIndex: number): number => Math.min(1000 * 2 ** attemptIndex, 5000),
  }
}
