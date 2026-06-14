import { useMemo, useState } from 'react'
import { useQuery, useQueryClient, useMutation } from '@tanstack/react-query'
import { useTranslation } from 'react-i18next'
import { ShieldCheck, Loader2, Trash2, UserPlus, X } from 'lucide-react'

import { ModalOverlay } from '@/components/ModalOverlay'
import CustomDropdown from '@/components/CustomDropdown'
import { api } from '@/services/api'
import type { ClusterMeta } from '@/services/api/clusters'

// Per-cluster access management (the inverse of the user-detail ClusterRoleMatrix):
// for ONE cluster, list every user granted a role on it and let an admin change
// the role, revoke it, or add another user. Backed by the same per-user grant API
// (setUserClusterRole / removeUserClusterRole) plus the reverse list endpoint.
// Global admins are not shown — they reach every cluster via "*". Changes take
// effect on the target user's next login (token re-issue).
//
// Pending/Member are account-level roles (no cluster perms), so they are not
// offered as a per-cluster grant.
const ACCOUNT_LEVEL_ROLES = new Set(['Pending', 'Member'])

export default function ClusterAccessModal({
  cluster,
  onClose,
}: {
  cluster: ClusterMeta
  onClose: () => void
}) {
  const { t } = useTranslation()
  const tr = (key: string, fallback: string) => t(key, { defaultValue: fallback })
  const queryClient = useQueryClient()

  const grantsKey = ['cluster-user-roles', cluster.id]
  const { data: grants = [], isLoading } = useQuery({
    queryKey: grantsKey,
    queryFn: () => api.getClusterUserRoles(cluster.id),
  })
  const { data: roles = [] } = useQuery({ queryKey: ['roles'], queryFn: api.listRoles, staleTime: 60_000 })
  const { data: allUsers = [] } = useQuery({
    queryKey: ['admin-users-all'],
    queryFn: () => api.adminListUsers({ limit: 500 }),
    staleTime: 30_000,
  })

  const grantRoles = useMemo(() => roles.filter((r) => !ACCOUNT_LEVEL_ROLES.has(r.name)), [roles])
  const invalidate = () => queryClient.invalidateQueries({ queryKey: grantsKey })

  const setMutation = useMutation({
    mutationFn: ({ userId, role }: { userId: string; role: string }) =>
      api.setUserClusterRole(userId, cluster.id, role),
    onSuccess: invalidate,
  })
  const removeMutation = useMutation({
    mutationFn: (userId: string) => api.removeUserClusterRole(userId, cluster.id),
    onSuccess: invalidate,
  })
  const pending = setMutation.isPending || removeMutation.isPending

  // "Add user" row state — users without an existing grant on this cluster.
  const grantedIds = useMemo(() => new Set(grants.map((g) => g.user_id)), [grants])
  const addable = useMemo(
    () => allUsers.filter((u) => !grantedIds.has(u.id)),
    [allUsers, grantedIds],
  )
  const [addUserId, setAddUserId] = useState('')
  const [addRole, setAddRole] = useState('Read')

  const onAdd = () => {
    if (!addUserId) return
    setMutation.mutate({ userId: addUserId, role: addRole })
    setAddUserId('')
  }

  return (
    <ModalOverlay onClose={() => pending || onClose()}>
      <div className="w-full max-w-lg rounded-xl border border-slate-700 bg-slate-800 p-6 shadow-2xl">
        <div className="flex items-start justify-between">
          <div className="flex items-center gap-2">
            <ShieldCheck className="w-5 h-5 text-primary-400" />
            <div>
              <h3 className="text-lg font-bold text-white">
                {tr('cluster.access.title', 'Cluster access')}
              </h3>
              <p className="text-xs text-slate-400">
                {cluster.display_name}
                {cluster.is_self_cluster && (
                  <span className="ml-2 text-[10px] px-1.5 py-0.5 rounded bg-slate-700 text-slate-300">self</span>
                )}
              </p>
            </div>
          </div>
          <button type="button" onClick={() => pending || onClose()} className="text-slate-400 hover:text-white">
            <X className="w-5 h-5" />
          </button>
        </div>

        <p className="mt-3 text-xs text-slate-400">
          {tr(
            'cluster.access.note',
            'Users granted a role here can access this cluster (deny-by-default for everyone else). Global admins reach every cluster and are not listed. Changes apply after the user logs in again.',
          )}
        </p>

        <div className="mt-4 space-y-1.5" data-testid="cluster-access-list">
          {isLoading ? (
            <div className="text-xs text-slate-400 py-2">…</div>
          ) : grants.length === 0 ? (
            <div className="text-xs text-slate-400 py-3 text-center">
              {tr('cluster.access.empty', 'No users have access to this cluster yet.')}
            </div>
          ) : (
            grants.map((g) => (
              <div key={g.user_id} className="flex items-center justify-between gap-3 rounded-lg bg-slate-900/40 px-3 py-2">
                <div className="min-w-0">
                  <div className="text-sm text-white truncate">{g.name || g.email}</div>
                  <div className="text-xs text-slate-400 truncate">{g.email}</div>
                </div>
                <div className="flex items-center gap-2 shrink-0">
                  <CustomDropdown
                    testId={`cluster-access-role-${g.user_id}`}
                    value={g.role}
                    disabled={pending}
                    onChange={(v) => setMutation.mutate({ userId: g.user_id, role: v })}
                    className="w-32"
                    options={grantRoles.map((r) => ({
                      value: r.name,
                      label: r.name,
                      testId: `cluster-access-role-${g.user_id}-opt-${r.name}`,
                    }))}
                  />
                  <button
                    type="button"
                    data-testid={`cluster-access-revoke-${g.user_id}`}
                    title={tr('cluster.access.revoke', 'Revoke')}
                    disabled={pending}
                    onClick={() => removeMutation.mutate(g.user_id)}
                    className="rounded-lg border border-red-900/60 p-1.5 text-red-300 hover:bg-red-900/20 disabled:opacity-50"
                  >
                    <Trash2 className="w-3.5 h-3.5" />
                  </button>
                </div>
              </div>
            ))
          )}
        </div>

        {/* Add a user */}
        <div className="mt-4 flex items-center gap-2 border-t border-slate-700/60 pt-4">
          <CustomDropdown
            testId="cluster-access-add-user"
            value={addUserId}
            onChange={setAddUserId}
            disabled={pending || addable.length === 0}
            className="flex-1 min-w-0"
            placeholder={
              addable.length === 0
                ? tr('cluster.access.allAdded', 'All users already granted')
                : tr('cluster.access.selectUser', 'Select a user…')
            }
            options={addable.map((u) => ({
              value: u.id,
              label: u.email ? `${u.name || u.email} (${u.email})` : u.name || u.id,
              testId: `cluster-access-add-user-opt-${u.id}`,
            }))}
          />
          <CustomDropdown
            testId="cluster-access-add-role"
            value={addRole}
            onChange={setAddRole}
            disabled={pending}
            className="w-32 shrink-0"
            options={grantRoles.map((r) => ({
              value: r.name,
              label: r.name,
              testId: `cluster-access-add-role-opt-${r.name}`,
            }))}
          />
          <button
            type="button"
            data-testid="cluster-access-add-btn"
            onClick={onAdd}
            disabled={pending || !addUserId}
            className="flex items-center gap-1 rounded-lg bg-primary-600 px-3 py-1.5 text-sm text-white hover:bg-primary-500 disabled:opacity-50"
          >
            {pending ? <Loader2 className="w-4 h-4 animate-spin" /> : <UserPlus className="w-4 h-4" />}
            {tr('cluster.access.add', 'Add')}
          </button>
        </div>
      </div>
    </ModalOverlay>
  )
}
