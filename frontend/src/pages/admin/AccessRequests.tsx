import { useEffect, useState } from 'react'
import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useTranslation } from 'react-i18next'
import { Check, Clock, Loader2, Search, ShieldCheck, X } from 'lucide-react'

import { api } from '@/services/api'
import StatusBadge from '@/components/AccessRequestStatusBadge'
import { ListPager } from '@/components/ListPager'
import { AdaptiveTableFillerRows } from '@/components/AdaptiveTableFillerRows'
import { formatDuration, formatWhen } from './accessRequestFormat'
import { accessRequestQuery, pageCount, type AccessRequestTab } from './accessRequestPages'
import { usePendingAccessRequestCount } from '@/hooks/usePendingAccessRequestCount'
import { useAdaptiveTable } from '@/hooks/useAdaptiveTable'
import { utcTitle } from '@/utils/time'
import { givesChartBoundRole } from '@/utils/adminAccess'
import { parsePermissions } from '@/utils/permissions'

// Admin review of access requests (temporary per-cluster role grants):
// pending requests to approve or reject with an optional note, and the
// history. The server refuses a decision on the reviewer's own request; the
// row says so instead of offering the buttons. Both tabs search by requester, cluster, role, reason and
// decider, and page: the page is as high as the screen and a page of the table is the rows it fits (or the
// footer's fixed choice). The server searches, pages and counts each tab, so the history reaches its first
// request; a page being read keeps the rows shown before it.

