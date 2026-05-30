import { useQuery, useQueries } from '@tanstack/react-query'
import { api } from '@/services/api'
import type { RoleBindingInfo, ClusterRoleBindingInfo } from '@/services/api'
import { useKubeWatchList } from '@/services/useKubeWatchList'

interface Params {
  namespace: string
  name: string
}

interface RuleEntry {
  apiGroups: string[]
  resources: string[]
  verbs: string[]
  resourceNames?: string[]
}

export interface BoundRole {
  // Tracks which binding granted this Role/ClusterRole to the SA — used so the
  // UI can group rules by binding and show provenance.
  binding_kind: 'RoleBinding' | 'ClusterRoleBinding'
  binding_name: string
  binding_namespace?: string
  role_kind: 'Role' | 'ClusterRole'
  role_name: string
  role_namespace?: string  // empty for ClusterRole
  rules: RuleEntry[]
  loading: boolean
  error?: string
}

interface NormalizedBinding {
  kind: 'RoleBinding' | 'ClusterRoleBinding'
  name: string
  namespace?: string
  role_ref_kind: string
  role_ref_name: string
  subjects: Array<{ kind?: string | null; name?: string | null; namespace?: string | null }>
}

function normalizeRb(item: any, defaultKind: 'RoleBinding' | 'ClusterRoleBinding'): NormalizedBinding | null {
  if (!item) return null
  const meta = item?.metadata ?? item ?? {}
  const roleRef = item?.roleRef ?? item?.role_ref ?? {}
  const subjectsRaw = Array.isArray(item?.subjects) ? item.subjects : []
  const name = meta?.name ?? item?.name
  if (!name) return null
  return {
    kind: defaultKind,
    name,
    namespace: meta?.namespace ?? item?.namespace,
    role_ref_kind: roleRef?.kind ?? item?.role_ref_kind ?? '',
    role_ref_name: roleRef?.name ?? item?.role_ref_name ?? '',
    subjects: subjectsRaw.map((s: any) => ({
      kind: s?.kind ?? null,
      name: s?.name ?? null,
      namespace: s?.namespace ?? null,
    })),
  }
}

function bindsServiceAccount(b: NormalizedBinding, ns: string, saName: string): boolean {
  for (const s of b.subjects) {
    if (s.kind !== 'ServiceAccount') continue
    if (s.name !== saName) continue
    // RoleBinding subjects always carry an explicit namespace for SA. If missing
    // (older shape), fall back to the binding's namespace.
    const subjNs = s.namespace || b.namespace
    if (subjNs === ns) return true
  }
  return false
}

function normalizeRules(rulesRaw: any): RuleEntry[] {
  const list = Array.isArray(rulesRaw) ? rulesRaw : []
  return list.map((r: any) => ({
    apiGroups: Array.isArray(r?.apiGroups) ? r.apiGroups : (Array.isArray(r?.api_groups) ? r.api_groups : []),
    resources: Array.isArray(r?.resources) ? r.resources : [],
    verbs: Array.isArray(r?.verbs) ? r.verbs : [],
    resourceNames: Array.isArray(r?.resourceNames) ? r.resourceNames : (Array.isArray(r?.resource_names) ? r.resource_names : undefined),
  }))
}

