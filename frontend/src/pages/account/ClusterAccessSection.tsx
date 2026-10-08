import { useMemo, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useTranslation } from 'react-i18next'
import { KeyRound, Loader2, X } from 'lucide-react'

import { api } from '@/services/api'
import { clustersApi } from '@/services/api/clusters'
import type { AccessRequest } from '@/services/api/access_requests'
import type { Member } from '@/services/api/types'
import CustomDropdown from '@/components/CustomDropdown'
import { ModalOverlay } from '@/components/ModalOverlay'
import StatusBadge from '@/components/AccessRequestStatusBadge'
import { formatDuration, formatWhen } from '@/pages/admin/accessRequestFormat'

// Settings → Cluster access: the signed-in user's role on each cluster, a
// "request temporary access" modal (role, duration, reason) and their
// requests. Shown only while the installation has access requests on. An
// approval signs the user out (their token is revoked); the next sign-in
// carries the role until it expires.

const DURATIONS = [30, 60, 120, 240, 480]

export default function ClusterAccessSection({ me }: { me: Member | undefined }) {
  const { t } = useTranslation()
  const tr = (key: string, fallback: string, opts?: Record<string, unknown>) => t(key, { defaultValue: fallback, ...opts })
  const queryClient = useQueryClient()

  const { data: config } = useQuery({ queryKey: ['access-requests', 'config'], queryFn: api.getAccessRequestsConfig, staleTime: 60_000 })
  const enabled = !!config?.enabled
  const { data: clusters = [] } = useQuery({
    queryKey: ['clusters-accessible'],
    queryFn: () => clustersApi.listClusters(true),
    staleTime: 30_000,
    enabled,
  })
  const { data: mine = [] } = useQuery({
    queryKey: ['access-requests', 'mine'],
    queryFn: api.listMyAccessRequests,
    refetchInterval: 30_000,
    enabled,
  })

  const isGlobalAdmin = (me?.permissions_matrix?.['*'] ?? []).some((p) => p === '*' || p.startsWith('admin.'))
  const myRoles = me?.cluster_roles ?? {}
  const durations = useMemo(() => {
    const max = (config?.max_hours ?? 8) * 60
    const list = DURATIONS.filter((m) => m <= max)
    if (!list.includes(max)) list.push(max)
    return list
  }, [config])

  const [target, setTarget] = useState<string | null>(null)
  const [role, setRole] = useState('')
  const [duration, setDuration] = useState(60)
  const [reason, setReason] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)

  const open = (clusterId: string) => {
    const current = myRoles[clusterId]
    const choices = (config?.roles ?? []).filter((r) => r !== current)
    setRole(choices[0] ?? config?.roles?.[0] ?? '')
    setDuration(durations.includes(60) ? 60 : durations[0])
    setReason('')
    setError(null)
    setTarget(clusterId)
  }

  const create = useMutation({
    mutationFn: () => api.createAccessRequest({ cluster_id: target!, role, duration_minutes: duration, reason: reason.trim() }),
    onSuccess: () => {
      setTarget(null)
      setNotice(tr('accessRequests.mine.sent', 'Request sent. An admin will review it; once approved you will be signed out and back in with the role.'))
      queryClient.invalidateQueries({ queryKey: ['access-requests', 'mine'] })
    },
    onError: (err: any) => setError(err?.response?.data?.detail || tr('accessRequests.mine.failed', 'The request was not sent.')),
  })
  const cancel = useMutation({
    mutationFn: (id: string) => api.cancelAccessRequest(id),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['access-requests', 'mine'] }),
  })

  if (!enabled) return null

  const pendingFor = (clusterId: string) => mine.find((r) => r.cluster_id === clusterId && r.status === 'pending')
  const activeFor = (clusterId: string) => mine.find((r) => r.cluster_id === clusterId && r.status === 'approved')
  const rows = clusters.map((c) => ({ cluster: c, role: myRoles[c.id] ?? '' }))

  return (
    <div className="card" data-testid="account-cluster-access">
      <div className="flex items-center gap-3 mb-4">
        <div className="p-2 bg-primary-600/20 rounded-lg">
          <KeyRound className="w-5 h-5 text-primary-400" />
        </div>
        <div>
          <h2 className="text-xl font-bold text-white">{tr('accessRequests.mine.title', 'Cluster access')}</h2>
          <p className="text-slate-400 text-sm">
            {tr('accessRequests.mine.subtitle', 'Your role on each cluster. Ask for a higher role for a limited time when you need it; an admin approves.')}
          </p>
        </div>
      </div>

      {notice && (
        <div className="mb-3 rounded-lg border border-emerald-800/60 bg-emerald-900/20 px-3 py-2 text-sm text-emerald-200" data-testid="access-request-notice">
          {notice}
        </div>
      )}

      {isGlobalAdmin ? (
        <p className="text-sm text-primary-300 bg-primary-900/20 border border-primary-800/40 rounded-lg px-3 py-2">
          {tr('accessRequests.mine.globalAdmin', 'Global admin — you reach every cluster already; nothing to request.')}
        </p>
      ) : rows.length === 0 ? (
        <p className="text-sm text-slate-400">{tr('accessRequests.mine.noClusters', 'You have no cluster access yet. Ask an admin for a grant first.')}</p>
      ) : (
        <div className="space-y-1.5">
          {rows.map(({ cluster, role: current }) => {
            const pending = pendingFor(cluster.id)
            const active = activeFor(cluster.id)
            const requestable = (config?.roles ?? []).some((r) => r !== current)
            return (
              <div key={cluster.id} className="flex items-center justify-between gap-3 rounded-lg bg-slate-900/40 px-3 py-2" data-testid={`account-cluster-${cluster.id}`}>
                <div className="min-w-0">
                  <div className="text-sm text-white truncate">{cluster.display_name}</div>
                  <div className="text-xs text-slate-400">
                    {current || tr('accessRequests.mine.noRole', 'No role')}
                    {active?.expires_at && (
                      <span className="ml-2 text-amber-300" data-testid={`account-cluster-until-${cluster.id}`}>
                        {tr('accessRequests.until', 'until {{time}}', { time: formatWhen(active.expires_at) })}
                      </span>
                    )}
                  </div>
                </div>
                {pending ? (
                  <span className="text-xs text-amber-300" data-testid={`account-cluster-pending-${cluster.id}`}>
                    {tr('accessRequests.mine.pendingShort', 'Request pending')}
                  </span>
                ) : requestable ? (
                  <button
                    type="button"
                    data-testid={`access-request-open-${cluster.id}`}
                    onClick={() => open(cluster.id)}
                    className="rounded-lg bg-primary-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-primary-500"
                  >
                    {tr('accessRequests.mine.request', 'Request temporary access')}
                  </button>
                ) : null}
              </div>
            )
          })}
        </div>
      )}

      {mine.length > 0 && (
        <div className="mt-5">
          <h3 className="text-sm font-semibold text-slate-200 mb-2">{tr('accessRequests.mine.list', 'My requests')}</h3>
          <div className="space-y-1.5" data-testid="my-access-requests">
            {mine.map((r: AccessRequest) => (
              <div key={r.id} className="flex items-center justify-between gap-3 rounded-lg border border-slate-700/60 px-3 py-2 text-sm" data-testid={`my-access-request-${r.id}`}>
                <div className="min-w-0">
                  <div className="text-slate-200 truncate">
                    <span className="font-medium">{r.cluster_name || r.cluster_id}</span> · {r.role} · {formatDuration(r.duration_minutes)}
                  </div>
                  <div className="text-xs text-slate-400 truncate">
                    {formatWhen(r.created_at)}
                    {r.expires_at && r.status === 'approved' && ` · ${tr('accessRequests.until', 'until {{time}}', { time: formatWhen(r.expires_at) })}`}
                    {r.decision_note && ` · ${r.decision_note}`}
                  </div>
                </div>
                <div className="flex items-center gap-2 shrink-0">
                  <StatusBadge request={r} />
                  {r.status === 'pending' && (
                    <button
                      type="button"
                      data-testid={`access-request-cancel-${r.id}`}
                      disabled={cancel.isPending}
                      onClick={() => cancel.mutate(r.id)}
                      className="rounded-lg border border-slate-600 px-2 py-1 text-xs text-slate-300 hover:bg-slate-700 disabled:opacity-50"
                    >
                      {tr('accessRequests.mine.cancel', 'Cancel')}
                    </button>
                  )}
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {target && (
        <ModalOverlay onClose={() => create.isPending || setTarget(null)}>
          <div
            className="w-full max-w-md rounded-2xl border border-slate-700 bg-slate-900 p-6 shadow-2xl"
            role="dialog"
            aria-modal="true"
            aria-label={tr('accessRequests.modal.title', 'Request temporary access')}
            data-testid="access-request-modal"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-start justify-between">
              <div>
                <h2 className="text-lg font-semibold text-white">{tr('accessRequests.modal.title', 'Request temporary access')}</h2>
                <p className="text-xs text-slate-400 mt-1">
                  {clusters.find((c) => c.id === target)?.display_name ?? target}
                  {myRoles[target] && ` · ${tr('accessRequests.modal.current', 'current role: {{role}}', { role: myRoles[target] })}`}
                </p>
              </div>
              <button type="button" onClick={() => setTarget(null)} className="text-slate-400 hover:text-white" aria-label={tr('accessRequests.modal.close', 'Close')}>
                <X className="w-5 h-5" />
              </button>
            </div>

            <div className="mt-4 space-y-3">
              <label className="block text-xs font-semibold text-slate-400">
                {tr('accessRequests.modal.role', 'Role')}
                <CustomDropdown
                  testId="access-request-role"
                  value={role}
                  onChange={setRole}
                  className="mt-1 w-full"
                  options={(config?.roles ?? []).filter((r) => r !== myRoles[target]).map((r) => ({ value: r, label: r, testId: `access-request-role-opt-${r}` }))}
                />
              </label>
              <label className="block text-xs font-semibold text-slate-400">
                {tr('accessRequests.modal.duration', 'Duration')}
                <CustomDropdown
                  testId="access-request-duration"
                  value={String(duration)}
                  onChange={(v) => setDuration(Number(v))}
                  className="mt-1 w-full"
                  options={durations.map((m) => ({ value: String(m), label: formatDuration(m), testId: `access-request-duration-opt-${m}` }))}
                />
              </label>
              <label className="block text-xs font-semibold text-slate-400">
                {tr('accessRequests.modal.reason', 'Reason')}
                <textarea
                  data-testid="access-request-reason"
                  value={reason}
                  onChange={(e) => setReason(e.target.value)}
                  rows={3}
                  maxLength={500}
                  placeholder={tr('accessRequests.modal.reasonPlaceholder', 'What you need to do and why (ticket, incident, deploy…)')}
                  className="mt-1 w-full rounded-lg border border-slate-600 bg-slate-800 px-3 py-2 text-sm text-white placeholder:text-slate-500"
                />
              </label>
              {error && <div className="text-sm text-red-300" data-testid="access-request-error">{error}</div>}
            </div>

            <div className="mt-5 flex justify-end gap-2">
              <button type="button" onClick={() => setTarget(null)} className="rounded-lg px-4 py-2 text-sm text-slate-300 hover:bg-slate-800">
                {tr('accessRequests.modal.cancel', 'Cancel')}
              </button>
              <button
                type="button"
                data-testid="access-request-submit"
                disabled={create.isPending || !role || !reason.trim()}
                onClick={() => create.mutate()}
                className="inline-flex items-center gap-2 rounded-lg bg-primary-600 px-4 py-2 text-sm font-medium text-white hover:bg-primary-500 disabled:opacity-50"
              >
                {create.isPending && <Loader2 className="w-4 h-4 animate-spin" />}
                {tr('accessRequests.modal.submit', 'Send request')}
              </button>
            </div>
          </div>
        </ModalOverlay>
      )}
    </div>
  )
}
