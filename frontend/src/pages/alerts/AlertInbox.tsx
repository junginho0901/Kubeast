import { useEffect, useState } from 'react'
import { useSearchParams } from 'react-router-dom'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useTranslation } from 'react-i18next'
import { BellOff, BellRing, Check, ExternalLink, FileSearch, Loader2, RefreshCw, UserCheck } from 'lucide-react'

import { api } from '@/services/api'
import type { AlertInboxDetail, AlertInboxItem, AlertInboxMarks } from '@/services/api/alertInbox'
import { useCluster } from '@/contexts/ClusterContext'
import { useClusterFeatures } from '@/hooks/usePrometheusQuery'
import { useAIContext } from '@/hooks/useAIContext'
import { usePermission } from '@/hooks/usePermission'
import { useAdaptiveTable } from '@/hooks/useAdaptiveTable'
import { useResourceDetail } from '@/components/ResourceDetailContext'
import CustomDropdown from '@/components/CustomDropdown'
import { ModalFrame } from '@/components/ModalFrame'
import { ListPager } from '@/components/ListPager'
import { TableEmptyRow } from '@/components/TableEmptyRow'
import { AdaptiveTableFillerRows } from '@/components/AdaptiveTableFillerRows'
import InvestigationReportModal from '@/components/InvestigationReportModal'
import SilenceList from './SilenceList'
import SilenceModal from './SilenceModal'
import { alertInvestigationEnabled } from '@/utils/features'
import { alertResource, liveStateOf, silenceStart, type LiveState } from '@/utils/alertInbox'
import { severityClass, statusClass as investigationClass } from '@/utils/investigationFormat'
import { formatAge, formatTime, utcTitle } from '@/utils/time'

// Alerts: every alert Alertmanager sent for the selected cluster (features.alertInvestigation's webhook), firing or
// resolved, for whoever reads the cluster as a whole. Resolving is the alert rule's: the marks here (acknowledged,
// assignee, note, done) are Kubeast's own and audited server-side. With an alert store for the cluster
// (features.alertStore), a firing alert also shows what Alertmanager says now.

const COLUMNS = 8

const statusClass: Record<string, string> = {
  firing: 'bg-red-900/40 text-red-300 border-red-800/60',
  stale: 'bg-amber-900/40 text-amber-300 border-amber-800/60',
  resolved: 'bg-emerald-900/40 text-emerald-300 border-emerald-800/60',
}

const liveClass: Record<LiveState, string> = {
  firing: 'text-red-300',
  silenced: 'text-slate-300',
  inhibited: 'text-slate-300',
  absent: 'text-amber-300',
}

