import { useQuery, useQueryClient, useMutation } from '@tanstack/react-query'
import { useTranslation } from 'react-i18next'
import { ShieldCheck, Loader2 } from 'lucide-react'

import { api } from '@/services/api'
import { clustersApi } from '@/services/api/clusters'

interface Props {
  userID: string
  canEdit: boolean
  // The target user is a global admin (admin.* / "*") → reaches every cluster
  // automatically, so per-cluster grants are unnecessary.
  userIsGlobalAdmin?: boolean
}

// Per-user × per-cluster role grants (step 12), backed by the step-08 API.
// One row per registered cluster with a role <select> ("none" = no access,
// deny-by-default). Changes apply on the user's NEXT login (token re-issue).
export default function ClusterRoleMatrix({ userID, canEdit, userIsGlobalAdmin }: Props) {
  const { t } = useTranslation()
  const tr = (key: string, fallback: string) => t(key, { defaultValue: fallback })
  const queryClient = useQueryClient()

  const { data: clusters = [] } = useQuery({
    queryKey: ['clusters-all'],
    queryFn: () => clustersApi.listClusters(false),
    staleTime: 30_000,
  })
  const { data: roles = [] } = useQuery({ queryKey: ['roles'], queryFn: api.listRoles, staleTime: 60_000 })
  const { data: userRoles = {}, isLoading } = useQuery({
    queryKey: ['user-cluster-roles', userID],
    queryFn: () => api.getUserClusterRoles(userID),
    enabled: !!userID,
  })

  const invalidate = () => queryClient.invalidateQueries({ queryKey: ['user-cluster-roles', userID] })

  const setMutation = useMutation({
    mutationFn: ({ clusterId, role }: { clusterId: string; role: string }) =>
      api.setUserClusterRole(userID, clusterId, role),
    onSuccess: invalidate,
  })
  const removeMutation = useMutation({
    mutationFn: (clusterId: string) => api.removeUserClusterRole(userID, clusterId),
    onSuccess: invalidate,
  })
  const pending = setMutation.isPending || removeMutation.isPending

  const onChange = (clusterId: string, role: string) => {
    if (role === '') removeMutation.mutate(clusterId)
    else setMutation.mutate({ clusterId, role })
  }

  return (
    <div className="rounded-lg border border-slate-700/50 bg-slate-950/30 p-3">
      <div className="flex items-center gap-2 mb-1">
        <ShieldCheck className="w-4 h-4 text-primary-400" />
        <h4 className="text-sm font-semibold text-white">
          {tr('admin.userClusterRoles.title', 'Cluster access')}
        </h4>
        {pending && <Loader2 className="w-3.5 h-3.5 animate-spin text-slate-400" />}
      </div>
      <p className="text-xs text-slate-400 mb-3">
        {tr(
          'admin.userClusterRoles.denyNote',
          'The user only sees clusters you grant a role on; ungranted clusters are denied. Changes apply after the user logs in again.',
        )}
      </p>

      {userIsGlobalAdmin ? (
        <p className="text-sm text-primary-300 bg-primary-900/20 border border-primary-800/40 rounded-lg px-3 py-2">
          {tr('admin.userClusterRoles.adminAll', 'Global admin — reaches every cluster automatically.')}
        </p>
      ) : isLoading ? (
        <div className="text-xs text-slate-400 py-2">…</div>
      ) : clusters.length === 0 ? (
        <div className="text-xs text-slate-400 py-2">
          {tr('admin.userClusterRoles.noClusters', 'No clusters registered.')}
        </div>
      ) : (
        <div className="space-y-1.5" data-testid="cluster-role-matrix">
          {clusters.map((c) => {
            const current = userRoles[c.id] ?? ''
            return (
              <div key={c.id} className="flex items-center justify-between gap-3">
                <span className="text-sm text-slate-200 truncate">
                  {c.display_name}
                  {c.is_self_cluster && (
                    <span className="ml-2 text-[10px] px-1.5 py-0.5 rounded bg-slate-700 text-slate-300">self</span>
                  )}
                </span>
                <select
                  data-testid={`cluster-role-${c.id}`}
                  value={current}
                  disabled={!canEdit || pending}
                  onChange={(e) => onChange(c.id, e.target.value)}
                  className="rounded-lg bg-slate-900 border border-slate-700 px-2 py-1 text-sm text-white disabled:opacity-60"
                >
                  <option value="">{tr('admin.userClusterRoles.none', 'No access')}</option>
                  {roles.map((r) => (
                    <option key={r.id} value={r.name}>
                      {r.name}
                    </option>
                  ))}
                </select>
              </div>
            )
          })}
        </div>
      )}
    </div>
  )
}
