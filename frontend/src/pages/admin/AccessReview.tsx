import { useEffect, useMemo, useState } from 'react'
import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useTranslation } from 'react-i18next'
import { AlertTriangle, ClipboardCheck, Download, History, Loader2, RefreshCw, X } from 'lucide-react'

import { api } from '@/services/api'
import {
  ACCESS_REVIEW_SECTIONS,
  type AccessReviewReport,
  type AccessReviewSection,
  type AccessReviewSignoff,
} from '@/services/api/access_review'
import { formatDuration, formatWhen } from './accessRequestFormat'
import { apiKeyTabCount, historyPage, requestsCut } from './accessReviewView'
import { answerPageSize } from '@/utils/fitServerPage'
import { ListPager } from '@/components/ListPager'
import { ModalFrame } from '@/components/ModalFrame'
import { modalButton } from '@/components/modalStyles'
import { TableEmptyRow } from '@/components/TableEmptyRow'
import { AdaptiveTableFillerRows } from '@/components/AdaptiveTableFillerRows'
import { useAdaptiveTable } from '@/hooks/useAdaptiveTable'
import { pageOf } from '@/utils/listPages'
import { utcTitle } from '@/utils/time'
import { failureText } from '@/utils/failureText'
import { RefreshFailure } from '@/components/RefreshFailure'
import { failureOf } from '@/hooks/useRefresh'

// Admin → Access review: the report of who has what (accounts, per-cluster
// grants, API keys, temporary grants since the last review, roles) with the
// flags a reviewer looks for, one CSV per section, and the sign-off that
// records the review was done. A past sign-off opens as the report it stored. The page is as high as the screen:
// each tab's table pages the report's rows in the browser (the answer holds them all), Past reviews are paged by
// the server with the count of every sign-off kept, each page the rows the table fits.

type Tab = AccessReviewSection | 'history'

const HISTORY_COLUMNS = 5

const FLAG_TONE: Record<string, string> = {
  global_admin: 'bg-red-500/20 text-red-300',
  lock_exempt: 'bg-yellow-500/20 text-yellow-300',
  api_key_only: 'bg-slate-700 text-slate-300',
  admin_role: 'bg-red-500/20 text-red-300',
  has_admin_permissions: 'bg-red-500/20 text-red-300',
  sensitive_access: 'bg-yellow-500/20 text-yellow-300',
  dormant: 'bg-red-500/20 text-red-300',
  expired: 'bg-red-500/20 text-red-300',
  locked: 'bg-yellow-500/20 text-yellow-300',
  dormant_locked: 'bg-red-500/20 text-red-300',
  never_logged_in: 'bg-yellow-500/20 text-yellow-300',
  expiring_30d: 'bg-yellow-500/20 text-yellow-300',
  unused_30d: 'bg-yellow-500/20 text-yellow-300',
  unused: 'bg-yellow-500/20 text-yellow-300',
  temporary: 'bg-primary-500/20 text-primary-300',
}

interface Column<T> {
  key: string
  label: string
  render: (row: T) => React.ReactNode
  text?: (row: T) => string
}

