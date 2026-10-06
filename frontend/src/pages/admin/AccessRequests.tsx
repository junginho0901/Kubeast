import { useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useTranslation } from 'react-i18next'
import { Check, Clock, Loader2, ShieldCheck, X } from 'lucide-react'

import { api } from '@/services/api'
import StatusBadge from '@/components/AccessRequestStatusBadge'
import { formatDuration, formatWhen } from './accessRequestFormat'

// Admin review of access requests (temporary per-cluster role grants):
// pending requests to approve or reject with an optional note, and the
// history. The server refuses a decision on the reviewer's own request; the
// row says so instead of offering the buttons.

export default function AccessRequests() {
  const { t } = useTranslation()
  const tr = (key: string, fallback: string, opts?: Record<string, unknown>) => t(key, { defaultValue: fallback, ...opts })
  const queryClient = useQueryClient()
  const [tab, setTab] = useState<'pending' | 'history'>('pending')
  const [notes, setNotes] = useState<Record<string, string>>({})
  const [error, setError] = useState<string | null>(null)

  const { data: me } = useQuery({ queryKey: ['me'], queryFn: api.me, staleTime: 30_000, retry: false })
  const { data: config } = useQuery({ queryKey: ['access-requests', 'config'], queryFn: api.getAccessRequestsConfig, staleTime: 60_000 })
  const { data: pending = [], isLoading: pendingLoading } = useQuery({
    queryKey: ['access-requests', 'admin', 'pending'],
    queryFn: () => api.adminListAccessRequests('pending'),
    refetchInterval: 30_000,
  })
  const { data: all = [], isLoading: allLoading } = useQuery({
    queryKey: ['access-requests', 'admin', 'all'],
    queryFn: () => api.adminListAccessRequests(),
    enabled: tab === 'history',
  })
  const history = all.filter((r) => r.status !== 'pending')

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
    <div className="space-y-6">
      <div>
        <div className="flex items-center gap-2">
          <ShieldCheck className="w-6 h-6 text-primary-400" />
          <h1 className="text-3xl font-bold text-white">{tr('accessRequests.title', 'Access requests')}</h1>
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

      <div className="flex gap-2">
        {(['pending', 'history'] as const).map((k) => (
          <button
            key={k}
            type="button"
            data-testid={`access-requests-tab-${k}`}
            onClick={() => setTab(k)}
            className={`rounded-lg px-3 py-1.5 text-sm ${tab === k ? 'bg-primary-600 text-white' : 'bg-slate-800 text-slate-300 hover:bg-slate-700'}`}
          >
            {k === 'pending' ? tr('accessRequests.tabs.pending', 'Pending') : tr('accessRequests.tabs.history', 'History')}
            {k === 'pending' && pending.length > 0 && (
              <span className="ml-2 rounded-full bg-amber-500/90 px-1.5 text-[10px] font-semibold text-slate-900">{pending.length}</span>
            )}
          </button>
        ))}
      </div>

      {error && (
        <div className="rounded-lg border border-red-800/60 bg-red-900/20 px-4 py-2 text-sm text-red-200" data-testid="access-requests-error">
          {error}
        </div>
      )}

      <div className="bg-slate-800 rounded-xl border border-slate-700 overflow-x-auto">
        <table className="w-full text-sm">
          <thead className="text-xs uppercase text-slate-400 bg-slate-900/40">
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
            {(tab === 'pending' ? pendingLoading : allLoading) ? (
              <tr><td colSpan={9} className="px-4 py-6 text-center text-slate-400"><Loader2 className="w-4 h-4 animate-spin inline" /></td></tr>
            ) : (tab === 'pending' ? pending : history).length === 0 ? (
              <tr><td colSpan={9} className="px-4 py-6 text-center text-slate-400">{tr('accessRequests.empty', 'No requests.')}</td></tr>
            ) : (
              (tab === 'pending' ? pending : history).map((r) => {
                const own = me?.id === r.user_id
                return (
                  <tr key={r.id} data-testid={`access-request-row-${r.id}`} className="text-slate-200">
                    <td className="px-4 py-3">
                      <div>{r.user_name || r.user_email}</div>
                      <div className="text-xs text-slate-400">{r.user_email}</div>
                    </td>
                    <td className="px-4 py-3">{r.cluster_name || r.cluster_id}</td>
                    <td className="px-4 py-3 font-medium">{r.role}</td>
                    <td className="px-4 py-3 whitespace-nowrap"><span className="inline-flex items-center gap-1"><Clock className="w-3.5 h-3.5 text-slate-400" />{formatDuration(r.duration_minutes)}</span></td>
                    <td className="px-4 py-3 max-w-xs whitespace-pre-wrap wrap-break-word text-slate-300">{r.reason}</td>
                    <td className="px-4 py-3 text-slate-400">{formatWhen(r.created_at)}</td>
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
                              className="w-40 rounded-lg border border-slate-600 bg-slate-900 px-2 py-1 text-xs text-white placeholder:text-slate-500"
                            />
                            <button
                              type="button"
                              data-testid={`access-request-approve-${r.id}`}
                              disabled={busy}
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
                          <div>{r.decided_by_email ?? '—'}</div>
                          {r.decision_note && <div className="text-xs text-slate-500">{r.decision_note}</div>}
                        </td>
                        <td className="px-4 py-3 text-slate-400">{formatWhen(r.expires_at)}</td>
                      </>
                    )}
                  </tr>
                )
              })
            )}
          </tbody>
        </table>
      </div>
    </div>
  )
}
