import type { TFunction } from 'i18next'

import { failureText } from '@/utils/failureText'

// Numbers a screen could not show because their read failed (`<part>_error`, with the reason the screen gives) or the
// cluster has no metrics-server (`metrics_unavailable`), told to the floating chat in the words the screen says where
// the numbers would be: the Dashboard's top cards and its cluster metrics card. The screen's own layer has no numbers
// then; a refusal is the screen's `<part>_refused`. Monitoring's tabs, which draw their numbers themselves, tell the
// chat from their own layer.
export const METRICS_NOT_READ = 'MetricsNotRead'

export type NotRead = { summary: string; data: Record<string, unknown> }

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
