import { useQuery } from '@tanstack/react-query'
import { api } from '@/services/api'
import { getCurrentClusterID } from '@/services/clusterRef'
import { usePermission } from './usePermission'

/** The Kubernetes resource a create or delete button acts on, for the cluster's own answer. */
export interface AccessTarget {
  group: string
  resource: string
  /** For a namespaced kind: the namespace being viewed ('' or a list's 'all' = every namespace). */
  namespace?: string
  /** The object a delete button acts on (RBAC resourceNames can allow one object only). */
  name?: string
  /** A subresource the action goes through, such as a pod's exec. */
  subresource?: string
}

// Whether a create or delete button shows: the app permission, and for kinds the
// cluster's RBAC may refuse even so — cluster-scoped objects, Roles, Endpoints,
// quotas and custom resources such as the Gateway API's and VPAs, which the
// Write role's edit ClusterRole does not cover — the cluster's answer for
// the signed-in user (SelfSubjectAccessReview). Hidden while the cluster is
// asked; if it cannot be asked, the app permission decides as before. The server also answers no, without asking the
// cluster, where it would refuse the action itself: outside a limited grant and in the namespaces it guards.
export function useCanI(permission: string, verb: string, target?: AccessTarget): boolean {
  const { has } = usePermission()
  const allowed = has(permission)
  const name = target?.name ?? ''
  // a list's 'all' is every namespace; a named object's namespace is its own, whatever it is called
  const namespace = target?.namespace === 'all' && !name ? '' : target?.namespace ?? ''
  const { data, isError } = useQuery({
    queryKey: ['can-i', getCurrentClusterID(), verb, target?.group, target?.resource, namespace, name, ...(target?.subresource ? [target.subresource] : [])],
    queryFn: () => api.canI({ verb, group: target!.group, resource: target!.resource, subresource: target!.subresource, namespace, name }),
    enabled: allowed && !!target,
    staleTime: 60_000,
    retry: false,
  })
  if (!allowed) return false
  if (!target || isError) return true
  return data === true
}

export function useCanCreate(permission: string, target?: AccessTarget): boolean {
  return useCanI(permission, 'create', target)
}
