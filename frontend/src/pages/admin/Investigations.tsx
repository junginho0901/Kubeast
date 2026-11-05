import { useState } from 'react'
import { useSearchParams } from 'react-router-dom'
import { keepPreviousData, useQuery } from '@tanstack/react-query'
import { useTranslation } from 'react-i18next'
import { FileSearch, RefreshCw, Siren } from 'lucide-react'

import { api } from '@/services/api'
import type { InvestigationSummary } from '@/services/api/investigations'
import { useClusterFeatures } from '@/hooks/usePrometheusQuery'
import { useAIContext } from '@/hooks/useAIContext'
import { alertInvestigationEnabled } from '@/utils/features'
import CustomDropdown from '@/components/CustomDropdown'
import InvestigationReportModal from '@/components/InvestigationReportModal'
import { duration, severityClass, statusClass } from '@/utils/investigationFormat'
import { formatWhen } from './accessRequestFormat'
import { investigationsView } from './investigationsView'
import { utcTitle } from '@/utils/time'

// Admin → Investigations: the reports the alert investigator wrote (features.alertInvestigation).
// Opening one is audited server-side (ai.investigation.view).

const PAGE_SIZE = 50
const STATUSES = ['queued', 'running', 'done', 'failed', 'skipped'] as const

export default function Investigations() {
  const { t } = useTranslation()
  const tr = (key: string, fallback: string, opts?: Record<string, unknown>) => t(key, { defaultValue: fallback, ...opts })
  const [params, setParams] = useSearchParams()
  const openId = params.get('id')
  // The status applies when picked; the cluster ID when Search or Enter is pressed (an unfinished ID lists nothing).
  const [cluster, setCluster] = useState('')
  const [applied, setApplied] = useState({ status: '', cluster: '' })
  const [page, setPage] = useState(1)
  const features = useClusterFeatures()

  // The rows on screen stay while another page or filter loads; the range, page and AI context are theirs.
  const { data, isLoading, isPlaceholderData, refetch, isFetching } = useQuery({
    queryKey: ['investigations', 'list', applied, page],
    queryFn: async () => ({ ...(await api.listInvestigations({ ...applied, limit: PAGE_SIZE, offset: (page - 1) * PAGE_SIZE })), filter: applied, page }),
    placeholderData: keepPreviousData,
    // while something is queued or running, follow it
    refetchInterval: (q) => ((q.state.data?.items ?? []).some((r) => r.status === 'queued' || r.status === 'running') ? 5_000 : 30_000),
  })
  const view = investigationsView(data, page, PAGE_SIZE)
  const { rows, total, first, shownPage, shownFilter } = view
  const clusterPending = cluster.trim() !== applied.cluster
  const applyCluster = () => {
    setApplied((a) => ({ ...a, cluster: cluster.trim() }))
    setPage(1)
  }

  const open = (id: string | null) => {
    const next = new URLSearchParams(params)
    if (id) next.set('id', id)
    else next.delete('id')
    setParams(next, { replace: true })
  }

  const statusTitle = (r: InvestigationSummary) =>
    r.status === 'skipped' ? tr('investigations.skipReason', 'Skipped: {{reason}}', { reason: r.skip_reason }) : undefined

  useAIContext(data ? {
    summary: `알림 조사 보고서 ${total}건${shownFilter.status ? ` (상태 ${shownFilter.status})` : ''}${shownFilter.cluster ? ` (클러스터 ${shownFilter.cluster})` : ''}`,
    data: {
      filters: { status: shownFilter.status || undefined, cluster: shownFilter.cluster || undefined, page: shownPage },
      items: rows.map((r) => ({
        alertname: r.alertname, cluster: r.cluster, namespace: r.namespace, severity: r.severity, status: r.status,
        skip_reason: r.skip_reason || undefined, received_at: r.received_at, repeat_count: r.repeat_count,
        tool_call_count: r.tool_call_count, total_tokens: r.total_tokens,
      })),
    },
  } : null, [data, total, shownFilter, shownPage, rows])

  return (
    <div className="page-scrolls space-y-6">
      <div className="flex items-start justify-between gap-3">
        <div className="flex items-center gap-3">
          <div className="p-2 bg-primary-600/20 rounded-lg">
            <Siren className="w-6 h-6 text-primary-400" />
          </div>
          <div>
            <h1 className="text-3xl font-semibold text-ink">{tr('investigations.title', 'Investigations')}</h1>
            <p className="text-slate-400">
              {tr('investigations.subtitle', 'What the AI found with read-only tools when an alert came in (Alertmanager or Grafana). Opening a report is audited.')}
            </p>
          </div>
        </div>
        <button type="button" onClick={() => refetch()} className="btn btn-primary flex items-center gap-2">
          <RefreshCw className={`w-4 h-4 ${isFetching ? 'animate-spin' : ''}`} /> {tr('investigations.refresh', 'Refresh')}
        </button>
      </div>

      {features.data && !alertInvestigationEnabled(features.data) && (
        <div className="rounded-lg border border-amber-800/60 bg-amber-900/20 px-3 py-2 text-sm text-amber-200" data-testid="investigations-disabled">
          {tr('investigations.disabled', 'Alert investigation is off on this installation (features.alertInvestigation.enabled). Earlier reports stay listed.')}
        </div>
      )}

      <div className="card">
        <div className="flex flex-wrap items-end gap-3 mb-4">
          <div className="w-44">
            <CustomDropdown
              label={tr('investigations.filter.status', 'Status')}
              value={applied.status}
              onChange={(v) => {
                setApplied((a) => ({ ...a, status: v }))
                setPage(1)
              }}
              options={[
                { value: '', label: tr('investigations.status.all', 'All') },
                ...STATUSES.map((s) => ({ value: s, label: tr(`investigations.status.${s}`, s) })),
              ]}
            />
          </div>
          <div>
            <label className="block text-xs font-semibold text-slate-400 mb-1">{tr('investigations.filter.cluster', 'Cluster')}</label>
            <input
              value={cluster}
              onChange={(e) => setCluster(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && !e.nativeEvent.isComposing) applyCluster()
              }}
              placeholder={tr('investigations.filter.clusterPlaceholder', 'cluster ID')}
              className="w-48 h-10 rounded-lg border border-slate-700 bg-slate-950/60 px-3 text-sm text-ink"
              data-testid="investigations-cluster-filter"
            />
          </div>
          <button
            type="button"
            onClick={applyCluster}
            className="h-10 rounded-lg bg-primary-600 px-3 text-sm font-medium text-white hover:bg-primary-500"
            data-testid="investigations-search"
          >
            {tr('investigations.filter.apply', 'Search')}
          </button>
          {/* kept in place while hidden, so the row does not move when it shows */}
          <span className={`h-10 flex items-center text-xs text-amber-400 ${clusterPending ? '' : 'invisible'}`} aria-hidden={!clusterPending} data-testid="investigations-cluster-pending">
            {tr('investigations.filter.pending', 'Not applied yet — press Search or Enter.')}
          </span>
        </div>

        <div className="overflow-x-auto">
          <table className="w-full text-sm" data-testid="investigations-table">
            <thead className="text-slate-400">
              <tr>
                <th className="px-3 py-2 text-left">{tr('investigations.col.received', 'Received')}</th>
                <th className="px-3 py-2 text-left">{tr('investigations.col.cluster', 'Cluster')}</th>
                <th className="px-3 py-2 text-left">{tr('investigations.col.alert', 'Alert')}</th>
                <th className="px-3 py-2 text-left">{tr('investigations.col.namespace', 'Namespace')}</th>
                <th className="px-3 py-2 text-left">{tr('investigations.col.status', 'Status')}</th>
                <th className="px-3 py-2 text-right">{tr('investigations.col.repeats', 'Repeats')}</th>
                <th className="px-3 py-2 text-right">{tr('investigations.col.tokens', 'Tokens')}</th>
                <th className="px-3 py-2 text-right">{tr('investigations.col.duration', 'Duration')}</th>
                <th className="px-3 py-2" />
              </tr>
            </thead>
            <tbody>
              {isLoading ? (
                <tr><td colSpan={9} className="px-3 py-6 text-center text-slate-500">{tr('investigations.loading', 'Loading…')}</td></tr>
              ) : rows.length === 0 ? (
                <tr><td colSpan={9} className="px-3 py-6 text-center text-slate-400">{tr('common.listEmpty', 'No items.')}</td></tr>
              ) : (
                rows.map((r) => (
                  <tr key={r.id} className="border-t border-slate-700" data-testid={`investigation-row-${r.id}`}>
                    <td className="px-3 py-2 text-slate-300 whitespace-nowrap" title={utcTitle(r.received_at)}>{formatWhen(r.received_at)}</td>
                    <td className="px-3 py-2 text-slate-300 whitespace-nowrap">{r.cluster}</td>
                    <td className="px-3 py-2">
                      <span className="block max-w-[260px] truncate font-medium text-slate-100" title={r.alertname}>{r.alertname || '-'}</span>
                      <span className={`text-xs ${severityClass[r.severity] ?? 'text-slate-400'}`}>{r.severity || '-'}</span>
                    </td>
                    <td className="px-3 py-2 font-mono text-xs text-slate-300 whitespace-nowrap">{r.namespace || '-'}</td>
                    <td className="px-3 py-2">
                      <span className={`inline-block whitespace-nowrap rounded-sm border px-2 py-0.5 text-xs ${statusClass[r.status] ?? ''}`} title={statusTitle(r)}>
                        {tr(`investigations.status.${r.status}`, r.status)}
                      </span>
                    </td>
                    <td className="px-3 py-2 text-right text-slate-300">{r.repeat_count}</td>
                    <td className="px-3 py-2 text-right text-slate-300 whitespace-nowrap">{r.total_tokens ?? '-'}</td>
                    <td className="px-3 py-2 text-right text-slate-300 whitespace-nowrap">{duration(r.duration_ms)}</td>
                    <td className="px-3 py-2 text-right">
                      <button
                        type="button"
                        onClick={() => open(r.id)}
                        disabled={r.status === 'queued' || r.status === 'running'}
                        data-testid={`investigation-open-${r.id}`}
                        className="inline-flex items-center gap-1 whitespace-nowrap rounded-lg bg-primary-600 px-2 py-1 text-xs text-white hover:bg-primary-500 disabled:opacity-40"
                      >
                        <FileSearch className="w-3.5 h-3.5" /> {tr('investigations.open', 'Report')}
                      </button>
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>

        <div className="flex items-center justify-between pt-3 mt-2 border-t border-slate-700" data-testid="investigations-pager">
          <div className="text-xs text-slate-400">
            {rows.length > 0
              ? tr('investigations.range', '{{from}}–{{to}} of {{total}}', { from: first, to: view.last, total })
              : tr('common.paginationEmpty', 'Showing 0 of 0')}
          </div>
          <div className="flex items-center gap-2">
            <button type="button" onClick={() => setPage((p) => Math.max(1, p - 1))} disabled={page <= 1} className="px-3 py-1.5 text-xs rounded-sm border border-slate-600 text-slate-300 disabled:opacity-40 disabled:cursor-not-allowed hover:text-ink hover:border-slate-500">
              {tr('common.prev', 'Prev')}
            </button>
            <span className="text-xs text-slate-300 min-w-[48px] text-center">{shownPage}</span>
            <button type="button" onClick={() => setPage((p) => p + 1)} disabled={!view.hasNext || isPlaceholderData} className="px-3 py-1.5 text-xs rounded-sm border border-slate-600 text-slate-300 disabled:opacity-40 disabled:cursor-not-allowed hover:text-ink hover:border-slate-500">
              {tr('common.next', 'Next')}
            </button>
          </div>
        </div>
      </div>

      {openId && <InvestigationReportModal id={openId} load={() => api.getInvestigation(openId)} onClose={() => open(null)} />}
    </div>
  )
}
