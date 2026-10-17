import { useState } from 'react'
import { useSearchParams } from 'react-router-dom'
import { useQuery } from '@tanstack/react-query'
import { useTranslation } from 'react-i18next'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { ExternalLink, FileSearch, RefreshCw, Siren } from 'lucide-react'

import { api } from '@/services/api'
import type { Investigation, InvestigationSummary } from '@/services/api/investigations'
import { useClusterFeatures } from '@/hooks/usePrometheusQuery'
import { useAIContext } from '@/hooks/useAIContext'
import { alertInvestigationEnabled } from '@/utils/features'
import CustomDropdown from '@/components/CustomDropdown'
import { ModalFrame } from '@/components/ModalFrame'
import { formatWhen } from './accessRequestFormat'
import { utcTitle } from '@/utils/time'

// Admin → Investigations: the reports the alert investigator wrote (features.alertInvestigation).
// Opening one is audited server-side (ai.investigation.view). The report text came from a model that
// read an external alert, so it is rendered as Markdown without raw HTML.

const PAGE_SIZE = 50
const STATUSES = ['queued', 'running', 'done', 'failed', 'skipped'] as const

const statusClass: Record<string, string> = {
  queued: 'bg-slate-800/60 text-slate-300 border-slate-600',
  running: 'bg-sky-900/40 text-sky-300 border-sky-800/60',
  done: 'bg-emerald-900/40 text-emerald-300 border-emerald-800/60',
  failed: 'bg-red-900/40 text-red-300 border-red-800/60',
  skipped: 'bg-amber-900/40 text-amber-300 border-amber-800/60',
}

const severityClass: Record<string, string> = {
  critical: 'text-red-300',
  warning: 'text-amber-300',
}

function duration(ms: number | null): string {
  if (ms === null || ms === undefined) return '-'
  return ms < 1000 ? `${ms} ms` : `${(ms / 1000).toFixed(1)} s`
}

export default function Investigations() {
  const { t } = useTranslation()
  const tr = (key: string, fallback: string, opts?: Record<string, unknown>) => t(key, { defaultValue: fallback, ...opts })
  const [params, setParams] = useSearchParams()
  const openId = params.get('id')
  const [status, setStatus] = useState('')
  const [cluster, setCluster] = useState('')
  const [applied, setApplied] = useState({ status: '', cluster: '' })
  const [page, setPage] = useState(1)
  const features = useClusterFeatures()

  const { data, isLoading, refetch, isFetching } = useQuery({
    queryKey: ['investigations', 'list', applied, page],
    queryFn: () => api.listInvestigations({ ...applied, limit: PAGE_SIZE, offset: (page - 1) * PAGE_SIZE }),
    // while something is queued or running, follow it
    refetchInterval: (q) => ((q.state.data?.items ?? []).some((r) => r.status === 'queued' || r.status === 'running') ? 5_000 : 30_000),
  })
  const rows = data?.items ?? []
  const total = data?.total ?? 0
  const first = (page - 1) * PAGE_SIZE + 1

  const open = (id: string | null) => {
    const next = new URLSearchParams(params)
    if (id) next.set('id', id)
    else next.delete('id')
    setParams(next, { replace: true })
  }

  const statusTitle = (r: InvestigationSummary) =>
    r.status === 'skipped' ? tr('investigations.skipReason', 'Skipped: {{reason}}', { reason: r.skip_reason }) : undefined

  useAIContext(data ? {
    summary: `알림 조사 보고서 ${total}건${applied.status ? ` (상태 ${applied.status})` : ''}${applied.cluster ? ` (클러스터 ${applied.cluster})` : ''}`,
    data: {
      filters: { status: applied.status || undefined, cluster: applied.cluster || undefined, page },
      items: rows.map((r) => ({
        alertname: r.alertname, cluster: r.cluster, namespace: r.namespace, severity: r.severity, status: r.status,
        skip_reason: r.skip_reason || undefined, received_at: r.received_at, repeat_count: r.repeat_count,
        tool_call_count: r.tool_call_count, total_tokens: r.total_tokens,
      })),
    },
  } : null, [data, total, applied, page, rows])

  return (
    <div className="page-scrolls space-y-6">
      <div className="flex items-start justify-between gap-3">
        <div className="flex items-center gap-3">
          <div className="p-2 bg-primary-600/20 rounded-lg">
            <Siren className="w-6 h-6 text-primary-400" />
          </div>
          <div>
            <h1 className="text-3xl font-bold text-white">{tr('investigations.title', 'Investigations')}</h1>
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
              value={status}
              onChange={setStatus}
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
              placeholder={tr('investigations.filter.clusterPlaceholder', 'cluster ID')}
              className="w-48 h-10 rounded-lg border border-slate-700 bg-slate-950/60 px-3 text-sm text-white"
              data-testid="investigations-cluster-filter"
            />
          </div>
          <button
            type="button"
            onClick={() => {
              setApplied({ status, cluster: cluster.trim() })
              setPage(1)
            }}
            className="h-10 rounded-lg bg-primary-600 px-3 text-sm font-medium text-white hover:bg-primary-500"
            data-testid="investigations-search"
          >
            {tr('investigations.filter.apply', 'Search')}
          </button>
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
              ? tr('investigations.range', '{{from}}–{{to}} of {{total}}', { from: first, to: first + rows.length - 1, total })
              : tr('common.paginationEmpty', 'Showing 0 of 0')}
          </div>
          <div className="flex items-center gap-2">
            <button type="button" onClick={() => setPage((p) => Math.max(1, p - 1))} disabled={page <= 1} className="px-3 py-1.5 text-xs rounded-sm border border-slate-600 text-slate-300 disabled:opacity-40 disabled:cursor-not-allowed hover:text-white hover:border-slate-500">
              {tr('common.prev', 'Prev')}
            </button>
            <span className="text-xs text-slate-300 min-w-[48px] text-center">{page}</span>
            <button type="button" onClick={() => setPage((p) => p + 1)} disabled={first + rows.length - 1 >= total} className="px-3 py-1.5 text-xs rounded-sm border border-slate-600 text-slate-300 disabled:opacity-40 disabled:cursor-not-allowed hover:text-white hover:border-slate-500">
              {tr('common.next', 'Next')}
            </button>
          </div>
        </div>
      </div>

      {openId && <InvestigationModal id={openId} onClose={() => open(null)} />}
    </div>
  )
}

