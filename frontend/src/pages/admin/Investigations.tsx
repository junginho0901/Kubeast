import { useEffect, useState } from 'react'
import { useSearchParams } from 'react-router-dom'
import { keepPreviousData, useQuery } from '@tanstack/react-query'
import { useTranslation } from 'react-i18next'
import { FileSearch, RefreshCw, Siren } from 'lucide-react'

import { api } from '@/services/api'
import type { InvestigationSummary } from '@/services/api/investigations'
import { useClusterFeatures } from '@/hooks/usePrometheusQuery'
import { useAIContext } from '@/hooks/useAIContext'
import { useAdaptiveTable } from '@/hooks/useAdaptiveTable'
import { alertInvestigationEnabled } from '@/utils/features'
import CustomDropdown from '@/components/CustomDropdown'
import { ListPager } from '@/components/ListPager'
import { AdaptiveTableFillerRows } from '@/components/AdaptiveTableFillerRows'
import InvestigationReportModal from '@/components/InvestigationReportModal'
import { duration, severityClass, skipReason, statusClass } from '@/utils/investigationFormat'
import { formatWhen } from './accessRequestFormat'
import { investigationsView } from './investigationsView'
import { utcTitle } from '@/utils/time'
import { RefreshFailure } from '@/components/RefreshFailure'
import { TableEmptyRow } from '@/components/TableEmptyRow'
import { failureOf } from '@/hooks/useRefresh'

// Admin → Investigations: the reports the alert investigator wrote (features.alertInvestigation).
// Opening one is audited server-side (ai.investigation.view).

const COLUMNS = 9
const STATUSES = ['queued', 'running', 'done', 'failed', 'skipped'] as const

export default function Investigations() {
  const { t } = useTranslation()
  const tr = (key: string, fallback: string, opts?: Record<string, unknown>) => t(key, { defaultValue: fallback, ...opts })
  const [params, setParams] = useSearchParams()
  const openId = params.get('id')
  // The status applies when picked; the cluster ID when Search or Enter is pressed (an unfinished ID lists nothing).
  const [cluster, setCluster] = useState('')
  const [applied, setApplied] = useState({ status: '', cluster: '' })
  // the first row on screen: a new rows per page (Fit or a choice) shows the page that holds it
  const [firstRow, setFirstRow] = useState(0)
  const features = useClusterFeatures()

  // the first row's height is measured once rows have come (recalculationKey)
  const [rowsIn, setRowsIn] = useState(false)
  const { containerRef, bodyRef, theadRef, firstRowRef, rowsPerPage } = useAdaptiveTable({ rowHeight: 57, recalculationKey: String(rowsIn) })
  const page = Math.floor(firstRow / rowsPerPage) + 1

  // The rows on screen stay while another page, filter or page size loads; the range, page and AI context are theirs.
  const { data, isLoading, refetch, isFetching, error: listError, errorUpdatedAt } = useQuery({
    queryKey: ['investigations', 'list', applied, page, rowsPerPage],
    queryFn: async () => ({
      ...(await api.listInvestigations({ ...applied, limit: rowsPerPage, offset: (page - 1) * rowsPerPage })),
      filter: applied, page, limit: rowsPerPage,
    }),
    placeholderData: keepPreviousData,
    // while something is queued or running, follow it
    refetchInterval: (q) => ((q.state.data?.items ?? []).some((r) => r.status === 'queued' || r.status === 'running') ? 5_000 : 30_000),
  })
  const view = investigationsView(data, page, rowsPerPage)
  const { rows, total, shownPage, shownFilter } = view
  const hasRows = rows.length > 0
  useEffect(() => { if (hasRows) setRowsIn(true) }, [hasRows])
  const clusterPending = cluster.trim() !== applied.cluster
  const applyCluster = () => {
    setApplied((a) => ({ ...a, cluster: cluster.trim() }))
    setFirstRow(0)
  }

  const open = (id: string | null) => {
    const next = new URLSearchParams(params)
    if (id) next.set('id', id)
    else next.delete('id')
    setParams(next, { replace: true })
  }

  const statusTitle = (r: InvestigationSummary) =>
    r.status === 'skipped' ? skipReason(r, tr).text : undefined

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
    <div className="flex flex-col h-[calc(100vh-4rem)] gap-6">
      <div className="flex items-start justify-between gap-3 shrink-0">
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
        <div className="shrink-0 rounded-lg border border-amber-800/60 bg-amber-900/20 px-3 py-2 text-sm text-amber-200" data-testid="investigations-disabled">
          {tr('investigations.disabled', 'Alert investigation is off on this installation (features.alertInvestigation.enabled). Earlier reports stay listed.')}
        </div>
      )}

      <RefreshFailure failure={rows.length ? failureOf(listError, errorUpdatedAt) : null} />
      <div ref={containerRef} className="card flex-1 min-h-0 flex flex-col">
        <div className="flex flex-wrap items-end gap-3 mb-4 shrink-0">
          <div className="w-44">
            <CustomDropdown
              label={tr('investigations.filter.status', 'Status')}
              value={applied.status}
              onChange={(v) => {
                setApplied((a) => ({ ...a, status: v }))
                setFirstRow(0)
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

        <div ref={bodyRef} className="overflow-x-auto flex-1 min-h-0">
          <table className="w-full text-sm" data-testid="investigations-table">
            <thead ref={theadRef} className="text-slate-400">
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
                <tr><td colSpan={COLUMNS} className="px-3 py-6 text-center text-slate-500">{tr('investigations.loading', 'Loading…')}</td></tr>
              ) : rows.length === 0 ? (
                <TableEmptyRow colSpan={COLUMNS} resource="investigations" error={listError} onRetry={() => void refetch()} className="px-3 py-6 text-center text-slate-400" />
              ) : (
                rows.map((r, idx) => (
                  <tr key={r.id} ref={idx === 0 ? firstRowRef : undefined} className="border-t border-slate-700" data-testid={`investigation-row-${r.id}`}>
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
            <AdaptiveTableFillerRows count={rowsPerPage - rows.length} columnCount={COLUMNS} cellClassName="py-2" />
          </table>
        </div>

        <ListPager
          currentPage={shownPage}
          totalPages={view.pages}
          total={total}
          rowsPerPage={view.limit}
          onPageChange={(p) => setFirstRow((p - 1) * view.limit)}
          testId="investigations-pager"
        />
      </div>

      {openId && <InvestigationReportModal id={openId} load={() => api.getInvestigation(openId)} onClose={() => open(null)} />}
    </div>
  )
}
