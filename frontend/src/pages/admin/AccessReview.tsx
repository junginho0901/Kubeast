import { useMemo, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
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

// Admin → Access review: the report of who has what (accounts, per-cluster
// grants, API keys, temporary grants since the last review, roles) with the
// flags a reviewer looks for, one CSV per section, and the sign-off that
// records the review was done. A past sign-off opens as the report it stored.

type Tab = AccessReviewSection | 'history'

const FLAG_TONE: Record<string, string> = {
  global_admin: 'bg-red-500/20 text-red-300',
  admin_role: 'bg-red-500/20 text-red-300',
  has_admin_permissions: 'bg-red-500/20 text-red-300',
  dormant: 'bg-red-500/20 text-red-300',
  expired: 'bg-red-500/20 text-red-300',
  locked: 'bg-yellow-500/20 text-yellow-300',
  dormant_locked: 'bg-red-500/20 text-red-300',
  never_logged_in: 'bg-yellow-500/20 text-yellow-300',
  expiring_30d: 'bg-yellow-500/20 text-yellow-300',
  unused_30d: 'bg-yellow-500/20 text-yellow-300',
  unused: 'bg-yellow-500/20 text-yellow-300',
  temporary: 'bg-blue-500/20 text-blue-300',
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

  const { data: live, isLoading, isFetching, refetch, error: reportError } = useQuery({
    queryKey: ['access-review', 'report'],
    queryFn: () => api.getAccessReview(),
    retry: false,
  })
  const { data: history = [], isLoading: historyLoading } = useQuery({
    queryKey: ['access-review', 'history'],
    queryFn: api.listAccessReviews,
    enabled: tab === 'history' || !!viewId,
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

  const columns = useMemo<Record<AccessReviewSection, Column<any>[]>>(() => ({
    users: [
      { key: 'email', label: tr('accessReview.col.email', 'Email'), render: (r) => <span className="text-white">{r.email}</span>, text: (r) => r.email },
      { key: 'name', label: tr('accessReview.col.name', 'Name'), render: (r) => r.name, text: (r) => r.name },
      { key: 'team', label: tr('accessReview.col.team', 'Team'), render: (r) => r.team || '-', text: (r) => r.team },
      { key: 'global_role', label: tr('accessReview.col.globalRole', 'Global role'), render: (r) => r.global_role, text: (r) => r.global_role },
      { key: 'auth_source', label: tr('accessReview.col.authSource', 'Sign-in'), render: (r) => (r.auth_source ? tr(`accessReview.auth.${r.auth_source}`, r.auth_source) : '-') },
      { key: 'last_login_at', label: tr('accessReview.col.lastLogin', 'Last login'), render: (r) => when(r.last_login_at) },
      { key: 'created_at', label: tr('accessReview.col.created', 'Created'), render: (r) => when(r.created_at) },
      { key: 'counts', label: tr('accessReview.col.grantsKeys', 'Clusters / keys / temp'), render: (r) => `${r.cluster_roles} / ${r.api_keys} / ${r.temporary_grants}` },
      { key: 'flags', label: tr('accessReview.col.flags', 'Flags'), render: (r) => flags(r.flags), text: (r) => r.flags.join(' ') },
    ],
    cluster_roles: [
      { key: 'user_email', label: tr('accessReview.col.email', 'Email'), render: (r) => <span className="text-white">{r.user_email}</span>, text: (r) => r.user_email },
      { key: 'cluster', label: tr('accessReview.col.cluster', 'Cluster'), render: (r) => r.cluster, text: (r) => r.cluster },
      { key: 'role', label: tr('accessReview.col.role', 'Role'), render: (r) => r.role, text: (r) => r.role },
      { key: 'granted_via', label: tr('accessReview.col.grantedVia', 'Granted via'), render: (r) => r.granted_via, text: (r) => r.granted_via },
      { key: 'expires_at', label: tr('accessReview.col.expires', 'Expires'), render: (r) => when(r.expires_at) },
      { key: 'restore_role', label: tr('accessReview.col.restoreRole', 'Then back to'), render: (r) => r.restore_role || '-' },
      { key: 'flags', label: tr('accessReview.col.flags', 'Flags'), render: (r) => flags(r.flags), text: (r) => r.flags.join(' ') },
    ],
    api_keys: [
      { key: 'owner_email', label: tr('accessReview.col.owner', 'Owner'), render: (r) => <span className="text-white">{r.owner_email}</span>, text: (r) => r.owner_email },
      { key: 'name', label: tr('accessReview.col.name', 'Name'), render: (r) => `${r.name} (${r.key_prefix}…)`, text: (r) => `${r.name} ${r.key_prefix}` },
      { key: 'clusters', label: tr('accessReview.col.clusters', 'Clusters'), render: (r) => (r.clusters.length ? r.clusters.join(', ') : tr('accessReview.allClusters', 'all')), text: (r) => r.clusters.join(' ') },
      { key: 'role_ceiling', label: tr('accessReview.col.roleCeiling', 'Role ceiling'), render: (r) => r.role_ceiling },
      { key: 'created_at', label: tr('accessReview.col.created', 'Created'), render: (r) => when(r.created_at) },
      { key: 'expires_at', label: tr('accessReview.col.expires', 'Expires'), render: (r) => when(r.expires_at) },
      { key: 'last_used_at', label: tr('accessReview.col.lastUsed', 'Last used'), render: (r) => (r.last_used_at ? `${when(r.last_used_at)}${r.last_used_ip ? ` · ${r.last_used_ip}` : ''}` : tr('accessReview.never', 'never')) },
      { key: 'flags', label: tr('accessReview.col.flags', 'Flags'), render: (r) => flags(r.flags), text: (r) => r.flags.join(' ') },
    ],
    access_requests: [
      { key: 'requester_email', label: tr('accessReview.col.requester', 'Requester'), render: (r) => <span className="text-white">{r.requester_email}</span>, text: (r) => r.requester_email },
      { key: 'cluster', label: tr('accessReview.col.cluster', 'Cluster'), render: (r) => `${r.cluster} · ${r.role}`, text: (r) => `${r.cluster} ${r.role}` },
      { key: 'duration', label: tr('accessReview.col.duration', 'Duration'), render: (r) => formatDuration(r.duration_minutes) },
      { key: 'reason', label: tr('accessReview.col.reason', 'Reason'), render: (r) => <span className="line-clamp-2">{r.reason}</span>, text: (r) => r.reason },
      { key: 'status', label: tr('accessReview.col.status', 'Status'), render: (r) => `${r.status}${r.end_reason ? ` (${r.end_reason})` : ''}`, text: (r) => r.status },
      { key: 'created_at', label: tr('accessReview.col.requested', 'Requested'), render: (r) => when(r.created_at) },
      { key: 'decided', label: tr('accessReview.col.decided', 'Decided'), render: (r) => (r.decided_at ? `${when(r.decided_at)} · ${r.decided_by_email ?? ''}${r.decision_note ? ` · ${r.decision_note}` : ''}` : '-'), text: (r) => r.decided_by_email ?? '' },
    ],
    roles: [
      { key: 'name', label: tr('accessReview.col.role', 'Role'), render: (r) => <span className="text-white">{r.name}{r.is_system ? ` (${tr('accessReview.system', 'system')})` : ''}</span>, text: (r) => r.name },
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

  return (
    <div className="space-y-4">
      <div className="flex items-start justify-between gap-4">
        <div>
          <div className="flex items-center gap-2">
            <ClipboardCheck className="w-6 h-6 text-primary-400" />
            <h1 className="text-3xl font-bold text-white">{tr('accessReview.title', 'Access review')}</h1>
          </div>
          <p className="text-slate-400 text-sm mt-1">
            {tr('accessReview.subtitle', 'Who can do what right now: accounts, per-cluster grants, API keys, temporary grants since the last review, roles. Review, export, sign off.')}
          </p>
        </div>
        <button
          onClick={() => refetch()}
          disabled={isFetching || !!viewId}
          className="btn btn-primary flex items-center gap-2 disabled:opacity-50"
        >
          <RefreshCw className={`w-4 h-4 ${isFetching ? 'animate-spin' : ''}`} />
          {tr('accessReview.refresh', 'Refresh')}
        </button>
      </div>

      {viewId && viewed && (
        <div className="rounded-lg border border-blue-500/40 bg-blue-500/10 p-3 text-sm text-blue-100 flex items-center justify-between gap-3" data-testid="access-review-snapshot-banner">
          <span>
            <History className="inline w-4 h-4 mr-1" />
            {tr('accessReview.snapshot.viewing', 'Viewing the report as signed off on {{when}} by {{who}}.', { when: formatWhen(viewed.reviewed_at), who: viewed.reviewed_by_email })}
            {viewed.note && <span className="text-blue-200/80"> · {viewed.note}</span>}
          </span>
          <button onClick={() => setViewId(null)} className="rounded-sm bg-slate-700 hover:bg-slate-600 px-2 py-1 text-xs text-white flex items-center gap-1">
            <X className="w-3 h-3" /> {tr('accessReview.snapshot.back', 'Back to now')}
          </button>
        </div>
      )}

      {reportError && !report && (
        <div className="rounded-lg border border-red-500/40 bg-red-500/10 p-3 text-sm text-red-200" data-testid="access-review-error">
          {(reportError as any)?.response?.data?.detail || (reportError as Error).message}
        </div>
      )}

      {summary && (
        <div className="grid grid-cols-2 md:grid-cols-4 lg:grid-cols-8 gap-3" data-testid="access-review-summary">
          {[
            ['users', summary.users, 'accessReview.card.users', 'Accounts'],
            ['global_admins', summary.global_admins, 'accessReview.card.globalAdmins', 'Global admins'],
            ['dormant', summary.dormant, 'accessReview.card.dormant', 'Dormant'],
            ['never_logged_in', summary.never_logged_in, 'accessReview.card.neverLoggedIn', 'Never signed in'],
            ['cluster_grants', summary.cluster_grants, 'accessReview.card.clusterGrants', 'Cluster grants'],
            ['temporary_grants', summary.temporary_grants, 'accessReview.card.temporaryGrants', 'Temporary'],
            ['api_keys_active', summary.api_keys_active, 'accessReview.card.apiKeys', 'Active API keys'],
            ['api_keys_expiring', summary.api_keys_expiring, 'accessReview.card.apiKeysExpiring', 'Keys expiring ≤30d'],
          ].map(([key, value, i18nKey, fallback]) => (
            <div key={String(key)} className="rounded-lg bg-slate-800/50 border border-slate-700 p-3" data-testid={`access-review-card-${key}`}>
              <div className="text-xs text-slate-400">{tr(String(i18nKey), String(fallback))}</div>
              <div className={`text-2xl font-semibold ${['dormant', 'global_admins', 'api_keys_expiring'].includes(String(key)) && Number(value) > 0 ? 'text-yellow-300' : 'text-white'}`}>{value}</div>
            </div>
          ))}
        </div>
      )}

      {report && (
        <div className="rounded-lg bg-slate-800/50 border border-slate-700 p-3 text-sm flex flex-wrap items-center gap-x-6 gap-y-1" data-testid="access-review-last-review">
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
        </div>
      )}

      <div className="flex flex-wrap items-center gap-2">
        {ACCESS_REVIEW_SECTIONS.map((s) => (
          <button
            key={s}
            onClick={() => setTab(s)}
            data-testid={`access-review-tab-${s}`}
            className={`rounded-sm px-3 py-1.5 text-sm ${tab === s ? 'bg-primary-600 text-white' : 'bg-slate-700 hover:bg-slate-600 text-slate-200'}`}
          >
            {sectionLabel(s)} {report ? <span className="text-xs opacity-70">({(report[s] ?? []).length})</span> : null}
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
              className="ml-auto h-10 px-3 bg-slate-700 text-white rounded-lg border border-slate-600 focus:outline-hidden focus:border-primary-500 text-sm"
            />
            <button
              onClick={() => download(tab)}
              disabled={!report}
              data-testid="access-review-export"
              className="rounded-sm bg-slate-700 hover:bg-slate-600 disabled:opacity-50 px-3 py-1.5 text-sm text-white flex items-center gap-2"
            >
              <Download className="w-4 h-4" /> CSV
            </button>
          </>
        )}
      </div>

      {tab === 'history' ? (
        <div className="rounded-lg bg-slate-800/50 border border-slate-700 overflow-x-auto">
          {historyLoading ? (
            <div className="p-6 text-slate-400 flex items-center gap-2"><Loader2 className="w-4 h-4 animate-spin" /> {tr('accessReview.loading', 'Loading...')}</div>
          ) : history.length === 0 ? (
            <div className="p-6 text-slate-400">{tr('accessReview.noHistory', 'No review has been signed off yet.')}</div>
          ) : (
            <table className="min-w-full text-sm">
              <thead className="text-xs text-slate-400">
                <tr>
                  <th className="px-3 py-2 text-left">{tr('accessReview.col.reviewedAt', 'Signed off')}</th>
                  <th className="px-3 py-2 text-left">{tr('accessReview.col.reviewedBy', 'By')}</th>
                  <th className="px-3 py-2 text-left">{tr('accessReview.col.note', 'Note')}</th>
                  <th className="px-3 py-2 text-left">{tr('accessReview.col.counts', 'Accounts / admins / dormant / keys')}</th>
                  <th className="px-3 py-2" />
                </tr>
              </thead>
              <tbody>
                {history.map((h) => (
                  <tr key={h.id} className="border-t border-slate-700/60 text-slate-300" data-testid="access-review-history-row">
                    <td className="px-3 py-2 whitespace-nowrap text-white">{formatWhen(h.reviewed_at)}</td>
                    <td className="px-3 py-2">{h.reviewed_by_email}</td>
                    <td className="px-3 py-2">{h.note || '-'}</td>
                    <td className="px-3 py-2 whitespace-nowrap">{h.counts?.users ?? '-'} / {h.counts?.global_admins ?? '-'} / {h.counts?.dormant ?? '-'} / {h.counts?.api_keys_active ?? '-'}</td>
                    <td className="px-3 py-2 text-right">
                      <button onClick={() => { setViewId(h.id); setTab('users') }} className="rounded-sm bg-slate-700 hover:bg-slate-600 px-2 py-1 text-xs text-white">
                        {tr('accessReview.open', 'Open')}
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      ) : (
        <div className="rounded-lg bg-slate-800/50 border border-slate-700 overflow-x-auto">
          {isLoading || (viewId && !viewed) ? (
            <div className="p-6 text-slate-400 flex items-center gap-2"><Loader2 className="w-4 h-4 animate-spin" /> {tr('accessReview.loading', 'Loading...')}</div>
          ) : rows.length === 0 ? (
            <div className="p-6 text-slate-400">{tr('accessReview.empty', 'Nothing to show.')}</div>
          ) : (
            <table className="min-w-full text-sm" data-testid="access-review-table">
              <thead className="text-xs text-slate-400">
                <tr>{columns[tab].map((c) => <th key={c.key} className="px-3 py-2 text-left font-medium whitespace-nowrap">{c.label}</th>)}</tr>
              </thead>
              <tbody>
                {rows.map((r, i) => (
                  <tr key={i} className="border-t border-slate-700/60 text-slate-300 align-top" data-testid="access-review-row">
                    {columns[tab].map((c) => <td key={c.key} className="px-3 py-2">{c.render(r)}</td>)}
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      )}

      {!viewId && (
        <div className="rounded-lg bg-slate-800/50 border border-slate-700 p-4 space-y-2" data-testid="access-review-signoff-panel">
          <div className="text-sm font-medium text-white">{tr('accessReview.signoff.title', 'Sign off this review')}</div>
          <p className="text-xs text-slate-400">
            {tr('accessReview.signoff.hint', 'Stores the report as it stands with your name, the time and your note, so the review can be shown later. Change any access on the Users, Clusters and API keys pages first.')}
          </p>
          <textarea
            value={note}
            onChange={(e) => setNote(e.target.value)}
            maxLength={2000}
            rows={2}
            placeholder={tr('accessReview.signoff.notePlaceholder', 'Findings and actions taken (optional)')}
            data-testid="access-review-signoff-note"
            className="w-full px-3 py-2 bg-slate-700 text-white rounded-sm border border-slate-600 focus:outline-hidden focus:border-primary-500 text-sm"
          />
          <div className="flex items-center gap-3">
            <button
              onClick={() => signoff.mutate()}
              disabled={signoff.isPending || !live}
              data-testid="access-review-signoff"
              className="rounded-sm bg-primary-600 hover:bg-primary-500 disabled:opacity-50 px-3 py-1.5 text-sm text-white flex items-center gap-2"
            >
              {signoff.isPending ? <Loader2 className="w-4 h-4 animate-spin" /> : <ClipboardCheck className="w-4 h-4" />}
              {tr('accessReview.signoff.button', 'Sign off')}
            </button>
            {message && <span className="text-sm text-green-300" data-testid="access-review-signoff-message">{message}</span>}
            {error && <span className="text-sm text-red-300">{error}</span>}
          </div>
        </div>
      )}
    </div>
  )
}
