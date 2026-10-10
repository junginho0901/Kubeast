import { useEffect, useMemo, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useTranslation } from 'react-i18next'
import { AlertTriangle, Download, History, Loader2, RefreshCw, ShieldCheck, X } from 'lucide-react'

import CustomDropdown from '@/components/CustomDropdown'
import { api, clustersApi } from '@/services/api'
import type { HygieneFinding, HygieneReport, HygieneReview, HygieneSeverity } from '@/services/api/hygiene'
import { getCurrentClusterID } from '@/services/clusterRef'
import { formatWhen } from './accessRequestFormat'

// Admin → Cluster hygiene: configuration risks of one cluster (Pod Security
// Standards, image tags, resources, namespace policy, service account tokens,
// RBAC, TLS expiry) read as the signed-in user, with CSV/JSON export and the
// monthly sign-off. A past sign-off opens as the report it stored.

type Tab = 'findings' | 'checks' | 'history'
type SeverityFilter = 'all' | HygieneSeverity | 'exempt'

const SEVERITY_TONE: Record<HygieneSeverity, string> = {
  critical: 'bg-red-500/20 text-red-300',
  warning: 'bg-yellow-500/20 text-yellow-300',
  info: 'bg-blue-500/20 text-blue-300',
}

export default function ClusterHygiene() {
  const { t } = useTranslation()
  const tr = (key: string, fallback: string, opts?: Record<string, unknown>) => t(key, { defaultValue: fallback, ...opts })
  const queryClient = useQueryClient()
  const [cluster, setCluster] = useState('')
  const [tab, setTab] = useState<Tab>('findings')
  const [severity, setSeverity] = useState<SeverityFilter>('all')
  const [check, setCheck] = useState('all')
  const [search, setSearch] = useState('')
  const [note, setNote] = useState('')
  const [message, setMessage] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [viewId, setViewId] = useState<string | null>(null)

  const { data: clusters = [] } = useQuery({ queryKey: ['clusters', 'all'], queryFn: () => clustersApi.listClusters() })
  useEffect(() => {
    if (cluster || clusters.length === 0) return
    const current = getCurrentClusterID()
    setCluster(clusters.some((c) => c.id === current) ? current : clusters[0].id)
  }, [clusters, cluster])

  const { data: live, isLoading, isFetching, refetch, error: reportError } = useQuery({
    queryKey: ['hygiene', cluster, 'report'],
    queryFn: () => api.getHygiene(cluster),
    enabled: !!cluster,
    retry: false,
  })
  const { data: history = [], isLoading: historyLoading } = useQuery({
    queryKey: ['hygiene', cluster, 'history'],
    queryFn: () => api.listHygieneReviews(cluster),
    enabled: !!cluster && (tab === 'history' || !!viewId),
  })
  const { data: viewed } = useQuery({
    queryKey: ['hygiene', cluster, 'snapshot', viewId],
    queryFn: () => api.getHygieneSnapshot(cluster, viewId as string),
    enabled: !!cluster && !!viewId,
  })
  const signoff = useMutation({
    mutationFn: () => api.signoffHygiene(cluster, note),
    onSuccess: (rev: HygieneReview) => {
      setNote('')
      setError(null)
      setMessage(tr('clusterHygiene.signoff.saved', 'Signed off at {{when}}.', { when: formatWhen(rev.reviewed_at) }))
      queryClient.invalidateQueries({ queryKey: ['hygiene', cluster] })
    },
    onError: (err: any) => setError(err?.response?.data?.detail || tr('clusterHygiene.signoff.failed', 'The sign-off was not saved.')),
  })

  const report: HygieneReport | undefined = viewId ? viewed?.snapshot?.report : live?.report
  const checkTitle = (id: string) => tr(`clusterHygiene.checks.${id}`, id)
  const severityLabel = (s: HygieneSeverity) => tr(`clusterHygiene.severity.${s}`, s)

  const findings = useMemo(() => {
    if (!report) return []
    const q = search.trim().toLowerCase()
    return report.findings.filter((f: HygieneFinding) => {
      if (severity === 'exempt' ? !f.exempt : severity !== 'all' && (f.exempt || f.severity !== severity)) return false
      if (check !== 'all' && f.check !== check) return false
      if (!q) return true
      return [f.namespace, f.kind, f.name, f.container, f.message, f.exempt_reason].join(' ').toLowerCase().includes(q)
    })
  }, [report, severity, check, search])

  const download = (format: 'csv' | 'json') => {
    const a = document.createElement('a')
    a.href = api.hygieneExportUrl(cluster, format)
    a.download = ''
    document.body.appendChild(a)
    a.click()
    a.remove()
  }

  const clusterOptions = clusters.map((c) => ({ value: c.id, label: c.display_name || c.id, testId: `hygiene-cluster-opt-${c.id}` }))
  const severityOptions = (['all', 'critical', 'warning', 'info', 'exempt'] as SeverityFilter[]).map((s) => ({
    value: s,
    label: s === 'all' ? tr('clusterHygiene.filter.allSeverities', 'All severities') : s === 'exempt' ? tr('clusterHygiene.exempt', 'Exempt') : severityLabel(s),
  }))
  const checkOptions = [
    { value: 'all', label: tr('clusterHygiene.filter.allChecks', 'All checks') },
    ...(report?.checks ?? []).map((c) => ({ value: c.id, label: `${checkTitle(c.id)} (${c.findings})` })),
  ]
  const counts = report?.counts
  const tabClass = (active: boolean) =>
    `rounded-sm px-3 py-1.5 text-sm flex items-center gap-1 ${active ? 'bg-primary-600 text-white' : 'bg-slate-700 hover:bg-slate-600 text-slate-200'}`
  const badge = (f: { severity: HygieneSeverity; exempt?: boolean }) => (
    <span className={`inline-flex rounded-sm px-1.5 py-0.5 text-[11px] font-medium whitespace-nowrap ${f.exempt ? 'bg-slate-700 text-slate-300' : SEVERITY_TONE[f.severity]}`}>
      {f.exempt ? tr('clusterHygiene.exempt', 'Exempt') : severityLabel(f.severity)}
    </span>
  )

  return (
    <div className="space-y-4">
      <div className="flex items-start justify-between gap-4">
        <div>
          <div className="flex items-center gap-2">
            <ShieldCheck className="w-6 h-6 text-primary-400" />
            <h1 className="text-3xl font-bold text-white">{tr('clusterHygiene.title', 'Cluster hygiene')}</h1>
          </div>
          <p className="text-slate-400 text-sm mt-1">
            {tr('clusterHygiene.subtitle', 'Configuration risks read from the cluster as you: Pod Security Standards, image tags, resources, namespace policy, ServiceAccount tokens, RBAC and TLS expiry. Review, export, sign off.')}
          </p>
        </div>
        <div className="flex items-end gap-2">
          <div className="w-56">
            <label className="block text-xs font-semibold text-slate-400 mb-1">{tr('clusterHygiene.cluster', 'Cluster')}</label>
            <CustomDropdown
              options={clusterOptions}
              value={cluster}
              onChange={(v) => { setCluster(v); setViewId(null); setMessage(null) }}
              testId="hygiene-cluster"
            />
          </div>
          <button
            onClick={() => refetch()}
            disabled={isFetching || !!viewId || !cluster}
            className="h-10 rounded-sm bg-slate-700 hover:bg-slate-600 disabled:opacity-50 px-3 text-sm text-white flex items-center gap-2 whitespace-nowrap"
          >
            <RefreshCw className={`w-4 h-4 ${isFetching ? 'animate-spin' : ''}`} />
            {tr('clusterHygiene.refresh', 'Scan again')}
          </button>
        </div>
      </div>

      {viewId && viewed && (
        <div className="rounded-lg border border-blue-500/40 bg-blue-500/10 p-3 text-sm text-blue-100 flex items-center justify-between gap-3" data-testid="hygiene-snapshot-banner">
          <span>
            <History className="inline w-4 h-4 mr-1" />
            {tr('clusterHygiene.snapshot.viewing', 'Viewing the report as signed off on {{when}} by {{who}}.', { when: formatWhen(viewed.reviewed_at), who: viewed.reviewed_by_email })}
            {viewed.note && <span className="text-blue-200/80"> · {viewed.note}</span>}
          </span>
          <button onClick={() => setViewId(null)} className="rounded-sm bg-slate-700 hover:bg-slate-600 px-2 py-1 text-xs text-white flex items-center gap-1">
            <X className="w-3 h-3" /> {tr('clusterHygiene.snapshot.back', 'Back to now')}
          </button>
        </div>
      )}

      {reportError && !report && (
        <div className="rounded-lg border border-red-500/40 bg-red-500/10 p-3 text-sm text-red-200" data-testid="hygiene-error">
          {(reportError as any)?.response?.data?.detail || (reportError as Error).message}
        </div>
      )}

      {counts && (
        <div className="grid grid-cols-2 md:grid-cols-4 gap-3" data-testid="hygiene-summary">
          {(['critical', 'warning', 'info', 'exempt'] as const).map((key) => (
            <button
              key={key}
              onClick={() => { setTab('findings'); setSeverity(key) }}
              className="text-left rounded-lg bg-slate-800/50 border border-slate-700 p-3 hover:border-slate-500"
              data-testid={`hygiene-card-${key}`}
            >
              <div className="text-xs text-slate-400">{key === 'exempt' ? tr('clusterHygiene.exempt', 'Exempt') : severityLabel(key)}</div>
              <div className={`text-2xl font-semibold ${key === 'critical' && counts[key] > 0 ? 'text-red-300' : key === 'warning' && counts[key] > 0 ? 'text-yellow-300' : 'text-white'}`}>{counts[key]}</div>
            </button>
          ))}
        </div>
      )}

      {report && (
        <div className="rounded-lg bg-slate-800/50 border border-slate-700 p-3 text-sm flex flex-wrap items-center gap-x-6 gap-y-1" data-testid="hygiene-last-review">
          {!viewId && live && (
            <>
              <span className="text-slate-300">
                {live.last_review
                  ? tr('clusterHygiene.lastReview', 'Last sign-off {{when}} by {{who}}', { when: formatWhen(live.last_review.reviewed_at), who: live.last_review.reviewed_by_email })
                  : tr('clusterHygiene.noReview', 'Not signed off yet')}
              </span>
              <span className={live.due ? 'text-red-300 font-medium' : 'text-slate-300'}>
                {live.next_due
                  ? tr(live.due ? 'clusterHygiene.overdue' : 'clusterHygiene.nextDue', live.due ? 'Overdue since {{when}}' : 'Next due {{when}}', { when: formatWhen(live.next_due) })
                  : tr('clusterHygiene.intervalHint', 'A sign-off is due every {{days}} days.', { days: live.interval_days })}
                {live.due && live.next_due && <AlertTriangle className="inline w-4 h-4 ml-1" />}
              </span>
            </>
          )}
          <span className="text-slate-500">
            {tr('clusterHygiene.generatedAt', 'Scanned {{when}}; not checked: {{namespaces}}.', {
              when: formatWhen(report.generated_at),
              namespaces: report.excluded_namespaces.length ? report.excluded_namespaces.join(', ') : '-',
            })}
          </span>
        </div>
      )}

      {report && report.collectors.length > 0 && (
        <div className="rounded-lg border border-yellow-500/40 bg-yellow-500/10 p-3 text-sm text-yellow-100" data-testid="hygiene-collectors">
          <div className="font-medium mb-1">{tr('clusterHygiene.collectors', 'Could not read these lists, so their checks were skipped:')}</div>
          <ul className="list-disc pl-5 space-y-0.5">
            {report.collectors.map((c) => <li key={c.what}><span className="font-mono">{c.what}</span> — {c.error}</li>)}
          </ul>
        </div>
      )}

      <div className="flex flex-wrap items-center gap-2">
        <button onClick={() => setTab('findings')} className={tabClass(tab === 'findings')} data-testid="hygiene-tab-findings">
          {tr('clusterHygiene.tab.findings', 'Findings')} {report ? <span className="text-xs opacity-70">({report.findings.length})</span> : null}
        </button>
        <button onClick={() => setTab('checks')} className={tabClass(tab === 'checks')} data-testid="hygiene-tab-checks">
          {tr('clusterHygiene.tab.checks', 'Checks')}
        </button>
        <button onClick={() => setTab('history')} className={tabClass(tab === 'history')} data-testid="hygiene-tab-history">
          <History className="w-4 h-4" /> {tr('clusterHygiene.tab.history', 'Past sign-offs')}
        </button>
        {!viewId && (
          <div className="ml-auto flex items-center gap-2">
            <button onClick={() => download('csv')} disabled={!live} data-testid="hygiene-export-csv"
              className="h-9 rounded-sm bg-slate-700 hover:bg-slate-600 disabled:opacity-50 px-3 text-sm text-white flex items-center gap-2">
              <Download className="w-4 h-4" /> CSV
            </button>
            <button onClick={() => download('json')} disabled={!live} data-testid="hygiene-export-json"
              className="h-9 rounded-sm bg-slate-700 hover:bg-slate-600 disabled:opacity-50 px-3 text-sm text-white flex items-center gap-2">
              <Download className="w-4 h-4" /> JSON
            </button>
          </div>
        )}
      </div>

      {tab === 'findings' && (
        <>
          <div className="flex flex-wrap items-end gap-2">
            <div className="w-44">
              <CustomDropdown options={severityOptions} value={severity} onChange={(v) => setSeverity(v as SeverityFilter)} testId="hygiene-filter-severity" />
            </div>
            <div className="w-72">
              <CustomDropdown options={checkOptions} value={check} onChange={setCheck} testId="hygiene-filter-check" />
            </div>
            <input
              type="text"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder={tr('clusterHygiene.search', 'Search Namespace, name, message...')}
              className="h-10 px-3 bg-slate-700 text-white rounded-sm border border-slate-600 focus:outline-hidden focus:border-primary-500 text-sm flex-1 min-w-48"
            />
          </div>
          <div className="rounded-lg bg-slate-800/50 border border-slate-700 overflow-x-auto">
            {isLoading || (viewId && !viewed) ? (
              <div className="p-6 text-slate-400 flex items-center gap-2"><Loader2 className="w-4 h-4 animate-spin" /> {tr('clusterHygiene.scanning', 'Scanning...')}</div>
            ) : findings.length === 0 ? (
              <div className="p-6 text-slate-400">{tr('clusterHygiene.empty', 'Nothing to show.')}</div>
            ) : (
              <table className="min-w-full text-sm" data-testid="hygiene-findings-table">
                <thead className="text-xs text-slate-400">
                  <tr className="whitespace-nowrap">
                    <th className="px-3 py-2 text-left font-medium">{tr('clusterHygiene.col.severity', 'Severity')}</th>
                    <th className="px-3 py-2 text-left font-medium">{tr('clusterHygiene.col.check', 'Check')}</th>
                    <th className="px-3 py-2 text-left font-medium">Namespace</th>
                    <th className="px-3 py-2 text-left font-medium">{tr('clusterHygiene.col.object', 'Object')}</th>
                    <th className="px-3 py-2 text-left font-medium">{tr('clusterHygiene.col.message', 'Details')}</th>
                  </tr>
                </thead>
                <tbody>
                  {findings.map((f, i) => (
                    <tr key={`${f.check}-${f.kind}-${f.namespace}-${f.name}-${f.container}-${i}`} className="border-t border-slate-700/60 text-slate-300 align-top" data-testid="hygiene-finding-row">
                      <td className="px-3 py-2">{badge(f)}</td>
                      <td className="px-3 py-2 whitespace-nowrap">{checkTitle(f.check)}</td>
                      <td className="px-3 py-2">{f.namespace || '-'}</td>
                      <td className="px-3 py-2">
                        <span className="text-white">{f.kind}/{f.name}</span>
                        {f.container && <span className="text-slate-400"> · {f.container}</span>}
                        {f.pods && f.pods > 1 ? <span className="text-slate-500"> · {tr('clusterHygiene.pods', '{{count}} Pods', { count: f.pods })}</span> : null}
                      </td>
                      <td className="px-3 py-2">
                        <span className="break-all">{f.message}</span>
                        {f.exempt && f.exempt_reason && <div className="text-xs text-slate-400 mt-0.5">{tr('clusterHygiene.exemptReason', 'Exempt: {{reason}}', { reason: f.exempt_reason })}</div>}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
            {report?.truncated && <div className="p-3 text-xs text-yellow-300">{tr('clusterHygiene.truncated', 'Only the first 5000 findings are shown; the counts include all of them.')}</div>}
          </div>
        </>
      )}

      {tab === 'checks' && report && (
        <div className="rounded-lg bg-slate-800/50 border border-slate-700 overflow-x-auto">
          <table className="min-w-full text-sm" data-testid="hygiene-checks-table">
            <thead className="text-xs text-slate-400">
              <tr className="whitespace-nowrap">
                <th className="px-3 py-2 text-left font-medium">{tr('clusterHygiene.col.check', 'Check')}</th>
                <th className="px-3 py-2 text-left font-medium">{tr('clusterHygiene.col.severity', 'Severity')}</th>
                <th className="px-3 py-2 text-right font-medium">{tr('clusterHygiene.col.findings', 'Findings')}</th>
                <th className="px-3 py-2 text-right font-medium">{tr('clusterHygiene.exempt', 'Exempt')}</th>
                <th className="px-3 py-2 text-left font-medium">{tr('clusterHygiene.col.refs', 'Basis')}</th>
              </tr>
            </thead>
            <tbody>
              {report.checks.map((c) => (
                <tr key={c.id} className="border-t border-slate-700/60 text-slate-300" data-testid="hygiene-check-row">
                  <td className="px-3 py-2">
                    <button onClick={() => { setCheck(c.id); setSeverity('all'); setTab('findings') }} className="text-white hover:text-primary-300 text-left">{checkTitle(c.id)}</button>
                    <div className="text-[11px] font-mono text-slate-500">{c.id}</div>
                  </td>
                  <td className="px-3 py-2">{badge({ severity: c.severity })}</td>
                  <td className="px-3 py-2 text-right">{c.findings}</td>
                  <td className="px-3 py-2 text-right">{c.exempt}</td>
                  <td className="px-3 py-2 text-xs text-slate-400">{c.refs}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {tab === 'history' && (
        <div className="rounded-lg bg-slate-800/50 border border-slate-700 overflow-x-auto">
          {historyLoading ? (
            <div className="p-6 text-slate-400 flex items-center gap-2"><Loader2 className="w-4 h-4 animate-spin" /> {tr('clusterHygiene.loading', 'Loading...')}</div>
          ) : history.length === 0 ? (
            <div className="p-6 text-slate-400">{tr('clusterHygiene.noHistory', 'This cluster has not been signed off yet.')}</div>
          ) : (
            <table className="min-w-full text-sm">
              <thead className="text-xs text-slate-400">
                <tr>
                  <th className="px-3 py-2 text-left">{tr('clusterHygiene.col.reviewedAt', 'Signed off')}</th>
                  <th className="px-3 py-2 text-left">{tr('clusterHygiene.col.reviewedBy', 'By')}</th>
                  <th className="px-3 py-2 text-left">{tr('clusterHygiene.col.note', 'Note')}</th>
                  <th className="px-3 py-2 text-left">{tr('clusterHygiene.col.counts', 'Critical / warning / info / exempt')}</th>
                  <th className="px-3 py-2" />
                </tr>
              </thead>
              <tbody>
                {history.map((h) => (
                  <tr key={h.id} className="border-t border-slate-700/60 text-slate-300" data-testid="hygiene-history-row">
                    <td className="px-3 py-2 whitespace-nowrap text-white">{formatWhen(h.reviewed_at)}</td>
                    <td className="px-3 py-2">{h.reviewed_by_email}</td>
                    <td className="px-3 py-2">{h.note || '-'}</td>
                    <td className="px-3 py-2 whitespace-nowrap">{h.counts?.critical ?? '-'} / {h.counts?.warning ?? '-'} / {h.counts?.info ?? '-'} / {h.counts?.exempt ?? '-'}</td>
                    <td className="px-3 py-2 text-right">
                      <button onClick={() => { setViewId(h.id); setTab('findings') }} className="rounded-sm bg-slate-700 hover:bg-slate-600 px-2 py-1 text-xs text-white">
                        {tr('clusterHygiene.open', 'Open')}
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      )}

      {!viewId && (
        <div className="rounded-lg bg-slate-800/50 border border-slate-700 p-4 space-y-2" data-testid="hygiene-signoff-panel">
          <div className="text-sm font-medium text-white">{tr('clusterHygiene.signoff.title', 'Sign off this cluster')}</div>
          <p className="text-xs text-slate-400">
            {tr('clusterHygiene.signoff.hint', 'Stores the report as it stands with your name, the time and your note. Fix or exempt findings first (annotations kubeast.io/hygiene-exempt and kubeast.io/hygiene-exempt-reason).')}
          </p>
          <textarea
            value={note}
            onChange={(e) => setNote(e.target.value)}
            maxLength={2000}
            rows={2}
            placeholder={tr('clusterHygiene.signoff.notePlaceholder', 'Findings and actions taken (optional)')}
            data-testid="hygiene-signoff-note"
            className="w-full px-3 py-2 bg-slate-700 text-white rounded-sm border border-slate-600 focus:outline-hidden focus:border-primary-500 text-sm"
          />
          <div className="flex items-center gap-3">
            <button
              onClick={() => signoff.mutate()}
              disabled={signoff.isPending || !live}
              data-testid="hygiene-signoff"
              className="rounded-sm bg-primary-600 hover:bg-primary-500 disabled:opacity-50 px-3 py-1.5 text-sm text-white flex items-center gap-2"
            >
              {signoff.isPending ? <Loader2 className="w-4 h-4 animate-spin" /> : <ShieldCheck className="w-4 h-4" />}
              {tr('clusterHygiene.signoff.button', 'Sign off')}
            </button>
            {message && <span className="text-sm text-green-300" data-testid="hygiene-signoff-message">{message}</span>}
            {error && <span className="text-sm text-red-300">{error}</span>}
          </div>
        </div>
      )}
    </div>
  )
}
