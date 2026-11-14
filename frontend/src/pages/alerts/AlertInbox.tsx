import { useEffect, useState } from 'react'
import { useSearchParams } from 'react-router-dom'
import { useIsFetching, useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useTranslation } from 'react-i18next'
import { BellOff, BellRing, Bot, Check, ExternalLink, FileSearch, Loader2, RefreshCw, Search, UserCheck } from 'lucide-react'

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
import { alertStoreEnabledFor } from '@/utils/features'
import { alertResource, inboxState, liveLineOf, liveStateOf, severityChoices, silenceStart, storeCut, storeLimited, storeLimitedSeconds, storeRefetchMs, type LiveState } from '@/utils/alertInbox'
import { severityClass, skipReason, statusClass as investigationClass } from '@/utils/investigationFormat'
import { investigateErrorText, investigateNowView } from '@/utils/investigateNow'
import { formatAge, formatTime, utcTitle } from '@/utils/time'
import { failureText } from '@/utils/failureText'
import { RefreshFailure } from '@/components/RefreshFailure'
import { failureOf } from '@/hooks/useRefresh'

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
  const queryClient = useQueryClient()
  const [status, setStatus] = useState('')
  const [showSilences, setShowSilences] = useState(false)
  const [newSilence, setNewSilence] = useState(false)
  const [severity, setSeverity] = useState('')
  const [mine, setMine] = useState(false)
  const [openOnly, setOpenOnly] = useState(false)
  // the server searches the whole inbox (q), not only the page shown; asked once typing pauses
  const [searchInput, setSearchInput] = useState('')
  const [search, setSearch] = useState('')
  useEffect(() => {
    const t = setTimeout(() => setSearch(searchInput.trim()), 300)
    return () => clearTimeout(t)
  }, [searchInput])
  const [page, setPage] = useState(1)
  const { containerRef, bodyRef, theadRef, firstRowRef, rowsPerPage } = useAdaptiveTable({ recalculationKey: status })

  const inbox = inboxState(features.data, features.isPlaceholderData)
  const filter = { status, severity, mine, open: openOnly, q: search, limit: rowsPerPage, offset: (page - 1) * rowsPerPage }
  // The rows on screen stay while another tab, page or search loads (never another cluster's); the pager, the counts
  // and the AI context follow the answer's own filter and page.
  const { data, isLoading, isFetching, error, errorUpdatedAt, refetch } = useQuery({
    queryKey: ['alert-inbox', 'list', currentCluster, filter],
    queryFn: async () => ({ ...(await api.listAlertInbox(filter)), filter, page }),
    placeholderData: (prev, prevQuery) => (prevQuery?.queryKey[2] === currentCluster ? prev : undefined),
    refetchInterval: 30_000,
    retry: false,
    enabled: inbox === 'on',
  })
  const storeOn = alertStoreEnabledFor(features.data, currentCluster)
  // without the inbox the page is the store's silences
  const inboxOff = inbox === 'off' || inbox === 'aiOff'
  const silencesShown = showSilences || inboxOff
  const silencesFetching = useIsFetching({ queryKey: ['alert-inbox', 'silences'] }) > 0
  // making and ending silences: the store takes writes (features.alertStore.silences) and the user holds resource.alert.silence
  const silenceWith = storeOn && features.data?.alertStore?.silences && has('resource.alert.silence')
    ? { maxHours: features.data.alertStore.silenceMaxHours ?? 168, clusterLabel: features.data.alertStore.clusterLabel ?? 'cluster' }
    : undefined
  const storeQuery = useQuery({
    queryKey: ['alert-inbox', 'store', currentCluster],
    queryFn: api.listAlertStoreAlerts,
    enabled: storeOn && !inboxOff,
    // read again when the server said after a refusal at the request limit, not at the next minute
    refetchInterval: (q) => storeRefetchMs(q.state.error),
    retry: false,
  })
  const store = storeQuery.data
  // Until a refused read's wait ends. Held while the next read is on its way (a query that never answered has no error
  // then), so the notice does not blink each time.
  const [limitedUntil, setLimitedUntil] = useState<number | null>(null)
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    if (storeQuery.isFetching) return
    const limited = storeLimited(storeQuery.error)
    setNow(Date.now())
    setLimitedUntil(limited ? storeQuery.errorUpdatedAt + limited.retryAfter * 1000 : null)
  }, [storeQuery.isFetching, storeQuery.error, storeQuery.errorUpdatedAt])
  useEffect(() => setLimitedUntil(null), [currentCluster])
  useEffect(() => {
    if (limitedUntil === null) return
    const tick = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(tick)
  }, [limitedUntil])
  const limitedSeconds = storeLimitedSeconds(limitedUntil, now)
  // what the alert window says about Alertmanager now; while the features are not known yet, as loading
  const storeRead = { on: storeOn || !features.data, answer: store, failed: storeQuery.isError, limited: limitedSeconds }
  // the last read failed for another reason than the request limit: the rows keep what the store said before, if it did
  const storeFailed = storeQuery.isError && !storeLimited(storeQuery.error)
    ? { reason: failureText(storeQuery.error), shownFrom: store ? storeQuery.dataUpdatedAt : null }
    : null
  const cut = storeCut(store)
  const rows = data?.items ?? []
  const total = data?.total ?? 0
  const counts = data?.counts ?? { firing: 0, stale: 0, resolved: 0 }
  const shown = data ? { ...data.filter, page: data.page } : { ...filter, page }
  const totalPages = Math.max(1, Math.ceil(total / shown.limit))
  const severities = severityChoices(data?.severities, severity)
  const forbidden = (error as { response?: { status?: number } } | null)?.response?.status === 403

  useEffect(() => setPage(1), [status, severity, mine, openOnly, search, currentCluster])

  const open = (id: string | null) => {
    const next = new URLSearchParams(params)
    if (id) next.set('alert', id)
    else next.delete('alert')
    setParams(next, { replace: true })
  }

  useAIContext(inboxOff ? {
    summary: `알림 수신함 없음 — ${inbox === 'aiOff' ? 'AI(ai.enabled)' : '알림 조사(features.alertInvestigation.enabled)'}가 꺼져 있어 들어오는 알림이 없음`,
    data: { cluster: currentCluster, inbox_off: inbox === 'aiOff' ? 'ai.enabled' : 'features.alertInvestigation.enabled' },
  } : data ? {
    summary: `알림 ${total}건 (울리는 중 ${counts.firing}, 상태 확인 안 됨 ${counts.stale}, 해결됨 ${counts.resolved})${shown.status ? ` — ${shown.status}만` : ''}`,
    data: {
      cluster: currentCluster,
      filters: { status: shown.status || undefined, severity: shown.severity || undefined, mine: shown.mine || undefined, open: shown.open || undefined, search: shown.q || undefined, page: shown.page },
      counts,
      // the store's list was cut at its limit: "live" is left out for the alerts it did not send
      alert_store_cut: cut ?? undefined,
      // the store refused the last read (the request limit): "live" is what it last said, or left out; when it is read again
      alert_store_limited: limitedUntil !== null ? { read_again_at: new Date(limitedUntil).toISOString() } : undefined,
      // the last read of the store failed: "live" is what it said at shown_from, or left out
      alert_store_failed: storeFailed
        ? { reason: storeFailed.reason, shown_from: storeFailed.shownFrom !== null ? new Date(storeFailed.shownFrom).toISOString() : undefined }
        : undefined,
      items: rows.map((r) => ({
        alertname: r.alertname, severity: r.severity, namespace: r.namespace || undefined, status: r.status,
        live: liveStateOf(r, store) ?? undefined, summary: r.summary || undefined, starts_at: r.starts_at,
        resolved_at: r.resolved_at ?? undefined, received_count: r.received_count, acknowledged: r.acknowledged || undefined,
        assignee: r.assignee || undefined, done: r.done || undefined, investigation: r.investigation?.status,
        investigation_skip: r.investigation?.status === 'skipped' ? r.investigation.skip_reason || undefined : undefined,
      })),
    },
  } : null, [inbox, data, store, currentCluster, limitedUntil, storeFailed?.reason, storeFailed?.shownFrom])

  const statusLabel = (s: string) => tr(`alertInbox.status.${s}`, s)
  const tab = (value: string, label: string, count?: number) => (
    <button
      key={value || 'all'}
      type="button"
      onClick={() => { setStatus(value); setShowSilences(false) }}
      data-testid={`alert-tab-${value || 'all'}`}
      className={`h-10 rounded-lg border px-3 text-sm ${!silencesShown && status === value ? 'border-primary-600 bg-primary-600 text-white' : 'border-slate-700 text-slate-300 hover:border-slate-500'}`}
    >
      {label}{count !== undefined && <span className={`ml-2 text-xs ${!silencesShown && status === value ? 'text-white' : 'text-slate-400'}`}>{count}</span>}
    </button>
  )

  return (
    <div className="flex flex-col h-[calc(100vh-4rem)] gap-4">
      <div className="page-head items-start shrink-0">
        <div>
          <h1 className="text-3xl font-semibold text-ink">{tr('alertInbox.title', 'Alerts')}</h1>
          <p className="mt-2 text-slate-400">
            {tr('alertInbox.subtitle', 'Every alert Alertmanager sent for this cluster, firing or resolved. The alert rule decides when it resolves; the marks here are kept in Kubeast.')}
          </p>
        </div>
        <button type="button" onClick={() => void (inboxOff ? queryClient.invalidateQueries({ queryKey: ['alert-inbox'] }) : refetch())} className="btn btn-primary flex items-center gap-2">
          <RefreshCw className={`w-4 h-4 ${(inboxOff ? silencesFetching : isFetching) ? 'animate-spin' : ''}`} /> {tr('alertInbox.refresh', 'Refresh')}
        </button>
      </div>

      {inboxOff && (
        <div className="shrink-0 rounded-lg border border-amber-800/60 bg-amber-900/20 px-3 py-2 text-sm text-amber-200" data-testid="alert-inbox-disabled">
          {inbox === 'aiOff'
            ? tr('alertInbox.disabledNoAI', 'The alert webhook is part of alert investigation, which needs AI: AI is off on this installation (ai.enabled), so no alerts come in.')
            : tr('alertInbox.disabled', 'The alert webhook is off on this installation (features.alertInvestigation.enabled), so no alerts come in.')}
        </div>
      )}
      <RefreshFailure failure={!forbidden && rows.length ? failureOf(error, errorUpdatedAt) : null} />
      {forbidden && (
        <div className="shrink-0 rounded-lg border border-amber-800/60 bg-amber-900/20 px-3 py-2 text-sm text-amber-200" data-testid="alert-inbox-forbidden">
          {tr('alertInbox.forbidden', 'Alerts cover the whole cluster: they are shown to users who can read this cluster without a namespace limit.')}
        </div>
      )}
      {cut && !silencesShown && (
        <div className="shrink-0 rounded-lg border border-amber-800/60 bg-amber-900/20 px-3 py-2 text-sm text-amber-200">
          {tr('alertInbox.storeCut', 'The alert store sent the first {{listed}} of its {{total}} alerts for this cluster (its limit, alertStore.maxAlerts): for an alert not among them, what Alertmanager says now is not shown.', cut)}
        </div>
      )}

      {limitedSeconds !== null && !silencesShown && (
        <div className="shrink-0 rounded-lg border border-amber-800/60 bg-amber-900/20 px-3 py-2 text-sm text-amber-200" data-testid="alert-store-limited">
          {tr('alertInbox.storeLimited', 'Alertmanager\'s state could not be read for now (request limit). Reading again in {{seconds}} s.', { seconds: limitedSeconds })}
        </div>
      )}

      {storeFailed && !silencesShown && (
        <div className="shrink-0 rounded-lg border border-amber-800/60 bg-amber-900/20 px-3 py-2 text-sm text-amber-200" data-testid="alert-store-failed">
          {storeFailed.shownFrom !== null
            ? tr('alertInbox.storeFailedShown', 'Alertmanager\'s state could not be read: {{reason}}. What it said at {{time}} is shown.', { reason: storeFailed.reason, time: formatTime(storeFailed.shownFrom) })
            : tr('alertInbox.storeFailed', 'Alertmanager\'s state could not be read: {{reason}}', { reason: storeFailed.reason })}
        </div>
      )}

      <div className={`relative shrink-0 ${silencesShown ? 'hidden' : ''}`}>
        <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-5 h-5 text-slate-400" />
        <input
          type="text"
          value={searchInput}
          onChange={(e) => setSearchInput(e.target.value)}
          placeholder={tr('alertInbox.searchPlaceholder', 'Search by alert name, namespace, label, annotation or assignee...')}
          maxLength={200}
          data-testid="alert-inbox-search"
          className="h-12 w-full pl-10 pr-4 bg-slate-700 border border-slate-600 rounded-lg text-sm text-ink placeholder-slate-400 focus:outline-hidden focus:ring-2 focus:ring-primary-500 focus:border-transparent"
        />
      </div>

      <div className="flex flex-wrap items-end gap-3 shrink-0">
        {!inboxOff && (
          <>
            {tab('firing', statusLabel('firing'), counts.firing)}
            {tab('stale', statusLabel('stale'), counts.stale)}
            {tab('resolved', statusLabel('resolved'), counts.resolved)}
            {tab('', tr('alertInbox.status.all', 'All'), counts.firing + counts.stale + counts.resolved)}
          </>
        )}
        {storeOn && (
          <button
            type="button"
            onClick={() => setShowSilences(true)}
            data-testid="alert-tab-silences"
            className={`h-10 inline-flex items-center gap-1 rounded-lg border px-3 text-sm ${silencesShown ? 'border-primary-600 bg-primary-600 text-white' : 'border-slate-700 text-slate-300 hover:border-slate-500'}`}
          >
            <BellOff className="w-4 h-4" /> {tr('alertInbox.silence.tab', 'Silences')}
          </button>
        )}
        <div className={`w-40 ${silencesShown ? 'hidden' : ''}`}>
          <CustomDropdown
            label={tr('alertInbox.filter.severity', 'Severity')}
            value={severity}
            onChange={setSeverity}
            options={[{ value: '', label: tr('alertInbox.status.all', 'All') }, ...severities.map((s) => ({ value: s, label: s }))]}
          />
        </div>
        <label className={`flex h-10 items-center gap-2 text-sm text-slate-300 ${silencesShown ? 'hidden' : ''}`}>
          <input type="checkbox" checked={mine} onChange={(e) => setMine(e.target.checked)} data-testid="alert-filter-mine" />
          {tr('alertInbox.filter.mine', 'Assigned to me')}
        </label>
        <label className={`flex h-10 items-center gap-2 text-sm text-slate-300 ${silencesShown ? 'hidden' : ''}`}>
          <input type="checkbox" checked={openOnly} onChange={(e) => setOpenOnly(e.target.checked)} data-testid="alert-filter-open" />
          {tr('alertInbox.filter.open', 'Not done')}
        </label>
        {silencesShown && silenceWith && (
          <button type="button" onClick={() => setNewSilence(true)} className="btn btn-primary ml-auto flex items-center gap-2" data-testid="silence-new">
            <BellOff className="w-4 h-4" /> {tr('alertInbox.silence.new', 'New silence')}
          </button>
        )}
      </div>

      {silencesShown && storeOn && <SilenceList canExpire={!!silenceWith} />}
      <div ref={containerRef} className={`card flex-1 min-h-0 flex flex-col ${silencesShown ? 'hidden' : ''}`}>
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
                // not among the alerts the store's cut list sent: what Alertmanager says now is not known
                const unknown = !live && cut && r.status !== 'resolved'
                const skip = r.investigation?.status === 'skipped' ? skipReason(r.investigation, tr) : null
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
                      {unknown && (
                        <span className="block mt-1 text-xs text-slate-400" title={tr('alertInbox.liveUnknown.cut', 'Unknown — the alert store sent {{listed}} of its {{total}} alerts for this cluster, not this one', cut)} data-testid="alert-live-unknown">
                          {tr('alertInbox.live.unknown', 'Unknown')}
                        </span>
                      )}
                    </td>
                    <td className="py-3 px-4">
                      <span className="block break-all line-clamp-2 font-medium text-ink" title={r.alertname}>{r.alertname || '-'}</span>
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
                        <span className={`inline-block whitespace-nowrap rounded-sm border px-1.5 py-0.5 ${investigationClass[r.investigation.status] ?? ''}`} title={skip?.text}>
                          {tr(`investigations.status.${r.investigation.status}`, r.investigation.status)}
                        </span>
                      ) : '-'}
                      {skip && <span className="block mt-1 truncate text-slate-400" title={skip.text} data-testid="alert-investigation-skip">{skip.label}</span>}
                    </td>
                    <td className="py-3 px-4 text-xs" data-testid="alert-handling">
                      <Marks item={r} tr={tr} />
                    </td>
                  </tr>
                )
              })}
              {(isLoading || inbox === 'wait') && (
                <tr>
                  <td colSpan={COLUMNS} className="py-10 px-4 text-center text-slate-400">
                    <span className="inline-flex items-center gap-2"><Loader2 className="w-4 h-4 animate-spin" />{tr('common.loading', 'Loading…')}</span>
                  </td>
                </tr>
              )}
              {!isLoading && inbox === 'on' && rows.length === 0 && <TableEmptyRow colSpan={COLUMNS} resource="alerts" searching={!!search} error={forbidden ? undefined : error} onRetry={() => void refetch()} />}
            </tbody>
            <AdaptiveTableFillerRows count={rowsPerPage - rows.length} columnCount={COLUMNS} />
          </table>
        </div>
        <ListPager currentPage={shown.page} totalPages={totalPages} total={total} rowsPerPage={shown.limit} onPageChange={setPage} />
      </div>

      {newSilence && silenceWith && <SilenceModal initial={{}} maxHours={silenceWith.maxHours} onClose={() => setNewSilence(false)} />}
      {/* one window per alert: a note being typed, a sub-window and a save under way stay with the alert they were for */}
      {openId && inbox === 'on' && <AlertDetailModal key={openId} id={openId} store={storeRead} silenceWith={silenceWith} onClose={() => open(null)} />}
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

