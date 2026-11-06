// A refresh that failed while earlier numbers are on screen. The numbers stay, so nothing flickers, and the screen and
// the floating chat say how old they are; with no numbers to keep the tab shows the failure itself.
export interface MetricsRefreshFailure {
  valuesFrom: number
  detail?: string
}

export function metricsRefreshFailure(error: unknown, rows: unknown, dataUpdatedAt: number): MetricsRefreshFailure | null {
  if (!error || !dataUpdatedAt || !Array.isArray(rows) || rows.length === 0) return null
  const detail = (error as { response?: { data?: { detail?: unknown } } }).response?.data?.detail
  return { valuesFrom: dataUpdatedAt, ...(typeof detail === 'string' && detail ? { detail } : {}) }
}

export function refreshFailureForChat(failure: MetricsRefreshFailure): { values_from: string; reason?: string } {
  return { values_from: new Date(failure.valuesFrom).toISOString(), ...(failure.detail ? { reason: failure.detail } : {}) }
}