function InvestigationModal({ id, onClose }: { id: string; onClose: () => void }) {
  const { t } = useTranslation()
  const tr = (key: string, fallback: string, opts?: Record<string, unknown>) => t(key, { defaultValue: fallback, ...opts })
  // no retry: a 403/404/503 is the answer, and every fetch writes an audit row
  const { data, isLoading, error } = useQuery<Investigation>({
    queryKey: ['investigations', 'one', id],
    queryFn: () => api.getInvestigation(id),
    retry: false,
    staleTime: Infinity,
  })
  useAIContext(data ? {
    source: 'InvestigationModal',
    summary: `알림 조사 보고서 — ${data.alertname} (${data.cluster}${data.namespace ? ` / ${data.namespace}` : ''}, ${data.status})`,
    data: {
      alertname: data.alertname, cluster: data.cluster, namespace: data.namespace, severity: data.severity, status: data.status,
      labels: data.labels, received_at: data.received_at, model: data.model, iterations: data.iterations,
      tool_calls: data.tool_calls.map((c) => ({ tool: c.tool, args: c.args, error: c.error })),
      error: data.error || undefined, report: data.report.slice(0, 4096),
    },
  } : null, [data])

  return (
    <ModalFrame
      title={data ? data.alertname || id : tr('investigations.report', 'Report')}
      subtitle={data ? `${data.cluster}${data.namespace ? ' / ' + data.namespace : ''} · ${formatWhen(data.received_at)}` : undefined}
      icon={<Siren className="w-5 h-5 text-primary-400" />}
      size="lg"
      body="scroll"
      onClose={onClose}
      testId="investigation-modal"
      footer={
        <button type="button" onClick={onClose} className="btn btn-secondary">
          {tr('common.close', 'Close')}
        </button>
      }
    >
      {isLoading && <div className="py-6 text-center text-slate-500">{tr('investigations.loading', 'Loading…')}</div>}
      {error && (
        <div className="rounded-lg border border-red-800/60 bg-red-900/20 px-3 py-2 text-sm text-red-200" data-testid="investigation-error">
          {tr('investigations.loadFailed', 'The report could not be opened.')}
        </div>
      )}
      {data && (
        <div className="space-y-5">
          <div className="flex flex-wrap gap-x-6 gap-y-1 text-xs text-slate-400" data-testid="investigation-meta">
            <span>{tr('investigations.meta.status', 'Status')}: <span className={`rounded-sm border px-1.5 py-0.5 ${statusClass[data.status] ?? ''}`}>{tr(`investigations.status.${data.status}`, data.status)}</span></span>
            <span>{tr('investigations.meta.severity', 'Severity')}: <span className={severityClass[data.severity] ?? 'text-slate-300'}>{data.severity || '-'}</span></span>
            {data.model && <span>{tr('investigations.meta.model', 'Model')}: <span className="text-slate-300">{data.model}</span></span>}
            <span>{tr('investigations.meta.tokens', 'Tokens')}: <span className="text-slate-300">{data.prompt_tokens ?? '-'} + {data.completion_tokens ?? '-'}</span></span>
            <span>{tr('investigations.meta.steps', 'Model calls')}: <span className="text-slate-300">{data.iterations}</span></span>
            <span>{tr('investigations.meta.duration', 'Duration')}: <span className="text-slate-300">{duration(data.duration_ms)}</span></span>
            <span>{tr('investigations.meta.repeats', 'Repeats')}: <span className="text-slate-300">{data.repeat_count}</span></span>
          </div>

          {data.status === 'failed' && data.error && (
            <div className="rounded-lg border border-red-800/60 bg-red-900/20 px-3 py-2 text-sm text-red-200 break-words">{data.error}</div>
          )}
          {data.status === 'skipped' && (
            <div className="rounded-lg border border-amber-800/60 bg-amber-900/20 px-3 py-2 text-sm text-amber-200">
              {tr('investigations.skipReason', 'Skipped: {{reason}}', { reason: data.skip_reason })}
            </div>
          )}

          {data.report && (
            <section>
              <h3 className="mb-2 text-xs font-semibold uppercase tracking-wider text-slate-400">{tr('investigations.section.report', 'Report')}</h3>
              <div className="prose prose-invert prose-sm max-w-none rounded-lg border border-slate-700 bg-slate-950/40 px-4 py-3" data-testid="investigation-report">
                <ReactMarkdown remarkPlugins={[remarkGfm]}>{data.report}</ReactMarkdown>
              </div>
            </section>
          )}

          <section>
            <h3 className="mb-2 text-xs font-semibold uppercase tracking-wider text-slate-400">{tr('investigations.section.alert', 'Alert')}</h3>
            <div className="grid gap-3 md:grid-cols-2">
              <dl className="rounded-lg border border-slate-700 bg-slate-950/40 px-3 py-2 text-xs">
                {Object.entries(data.labels).map(([k, v]) => (
                  <div key={k} className="flex gap-2 py-0.5"><dt className="min-w-[110px] text-slate-500">{k}</dt><dd className="break-all font-mono text-slate-200">{v}</dd></div>
                ))}
              </dl>
              <dl className="rounded-lg border border-slate-700 bg-slate-950/40 px-3 py-2 text-xs">
                {Object.entries(data.annotations).map(([k, v]) => (
                  <div key={k} className="flex gap-2 py-0.5"><dt className="min-w-[110px] text-slate-500">{k}</dt><dd className="break-words text-slate-200">{v}</dd></div>
                ))}
                {Object.keys(data.annotations).length === 0 && <div className="text-slate-500">{tr('investigations.noAnnotations', 'No annotations')}</div>}
              </dl>
            </div>
            <div className="mt-2 flex flex-wrap gap-4 text-xs">
              {data.generator_url && (
                <a href={data.generator_url} target="_blank" rel="noreferrer noopener" className="inline-flex items-center gap-1 text-primary-300 hover:underline">
                  <ExternalLink className="w-3.5 h-3.5" /> {tr('investigations.link.source', 'Source query')}
                </a>
              )}
              {data.alertmanager_url && (
                <a href={data.alertmanager_url} target="_blank" rel="noreferrer noopener" className="inline-flex items-center gap-1 text-primary-300 hover:underline">
                  <ExternalLink className="w-3.5 h-3.5" /> {tr('investigations.link.sender', 'Alert sender')}
                </a>
              )}
            </div>
          </section>

          <section>
            <h3 className="mb-2 text-xs font-semibold uppercase tracking-wider text-slate-400">
              {tr('investigations.section.tools', 'Tool calls ({{count}})', { count: data.tool_calls.length })}
            </h3>
            {data.tool_calls.length === 0 ? (
              <div className="text-xs text-slate-500">{tr('investigations.noTools', 'The model answered without calling a tool.')}</div>
            ) : (
              <table className="w-full text-xs" data-testid="investigation-tools">
                <thead className="text-slate-500">
                  <tr>
                    <th className="px-2 py-1 text-left">#</th>
                    <th className="px-2 py-1 text-left">{tr('investigations.tool.name', 'Tool')}</th>
                    <th className="px-2 py-1 text-left">{tr('investigations.tool.args', 'Arguments')}</th>
                    <th className="px-2 py-1 text-right">{tr('investigations.tool.result', 'Result')}</th>
                  </tr>
                </thead>
                <tbody>
                  {data.tool_calls.map((c, i) => (
                    <tr key={i} className="border-t border-slate-800">
                      <td className="px-2 py-1 text-slate-500">{c.step}</td>
                      <td className="px-2 py-1 font-mono text-slate-200">{c.tool}</td>
                      <td className="px-2 py-1 font-mono text-slate-400"><span className="block max-w-[420px] truncate" title={JSON.stringify(c.args)}>{JSON.stringify(c.args)}</span></td>
                      <td className={`px-2 py-1 text-right whitespace-nowrap ${c.error ? 'text-red-300' : 'text-slate-400'}`} title={c.error || undefined}>
                        {c.error ? tr('investigations.tool.error', 'refused') : tr('investigations.tool.chars', '{{n}} chars', { n: c.result_chars ?? 0 })}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </section>
        </div>
      )}
    </ModalFrame>
  )
}
