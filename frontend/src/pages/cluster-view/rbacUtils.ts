// Pod RBAC 분석 helper. ClusterView.tsx 에서 추출 (Phase 3.1.d).
//
// `isAuthenticatedOnlyGrant`: binding 이 system:authenticated 그룹만으로 부여
// 됐는지 — UI 가 "인증된 사용자 전체" 부여를 noise 로 필터하는 데 사용.
//
// `buildRbacPermissionSummary`: 모든 role/cluster role binding 의 rules 를
// 평탄화 + 중복 제거 + 정렬해서 (resource, verbs) 표 형태로 가공.
// 가장 복잡한 로직 (~100줄) 인데 tr / React 의존 X 라 순수 함수로 추출.

const RBAC_API = '/apis/rbac.authorization.k8s.io/v1'

// What the tab's answer is worked out from: the bindings and the roles they name. A list the answer says it could not read
// would only be refused again, and say on the page what the tab already says.
export function rbacWatchPaths(namespace: string, answer: any): string[] {
  if (!answer) return []
  return [
    ...(answer.role_bindings_error ? [] : [`${RBAC_API}/namespaces/${namespace}/rolebindings`, `${RBAC_API}/namespaces/${namespace}/roles`]),
    ...(answer.cluster_role_bindings_error ? [] : [`${RBAC_API}/clusterrolebindings`, `${RBAC_API}/clusterroles`]),
  ]
}

export const isAuthenticatedOnlyGrant = (binding: any): boolean => {
  const matchedBy = binding?.matched_by
  if (Array.isArray(matchedBy) && matchedBy.length > 0) {
    return matchedBy.every((m: any) => m?.reason === 'group:system:authenticated')
  }
  return Boolean(binding?.is_broad)
}

export interface RbacPermissionItem {
  kind: 'resource' | 'nonResourceURL'
  apiGroup?: string
  resource?: string
  resourceNames?: string[]
  nonResourceURL?: string
  verbs: Set<string>
  verbsList: string[]
}

export interface RbacPermissionSummary {
  resourceItems: RbacPermissionItem[]
  nonResourceItems: RbacPermissionItem[]
  /** A list or a role could not be read, so the items may lack permissions */
  incomplete: boolean
}

export interface RbacBindingList {
  /** false: the cluster refused the list, so its rows say nothing about what exists */
  read: boolean
  error: string
  all: any[]
  normal: any[]
  broad: any[]
}

export const rbacBindingList = (rbac: any, key: 'role_bindings' | 'cluster_role_bindings'): RbacBindingList => {
  const rows = rbac?.[key]
  const all = Array.isArray(rows) ? rows : []
  return {
    read: Array.isArray(rows),
    error: rbac?.[`${key}_error`] || '',
    all,
    normal: all.filter((b) => !isAuthenticatedOnlyGrant(b)),
    broad: all.filter(isAuthenticatedOnlyGrant),
  }
}

/** A rule's API groups as the tab writes them: the core group has no name of its own. */
export const rbacApiGroupsText = (groups: unknown): string => {
  const list = Array.isArray(groups) ? groups : []
  return list.map((g) => (g === '' ? '(core)' : g)).join(', ') || '(core)'
}

const permissionRows = ({ resourceItems, nonResourceItems }: RbacPermissionSummary) => [
  ...resourceItems.map((i) => `${i.apiGroup}|${i.resource}|${(i.resourceNames ?? []).join(',')}|${i.verbsList.join(',')}`),
  ...nonResourceItems.map((i) => `${i.nonResourceURL}|${i.verbsList.join(',')}`),
]

const bindingContextRow = (b: any) => ({
  name: b?.name,
  role: `${b?.role_ref?.kind}:${b?.role_ref?.name}`,
  matched_by: (Array.isArray(b?.matched_by) ? b.matched_by : []).map((m: any) => m?.reason),
  rules: b?.resolved_role?.error ? undefined : (b?.resolved_role?.rules?.length ?? 0),
  role_error: b?.resolved_role?.error || undefined,
})

/** What the tab shows, for the floating chat. A list not read has no key and its reason in `errors`. */
export const podRbacAIContext = (rbac: any, pod: { name: string; namespace: string }) => {
  const summary = buildRbacPermissionSummary(rbac)
  const permissions = permissionRows(summary)
  const roleBindings = rbacBindingList(rbac, 'role_bindings')
  const clusterRoleBindings = rbacBindingList(rbac, 'cluster_role_bindings')
  const name = rbac?.service_account?.name
  const count = (list: RbacBindingList) => (list.read ? list.all.length : '-')
  return {
    source: 'PodRbacTab',
    summary: `Pod ${pod.name} (${pod.namespace}) RBAC: ServiceAccount ${name ?? '-'}, RoleBinding ${count(roleBindings)}, ClusterRoleBinding ${count(clusterRoleBindings)}, ${permissions.length} permission rows${summary.incomplete ? ' (some could not be read)' : ''}`,
    data: {
      kind: 'Pod',
      name: pod.name,
      namespace: pod.namespace,
      service_account: name ? `system:serviceaccount:${pod.namespace}:${name}` : null,
      include_authenticated: Boolean(rbac?.include_authenticated),
      // The budget halves arrays in this order; each total says what was there.
      permissions,
      permissions_total: permissions.length,
      permissions_format: 'apiGroup|resource|resourceNames|verbs, url|verbs',
      permissions_incomplete: summary.incomplete,
      ...(roleBindings.read ? { role_bindings: roleBindings.all.map(bindingContextRow), role_bindings_total: roleBindings.all.length } : {}),
      ...(clusterRoleBindings.read ? { cluster_role_bindings: clusterRoleBindings.all.map(bindingContextRow), cluster_role_bindings_total: clusterRoleBindings.all.length } : {}),
      errors: Array.isArray(rbac?.errors) ? rbac.errors : [],
    },
  }
}