export default function AccessRequests() {
  const { t } = useTranslation()
  const tr = (key: string, fallback: string, opts?: Record<string, unknown>) => t(key, { defaultValue: fallback, ...opts })
  const queryClient = useQueryClient()
  const [tab, setTab] = useState<AccessRequestTab>('pending')
  const [notes, setNotes] = useState<Record<string, string>>({})
  const [error, setError] = useState<string | null>(null)
  // the server searches every request, not only the page shown; asked once typing pauses
  const [searchInput, setSearchInput] = useState('')
  const [search, setSearch] = useState('')
  useEffect(() => {
    const timer = setTimeout(() => setSearch(searchInput.trim()), 300)
    return () => clearTimeout(timer)
  }, [searchInput])
  // the page goes back to 1 with another tab or search, in the same render (no read of the old page number)
  const pageKey = `${tab}\u0000${search}`
  const [paged, setPaged] = useState({ key: pageKey, page: 1 })
  const page = paged.key === pageKey ? paged.page : 1
  const setPage = (p: number) => setPaged({ key: pageKey, page: p })

  const { data: me } = useQuery({ queryKey: ['me'], queryFn: api.me, staleTime: 30_000, retry: false })
  // a role the chart binds is approved only by a global admin or an Admin of its cluster (givesChartBoundRole)
  const { data: roles = [] } = useQuery({ queryKey: ['roles'], queryFn: api.listRoles, staleTime: 60_000 })
  const chartBound = new Set(roles.filter((role) => role.chart_bound).map((role) => role.name))
  const approvalHeld = (role: string, cluster: string) =>
    chartBound.has(role) && !givesChartBoundRole(parsePermissions(me?.permissions_matrix), me?.cluster_roles, me?.cluster_namespaces, cluster)
  const { data: config } = useQuery({ queryKey: ['access-requests', 'config'], queryFn: api.getAccessRequestsConfig, staleTime: 60_000 })
  const { data: pendingCount = 0 } = usePendingAccessRequestCount({ enabled: true, refetchInterval: 30_000 })
  // The table takes the screen's height left and the server is asked for the rows it fits: measured again once rows
  // show (a row's height), not on each page, so turning pages keeps one page size.
  const [hasRows, setHasRows] = useState(false)
  const { containerRef, bodyRef, theadRef, firstRowRef, rowsPerPage } = useAdaptiveTable({ recalculationKey: `${tab}:${hasRows}` })
  // Both tabs are read (the one not shown at its first page), so switching shows rows at once; each keeps the
  // rows it showed while its next page or search loads.
  const tabQuery = (k: AccessRequestTab) => accessRequestQuery(k, search, tab === k ? page : 1, rowsPerPage)
  const pendingList = useQuery({
    queryKey: ['access-requests', 'admin', 'list', 'pending', tabQuery('pending')],
    queryFn: async () => {
      const q = tabQuery('pending')
      return { ...(await api.adminAccessRequestsPage(q)), offset: q.offset, limit: q.limit }
    },
    placeholderData: keepPreviousData,
    refetchInterval: 30_000,
  })
  const historyList = useQuery({
    queryKey: ['access-requests', 'admin', 'list', 'history', tabQuery('history')],
    queryFn: async () => {
      const q = tabQuery('history')
      return { ...(await api.adminAccessRequestsPage(q)), offset: q.offset, limit: q.limit }
    },
    placeholderData: keepPreviousData,
  })
  const list = tab === 'pending' ? pendingList : historyList
  const pagedRows = list.data?.items ?? []
  const total = list.data?.total ?? 0
  // the pager follows the answer on screen: its page size, and its page, which does not turn while the next loads
  const shownLimit = list.data?.limit ?? rowsPerPage
  const totalPages = pageCount(total, shownLimit)
  const shownPage = list.data ? list.data.offset / shownLimit + 1 : page
  useEffect(() => {
    if (pagedRows.length > 0 !== hasRows) setHasRows(pagedRows.length > 0)
  }, [pagedRows.length, hasRows])
  const turnPage = (p: number) => {
    if (!list.isPlaceholderData) setPage(p)
  }
  useEffect(() => {
    if (!list.isPlaceholderData && page > totalPages) setPaged({ key: pageKey, page: totalPages })
  }, [list.isPlaceholderData, page, totalPages, pageKey])

  const invalidate = () => {
    queryClient.invalidateQueries({ queryKey: ['access-requests'] })
    queryClient.invalidateQueries({ queryKey: ['cluster-user-roles'] })
    queryClient.invalidateQueries({ queryKey: ['user-cluster-roles'] })
  }
  const approve = useMutation({
    mutationFn: (id: string) => api.adminApproveAccessRequest(id, notes[id] ?? ''),
    onSuccess: () => { setError(null); invalidate() },
    onError: (err: any) => setError(err?.response?.data?.detail || tr('accessRequests.admin.failed', 'The decision was not saved.')),
  })
  const reject = useMutation({
    mutationFn: (id: string) => api.adminRejectAccessRequest(id, notes[id] ?? ''),
    onSuccess: () => { setError(null); invalidate() },
    onError: (err: any) => setError(err?.response?.data?.detail || tr('accessRequests.admin.failed', 'The decision was not saved.')),
  })
  const busy = approve.isPending || reject.isPending

  return (
    <div className="flex flex-col h-[calc(100vh-4rem)] gap-4">
      <div className="shrink-0">
        <div className="flex items-center gap-2">
          <ShieldCheck className="w-6 h-6 text-primary-400" />
          <h1 className="text-3xl font-semibold text-ink">{tr('accessRequests.title', 'Access requests')}</h1>
        </div>
        <p className="text-slate-400 mt-2">
          {tr(
            'accessRequests.admin.subtitle',
            'Users ask for a higher role on a cluster for a limited time. Approving grants it until the time runs out, then the previous role comes back. You cannot decide your own request.',
          )}
        </p>
        {config && !config.enabled && (
          <p className="mt-2 text-xs text-amber-300" data-testid="access-requests-disabled">
            {tr('accessRequests.disabled', 'Access requests are off on this installation (auth.accessRequests.enabled).')}
          </p>
        )}
      </div>

      <div className="flex gap-2 shrink-0">
        {(['pending', 'history'] as const).map((k) => (
          <button
            key={k}
            type="button"
            data-testid={`access-requests-tab-${k}`}
            onClick={() => setTab(k)}
            className={`rounded-lg px-3 py-1.5 text-sm ${tab === k ? 'bg-primary-600 text-white' : 'bg-slate-800 text-slate-300 hover:bg-slate-700'}`}
          >
            {k === 'pending' ? tr('accessRequests.tabs.pending', 'Pending') : tr('accessRequests.tabs.history', 'History')}
            {k === 'pending' && pendingCount > 0 && (
              <span className="ml-2 rounded-full bg-amber-500/90 px-1.5 text-[10px] font-semibold text-slate-900">{pendingCount}</span>
            )}
          </button>
        ))}
      </div>

      <div className="relative shrink-0">
        <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-5 h-5 text-slate-400" />
        <input
          type="text"
          value={searchInput}
          onChange={(e) => setSearchInput(e.target.value)}
          placeholder={tr('accessRequests.searchPlaceholder', 'Search by requester, cluster or role...')}
          data-testid="access-requests-search"
          className="h-12 w-full pl-10 pr-4 bg-slate-700 border border-slate-600 rounded-lg text-sm text-ink placeholder-slate-400 focus:outline-hidden focus:ring-2 focus:ring-primary-500 focus:border-transparent"
        />
      </div>

      {error && (
        <div className="shrink-0 rounded-lg border border-red-800/60 bg-red-900/20 px-4 py-2 text-sm text-red-200" data-testid="access-requests-error">
          {error}
        </div>
      )}

      <div ref={containerRef} className="flex-1 min-h-0 flex flex-col bg-slate-800 rounded-xl border border-slate-700">
        <div ref={bodyRef} className="overflow-x-auto flex-1 min-h-0">
        <table className="w-full text-sm">
          <thead ref={theadRef} className="text-slate-400 bg-slate-900/40">
            <tr>
              <th className="px-4 py-3 text-left">{tr('accessRequests.columns.requester', 'Requester')}</th>
              <th className="px-4 py-3 text-left">{tr('accessRequests.columns.cluster', 'Cluster')}</th>
              <th className="px-4 py-3 text-left">{tr('accessRequests.columns.role', 'Role')}</th>
              <th className="px-4 py-3 text-left">{tr('accessRequests.columns.duration', 'Duration')}</th>
              <th className="px-4 py-3 text-left">{tr('accessRequests.columns.reason', 'Reason')}</th>
              <th className="px-4 py-3 text-left">{tr('accessRequests.columns.requested', 'Requested')}</th>
              {tab === 'pending' ? (
                <th className="px-4 py-3 text-right">{tr('accessRequests.columns.actions', 'Decision')}</th>
              ) : (
                <>
                  <th className="px-4 py-3 text-left">{tr('accessRequests.columns.status', 'Status')}</th>
                  <th className="px-4 py-3 text-left">{tr('accessRequests.columns.decidedBy', 'Decided by')}</th>
                  <th className="px-4 py-3 text-left">{tr('accessRequests.columns.expires', 'Until')}</th>
                </>
              )}
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-700/60" data-testid={`access-requests-table-${tab}`}>
            {list.isLoading ? (
              <tr><td colSpan={9} className="px-4 py-6 text-center text-slate-400"><Loader2 className="w-4 h-4 animate-spin inline" /></td></tr>
            ) : list.isError && !list.data ? (
              <tr><td colSpan={9} className="px-4 py-6 text-center text-red-300" data-testid="access-requests-load-error">{(list.error as any)?.response?.data?.detail || (list.error as Error).message}</td></tr>
            ) : pagedRows.length === 0 ? (
              <tr><td colSpan={9} className="px-4 py-6 text-center text-slate-400">{search ? tr('common.noSearchResults', 'No results found.') : tr('common.listEmpty', 'No items.')}</td></tr>
            ) : (
              pagedRows.map((r, idx) => {
                const own = me?.id === r.user_id
                return (
                  <tr key={r.id} ref={idx === 0 ? firstRowRef : undefined} data-testid={`access-request-row-${r.id}`} className="text-slate-200">
                    <td className="px-4 py-3">
                      <div>{r.user_name || r.user_email}</div>
                      <div className="text-xs text-slate-400">{r.user_email}</div>
                    </td>
                    <td className="px-4 py-3">{r.cluster_name || r.cluster_id}</td>
                    <td className="px-4 py-3 font-medium">{r.role}</td>
                    <td className="px-4 py-3 whitespace-nowrap"><span className="inline-flex items-center gap-1"><Clock className="w-3.5 h-3.5 text-slate-400" />{formatDuration(r.duration_minutes, t)}</span></td>
                    <td className="px-4 py-3 max-w-xs whitespace-pre-wrap wrap-break-word text-slate-300">{r.reason}</td>
                    <td className="px-4 py-3 text-slate-400 whitespace-nowrap" title={utcTitle(r.created_at)}>{formatWhen(r.created_at)}</td>
                    {tab === 'pending' ? (
                      <td className="px-4 py-3">
                        {own ? (
                          <div className="text-right text-xs text-slate-400" data-testid={`access-request-own-${r.id}`}>
                            {tr('accessRequests.admin.own', 'Your own request — another admin must decide.')}
                          </div>
                        ) : (
                          <div className="flex items-center justify-end gap-2 whitespace-nowrap">
                            <input
                              data-testid={`access-request-note-${r.id}`}
                              value={notes[r.id] ?? ''}
                              onChange={(e) => setNotes((n) => ({ ...n, [r.id]: e.target.value }))}
                              placeholder={tr('accessRequests.admin.notePlaceholder', 'Note (optional)')}
                              className="w-40 rounded-lg border border-slate-600 bg-slate-900 px-2 py-1 text-xs text-ink placeholder:text-slate-500"
                            />
                            {approvalHeld(r.role, r.cluster_id) && (
                              <span className="max-w-56 whitespace-normal text-right text-xs text-amber-200" data-testid={`access-request-chart-bound-${r.id}`}>
                                {tr('accessRequests.admin.chartBound', 'The chart binds this role on the cluster: only a global admin or an Admin of this cluster can approve it.')}
                              </span>
                            )}
                            <button
                              type="button"
                              data-testid={`access-request-approve-${r.id}`}
                              disabled={busy || approvalHeld(r.role, r.cluster_id)}
                              onClick={() => approve.mutate(r.id)}
                              className="inline-flex shrink-0 items-center gap-1 rounded-lg bg-emerald-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-emerald-500 disabled:opacity-50"
                            >
                              <Check className="w-3.5 h-3.5" />{tr('accessRequests.admin.approve', 'Approve')}
                            </button>
                            <button
                              type="button"
                              data-testid={`access-request-reject-${r.id}`}
                              disabled={busy}
                              onClick={() => reject.mutate(r.id)}
                              className="inline-flex shrink-0 items-center gap-1 rounded-lg border border-red-800/60 px-3 py-1.5 text-xs font-medium text-red-300 hover:bg-red-900/20 disabled:opacity-50"
                            >
                              <X className="w-3.5 h-3.5" />{tr('accessRequests.admin.reject', 'Reject')}
                            </button>
                          </div>
                        )}
                      </td>
                    ) : (
                      <>
                        <td className="px-4 py-3"><StatusBadge request={r} /></td>
                        <td className="px-4 py-3 text-slate-400">
                          <div>{r.decided_by_email ?? '-'}</div>
                          {r.decision_note && <div className="text-xs text-slate-500">{r.decision_note}</div>}
                        </td>
                        <td className="px-4 py-3 text-slate-400 whitespace-nowrap" title={utcTitle(r.expires_at)}>{formatWhen(r.expires_at)}</td>
                      </>
                    )}
                  </tr>
                )
              })
            )}
          </tbody>
          <AdaptiveTableFillerRows count={rowsPerPage - pagedRows.length} columnCount={tab === 'pending' ? 7 : 9} />
        </table>
        </div>
        <ListPager currentPage={shownPage} totalPages={totalPages} total={total} rowsPerPage={shownLimit} onPageChange={turnPage} testId="access-requests-pager" />
      </div>
    </div>
  )
}