export default function AccessReview() {
  const { t } = useTranslation()
  const tr = (key: string, fallback: string, opts?: Record<string, unknown>) => t(key, { defaultValue: fallback, ...opts })
  const queryClient = useQueryClient()
  const [tab, setTab] = useState<Tab>('users')
  const [search, setSearch] = useState('')
  const [note, setNote] = useState('')
  const [message, setMessage] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [viewId, setViewId] = useState<string | null>(null)
  const [pastPage, setPastPage] = useState(1)
  const [signoffOpen, setSignoffOpen] = useState(false)
  // a tab's page goes back to 1 with another tab, search or stored report, in the same render
  const tabPageKey = `${tab}\u0000${search}\u0000${viewId ?? ''}`
  const [tabPaged, setTabPaged] = useState({ key: tabPageKey, page: 1 })
  const tabPage = tabPaged.key === tabPageKey ? tabPaged.page : 1

  const { data: live, isLoading, isFetching, refetch, error: reportError, errorUpdatedAt: reportErrorAt } = useQuery({
    queryKey: ['access-review', 'report'],
    queryFn: () => api.getAccessReview(),
    retry: false,
  })
  const { data: viewed } = useQuery({
    queryKey: ['access-review', 'snapshot', viewId],
    queryFn: () => api.getAccessReviewSnapshot(viewId as string),
    enabled: !!viewId,
  })
  const signoff = useMutation({
    mutationFn: () => api.signoffAccessReview(note),
    onSuccess: (rev: AccessReviewSignoff) => {
      setNote('')
      setError(null)
      setSignoffOpen(false)
      setMessage(tr('accessReview.signoff.saved', 'Review signed off at {{when}}.', { when: formatWhen(rev.reviewed_at) }))
      queryClient.invalidateQueries({ queryKey: ['access-review'] })
    },
    onError: (err: any) => setError(err?.response?.data?.detail || tr('accessReview.signoff.failed', 'The sign-off was not saved.')),
  })

  const report: AccessReviewReport | undefined = viewId ? viewed?.snapshot : live
  const flagLabel = (f: string) => tr(`accessReview.flags.${f}`, f)
  const flags = (list: string[]) => (
    <div className="flex flex-wrap gap-1">
      {list.map((f) => (
        <span key={f} className={`inline-flex rounded-sm px-1.5 py-0.5 text-[11px] font-medium ${FLAG_TONE[f] ?? 'bg-slate-700 text-slate-300'}`} title={f}>
          {flagLabel(f)}
        </span>
      ))}
    </div>
  )
  const when = (iso?: string | null) => (iso ? formatWhen(iso) : '-')
  // a time alone in a cell: on one line, the UTC value on hover
  const whenCell = (iso?: string | null) => (iso ? <span className="whitespace-nowrap" title={utcTitle(iso)}>{formatWhen(iso)}</span> : '-')

  const columns = useMemo<Record<AccessReviewSection, Column<any>[]>>(() => ({
    users: [
      { key: 'email', label: tr('accessReview.col.email', 'Email'), render: (r) => <span className="text-ink">{r.email}</span>, text: (r) => r.email },
      { key: 'name', label: tr('accessReview.col.name', 'Name'), render: (r) => r.name, text: (r) => r.name },
      { key: 'team', label: tr('accessReview.col.team', 'Team'), render: (r) => r.team || '-', text: (r) => r.team },
      { key: 'global_role', label: tr('accessReview.col.globalRole', 'Global role'), render: (r) => r.global_role, text: (r) => r.global_role },
      { key: 'auth_source', label: tr('accessReview.col.authSource', 'Sign-in'), render: (r) => (r.auth_source ? tr(`accessReview.auth.${r.auth_source}`, r.auth_source) : '-') },
      { key: 'last_login_at', label: tr('accessReview.col.lastLogin', 'Last login'), render: (r) => whenCell(r.last_login_at) },
      { key: 'created_at', label: tr('accessReview.col.created', 'Created'), render: (r) => whenCell(r.created_at) },
      { key: 'counts', label: tr('accessReview.col.grantsKeys', 'Clusters / keys / temp'), render: (r) => `${r.cluster_roles} / ${r.api_keys} / ${r.temporary_grants}` },
      { key: 'flags', label: tr('accessReview.col.flags', 'Flags'), render: (r) => flags(r.flags), text: (r) => r.flags.join(' ') },
    ],
    cluster_roles: [
      { key: 'user_email', label: tr('accessReview.col.email', 'Email'), render: (r) => <span className="text-ink">{r.user_email}</span>, text: (r) => r.user_email },
      { key: 'cluster', label: tr('accessReview.col.cluster', 'Cluster'), render: (r) => r.cluster, text: (r) => r.cluster },
      { key: 'role', label: tr('accessReview.col.role', 'Role'), render: (r) => r.role, text: (r) => r.role },
      { key: 'namespaces', label: tr('accessReview.col.namespaces', 'Namespaces'), render: (r) => (r.namespaces?.length ? r.namespaces.join(', ') : tr('accessReview.wholeCluster', 'whole cluster')), text: (r) => (r.namespaces ?? []).join(' ') },
      { key: 'granted_via', label: tr('accessReview.col.grantedVia', 'Granted via'), render: (r) => r.granted_via, text: (r) => r.granted_via },
      { key: 'expires_at', label: tr('accessReview.col.expires', 'Expires'), render: (r) => whenCell(r.expires_at) },
      { key: 'restore_role', label: tr('accessReview.col.restoreRole', 'Then back to'), render: (r) => r.restore_role || '-' },
      { key: 'flags', label: tr('accessReview.col.flags', 'Flags'), render: (r) => flags(r.flags), text: (r) => r.flags.join(' ') },
    ],
    api_keys: [
      { key: 'owner_email', label: tr('accessReview.col.owner', 'Owner'), render: (r) => <span className="text-ink">{r.owner_email}</span>, text: (r) => r.owner_email },
      { key: 'name', label: tr('accessReview.col.name', 'Name'), render: (r) => `${r.name} (${r.key_prefix}…)`, text: (r) => `${r.name} ${r.key_prefix}` },
      { key: 'clusters', label: tr('accessReview.col.clusters', 'Clusters'), render: (r) => (r.clusters.length ? r.clusters.join(', ') : tr('accessReview.allClusters', 'all')), text: (r) => r.clusters.join(' ') },
      { key: 'role_ceiling', label: tr('accessReview.col.roleCeiling', 'Role ceiling'), render: (r) => r.role_ceiling },
      { key: 'created_at', label: tr('accessReview.col.created', 'Created'), render: (r) => whenCell(r.created_at) },
      { key: 'expires_at', label: tr('accessReview.col.expires', 'Expires'), render: (r) => whenCell(r.expires_at) },
      { key: 'last_used_at', label: tr('accessReview.col.lastUsed', 'Last used'), render: (r) => (r.last_used_at ? `${when(r.last_used_at)}${r.last_used_ip ? ` · ${r.last_used_ip}` : ''}` : tr('accessReview.never', 'never')) },
      { key: 'flags', label: tr('accessReview.col.flags', 'Flags'), render: (r) => flags(r.flags), text: (r) => r.flags.join(' ') },
    ],
    access_requests: [
      { key: 'requester_email', label: tr('accessReview.col.requester', 'Requester'), render: (r) => <span className="text-ink">{r.requester_email}</span>, text: (r) => r.requester_email },
      { key: 'cluster', label: tr('accessReview.col.cluster', 'Cluster'), render: (r) => `${r.cluster} · ${r.role}`, text: (r) => `${r.cluster} ${r.role}` },
      { key: 'duration', label: tr('accessReview.col.duration', 'Duration'), render: (r) => formatDuration(r.duration_minutes, t) },
      { key: 'reason', label: tr('accessReview.col.reason', 'Reason'), render: (r) => <span className="line-clamp-2">{r.reason}</span>, text: (r) => r.reason },
      { key: 'status', label: tr('accessReview.col.status', 'Status'), render: (r) => `${r.status}${r.end_reason ? ` (${r.end_reason})` : ''}`, text: (r) => r.status },
      { key: 'created_at', label: tr('accessReview.col.requested', 'Requested'), render: (r) => whenCell(r.created_at) },
      { key: 'decided', label: tr('accessReview.col.decided', 'Decided'), render: (r) => (r.decided_at ? `${when(r.decided_at)} · ${r.decided_by_email ?? ''}${r.decision_note ? ` · ${r.decision_note}` : ''}` : '-'), text: (r) => r.decided_by_email ?? '' },
    ],
    roles: [
      { key: 'name', label: tr('accessReview.col.role', 'Role'), render: (r) => <span className="text-ink">{r.name}{r.is_system ? ` (${tr('accessReview.system', 'system')})` : ''}</span>, text: (r) => r.name },
      { key: 'description', label: tr('accessReview.col.description', 'Description'), render: (r) => r.description || '-', text: (r) => r.description },
      { key: 'permissions', label: tr('accessReview.col.permissions', 'Permissions'), render: (r) => <span className="font-mono text-[11px] break-all">{r.permissions.join(', ') || '-'}</span>, text: (r) => r.permissions.join(' ') },
      { key: 'users', label: tr('accessReview.col.usersBindings', 'Users / bindings'), render: (r) => `${r.users} / ${r.cluster_bindings}` },
      { key: 'flags', label: tr('accessReview.col.flags', 'Flags'), render: (r) => flags(r.flags), text: (r) => r.flags.join(' ') },
    ],
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }), [t])

  const rows = useMemo(() => {
    if (!report || tab === 'history') return []
    const list: any[] = report[tab] ?? []
    const q = search.trim().toLowerCase()
    if (!q) return list
    const cols = columns[tab]
    return list.filter((r) => cols.map((c) => (c.text ? c.text(r) : '')).join(' ').toLowerCase().includes(q))
  }, [report, tab, search, columns])
  // The rows the table fits: measured again with another tab and once rows show (a row's height), not on each page,
  // so turning pages keeps one page size. A section's rows are known in this render, so the first frame with them is
  // measured; the sign-offs come from the server with the page size, so they are known an answer later.
  const [historyRows, setHistoryRows] = useState(false)
  const rowsShow = tab === 'history' ? historyRows : rows.length > 0
  const { containerRef, bodyRef, theadRef, firstRowRef, rowsPerPage, fit } = useAdaptiveTable({ recalculationKey: `${tab}:${rowsShow}` })
  // read with the page (the tab then opens on rows, not a loading line); a page being read keeps the sign-offs shown
  // before it. With Fit the first page is one block, so the count the Users tab gives reads it as well as the
  // History tab's own.
  const pastQuery = historyPage(pastPage, rowsPerPage, fit)
  const { data: past, isLoading: historyLoading, isPlaceholderData: pastLoading, error: historyError } = useQuery({
    queryKey: ['access-review', 'history', pastQuery],
    queryFn: async () => ({ ...(await api.listAccessReviews(pastQuery)), offset: pastQuery.offset, limit: pastQuery.limit }),
    placeholderData: keepPreviousData,
  })
  const pastTotal = past?.total ?? 0
  // the pager follows the answer on screen, with its page size (a first-page block cut at the rows that fit)
  const pastLimit = past ? answerPageSize(past, rowsPerPage) : rowsPerPage
  const history = (past?.items ?? []).slice(0, pastLimit)
  const pastPages = Math.max(1, Math.ceil(pastTotal / pastLimit))
  useEffect(() => {
    if (past && !pastLoading && pastPage > pastPages) setPastPage(pastPages)
  }, [past, pastLoading, pastPage, pastPages])
  // in the render the sign-offs come in, so the row height is measured before that frame is painted
  if (history.length > 0 !== historyRows) setHistoryRows(history.length > 0)
  // the answer holds every row of the section: the browser pages them, as many as the table fits
  const shown = pageOf(rows, tabPage, rowsPerPage)
  const setTabPage = (p: number) => setTabPaged({ key: tabPageKey, page: p })

  const download = (section: AccessReviewSection) => {
    const a = document.createElement('a')
    a.href = api.accessReviewExportUrl(section, { reviewId: viewId ?? undefined, since: viewId ? undefined : report?.since })
    a.download = ''
    document.body.appendChild(a)
    a.click()
    a.remove()
  }

  const sectionLabel = (s: AccessReviewSection) => tr(`accessReview.section.${s}`, s)
  const summary = report?.summary
  const cut = report ? requestsCut(report) : null
  const keyCount = report ? apiKeyTabCount(report) : null

  return (
    <div className="flex flex-col h-[calc(100vh-4rem)] gap-4">
      <div className="page-head items-start gap-4 shrink-0">
        <div>
          <div className="flex items-center gap-2">
            <ClipboardCheck className="w-6 h-6 text-primary-400" />
            <h1 className="text-3xl font-semibold text-ink">{tr('accessReview.title', 'Access review')}</h1>
          </div>
          <p className="text-slate-400 text-sm mt-1">
            {tr('accessReview.subtitle', 'Who can do what right now: accounts, per-cluster grants, API keys, temporary grants since the last review, roles. Review, export, sign off.')}
          </p>
        </div>
        <div className="flex items-center gap-2">
          {/* signing off stores the report as it stands now, not a stored one being viewed */}
          {!viewId && (
            <button
              type="button"
              onClick={() => { setError(null); setSignoffOpen(true) }}
              disabled={!live}
              data-testid="access-review-signoff-open"
              className="btn btn-primary flex items-center gap-2 disabled:opacity-50"
            >
              <ClipboardCheck className="w-4 h-4" />
              {tr('accessReview.signoff.button', 'Sign off')}
            </button>
          )}
          <button
            onClick={() => refetch()}
            disabled={isFetching || !!viewId}
            className="btn btn-primary flex items-center gap-2 disabled:opacity-50"
          >
            <RefreshCw className={`w-4 h-4 ${isFetching ? 'animate-spin' : ''}`} />
            {tr('accessReview.refresh', 'Refresh')}
          </button>
        </div>
      </div>

      {viewId && viewed && (
        <div className="shrink-0 rounded-lg border border-primary-500/40 bg-primary-500/10 p-3 text-sm text-primary-100 flex items-center justify-between gap-3" data-testid="access-review-snapshot-banner">
          <span>
            <History className="inline w-4 h-4 mr-1" />
            {tr('accessReview.snapshot.viewing', 'Viewing the report as signed off on {{when}} by {{who}}.', { when: formatWhen(viewed.reviewed_at), who: viewed.reviewed_by_email })}
            {viewed.note && <span className="text-primary-200/80"> · {viewed.note}</span>}
          </span>
          <button onClick={() => setViewId(null)} className="rounded-sm bg-slate-700 hover:bg-slate-600 px-2 py-1 text-xs text-ink flex items-center gap-1">
            <X className="w-3 h-3" /> {tr('accessReview.snapshot.back', 'Back to now')}
          </button>
        </div>
      )}

      {reportError && !report && (
        <div className="shrink-0 rounded-lg border border-red-500/40 bg-red-500/10 p-3 text-sm text-red-200" data-testid="access-review-error">
          {failureText(reportError)}
        </div>
      )}
      {/* a Refresh that failed while a report is on screen: that report is the one before */}
      <RefreshFailure failure={!viewId && live ? failureOf(reportError, reportErrorAt) : null} />

      {summary && (
        <div className="shrink-0 grid grid-cols-2 md:grid-cols-4 lg:grid-cols-8 gap-3" data-testid="access-review-summary">
          {([
            ['users', summary.users, 'accessReview.card.users', 'Accounts'],
            // every account whose global role carries "*" or an admin.* permission; beside it the "*" ones
            ['global_admins', summary.global_admins, 'accessReview.card.adminPermissions', 'With admin permissions',
              summary.full_admins === undefined ? undefined : tr('accessReview.card.fullAdmins', '{{count}} global admins', { count: summary.full_admins })],
            // a report that keeps the lock's settings counts dormant as the lock does (older sign-offs: sign-ins only)
            ['dormant', summary.dormant, 'accessReview.card.dormant', 'Dormant', undefined,
              report?.settings.lock_enabled === undefined ? undefined
                : tr('accessReview.card.dormantHint', 'No sign-in or API key use for {{days}} days — the activity the dormant lock checks', { days: report.settings.dormant_days })],
            ['never_logged_in', summary.never_logged_in, 'accessReview.card.neverLoggedIn', 'Never signed in'],
            ['cluster_grants', summary.cluster_grants, 'accessReview.card.clusterGrants', 'Cluster grants'],
            ['temporary_grants', summary.temporary_grants, 'accessReview.card.temporaryGrants', 'Temporary'],
            ['api_keys_active', summary.api_keys_active, 'accessReview.card.apiKeys', 'Active API keys'],
            ['api_keys_expiring', summary.api_keys_expiring, 'accessReview.card.apiKeysExpiring', 'Keys expiring ≤30d'],
          ] as [string, number, string, string, string?, string?][]).map(([key, value, i18nKey, fallback, sub, hint]) => (
            <div key={key} className="rounded-lg bg-slate-800/50 border border-slate-700 p-3" data-testid={`access-review-card-${key}`} title={hint}>
              <div className="text-xs text-slate-400">{tr(i18nKey, fallback)}</div>
              <div className={`text-2xl font-semibold ${['dormant', 'global_admins', 'api_keys_expiring'].includes(key) && value > 0 ? 'text-yellow-300' : 'text-ink'}`}>{value}</div>
              {sub !== undefined && <div className="text-[11px] text-slate-400" data-testid={`access-review-card-${key}-sub`}>{sub}</div>}
            </div>
          ))}
        </div>
      )}

      {report && (
        <div className="shrink-0 rounded-lg bg-slate-800/50 border border-slate-700 p-3 text-sm flex flex-wrap items-center gap-x-6 gap-y-1" data-testid="access-review-last-review">
          <span className="text-slate-300">
            {report.last_review
              ? tr('accessReview.lastReview', 'Last review {{when}} by {{who}}', { when: formatWhen(report.last_review.reviewed_at), who: report.last_review.reviewed_by_email })
              : tr('accessReview.noReview', 'No review signed off yet')}
          </span>
          <span className={report.overdue ? 'text-red-300 font-medium' : 'text-slate-300'}>
            {report.next_due_at
              ? tr(report.overdue ? 'accessReview.overdue' : 'accessReview.nextDue', report.overdue ? 'Overdue since {{when}}' : 'Next due {{when}}', { when: formatWhen(report.next_due_at) })
              : tr('accessReview.intervalHint', 'A review is due every {{days}} days.', { days: report.settings.interval_days })}
            {report.overdue && <AlertTriangle className="inline w-4 h-4 ml-1" />}
          </span>
          <span className="text-slate-500">
            {tr('accessReview.generatedAt', 'Report as of {{when}}; requests since {{since}}.', { when: formatWhen(report.generated_at), since: formatWhen(report.since) })}
          </span>
          {message && !viewId && <span className="text-green-300" data-testid="access-review-signoff-message">{message}</span>}
        </div>
      )}

      <div className="shrink-0 flex flex-wrap items-center gap-2">
        {ACCESS_REVIEW_SECTIONS.map((s) => (
          <button
            key={s}
            onClick={() => setTab(s)}
            data-testid={`access-review-tab-${s}`}
            className={`rounded-sm px-3 py-1.5 text-sm ${tab === s ? 'bg-primary-600 text-white' : 'bg-slate-700 hover:bg-slate-600 text-slate-200'}`}
          >
            {sectionLabel(s)}{' '}
            {report ? (
              <span className="text-xs">
                {s === 'api_keys' && keyCount && keyCount.expired > 0
                  ? tr('accessReview.tabCountExpired', '({{count}} · {{expired}} expired)', { count: keyCount.all, expired: keyCount.expired })
                  : `(${(report[s] ?? []).length})`}
              </span>
            ) : null}
          </button>
        ))}
        <button
          onClick={() => setTab('history')}
          data-testid="access-review-tab-history"
          className={`rounded-sm px-3 py-1.5 text-sm flex items-center gap-1 ${tab === 'history' ? 'bg-primary-600 text-white' : 'bg-slate-700 hover:bg-slate-600 text-slate-200'}`}
        >
          <History className="w-4 h-4" /> {tr('accessReview.section.history', 'Past reviews')}
        </button>
        {tab !== 'history' && (
          <>
            <input
              type="text"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder={tr('accessReview.search', 'Search...')}
              className="ml-auto h-10 px-3 bg-slate-700 text-ink rounded-lg border border-slate-600 focus:outline-hidden focus:border-primary-500 text-sm"
            />
            <button
              onClick={() => download(tab)}
              disabled={!report}
              data-testid="access-review-export"
              className="btn btn-primary flex items-center gap-2 disabled:opacity-50"
            >
              <Download className="w-4 h-4" /> CSV
            </button>
          </>
        )}
      </div>

      {tab === 'access_requests' && cut && (
        <div className="shrink-0 rounded-lg border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-sm text-amber-200" data-testid="access-review-requests-cut">
          {tr('accessReview.requestsCut', 'The newest {{shown}} of {{total}} requests since {{since}} are listed here and in the CSV.', { shown: cut.shown, total: cut.total, since: formatWhen(cut.since) })}
        </div>
      )}

      <div ref={containerRef} className="flex-1 min-h-0 flex flex-col rounded-lg bg-slate-800/50 border border-slate-700">
        <div ref={bodyRef} className="overflow-x-auto flex-1 min-h-0">
          {tab === 'history' ? (
            <table className="min-w-full text-sm" data-testid="access-review-history-table">
              <thead ref={theadRef} className="text-slate-400">
                <tr>
                  <th className="px-3 py-2 text-left">{tr('accessReview.col.reviewedAt', 'Signed off')}</th>
                  <th className="px-3 py-2 text-left">{tr('accessReview.col.reviewedBy', 'By')}</th>
                  <th className="px-3 py-2 text-left">{tr('accessReview.col.note', 'Note')}</th>
                  <th className="px-3 py-2 text-left">{tr('accessReview.col.counts', 'Accounts / admins / dormant / keys')}</th>
                  <th className="px-3 py-2" />
                </tr>
              </thead>
              <tbody>
                {history.map((h, idx) => (
                  <tr key={h.id} ref={idx === 0 ? firstRowRef : undefined} className="border-t border-slate-700/60 text-slate-300" data-testid="access-review-history-row">
                    <td className="px-3 py-2 whitespace-nowrap text-ink" title={utcTitle(h.reviewed_at)}>{formatWhen(h.reviewed_at)}</td>
                    <td className="px-3 py-2">{h.reviewed_by_email}</td>
                    <td className="px-3 py-2">{h.note || '-'}</td>
                    <td className="px-3 py-2 whitespace-nowrap">{h.counts?.users ?? '-'} / {h.counts?.global_admins ?? '-'} / {h.counts?.dormant ?? '-'} / {h.counts?.api_keys_active ?? '-'}</td>
                    <td className="px-3 py-2 text-right">
                      <button onClick={() => { setViewId(h.id); setTab('users') }} className="rounded-sm bg-slate-700 hover:bg-slate-600 px-2 py-1 text-xs text-ink">
                        {tr('accessReview.open', 'Open')}
                      </button>
                    </td>
                  </tr>
                ))}
                {history.length === 0 && (
                  <TableEmptyRow colSpan={HISTORY_COLUMNS} resource="access-review-history" className="p-6 text-left text-slate-400">
                    {historyLoading ? (
                      <span className="inline-flex items-center gap-2"><Loader2 className="w-4 h-4 animate-spin" /> {tr('accessReview.loading', 'Loading...')}</span>
                    ) : historyError && !past ? (
                      <span className="text-red-300">{(historyError as any)?.response?.data?.detail || (historyError as Error).message}</span>
                    ) : tr('accessReview.noHistory', 'No review has been signed off yet.')}
                  </TableEmptyRow>
                )}
              </tbody>
              <AdaptiveTableFillerRows count={rowsPerPage - history.length} columnCount={HISTORY_COLUMNS} cellClassName="py-2" />
            </table>
          ) : (
            <table className="min-w-full text-sm" data-testid="access-review-table">
              <thead ref={theadRef} className="text-slate-400">
                <tr>{columns[tab].map((c) => <th key={c.key} className="px-3 py-2 text-left whitespace-nowrap">{c.label}</th>)}</tr>
              </thead>
              <tbody>
                {shown.rows.map((r, i) => (
                  <tr key={i} ref={i === 0 ? firstRowRef : undefined} className="border-t border-slate-700/60 text-slate-300 align-top" data-testid="access-review-row">
                    {columns[tab].map((c) => <td key={c.key} className="px-3 py-2">{c.render(r)}</td>)}
                  </tr>
                ))}
                {shown.rows.length === 0 && (
                  <TableEmptyRow colSpan={columns[tab].length} resource="access-review" className="p-6 text-left text-slate-400">
                    {isLoading || (viewId && !viewed) ? (
                      <span className="inline-flex items-center gap-2"><Loader2 className="w-4 h-4 animate-spin" /> {tr('accessReview.loading', 'Loading...')}</span>
                    ) : tr('accessReview.empty', 'Nothing to show.')}
                  </TableEmptyRow>
                )}
              </tbody>
              <AdaptiveTableFillerRows count={rowsPerPage - shown.rows.length} columnCount={columns[tab].length} cellClassName="py-2" />
            </table>
          )}
        </div>
        {tab === 'history' ? (
          <ListPager
            currentPage={past ? past.offset / pastLimit + 1 : pastPage}
            totalPages={pastPages}
            total={pastTotal}
            rowsPerPage={pastLimit}
            onPageChange={(p) => { if (!pastLoading) setPastPage(p) }}
            testId="access-review-history-pager"
          />
        ) : (
          <ListPager
            currentPage={shown.page}
            totalPages={shown.pages}
            total={rows.length}
            rowsPerPage={rowsPerPage}
            onPageChange={setTabPage}
            testId="access-review-pager"
          />
        )}
      </div>

      {signoffOpen && !viewId && (
        <ModalFrame
          size="md"
          title={tr('accessReview.signoff.title', 'Sign off this review')}
          subtitle={tr('accessReview.signoff.hint', 'Stores the report as it stands with your name, the time and your note, so the review can be shown later. Change any access on the Users, Clusters and API keys pages first.')}
          onClose={() => setSignoffOpen(false)}
          busy={signoff.isPending}
          testId="access-review-signoff-panel"
          footerStart={error ? <span className="text-red-300" role="alert">{error}</span> : undefined}
          footer={
            <>
              <button type="button" onClick={() => setSignoffOpen(false)} className={modalButton.cancel} disabled={signoff.isPending}>
                {tr('common.cancel', 'Cancel')}
              </button>
              <button
                type="button"
                onClick={() => signoff.mutate()}
                disabled={signoff.isPending || !live}
                data-testid="access-review-signoff"
                className={modalButton.primary}
              >
                {signoff.isPending ? <Loader2 className="w-4 h-4 animate-spin" /> : <ClipboardCheck className="w-4 h-4" />}
                {tr('accessReview.signoff.button', 'Sign off')}
              </button>
            </>
          }
        >
          <textarea
            value={note}
            onChange={(e) => setNote(e.target.value)}
            maxLength={2000}
            rows={4}
            autoFocus
            placeholder={tr('accessReview.signoff.notePlaceholder', 'Findings and actions taken (optional)')}
            data-testid="access-review-signoff-note"
            className="w-full px-3 py-2 bg-slate-700 text-ink rounded-sm border border-slate-600 focus:outline-hidden focus:border-primary-500 text-sm"
          />
        </ModalFrame>
      )}
    </div>
  )
}