export default function AlertInbox() {
  const { t } = useTranslation()
  const tr = (key: string, fallback: string, opts?: Record<string, unknown>) => t(key, { defaultValue: fallback, ...opts })
  const [params, setParams] = useSearchParams()
  const openId = params.get('alert')
  const { currentCluster } = useCluster()
  const features = useClusterFeatures()
  const { open: openDetail } = useResourceDetail()
  const { has } = usePermission()
  const [status, setStatus] = useState('')
  const [showSilences, setShowSilences] = useState(false)
  const [severity, setSeverity] = useState('')
  const [mine, setMine] = useState(false)
  const [openOnly, setOpenOnly] = useState(false)
  const [page, setPage] = useState(1)
  const { containerRef, bodyRef, theadRef, firstRowRef, rowsPerPage } = useAdaptiveTable({ recalculationKey: status })

  const filter = { status, severity, mine, open: openOnly, limit: rowsPerPage, offset: (page - 1) * rowsPerPage }
  const { data, isLoading, isFetching, error, refetch } = useQuery({
    queryKey: ['alert-inbox', 'list', currentCluster, filter],
    queryFn: () => api.listAlertInbox(filter),
    refetchInterval: 30_000,
    retry: false,
  })
  const storeOn = !!currentCluster && !!features.data?.alertStore?.enabled && (features.data.alertStore.clusters ?? []).includes(currentCluster)
  // making and ending silences: the store takes writes (features.alertStore.silences) and the user holds resource.alert.silence
  const silenceWith = storeOn && features.data?.alertStore?.silences && has('resource.alert.silence')
    ? { maxHours: features.data.alertStore.silenceMaxHours ?? 168, clusterLabel: features.data.alertStore.clusterLabel ?? 'cluster' }
    : undefined
  const { data: store } = useQuery({
    queryKey: ['alert-inbox', 'store', currentCluster],
    queryFn: api.listAlertStoreAlerts,
    enabled: storeOn,
    refetchInterval: 60_000,
    retry: false,
  })
  const rows = data?.items ?? []
  const total = data?.total ?? 0
  const counts = data?.counts ?? { firing: 0, stale: 0, resolved: 0 }
  const totalPages = Math.max(1, Math.ceil(total / rowsPerPage))
  const forbidden = (error as { response?: { status?: number } } | null)?.response?.status === 403

  useEffect(() => setPage(1), [status, severity, mine, openOnly, currentCluster])

  const open = (id: string | null) => {
    const next = new URLSearchParams(params)
    if (id) next.set('alert', id)
    else next.delete('alert')
    setParams(next, { replace: true })
  }

  useAIContext(data ? {
    summary: `알림 ${total}건 (울리는 중 ${counts.firing}, 상태 확인 안 됨 ${counts.stale}, 해결됨 ${counts.resolved})${status ? ` — ${status}만` : ''}`,
    data: {
      cluster: currentCluster,
      filters: { status: status || undefined, severity: severity || undefined, mine: mine || undefined, open: openOnly || undefined, page },
      counts,
      items: rows.map((r) => ({
        alertname: r.alertname, severity: r.severity, namespace: r.namespace || undefined, status: r.status,
        live: liveStateOf(r, store) ?? undefined, summary: r.summary || undefined, starts_at: r.starts_at,
        resolved_at: r.resolved_at ?? undefined, received_count: r.received_count, acknowledged: r.acknowledged || undefined,
        assignee: r.assignee || undefined, done: r.done || undefined, investigation: r.investigation?.status,
      })),
    },
  } : null, [data, store, status, severity, mine, openOnly, page, currentCluster])

  const statusLabel = (s: string) => tr(`alertInbox.status.${s}`, s)
  const tab = (value: string, label: string, count?: number) => (
    <button
      key={value || 'all'}
      type="button"
      onClick={() => { setStatus(value); setShowSilences(false) }}
      data-testid={`alert-tab-${value || 'all'}`}
      className={`h-10 rounded-lg border px-3 text-sm ${!showSilences && status === value ? 'border-primary-500 bg-primary-600/20 text-white' : 'border-slate-700 text-slate-300 hover:border-slate-500'}`}
    >
      {label}{count !== undefined && <span className="ml-2 text-xs text-slate-400">{count}</span>}
    </button>
  )

  return (
    <div className="flex flex-col h-[calc(100vh-4rem)] gap-4">
      <div className="flex items-start justify-between gap-3 shrink-0">
        <div>
          <h1 className="text-3xl font-bold text-white">{tr('alertInbox.title', 'Alerts')}</h1>
          <p className="mt-2 text-slate-400">
            {tr('alertInbox.subtitle', 'Every alert Alertmanager sent for this cluster, firing or resolved. The alert rule decides when it resolves; the marks here are kept in Kubeast.')}
          </p>
        </div>
        <button type="button" onClick={() => refetch()} className="btn btn-primary flex items-center gap-2">
          <RefreshCw className={`w-4 h-4 ${isFetching ? 'animate-spin' : ''}`} /> {tr('alertInbox.refresh', 'Refresh')}
        </button>
      </div>

      {features.data && !alertInvestigationEnabled(features.data) && (
        <div className="shrink-0 rounded-lg border border-amber-800/60 bg-amber-900/20 px-3 py-2 text-sm text-amber-200" data-testid="alert-inbox-disabled">
          {tr('alertInbox.disabled', 'The alert webhook is off on this installation (features.alertInvestigation.enabled), so no alerts come in.')}
        </div>
      )}
      {forbidden && (
        <div className="shrink-0 rounded-lg border border-amber-800/60 bg-amber-900/20 px-3 py-2 text-sm text-amber-200" data-testid="alert-inbox-forbidden">
          {tr('alertInbox.forbidden', 'Alerts cover the whole cluster: they are shown to users who can read this cluster without a namespace limit.')}
        </div>
      )}

      <div className="flex flex-wrap items-end gap-3 shrink-0">
        {tab('firing', statusLabel('firing'), counts.firing)}
        {tab('stale', statusLabel('stale'), counts.stale)}
        {tab('resolved', statusLabel('resolved'), counts.resolved)}
        {tab('', tr('alertInbox.status.all', 'All'), counts.firing + counts.stale + counts.resolved)}
        {storeOn && (
          <button
            type="button"
            onClick={() => setShowSilences(true)}
            data-testid="alert-tab-silences"
            className={`h-10 inline-flex items-center gap-1 rounded-lg border px-3 text-sm ${showSilences ? 'border-primary-500 bg-primary-600/20 text-white' : 'border-slate-700 text-slate-300 hover:border-slate-500'}`}
          >
            <BellOff className="w-4 h-4" /> {tr('alertInbox.silence.tab', 'Silences')}
          </button>
        )}
        <div className={`w-40 ${showSilences ? 'hidden' : ''}`}>
          <CustomDropdown
            label={tr('alertInbox.filter.severity', 'Severity')}
            value={severity}
            onChange={setSeverity}
            options={[
              { value: '', label: tr('alertInbox.status.all', 'All') },
              { value: 'critical', label: 'critical' },
              { value: 'warning', label: 'warning' },
              { value: 'info', label: 'info' },
            ]}
          />
        </div>
        <label className={`flex h-10 items-center gap-2 text-sm text-slate-300 ${showSilences ? 'hidden' : ''}`}>
          <input type="checkbox" checked={mine} onChange={(e) => setMine(e.target.checked)} data-testid="alert-filter-mine" />
          {tr('alertInbox.filter.mine', 'Assigned to me')}
        </label>
        <label className={`flex h-10 items-center gap-2 text-sm text-slate-300 ${showSilences ? 'hidden' : ''}`}>
          <input type="checkbox" checked={openOnly} onChange={(e) => setOpenOnly(e.target.checked)} data-testid="alert-filter-open" />
          {tr('alertInbox.filter.open', 'Not done')}
        </label>
      </div>

      {showSilences && <SilenceList canExpire={!!silenceWith} />}
      <div ref={containerRef} className={`card flex-1 min-h-0 flex flex-col ${showSilences ? 'hidden' : ''}`}>
        <div ref={bodyRef} className="overflow-x-auto flex-1 min-h-0">
          <table className="w-full text-sm min-w-[820px] table-fixed" data-testid="alert-inbox-table">
            <thead ref={theadRef} className="text-slate-400">
              <tr>
                <th className="text-left py-3 px-4 w-[140px]">{tr('alertInbox.col.status', 'Status')}</th>
                <th className="text-left py-3 px-4">{tr('alertInbox.col.alert', 'Alert')}</th>
                <th className="col-low text-left py-3 px-4 w-[130px]">{tr('alertInbox.col.namespace', 'Namespace')}</th>
                <th className="text-left py-3 px-4 w-[200px]">{tr('alertInbox.col.object', 'Object')}</th>
                <th className="text-left py-3 px-4 w-[90px]">{tr('alertInbox.col.started', 'Started')}</th>
                <th className="col-optional text-right py-3 px-4 w-[90px]">{tr('alertInbox.col.received', 'Received')}</th>
                <th className="col-optional text-left py-3 px-4 w-[110px]">{tr('alertInbox.col.investigation', 'AI investigation')}</th>
                <th className="text-left py-3 px-4 w-[170px]">{tr('alertInbox.col.handling', 'Handling')}</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-700">
              {rows.map((r, idx) => {
                const live = liveStateOf(r, store)
                const target = alertResource(r.labels)
                return (
                  <tr
                    key={r.id}
                    ref={idx === 0 ? firstRowRef : undefined}
                    className="text-slate-200 hover:bg-slate-800/60 cursor-pointer"
                    onClick={() => open(r.id)}
                    data-testid={`alert-row-${r.id}`}
                  >
                    <td className="py-3 px-4">
                      <span className={`inline-block whitespace-nowrap rounded-sm border px-2 py-0.5 text-xs ${statusClass[r.status] ?? ''}`} data-testid="alert-status">
                        {statusLabel(r.status)}
                      </span>
                      {live && live !== 'firing' && (
                        <span className={`block mt-1 text-xs ${liveClass[live]}`} data-testid="alert-live">{tr(`alertInbox.live.${live}`, live)}</span>
                      )}
                    </td>
                    <td className="py-3 px-4">
                      <span className="block break-all line-clamp-2 font-medium text-white" title={r.alertname}>{r.alertname || '-'}</span>
                      <span className={`text-xs ${severityClass[r.severity] ?? 'text-slate-400'}`}>{r.severity || '-'}</span>
                      {r.summary && <span className="block truncate text-xs text-slate-400" title={r.summary}>{r.summary}</span>}
                    </td>
                    <td className="col-low py-3 px-4 font-mono text-xs whitespace-nowrap" title={r.namespace || undefined}>{r.namespace || '-'}</td>
                    <td className="py-3 px-4 text-xs">
                      {target ? (
                        <button
                          type="button"
                          onClick={(e) => { e.stopPropagation(); openDetail(target) }}
                          className="block max-w-full truncate text-left text-primary-300 hover:underline"
                          title={`${target.kind} ${target.name}`}
                          data-testid="alert-object"
                        >
                          {target.kind}/{target.name}
                        </button>
                      ) : '-'}
                    </td>
                    <td className="py-3 px-4 text-xs whitespace-nowrap" title={utcTitle(r.starts_at)}>{formatAge(r.starts_at)}</td>
                    <td className="col-optional py-3 px-4 text-right text-xs">{r.received_count}</td>
                    <td className="col-optional py-3 px-4 text-xs">
                      {r.investigation ? (
                        <span className={`inline-block whitespace-nowrap rounded-sm border px-1.5 py-0.5 ${investigationClass[r.investigation.status] ?? ''}`}>
                          {tr(`investigations.status.${r.investigation.status}`, r.investigation.status)}
                        </span>
                      ) : '-'}
                    </td>
                    <td className="py-3 px-4 text-xs" data-testid="alert-handling">
                      <Marks item={r} tr={tr} />
                    </td>
                  </tr>
                )
              })}
              {isLoading && (
                <tr>
                  <td colSpan={COLUMNS} className="py-10 px-4 text-center text-slate-400">
                    <span className="inline-flex items-center gap-2"><Loader2 className="w-4 h-4 animate-spin" />{tr('common.loading', 'Loading…')}</span>
                  </td>
                </tr>
              )}
              {!isLoading && rows.length === 0 && <TableEmptyRow colSpan={COLUMNS} resource="alerts" />}
            </tbody>
            <AdaptiveTableFillerRows count={rowsPerPage - rows.length} columnCount={COLUMNS} />
          </table>
        </div>
        <ListPager currentPage={page} totalPages={totalPages} total={total} rowsPerPage={rowsPerPage} onPageChange={setPage} />
      </div>

      {openId && <AlertDetailModal id={openId} live={store} silenceWith={silenceWith} onClose={() => open(null)} />}
    </div>
  )
}