function AlertDetailModal({ id, store, silenceWith, onClose }: {
  id: string
  // the page's alert store read: whether the cluster has one, its answer, whether it failed
  store: Parameters<typeof liveLineOf>[1]
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
    // a queued or running investigation is read again until it ends (the window keeps what it shows meanwhile)
    refetchInterval: (q) => (['queued', 'running'].includes(q.state.data?.investigation?.status ?? '') ? 5_000 : false),
  })
  // a save names its alert, and its answer goes to that alert's window
  const save = useMutation({
    mutationFn: ({ alert, marks }: { alert: string; marks: AlertInboxMarks }) => api.setAlertInboxMarks(alert, marks),
    onSuccess: (fresh, { alert }) => {
      queryClient.setQueryData(['alert-inbox', 'one', alert], fresh)
      queryClient.invalidateQueries({ queryKey: ['alert-inbox', 'list'] })
      setNote(null)
    },
  })
  // "Investigate now": the answer is the window with its new investigation; a refusal reads the window again
  const start = useMutation({
    mutationFn: (alert: string) => api.investigateAlertInboxItem(alert),
    onSuccess: (fresh, alert) => {
      queryClient.setQueryData(['alert-inbox', 'one', alert], fresh)
      queryClient.invalidateQueries({ queryKey: ['alert-inbox', 'list'] })
    },
    onError: (_err, alert) => queryClient.invalidateQueries({ queryKey: ['alert-inbox', 'one', alert] }),
  })
  const now = investigateNowView(data?.investigate_now, tr)
  const nowNote = start.isError ? investigateErrorText(start.error, tr) : now.note
  // a refusal's words give way once the window's own state says why (or that it works again)
  const { reset: resetStart } = start
  const nowReason = data?.investigate_now?.reason
  useEffect(() => resetStart(), [nowReason, resetStart])
  const liveLine = data ? liveLineOf(data, store) : null
  const liveState = liveLine && 'state' in liveLine ? liveLine.state : null
  const liveUnknown = liveLine && 'unknown' in liveLine ? liveLine.unknown : null
  const cut = storeCut(store.answer)
  const skip = data?.investigation?.status === 'skipped' ? skipReason(data.investigation, tr) : null
  const target = data ? alertResource(data.labels) : null
  const noteValue = note ?? data?.note ?? ''

  useAIContext(data ? {
    source: 'AlertDetailModal',
    summary: `알림 — ${data.alertname} (${data.cluster}${data.namespace ? ` / ${data.namespace}` : ''}, ${data.status})`,
    data: {
      alertname: data.alertname, severity: data.severity, status: data.status, live: liveState ?? undefined,
      // why "live" is missing: the store's list was cut before this alert, not answered yet, failed, or no store
      live_unknown: liveUnknown ?? undefined,
      alert_store_cut: cut ?? undefined,
      labels: data.labels, annotations: data.annotations, starts_at: data.starts_at, resolved_at: data.resolved_at ?? undefined,
      received_count: data.received_count, last_received_at: data.last_received_at, acknowledged: data.acknowledged,
      assignee: data.assignee || undefined, done: data.done, note: data.note || undefined, investigation: data.investigation?.status,
      investigation_skip: skip ? data.investigation?.skip_reason || undefined : undefined,
      investigation_requested_by: data.investigation?.requested_by || undefined,
      // the "Investigate now" button as the server decided it for this user (until = when it works again, UTC)
      investigate_now: data.investigate_now ? {
        allowed: data.investigate_now.allowed, reason: data.investigate_now.reason || undefined, until: data.investigate_now.until ?? undefined,
        automatic: data.investigate_now.automatic, budget: data.investigate_now.budget, used: data.investigate_now.used,
        shown: now.show, note: nowNote || undefined,
      } : undefined,
    },
  } : null, [data, liveState, liveUnknown, cut?.listed, cut?.total, skip?.text, nowNote])

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
        busy={save.isPending || start.isPending}
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
              {liveLine && (
                <span>
                  {tr('alertInbox.liveLabel', 'Alertmanager now')}:{' '}
                  {'state' in liveLine
                    ? <span className={liveClass[liveLine.state]}>{tr(`alertInbox.live.${liveLine.state}`, liveLine.state)}</span>
                    : <span className="text-slate-300">{tr(`alertInbox.liveUnknown.${liveLine.unknown}`, liveLine.unknown, liveLine)}</span>}
                </span>
              )}
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
              <h3 className="mb-1 text-xs font-semibold text-slate-400">{tr('alertInbox.section.handling', 'Handling')}</h3>
              <p className="mb-2 text-xs text-slate-500">{tr('alertInbox.handlingNote', 'Kept in Kubeast for your team; Alertmanager and the alert rule are not changed.')}</p>
              <div className="flex flex-wrap gap-2">
                <button type="button" disabled={save.isPending} onClick={() => save.mutate({ alert: id, marks: { acknowledged: !data.acknowledged } })} className="btn btn-secondary flex items-center gap-1" data-testid="alert-ack">
                  <Check className="w-4 h-4" /> {data.acknowledged ? tr('alertInbox.action.unack', 'Undo acknowledge') : tr('alertInbox.action.ack', 'Acknowledge')}
                </button>
                <button type="button" disabled={save.isPending} onClick={() => save.mutate({ alert: id, marks: { assignee: data.assignee ? '' : 'me' } })} className="btn btn-secondary flex items-center gap-1" data-testid="alert-assign">
                  <UserCheck className="w-4 h-4" /> {data.assignee ? tr('alertInbox.action.unassign', 'Unassign') : tr('alertInbox.action.assign', 'Assign to me')}
                </button>
                <button type="button" disabled={save.isPending} onClick={() => save.mutate({ alert: id, marks: { done: !data.done } })} className="btn btn-secondary flex items-center gap-1" data-testid="alert-done">
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
                className="w-full rounded-lg border border-slate-700 bg-slate-950/60 px-3 py-2 text-sm text-ink"
                data-testid="alert-note"
              />
              <div className="mt-1 flex items-center justify-between text-xs text-slate-500">
                <span>{data.note_by ? tr('alertInbox.noteBy', 'Last written by {{who}} · {{when}}', { who: data.note_by, when: formatTime(data.note_at) }) : ''}</span>
                <button type="button" disabled={save.isPending || note === null || note.trim() === data.note} onClick={() => save.mutate({ alert: id, marks: { note: noteValue } })} className="btn btn-primary" data-testid="alert-note-save">
                  {tr('alertInbox.action.saveNote', 'Save note')}
                </button>
              </div>
              {failed && (
                <div className="mt-2 rounded-lg border border-red-800/60 bg-red-900/20 px-3 py-2 text-sm text-red-200" data-testid="alert-save-error">
                  {failed.response?.status === 503
                    ? tr('alertInbox.auditUnavailable', 'Not saved: the audit log cannot take the record right now.')
                    : tr('alertInbox.saveFailed', 'Not saved: {{reason}}', { reason: failureText(failed) })}
                </div>
              )}
            </section>

            <section data-testid="alert-investigation-section">
              <h3 className="mb-2 text-xs font-semibold text-slate-400">{tr('alertInbox.col.investigation', 'AI investigation')}</h3>
              {/* a row of one height and a note of two lines: the status, the buttons and the notes change in place
                  while an investigation is asked for, queued, runs and ends (no empty row for someone with neither) */}
              {(data.investigation || now.show) && <div className="flex h-8 flex-nowrap items-center gap-3 text-sm">
                {data.investigation && (
                  <>
                    <span className={`inline-block min-w-[4.5rem] shrink-0 rounded-sm border px-1.5 py-0.5 text-center text-xs ${investigationClass[data.investigation.status] ?? ''}`} data-testid="alert-investigation-status">
                      {tr(`investigations.status.${data.investigation.status}`, data.investigation.status)}
                    </span>
                    <button
                      type="button"
                      onClick={() => setReportOpen(true)}
                      disabled={data.investigation.status === 'queued' || data.investigation.status === 'running'}
                      className="inline-flex shrink-0 items-center gap-1 rounded-lg bg-primary-600 px-2 py-1 text-xs text-white hover:bg-primary-500 disabled:opacity-40"
                      data-testid="alert-report"
                    >
                      <FileSearch className="w-3.5 h-3.5" /> {tr('investigations.open', 'Report')}
                    </button>
                  </>
                )}
                {now.show && (
                  <>
                    <button
                      type="button"
                      onClick={() => start.mutate(id)}
                      disabled={!now.enabled || start.isPending}
                      title={now.enabled ? undefined : now.note}
                      className="inline-flex shrink-0 items-center gap-1 rounded-lg bg-primary-600 px-2 py-1 text-xs text-white hover:bg-primary-500 disabled:opacity-40"
                      data-testid="alert-investigate-now"
                    >
                      {start.isPending ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Bot className="w-3.5 h-3.5" />} {tr('alertInbox.investigateNow.button', 'Investigate now')}
                    </button>
                    <span className={`min-w-0 truncate text-xs ${start.isError ? 'text-red-300' : 'text-slate-400'}`} title={nowNote || undefined} data-testid="alert-investigate-note">{nowNote}</span>
                  </>
                )}
              </div>}
              {/* two lines kept while it may be asked for and after it was: the note does not shrink as it changes */}
              <div className={`space-y-1 text-xs ${data.investigation || now.show ? 'mt-2' : ''} ${now.show || data.investigation?.requested_by ? 'min-h-8' : ''}`}>
                {!data.investigation && (
                  <p className="text-slate-500">
                    {data.investigate_now?.automatic === false
                      ? tr('alertInbox.noInvestigationAutomaticOff', 'Not investigated: automatic investigations are off on this installation (features.alertInvestigation.automatic).')
                      : tr('alertInbox.noInvestigation', 'Not investigated (only firing alerts of the investigated severities are, within the hourly cap and token budget).')}
                  </p>
                )}
                {skip && <p className="text-slate-300" data-testid="alert-investigation-skip">{skip.text}</p>}
                {data.investigation?.requested_by && (
                  <p className="text-slate-400" data-testid="alert-investigation-requested">
                    {tr('alertInbox.investigateNow.requestedBy', 'Asked for by {{who}} · {{when}}', { who: data.investigation.requested_by, when: formatTime(data.investigation.received_at) })}
                  </p>
                )}
              </div>
            </section>

            <section>
              <h3 className="mb-2 text-xs font-semibold text-slate-400">{tr('alertInbox.section.labels', 'Labels and annotations')}</h3>
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
