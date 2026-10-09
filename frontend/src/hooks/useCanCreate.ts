import { useQuery } from '@tanstack/react-query'
import { api } from '@/services/api'
import { getCurrentClusterID } from '@/services/clusterRef'
import { usePermission } from './usePermission'

/** The Kubernetes resource a create button makes, for the cluster's own answer. */
export interface CreateTarget {
  group: string
  resource: string
  /** For a namespaced kind: the namespace being viewed ('' or 'all' = every namespace). */
  namespace?: string
}

// Whether a create button shows: the app permission, and for kinds the
// cluster's RBAC may refuse even so — cluster-scoped objects and Roles, which
// the Write role's edit ClusterRole cannot create — the cluster's answer for
// the signed-in user (SelfSubjectAccessReview). Hidden while the cluster is
// asked; if it cannot be asked, the app permission decides as before.
export function useCanCreate(permission: string, target?: CreateTarget): boolean {
  const { has } = usePermission()
  const allowed = has(permission)
  const namespace = target?.namespace && target.namespace !== 'all' ? target.namespace : ''
  const { data, isError } = useQuery({
    queryKey: ['can-i', getCurrentClusterID(), 'create', target?.group, target?.resource, namespace],
    queryFn: () => api.canI({ verb: 'create', group: target!.group, resource: target!.resource, namespace }),
    enabled: allowed && !!target,
    staleTime: 60_000,
    retry: false,
  })
  if (!allowed) return false
  if (!target || isError) return true
  return data === true
}
