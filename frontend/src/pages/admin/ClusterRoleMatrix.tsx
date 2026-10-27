import { useQuery, useQueryClient, useMutation } from '@tanstack/react-query'
import { useTranslation } from 'react-i18next'
import { ShieldCheck, Loader2 } from 'lucide-react'

import { api } from '@/services/api'
import { clustersApi } from '@/services/api/clusters'
import CustomDropdown from '@/components/CustomDropdown'
import NamespaceScopeInput from '@/components/NamespaceScopeInput'
import { usePermission } from '@/hooks/usePermission'

interface Props {
  userID: string
  canEdit: boolean
  // The target user is a global admin ("*") → reaches every cluster
  // automatically, so per-cluster grants are unnecessary.
  userIsGlobalAdmin?: boolean
  // The admin's own account: shown read-only (the server refuses a change to one's own cluster access).
  isSelf?: boolean
}

// Per-user × per-cluster role grants (step 12), backed by the step-08 API.
// One row per registered cluster with a role <select> ("none" = no access,
// deny-by-default). Changes apply on the user's NEXT login (token re-issue).
export default function ClusterRoleMatrix({ userID, canEdit: canEditUsers, userIsGlobalAdmin, isSelf }: Props) {
  const canEdit = canEditUsers && !isSelf
  const { t } = useTranslation()
  const tr = (key: string, fallback: string) => t(key, { defaultValue: fallback })
  const queryClient = useQueryClient()

  // Without the full cluster list, the clusters one reaches — the ones one may grant on (permission ceiling).
  const { has } = usePermission()
  const everyCluster = has('admin.clusters.list')
  const { data: clusters = [] } = useQuery({
    queryKey: ['clusters-all', everyCluster],
    queryFn: () => clustersApi.listClusters(!everyCluster),
    staleTime: 30_000,
  })
  const { data: roles = [] } = useQuery({ queryKey: ['roles'], queryFn: api.listRoles, staleTime: 60_000 })
  const { data: userRoles = {}, isLoading } = useQuery({
    queryKey: ['user-cluster-roles', userID],
    queryFn: () => api.getUserClusterRoles(userID),
    enabled: !!userID,
  })
  // The grants with their namespace scope (the role map above has no room for it).
  const { data: grants = [] } = useQuery({
    queryKey: ['user-cluster-grants', userID],
    queryFn: () => api.getUserClusterGrants(userID),
    enabled: !!userID,
  })
  const namespacesOf = (clusterId: string) => grants.find((g) => g.cluster_id === clusterId)?.namespaces

  const invalidate = () => {
    queryClient.invalidateQueries({ queryKey: ['user-cluster-roles', userID] })
    queryClient.invalidateQueries({ queryKey: ['user-cluster-grants', userID] })
  }

  const setMutation = useMutation({
    mutationFn: ({ clusterId, role, namespaces }: { clusterId: string; role: string; namespaces?: string[] }) =>
      api.setUserClusterRole(userID, clusterId, role, namespaces ?? namespacesOf(clusterId)),
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
        )}{' '}
        {tr('admin.userClusterRoles.namespacesNote', 'A role can be limited to namespaces (the box next to it; empty = the whole cluster).')}
      </p>
      {isSelf && (
        <p className="text-xs text-amber-200 mb-3" data-testid="cluster-role-matrix-self">
          {tr('admin.userClusterRoles.self', 'This is your own account: your cluster access is changed by another admin or through an access request.')}
        </p>
      )}

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
                    <span className="ml-2 text-[10px] px-1.5 py-0.5 rounded-sm bg-slate-700 text-slate-300">self</span>
                  )}
                </span>
                {current && (
                  <NamespaceScopeInput
                    testId={`cluster-role-${c.id}-namespaces`}
                    value={namespacesOf(c.id)}
                    disabled={!canEdit || pending}
                    onCommit={(namespaces) => setMutation.mutate({ clusterId: c.id, role: current, namespaces })}
                    className="w-44 shrink-0"
                  />
                )}
                {/* Pending/Member are account-level (no cluster perms), so only
                    the access roles are offered per cluster. */}
                <CustomDropdown
                  testId={`cluster-role-${c.id}`}
                  value={current}
                  disabled={!canEdit || pending}
                  onChange={(v) => onChange(c.id, v)}
                  className="w-40 shrink-0"
                  options={[
                    { value: '', label: tr('admin.userClusterRoles.none', 'No access'), testId: `cluster-role-${c.id}-opt-none` },
                    ...roles
                      .filter((r) => !['Pending', 'Member'].includes(r.name))
                      .map((r) => ({ value: r.name, label: r.name, testId: `cluster-role-${c.id}-opt-${r.name}` })),
                  ]}
                />
              </div>
            )
          })}
        </div>
      )}
    </div>
  )
}
