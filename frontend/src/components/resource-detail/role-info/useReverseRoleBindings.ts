import { useMemo } from 'react'
import { useQuery } from '@tanstack/react-query'
import { api } from '@/services/api'
import { useKubeWatchList } from '@/services/useKubeWatchList'
import { failureText } from '@/utils/failureText'
import { normalizeBinding, referencingBindings, type ReverseBinding } from './referencedBy'

export type { ReverseBinding } from './referencedBy'

interface Params {
  kind: 'Role' | 'ClusterRole'
  namespace?: string
  name: string
  // a ClusterRole's ClusterRoleBindings (the default) or the RoleBindings of every namespace that reference it
  via?: 'ClusterRoleBinding' | 'RoleBinding'
}

// Returns every binding that references this Role (RoleBindings of its namespace) or this ClusterRole
// (ClusterRoleBindings, or RoleBindings across namespaces — a namespace-scoped grant reads its namespaces only).
// Updates live via useKubeWatchList so kubectl create/delete on bindings is reflected
// immediately in the detail drawer.
export function useReverseRoleBindings({ kind, namespace, name, via = 'ClusterRoleBinding' }: Params): {
  bindings: ReverseBinding[]
  enabled: boolean
  error: { message: string; forbidden: boolean } | null
} {
  const source = kind === 'Role' ? 'namespace' : via === 'RoleBinding' ? 'all-namespaces' : 'cluster'
  const enabled = !!name && (kind === 'ClusterRole' || !!namespace)

  const queryKey = source === 'cluster'
    ? ['reverse-crb', name]
    : source === 'all-namespaces'
      ? ['reverse-rb-all', name]
      : ['reverse-rb', namespace, name]

  const { data, error } = useQuery({
    queryKey,
    queryFn: async (): Promise<ReverseBinding[]> => {
      const all: unknown[] = source === 'cluster'
        ? await api.getClusterRoleBindings()
        : source === 'all-namespaces'
          ? await api.getAllRoleBindings()
          : await api.getRoleBindings(namespace as string)
      return all.map(normalizeBinding).filter((b): b is ReverseBinding => b !== null)
    },
    enabled,
    staleTime: 5_000,
    retry: 1,
  })

  useKubeWatchList({
    enabled,
    queryKey,
    path: source === 'cluster'
      ? '/apis/rbac.authorization.k8s.io/v1/clusterrolebindings'
      : source === 'all-namespaces'
        ? '/apis/rbac.authorization.k8s.io/v1/rolebindings'
        : `/apis/rbac.authorization.k8s.io/v1/namespaces/${namespace}/rolebindings`,
    query: 'watch=1',
    applyEvent: (prev, event) => {
      const items = Array.isArray(prev) ? [...(prev as ReverseBinding[])] : []
      const normalized = normalizeBinding(event?.object)
      if (!normalized) return items
      const idx = items.findIndex((b) => b.name === normalized.name && b.namespace === normalized.namespace)
      if (event?.type === 'DELETED') {
        if (idx >= 0) items.splice(idx, 1)
        return items
      }
      if (idx >= 0) {
        items[idx] = normalized
      } else {
        items.push(normalized)
      }
      return items
    },
  })

  const bindings = useMemo(() => referencingBindings(Array.isArray(data) ? data : [], kind, name), [data, kind, name])
  const status = (error as { response?: { status?: number } } | null)?.response?.status
  const message = error ? failureText(error) : null
  const failure = useMemo(() => (message === null ? null : { message, forbidden: status === 403 }), [message, status])
  return { bindings, enabled, error: failure }
}
