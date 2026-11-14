import type { TFunction } from 'i18next'

import { isForbiddenError, isMetricsUnavailableError } from '@/services/api'
import { failureText } from '@/utils/failureText'

// Numbers a screen could not show because their read failed (`<part>_error`, with the reason the screen gives) or the
// cluster has no metrics-server (`metrics_unavailable`), told to the floating chat in the words the screen says where
// the numbers would be. The screen's own layer has no numbers then; a refusal is the screen's `<part>_refused`.
export const METRICS_NOT_READ = 'MetricsNotRead'

export type NotRead = { summary: string; data: Record<string, unknown> }

const detailOf = (error: unknown): string | undefined => {
  const detail = (error as { response?: { data?: { detail?: unknown } } } | null)?.response?.data?.detail
  return typeof detail === 'string' && detail ? detail : undefined
}

/** The Dashboard's top pods and nodes cards, as DashboardTopResources draws them once the first read ended. */
export function topResourcesNotRead(t: TFunction, read: {
  loading: boolean
  answer?: { top_pods?: unknown; top_nodes?: unknown }
  failed: boolean
  error?: unknown
  metricsUnavailable: boolean
}): NotRead | null {
  if (read.loading && !read.answer) return null
  if (read.metricsUnavailable) {
    return { summary: t('dashboard.metrics.unavailable', { defaultValue: 'Metrics server not available for this cluster' }), data: { metrics_unavailable: true } }
  }
  if (!read.failed) return null
  const reason = failureText(read.error)
  const data = {
    ...(!read.answer?.top_pods ? { top_pods_error: { reason } } : {}),
    ...(!read.answer?.top_nodes ? { top_nodes_error: { reason } } : {}),
  }
  if (Object.keys(data).length === 0) return null
  return { summary: t('common.readFailed', { defaultValue: 'Could not read the list: {{reason}}', reason }), data }
}

/** A Monitoring tab's numbers, as the tab draws them: its read failed with no numbers to keep, or no metrics-server. */
export function monitoringNotRead(t: TFunction, tab: 'nodes' | 'pods', read: { queryKey: readonly unknown[]; error: unknown; data: unknown } | null, metricsUnavailable: boolean): NotRead | null {
  const namespace = tab === 'pods' && typeof read?.queryKey[2] === 'string' ? read.queryKey[2] : undefined
  const scope = { tab, ...(namespace ? { filters: { namespace } } : {}) }
  if (metricsUnavailable) {
    return { summary: t('monitoring.metricsUnavailable', { defaultValue: 'Metrics server not available for this cluster' }), data: { ...scope, metrics_unavailable: true } }
  }
  const error = read?.error
  if (!error || isForbiddenError(error) || isMetricsUnavailableError(error)) return null
  if (Array.isArray(read.data) && read.data.length > 0) return null // the numbers stay, with when they were read
  if (tab === 'pods' && !namespace) return null
  const detail = detailOf(error)
  const title = tab === 'nodes' ? t('monitoring.nodes.errorTitle') : t('monitoring.pods.errorTitle')
  return {
    summary: [title, detail, t('monitoring.pods.retrying')].filter(Boolean).join(' '),
    data: { ...scope, metrics_error: detail ? { reason: detail } : {} },
  }
}
