import { useQuery, useQueries } from '@tanstack/react-query'
import { api } from '@/services/api'
import type { RoleBindingInfo, ClusterRoleBindingInfo } from '@/services/api'
import { useKubeWatchList } from '@/services/useKubeWatchList'
import { applyClusterRoleBindingWatchEvent, applyRoleBindingWatchEvent } from '@/pages/security/rolebindings/roleBindingWatchNormalize'

interface Params {
  namespace: string
  name: string
}

export interface RuleEntry {
  apiGroups: string[]
  resources: string[]
  verbs: string[]
  resourceNames?: string[]
  nonResourceURLs: string[]
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
  /** the User or Group subjects that make this binding apply, when it does not name the ServiceAccount itself */
  matched_by: string[]
  rules: RuleEntry[]
  loading: boolean
  error?: string
}

export interface NormalizedBinding {
  kind: 'RoleBinding' | 'ClusterRoleBinding'
  name: string
  namespace?: string
  role_ref_kind: string
  role_ref_name: string
  subjects: Subject[]
  matched_by: string[]
}

interface Subject {
  kind?: string | null
  name?: string | null
  namespace?: string | null
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
    matched_by: [],
  }
}

// A subject without a namespace is the RoleBinding's and nobody's in a ClusterRoleBinding, as the API server reads it.
function namesServiceAccount(s: Subject, b: NormalizedBinding, ns: string, saName: string): boolean {
  return s.kind === 'ServiceAccount' && s.name === saName && (s.namespace || b.namespace) === ns
}

// Who the API server also takes it for, as a pod's RBAC tab matches; system:authenticated is everyone signed in, so as there it does not count.
function includesServiceAccount(s: Subject, ns: string, saName: string): boolean {
  if (s.kind === 'User') return s.name === `system:serviceaccount:${ns}:${saName}`
  if (s.kind === 'Group') return s.name === 'system:serviceaccounts' || s.name === `system:serviceaccounts:${ns}`
  return false
}

// Every RoleBinding, then every ClusterRoleBinding, that applies to the ServiceAccount (the drawer pages them)
export function serviceAccountBindings(rbList: unknown, crbList: unknown, namespace: string, name: string): NormalizedBinding[] {
  const matched = (list: unknown, kind: 'RoleBinding' | 'ClusterRoleBinding') => (Array.isArray(list) ? list : [])
    .map((b: any) => normalizeRb(b, kind))
    .filter((b): b is NormalizedBinding => b !== null)
    .flatMap((b) => {
      const others = b.subjects.filter((s) => includesServiceAccount(s, namespace, name))
      const direct = b.subjects.some((s) => namesServiceAccount(s, b, namespace, name))
      if (!direct && others.length === 0) return []
      return [{ ...b, matched_by: direct ? [] : others.map((s) => `${s.kind} ${s.name}`) }]
    })
  return [...matched(rbList, 'RoleBinding'), ...matched(crbList, 'ClusterRoleBinding')]
}

export function normalizeRules(rulesRaw: any): RuleEntry[] {
  const list = Array.isArray(rulesRaw) ? rulesRaw : []
  return list.map((r: any) => ({
    apiGroups: Array.isArray(r?.apiGroups) ? r.apiGroups : (Array.isArray(r?.api_groups) ? r.api_groups : []),
    resources: Array.isArray(r?.resources) ? r.resources : [],
    verbs: Array.isArray(r?.verbs) ? r.verbs : [],
    resourceNames: Array.isArray(r?.resourceNames) ? r.resourceNames : (Array.isArray(r?.resource_names) ? r.resource_names : undefined),
    nonResourceURLs: Array.isArray(r?.nonResourceURLs) ? r.nonResourceURLs : [],
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
  /** Binding kinds whose list could not be read (403 or a failure): the result may be incomplete */
  unreadable: { kinds: string[]; forbidden: boolean }
} {
  const enabled = !!namespace && !!name

  const rbKey = ['sa-effperm-rb', namespace, name]
  const crbKey = ['sa-effperm-crb', name]

  const { data: rbList, error: rbError } = useQuery({
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
    applyEvent: (prev, event) => applyRoleBindingWatchEvent(prev as RoleBindingInfo[] | undefined, event),
  })

  const { data: crbList, error: crbError } = useQuery({
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
    applyEvent: (prev, event) => applyClusterRoleBindingWatchEvent(prev as ClusterRoleBindingInfo[] | undefined, event),
  })

  // queries of one role share their key, so a role is read once however many bindings name it
  const allMatched = serviceAccountBindings(rbList, crbList, namespace, name)

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
      matched_by: b.matched_by,
      rules: desc ? normalizeRules(desc?.rules) : [],
      loading: !!q?.isLoading,
      error: q?.error ? String(q.error) : undefined,
    }
  })

  const loading = roleResults.some((q) => q?.isLoading)
  // A refused binding list must not read as "nothing binds it" (re-QA #43).
  const failed = [
    { kind: 'RoleBinding', error: rbError },
    { kind: 'ClusterRoleBinding', error: crbError },
  ].filter((f) => f.error)
  const unreadable = {
    kinds: failed.map((f) => f.kind),
    forbidden: failed.some((f) => (f.error as { response?: { status?: number } })?.response?.status === 403),
  }
  return { bound, loading, unreadable }
}
