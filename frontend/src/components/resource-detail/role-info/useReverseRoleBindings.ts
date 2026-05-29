import { useQuery } from '@tanstack/react-query'
import { api } from '@/services/api'
import type { RoleBindingInfo, ClusterRoleBindingInfo } from '@/services/api'
import { useKubeWatchList } from '@/services/useKubeWatchList'

interface Params {
  kind: 'Role' | 'ClusterRole'
  namespace?: string
  name: string
}

// 50-row cap for cluster-wide ClusterRoleBinding fan-out per detail-modal-plan §1.B-6.
const MAX_RESULTS = 50

type Subject = { kind?: string | null; name?: string | null; namespace?: string | null }

export interface ReverseBinding {
  name: string
  namespace: string
  role_ref_kind?: string
  role_ref_name: string
  subjects: Subject[]
  subjects_count: number
}

function normalizeBinding(item: any): ReverseBinding | null {
  if (!item) return null
  const meta = item?.metadata ?? item ?? {}
  const roleRef = item?.roleRef ?? item?.role_ref ?? {}
  const subjectsRaw = Array.isArray(item?.subjects) ? item.subjects : []
  const subjects: Subject[] = subjectsRaw.map((s: any) => ({
    kind: s?.kind ?? null,
    name: s?.name ?? null,
    namespace: s?.namespace ?? null,
  }))
  const name = meta?.name ?? item?.name
  if (!name) return null
  return {
    name,
    namespace: meta?.namespace ?? item?.namespace ?? '',
    role_ref_kind: roleRef?.kind ?? item?.role_ref_kind,
    role_ref_name: roleRef?.name ?? item?.role_ref_name ?? '',
    subjects,
    subjects_count: subjects.length || item?.subjects_count || 0,
  }
}

function matchesRole(b: ReverseBinding, kind: 'Role' | 'ClusterRole', name: string): boolean {
  if (b.role_ref_name !== name) return false
  if (b.role_ref_kind && b.role_ref_kind !== kind) return false
  return true
}

// Returns RoleBindings that reference this Role (namespace-scoped) or
// ClusterRoleBindings that reference this ClusterRole (cluster-wide, capped at 50).
// Updates live via useKubeWatchList so kubectl create/delete on bindings is reflected
// immediately in the detail drawer.
export function useReverseRoleBindings({ kind, namespace, name }: Params): {
  bindings: ReverseBinding[]
  enabled: boolean
  truncated: boolean
} {
  const isClusterScope = kind === 'ClusterRole'
  const enabled = !!name && (isClusterScope || !!namespace)

  const queryKey = isClusterScope
    ? ['reverse-crb', name]
    : ['reverse-rb', namespace, name]

  const { data } = useQuery({
    queryKey,
    queryFn: async (): Promise<ReverseBinding[]> => {
      if (isClusterScope) {
        const all = await api.getClusterRoleBindings()
        return (all as ClusterRoleBindingInfo[])
          .map(normalizeBinding)
          .filter((b): b is ReverseBinding => b !== null)
      }
      const all = await api.getRoleBindings(namespace as string)
      return (all as RoleBindingInfo[])
        .map(normalizeBinding)
        .filter((b): b is ReverseBinding => b !== null)
    },
    enabled,
    staleTime: 5_000,
  })

  useKubeWatchList({
    enabled,
    queryKey,
    path: isClusterScope
      ? '/apis/rbac.authorization.k8s.io/v1/clusterrolebindings'
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

  const all = Array.isArray(data) ? data : []
  const matching = all.filter((b) => matchesRole(b, kind, name))
  const truncated = matching.length > MAX_RESULTS
  return {
    bindings: truncated ? matching.slice(0, MAX_RESULTS) : matching,
    enabled,
    truncated,
  }
}
