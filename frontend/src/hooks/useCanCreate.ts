import { useCallback } from 'react'
import { useQuery } from '@tanstack/react-query'
import { api } from '@/services/api'
import { getCurrentClusterID } from '@/services/clusterRef'
import { usePermission } from './usePermission'
import { useClusterFeatures } from './usePrometheusQuery'

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

// Whether the server refuses this user's writes in a namespace whatever the permissions say. It reads the features
// answer the layout already holds, so a list or a row asks nothing of its own; an answer that says nothing keeps the button.
export function useWritesRefusedIn(): (namespace?: string) => boolean {
  const refused = useClusterFeatures().data?.writeGuardedNamespaces
  return useCallback((namespace?: string) => !!namespace && !!refused?.includes(namespace), [refused])
}