export const buildRbacPermissionSummary = (rbac: any): RbacPermissionSummary => {
  const items: Array<{
    kind: 'resource' | 'nonResourceURL'
    apiGroup?: string
    resource?: string
    resourceNames?: string[]
    nonResourceURL?: string
    verbs: Set<string>
  }> = []

  const resourceIndex = new Map<string, number>()
  const nonResourceIndex = new Map<string, number>()

  const addResource = (apiGroup: string, resource: string, resourceNames: string[] | undefined, verbs: string[]) => {
    const namesKey = (resourceNames || []).slice().sort().join(',')
    const key = `${apiGroup}::${resource}::${namesKey}`
    const existingIndex = resourceIndex.get(key)
    if (existingIndex !== undefined) {
      for (const v of verbs) items[existingIndex].verbs.add(v)
      return
    }
    const idx = items.length
    resourceIndex.set(key, idx)
    items.push({
      kind: 'resource',
      apiGroup,
      resource,
      resourceNames: resourceNames && resourceNames.length ? resourceNames.slice().sort() : undefined,
      verbs: new Set(verbs || []),
    })
  }

  const addNonResource = (url: string, verbs: string[]) => {
    const key = url
    const existingIndex = nonResourceIndex.get(key)
    if (existingIndex !== undefined) {
      for (const v of verbs) items[existingIndex].verbs.add(v)
      return
    }
    const idx = items.length
    nonResourceIndex.set(key, idx)
    items.push({
      kind: 'nonResourceURL',
      nonResourceURL: url,
      verbs: new Set(verbs || []),
    })
  }

  const bindings = [
    ...((rbac?.role_bindings || []) as any[]),
    ...((rbac?.cluster_role_bindings || []) as any[]),
  ]

  for (const b of bindings) {
    const rules = b?.resolved_role?.rules
    if (!Array.isArray(rules)) continue
    for (const rule of rules) {
      const verbs: string[] = Array.isArray(rule?.verbs) ? rule.verbs : []

      const nonResourceURLs: string[] = Array.isArray(rule?.non_resource_urls) ? rule.non_resource_urls : []
      if (nonResourceURLs.length > 0) {
        for (const url of nonResourceURLs) {
          if (typeof url === 'string' && url.trim()) addNonResource(url, verbs)
        }
        continue
      }

      const apiGroups: string[] = Array.isArray(rule?.api_groups) && rule.api_groups.length ? rule.api_groups : ['']
      const resources: string[] = Array.isArray(rule?.resources) ? rule.resources : []
      const resourceNames: string[] | undefined = Array.isArray(rule?.resource_names) ? rule.resource_names : undefined

      for (const ag of apiGroups) {
        const apiGroup = ag === '' ? '(core)' : ag
        for (const res of resources) {
          if (typeof res === 'string' && res.trim()) addResource(apiGroup, res, resourceNames, verbs)
        }
      }
    }
  }

  const resourceItems = items
    .filter((i) => i.kind === 'resource')
    .map((i) => ({
      ...i,
      verbsList: Array.from(i.verbs).sort(),
    }))
    .sort((a, b) => {
      const ag = (a.apiGroup || '').localeCompare(b.apiGroup || '')
      if (ag !== 0) return ag
      const r = (a.resource || '').localeCompare(b.resource || '')
      if (r !== 0) return r
      const an = (a.resourceNames || []).join(',').localeCompare((b.resourceNames || []).join(','))
      return an
    })

  const nonResourceItems = items
    .filter((i) => i.kind === 'nonResourceURL')
    .map((i) => ({
      ...i,
      verbsList: Array.from(i.verbs).sort(),
    }))
    .sort((a, b) => (a.nonResourceURL || '').localeCompare(b.nonResourceURL || ''))

  const incomplete =
    !rbacBindingList(rbac, 'role_bindings').read ||
    !rbacBindingList(rbac, 'cluster_role_bindings').read ||
    bindings.some((b) => Boolean(b?.resolved_role?.error))

  return { resourceItems, nonResourceItems, incomplete }
}