function Marks({ item, tr }: { item: Pick<AlertInboxItem, 'acknowledged' | 'assignee' | 'done'>; tr: (k: string, f: string) => string }) {
  if (!item.acknowledged && !item.assignee && !item.done) return <>-</>
  return (
    <span className="flex flex-wrap gap-1">
      {item.done && <span className="rounded-sm border border-emerald-800/60 bg-emerald-900/30 px-1.5 py-0.5 text-emerald-300">{tr('alertInbox.mark.done', 'Done')}</span>}
      {item.acknowledged && !item.done && <span className="rounded-sm border border-slate-600 px-1.5 py-0.5 text-slate-300">{tr('alertInbox.mark.acknowledged', 'Acknowledged')}</span>}
      {item.assignee && <span className="max-w-full truncate rounded-sm border border-slate-600 px-1.5 py-0.5 text-slate-300" title={item.assignee}>{item.assignee}</span>}
    </span>
  )
}

function AlertDetailModal({ id, live, silenceWith, onClose }: {
  id: string
  live: Parameters<typeof liveStateOf>[1]
  // set when this user may silence the cluster's alerts
  silenceWith?: { maxHours: number; clusterLabel: string }
  onClose: () => void
}) {
  const { t } = useTranslation()
  const tr = (key: string, fallback: string, opts?: Record<string, unknown>) => t(key, { defaultValue: fallback, ...opts })
  const queryClient = useQueryClient()
  const { open: openDetail } = useResourceDetail()
  const [note, setNote] = useState<string | null>(null)
  const [reportOpen, setReportOpen] = useState(false)
  const [silenceOpen, setSilenceOpen] = useState(false)
  const { data, isLoading, error } = useQuery<AlertInboxDetail>({
    queryKey: ['alert-inbox', 'one', id],
    queryFn: () => api.getAlertInboxItem(id),
    retry: false,
  })
  const save = useMutation({
    mutationFn: (marks: AlertInboxMarks) => api.setAlertInboxMarks(id, marks),
    onSuccess: (fresh) => {
      queryClient.setQueryData(['alert-inbox', 'one', id], fresh)
      queryClient.invalidateQueries({ queryKey: ['alert-inbox', 'list'] })
      setNote(null)
    },
  })
  const liveState = data ? liveStateOf(data, live) : null
  const target = data ? alertResource(data.labels) : null
  const noteValue = note ?? data?.note ?? ''

  useAIContext(data ? {
    source: 'AlertDetailModal',
    summary: `알림 — ${data.alertname} (${data.cluster}${data.namespace ? ` / ${data.namespace}` : ''}, ${data.status})`,
    data: {
      alertname: data.alertname, severity: data.severity, status: data.status, live: liveState ?? undefined,
      labels: data.labels, annotations: data.annotations, starts_at: data.starts_at, resolved_at: data.resolved_at ?? undefined,
      received_count: data.received_count, last_received_at: data.last_received_at, acknowledged: data.acknowledged,
      assignee: data.assignee || undefined, done: data.done, note: data.note || undefined, investigation: data.investigation?.status,
    },
  } : null, [data, liveState])

  const failed = save.error as { response?: { status?: number } } | null
  return (
    <>
      <ModalFrame
        title={data ? data.alertname || id : tr('alertInbox.detail', 'Alert')}
        subtitle={data ? `${data.cluster}${data.namespace ? ' / ' + data.namespace : ''} · ${formatTime(data.starts_at)}` : undefined}
        icon={<BellRing className="w-5 h-5 text-primary-400" />}
        size="lg"
        body="scroll"
        onClose={onClose}
        busy={save.isPending}
        testId="alert-detail"
        footer={<button type="button" onClick={onClose} className="btn btn-secondary">{tr('common.close', 'Close')}</button>}
      >
        {isLoading && <div className="py-6 text-center text-slate-500">{tr('common.loading', 'Loading…')}</div>}
        {error && (
          <div className="rounded-lg border border-red-800/60 bg-red-900/20 px-3 py-2 text-sm text-red-200">
            {tr('alertInbox.loadFailed', 'The alert could not be opened.')}
          </div>
        )}
        {data && (
          <div className="space-y-5">
            <div className="flex flex-wrap gap-x-6 gap-y-1 text-xs text-slate-400" data-testid="alert-detail-meta">
              <span>{tr('alertInbox.col.status', 'Status')}: <span className={`rounded-sm border px-1.5 py-0.5 ${statusClass[data.status] ?? ''}`}>{tr(`alertInbox.status.${data.status}`, data.status)}</span></span>
              {liveState && <span>{tr('alertInbox.liveLabel', 'Alertmanager now')}: <span className={liveClass[liveState]}>{tr(`alertInbox.live.${liveState}`, liveState)}</span></span>}
              <span>{tr('alertInbox.filter.severity', 'Severity')}: <span className={severityClass[data.severity] ?? 'text-slate-300'}>{data.severity || '-'}</span></span>
              <span>{tr('alertInbox.col.started', 'Started')}: <span className="text-slate-300">{formatTime(data.starts_at)}</span></span>
              {data.resolved_at && <span>{tr('alertInbox.resolvedAt', 'Resolved')}: <span className="text-slate-300">{formatTime(data.resolved_at)}</span></span>}
              <span>{tr('alertInbox.lastReceived', 'Last received')}: <span className="text-slate-300">{formatTime(data.last_received_at)}</span></span>
              <span>{tr('alertInbox.col.received', 'Received')}: <span className="text-slate-300">{data.received_count}</span></span>
            </div>
            {data.status === 'stale' && (
              <div className="rounded-lg border border-amber-800/60 bg-amber-900/20 px-3 py-2 text-sm text-amber-200" data-testid="alert-stale-note">
                {tr('alertInbox.staleNote', 'No notification for this firing alert for a while: the resolved notification may have been missed (it resolved while silenced, the route changed, or delivery failed).')}
              </div>
            )}
            {(data.annotations.summary || data.annotations.description) && (
              <div className="space-y-1 text-sm text-slate-200">
                {data.annotations.summary && <p className="font-medium">{data.annotations.summary}</p>}
                {data.annotations.description && <p className="text-slate-300 whitespace-pre-wrap">{data.annotations.description}</p>}
              </div>
            )}
            <div className="flex flex-wrap gap-4 text-xs">
              {target && (
                <button type="button" onClick={() => openDetail(target)} className="inline-flex items-center gap-1 text-primary-300 hover:underline" data-testid="alert-detail-object">
                  <ExternalLink className="w-3.5 h-3.5" /> {target.kind}/{target.name}
                </button>
              )}
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

            <section data-testid="alert-handling-section">
              <h3 className="mb-1 text-xs font-semibold uppercase tracking-wider text-slate-400">{tr('alertInbox.section.handling', 'Handling')}</h3>
              <p className="mb-2 text-xs text-slate-500">{tr('alertInbox.handlingNote', 'Kept in Kubeast for your team; Alertmanager and the alert rule are not changed.')}</p>
              <div className="flex flex-wrap gap-2">
                <button type="button" disabled={save.isPending} onClick={() => save.mutate({ acknowledged: !data.acknowledged })} className="btn btn-secondary flex items-center gap-1" data-testid="alert-ack">
                  <Check className="w-4 h-4" /> {data.acknowledged ? tr('alertInbox.action.unack', 'Undo acknowledge') : tr('alertInbox.action.ack', 'Acknowledge')}
                </button>
                <button type="button" disabled={save.isPending} onClick={() => save.mutate({ assignee: data.assignee ? '' : 'me' })} className="btn btn-secondary flex items-center gap-1" data-testid="alert-assign">
                  <UserCheck className="w-4 h-4" /> {data.assignee ? tr('alertInbox.action.unassign', 'Unassign') : tr('alertInbox.action.assign', 'Assign to me')}
                </button>
                <button type="button" disabled={save.isPending} onClick={() => save.mutate({ done: !data.done })} className="btn btn-secondary flex items-center gap-1" data-testid="alert-done">
                  {data.done ? tr('alertInbox.action.reopen', 'Reopen') : tr('alertInbox.action.done', 'Mark done')}
                </button>
                {silenceWith && data.status !== 'resolved' && (
                  <button type="button" onClick={() => setSilenceOpen(true)} className="btn btn-secondary flex items-center gap-1" data-testid="alert-silence">
                    <BellOff className="w-4 h-4" /> {tr('alertInbox.action.silence', 'Silence')}
                  </button>
                )}
              </div>
              <div className="mt-2 grid gap-1 text-xs text-slate-400">
                {data.acknowledged && <span>{tr('alertInbox.ackedBy', 'Acknowledged by {{who}} · {{when}}', { who: data.acked_by, when: formatTime(data.acked_at) })}</span>}
                {data.assignee && <span data-testid="alert-assignee">{tr('alertInbox.assignee', 'Assignee: {{who}}', { who: data.assignee })}</span>}
                {data.done && <span>{tr('alertInbox.doneBy', 'Done by {{who}} · {{when}}', { who: data.done_by, when: formatTime(data.done_at) })}</span>}
              </div>
              <label className="mt-3 block text-xs font-semibold text-slate-400 mb-1" htmlFor="alert-note">{tr('alertInbox.note', 'Note')}</label>
              <textarea
                id="alert-note"
                value={noteValue}
                onChange={(e) => setNote(e.target.value)}
                maxLength={2000}
                rows={3}
                className="w-full rounded-lg border border-slate-700 bg-slate-950/60 px-3 py-2 text-sm text-white"
                data-testid="alert-note"
              />
              <div className="mt-1 flex items-center justify-between text-xs text-slate-500">
                <span>{data.note_by ? tr('alertInbox.noteBy', 'Last written by {{who}} · {{when}}', { who: data.note_by, when: formatTime(data.note_at) }) : ''}</span>
                <button type="button" disabled={save.isPending || note === null || note.trim() === data.note} onClick={() => save.mutate({ note: noteValue })} className="btn btn-primary" data-testid="alert-note-save">
                  {tr('alertInbox.action.saveNote', 'Save note')}
                </button>
              </div>
              {failed && (
                <div className="mt-2 rounded-lg border border-red-800/60 bg-red-900/20 px-3 py-2 text-sm text-red-200" data-testid="alert-save-error">
                  {failed.response?.status === 503
                    ? tr('alertInbox.auditUnavailable', 'Not saved: the audit log cannot take the record right now.')
                    : tr('alertInbox.saveFailed', 'Not saved.')}
                </div>
              )}
            </section>

            <section>
              <h3 className="mb-2 text-xs font-semibold uppercase tracking-wider text-slate-400">{tr('alertInbox.col.investigation', 'AI investigation')}</h3>
              {data.investigation ? (
                <div className="flex items-center gap-3 text-sm">
                  <span className={`rounded-sm border px-1.5 py-0.5 text-xs ${investigationClass[data.investigation.status] ?? ''}`}>
                    {tr(`investigations.status.${data.investigation.status}`, data.investigation.status)}
                  </span>
                  <button
                    type="button"
                    onClick={() => setReportOpen(true)}
                    disabled={data.investigation.status === 'queued' || data.investigation.status === 'running'}
                    className="inline-flex items-center gap-1 rounded-lg bg-primary-600 px-2 py-1 text-xs text-white hover:bg-primary-500 disabled:opacity-40"
                    data-testid="alert-report"
                  >
                    <FileSearch className="w-3.5 h-3.5" /> {tr('investigations.open', 'Report')}
                  </button>
                </div>
              ) : (
                <p className="text-xs text-slate-500">{tr('alertInbox.noInvestigation', 'Not investigated (only firing alerts of the investigated severities are, within the hourly cap and token budget).')}</p>
              )}
            </section>

            <section>
              <h3 className="mb-2 text-xs font-semibold uppercase tracking-wider text-slate-400">{tr('alertInbox.section.labels', 'Labels and annotations')}</h3>
              <div className="grid gap-3 md:grid-cols-2">
                <dl className="rounded-lg border border-slate-700 bg-slate-950/40 px-3 py-2 text-xs" data-testid="alert-labels">
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
            </section>
          </div>
        )}
      </ModalFrame>
      {silenceOpen && data && silenceWith && (
        <SilenceModal initial={silenceStart(data.labels, silenceWith.clusterLabel)} maxHours={silenceWith.maxHours} onClose={() => setSilenceOpen(false)} />
      )}
      {reportOpen && data?.investigation && (
        <InvestigationReportModal id={data.investigation.id} load={() => api.getAlertInboxInvestigation(id)} onClose={() => setReportOpen(false)} />
      )}
    </>
  )
}
