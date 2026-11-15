import type { TFunction } from 'i18next'

import { isMetricsUnavailableError } from '@/services/api'

// What a Monitoring tab draws where its rows go, decided once for the screen and for the floating chat, so the chat is
// told what the screen says: the rows, a refusal, a failed read with no rows to keep, metrics-server missing (an
// answer that says so), an answer with no samples, or on the Pods tab with one namespace no pods there. A tab that
// shows no rows tells the chat no count of usage.
export type MetricsTabView = 'prompt' | 'loading' | 'rows' | 'refused' | 'failed' | 'unavailable' | 'no_samples' | 'none_in_namespace'

export function metricsTabView(read: {
  /** the Pods tab's namespace ('' before one is chosen, 'all' for every one); the Nodes tab has none */
  namespace?: string
  isLoading: boolean
  rows: readonly unknown[] | undefined
  refused: boolean
  error: unknown
}): MetricsTabView {
  if (read.namespace === '') return 'prompt'
  if (read.isLoading) return 'loading'
  if (read.rows && read.rows.length > 0) return 'rows'
  if (read.refused) return 'refused'
  const missing = isMetricsUnavailableError(read.error)
  if (read.error && !missing) return 'failed'
  if (missing) return 'unavailable'
  return read.namespace && read.namespace !== 'all' ? 'none_in_namespace' : 'no_samples'
}

const detailOf = (error: unknown): string | undefined => {
  const detail = (error as { response?: { data?: { detail?: unknown } } } | null)?.response?.data?.detail
  return typeof detail === 'string' && detail ? detail : undefined
}

type Layer = { source: 'base'; summary: string; data: Record<string, unknown> }

/**
 * The tab's layer while it shows no rows, in the words it shows: `metrics_error` with the reason, `metrics_unavailable`,
 * `no_samples`, or 0 pods in the chosen namespace. Null while it shows rows or a refusal (the tab's own layers), loads or
 * waits for a namespace.
 */
export function metricsNotShownLayer(t: TFunction, tab: 'nodes' | 'pods', view: MetricsTabView, read: {
  error: unknown
  namespace?: string
}): Layer | null {
  const scope = { tab, ...(tab === 'pods' ? { filters: { namespace: read.namespace } } : {}) }
  const title = t(tab === 'nodes' ? 'monitoring.nodes.title' : 'monitoring.pods.title')
  const said = (...lines: (string | undefined)[]) => `${title} — ${lines.filter(Boolean).join(' — ')}`
  const notAvailable = t(tab === 'nodes' ? 'monitoring.nodes.unavailable' : 'monitoring.pods.unavailableAll')
  switch (view) {
    case 'failed': {
      const reason = detailOf(read.error)
      return {
        source: 'base',
        summary: said(t(tab === 'nodes' ? 'monitoring.nodes.errorTitle' : 'monitoring.pods.errorTitle'), reason, t('monitoring.pods.retrying')),
        data: { ...scope, metrics_error: reason ? { reason } : {} },
      }
    }
    case 'unavailable':
      return {
        source: 'base',
        summary: said(notAvailable, t('monitoring.metricsServerHint')),
        data: { ...scope, metrics_unavailable: true },
      }
    case 'no_samples':
      return { source: 'base', summary: said(notAvailable, t('monitoring.metricsServerHint')), data: { ...scope, no_samples: true } }
    case 'none_in_namespace':
      return { source: 'base', summary: said(t('monitoring.pods.noPodsInNamespace', { namespace: read.namespace })), data: { ...scope, total_count: 0 } }
    default:
      return null
  }
}