// Walks RoleBindings (ns-scoped) + ClusterRoleBindings (cluster-wide) for ones
// that bind the given ServiceAccount, then fans out describe calls for each
// referenced Role / ClusterRole and flattens the rules per binding.
//
// Watch live so kubectl create/delete on bindings or roles is reflected
// immediately. react-query dedupes overlapping describe queries when the same
// Role is referenced by multiple SA detail drawers.
export function useEffectivePermissions({ namespace, name }: Params): {
  bound: BoundRole[]
  loading: boolean
} {
  const enabled = !!namespace && !!name

  // Cluster-wide CRB fan-out cap matches useReverseRoleBindings (50). Keeps
  // describe storm bounded if SA is bound via system-wide patterns.
  const MAX_BINDINGS = 50

  const rbKey = ['sa-effperm-rb', namespace, name]
  const crbKey = ['sa-effperm-crb', name]

  const { data: rbList } = useQuery({
    queryKey: rbKey,
    queryFn: () => api.getRoleBindings(namespace),
    enabled,
    staleTime: 5_000,
  })

  useKubeWatchList({
    enabled,
    queryKey: rbKey,
    path: `/apis/rbac.authorization.k8s.io/v1/namespaces/${namespace}/rolebindings`,
    query: 'watch=1',
    applyEvent: (prev, event) => {
      const items = Array.isArray(prev) ? [...(prev as RoleBindingInfo[])] : []
      const obj = event?.object
      if (!obj) return items
      const meta = obj?.metadata ?? {}
      const rbName = meta?.name
      const rbNs = meta?.namespace
      if (!rbName || !rbNs) return items
      const roleRef = obj?.roleRef ?? {}
      const subjectsRaw = Array.isArray(obj?.subjects) ? obj.subjects : []
      const normalized: RoleBindingInfo = {
        name: rbName,
        namespace: rbNs,
        role_ref_kind: roleRef?.kind ?? '',
        role_ref_name: roleRef?.name ?? '',
        subjects_count: subjectsRaw.length,
        subjects: subjectsRaw.map((s: any) => ({
          kind: s?.kind ?? null,
          name: s?.name ?? null,
          namespace: s?.namespace ?? null,
          apiGroup: s?.apiGroup ?? null,
        })),
        created_at: meta?.creationTimestamp ?? null,
        labels: meta?.labels ?? null,
        annotations: meta?.annotations ?? null,
      }
      const idx = items.findIndex((b) => b.name === rbName && b.namespace === rbNs)
      if (event?.type === 'DELETED') {
        if (idx >= 0) items.splice(idx, 1)
        return items
      }
      if (idx >= 0) items[idx] = normalized
      else items.push(normalized)
      return items
    },
  })

  const { data: crbList } = useQuery({
    queryKey: crbKey,
    queryFn: () => api.getClusterRoleBindings(),
    enabled,
    staleTime: 5_000,
  })

  useKubeWatchList({
    enabled,
    queryKey: crbKey,
    path: '/apis/rbac.authorization.k8s.io/v1/clusterrolebindings',
    query: 'watch=1',
    applyEvent: (prev, event) => {
      const items = Array.isArray(prev) ? [...(prev as ClusterRoleBindingInfo[])] : []
      const obj = event?.object
      if (!obj) return items
      const meta = obj?.metadata ?? {}
      const crbName = meta?.name
      if (!crbName) return items
      const roleRef = obj?.roleRef ?? {}
      const subjectsRaw = Array.isArray(obj?.subjects) ? obj.subjects : []
      const normalized: ClusterRoleBindingInfo = {
        name: crbName,
        role_ref_kind: roleRef?.kind ?? '',
        role_ref_name: roleRef?.name ?? '',
        subjects_count: subjectsRaw.length,
        subjects: subjectsRaw.map((s: any) => ({
          kind: s?.kind ?? null,
          name: s?.name ?? null,
          namespace: s?.namespace ?? null,
          apiGroup: s?.apiGroup ?? null,
        })),
        created_at: meta?.creationTimestamp ?? null,
        labels: meta?.labels ?? null,
        annotations: meta?.annotations ?? null,
      }
      const idx = items.findIndex((b) => b.name === crbName)
      if (event?.type === 'DELETED') {
        if (idx >= 0) items.splice(idx, 1)
        return items
      }
      if (idx >= 0) items[idx] = normalized
      else items.push(normalized)
      return items
    },
  })

  const matchedRbs: NormalizedBinding[] = (Array.isArray(rbList) ? rbList : [])
    .map((b: any) => normalizeRb(b, 'RoleBinding'))
    .filter((b): b is NormalizedBinding => b !== null)
    .filter((b) => bindsServiceAccount(b, namespace, name))

  const matchedCrbs: NormalizedBinding[] = (Array.isArray(crbList) ? crbList : [])
    .map((b: any) => normalizeRb(b, 'ClusterRoleBinding'))
    .filter((b): b is NormalizedBinding => b !== null)
    .filter((b) => bindsServiceAccount(b, namespace, name))

  const allMatched = [...matchedRbs, ...matchedCrbs].slice(0, MAX_BINDINGS)

  // Fan out describe for each unique (role_kind, role_name, role_ns) referenced.
  // Use binding's namespace for Role kind (RoleBinding can only reference Role
  // in same namespace per K8s rule; subject is SA's ns but role is binding's ns).
  const roleQueries = allMatched.map((b) => {
    const roleKind = (b.role_ref_kind === 'ClusterRole' ? 'ClusterRole' : 'Role') as 'Role' | 'ClusterRole'
    const roleNs = roleKind === 'ClusterRole' ? '' : (b.namespace ?? '')
    const key = roleKind === 'ClusterRole'
      ? ['describe-clusterrole', b.role_ref_name]
      : ['describe-role', roleNs, b.role_ref_name]
    return {
      queryKey: key,
      queryFn: () => roleKind === 'ClusterRole'
        ? api.describeClusterRole(b.role_ref_name)
        : api.describeRole(roleNs, b.role_ref_name),
      enabled: enabled && !!b.role_ref_name,
      staleTime: 30_000,
      retry: false,
    }
  })

  const roleResults = useQueries({ queries: roleQueries })

  const bound: BoundRole[] = allMatched.map((b, i) => {
    const roleKind = (b.role_ref_kind === 'ClusterRole' ? 'ClusterRole' : 'Role') as 'Role' | 'ClusterRole'
    const roleNs = roleKind === 'ClusterRole' ? undefined : (b.namespace ?? undefined)
    const q = roleResults[i]
    const desc = q?.data as any
    return {
      binding_kind: b.kind,
      binding_name: b.name,
      binding_namespace: b.namespace,
      role_kind: roleKind,
      role_name: b.role_ref_name,
      role_namespace: roleNs,
      rules: desc ? normalizeRules(desc?.rules) : [],
      loading: !!q?.isLoading,
      error: q?.error ? String(q.error) : undefined,
    }
  })

  const loading = roleResults.some((q) => q?.isLoading)
  return { bound, loading }
}
