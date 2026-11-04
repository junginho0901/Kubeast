// The bindings that grant a Role or ClusterRole, as the Role and ClusterRole drawers list them.

export type Subject = { kind?: string | null; name?: string | null; namespace?: string | null }

export interface ReverseBinding {
  name: string
  namespace: string
  role_ref_kind?: string
  role_ref_name: string
  subjects: Subject[]
  subjects_count: number
}

// A binding as the list API answers it (role_ref_kind, role_ref_name) or as a watch event carries it (roleRef).
export function normalizeBinding(item: any): ReverseBinding | null {
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

// Every binding whose roleRef is kind/name (kubectl get rolebindings' ROLE column), in the order the API lists them
// (by namespace/name, byte order).
export function referencingBindings(items: unknown[], kind: 'Role' | 'ClusterRole', name: string): ReverseBinding[] {
  const key = (b: ReverseBinding) => `${b.namespace}/${b.name}`
  return (Array.isArray(items) ? items : [])
    .map(normalizeBinding)
    .filter((b): b is ReverseBinding => b !== null && b.role_ref_name === name && b.role_ref_kind === kind)
    .sort((a, b) => (key(a) < key(b) ? -1 : key(a) > key(b) ? 1 : 0))
}

// The Subjects cell: Kind/name, comma separated, or "-"
export function subjectsText(subjects: Subject[]): string {
  return subjects.length === 0 ? '-' : subjects.map((s) => `${s.kind || '?'}/${s.name || '-'}`).join(', ')
}

// What a Referenced By section says when its list could not be read, instead of a count it does not have
export function unreadableText(forbidden: boolean): string {
  return forbidden
    ? 'You may not list {{kind}} here, so the bindings that reference this {{role}} cannot be shown.'
    : 'Could not load {{kind}}, so the bindings that reference this {{role}} cannot be shown.'
}

export interface ReferencedByList {
  bindings: ReverseBinding[]
  error?: string
}

// What the ClusterRole drawer shows of its bindings, for the AI context: every row of both sections, their counts,
// and, for a namespace-scoped grant, that RoleBindings elsewhere are not known.
export function referencedByContext(crbs: ReferencedByList, rbs: ReferencedByList, scope: string[] | null): Record<string, unknown> {
  return {
    referenced_by_cluster_role_bindings_count: crbs.error ? null : crbs.bindings.length,
    referenced_by_cluster_role_bindings: crbs.bindings.map((b) => ({ name: b.name, subjects: subjectsText(b.subjects) })),
    ...(crbs.error ? { referenced_by_cluster_role_bindings_error: crbs.error } : {}),
    referenced_by_role_bindings_count: rbs.error ? null : rbs.bindings.length,
    referenced_by_role_bindings: rbs.bindings.map((b) => ({ namespace: b.namespace, name: b.name, subjects: subjectsText(b.subjects) })),
    ...(rbs.error ? { referenced_by_role_bindings_error: rbs.error } : {}),
    ...(scope && scope.length > 0 ? { role_bindings_read_in_namespaces: scope, role_bindings_in_other_namespaces: 'unknown' } : {}),
  }
}
