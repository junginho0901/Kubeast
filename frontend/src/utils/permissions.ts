// Per-cluster permission matrix on the frontend (step 06/09).
//
// The authoritative source is the matrix GET /auth/me returns — the same one
// the backend puts in the JWT and enforces (services/pkg/auth). UI gating must
// use this rather than the global role's flat permission list, otherwise we'd
// show buttons the backend then 403s (a user's global role may include
// resource.* perms while their effective per-cluster access is deny-by-default
// until granted).

// clusterID → permission keys. The "*" entry holds GLOBAL (admin.*) perms and,
// for a superuser, the "*" wildcard.
export type PermissionMatrix = Record<string, string[]>

// permMatches mirrors pkg/auth permMatches (Go) and ai-service security.py:
// "*" grants everything; a "*" segment matches exactly one segment
// ("resource.*.read" → "resource.pod.read"); a trailing "*" matches the rest
// ("ai.tool.*" → "ai.tool.k8s_scale").
export function permMatches(pattern: string, perm: string): boolean {
  if (pattern === '*' || pattern === perm) return true
  const ps = pattern.split('.')
  const qs = perm.split('.')
  for (let i = 0; i < ps.length; i++) {
    if (ps[i] === '*' && i === ps.length - 1) return qs.length >= ps.length
    if (i >= qs.length || (ps[i] !== '*' && ps[i] !== qs[i])) return false
  }
  return ps.length === qs.length
}

export function matchAny(perms: string[] | undefined, perm: string): boolean {
  if (!perms) return false
  return perms.some((p) => permMatches(p, perm))
}

// hasPermission honors the all-cluster "*" entry always; the concrete cluster's
// entry is consulted when clusterID is a real id (deny-by-default — no fallback),
// never for an admin.* key, which pkg/auth HasPermission reads from "*" alone.
export function hasPermission(matrix: PermissionMatrix, perm: string, clusterID = ''): boolean {
  if (matchAny(matrix['*'], perm)) return true
  if (perm.startsWith('admin.')) return false
  return clusterID ? matchAny(matrix[clusterID], perm) : false
}

// Held on at least one cluster: for a setting this browser keeps, which belongs to no one cluster.
export function holdsOnAnyCluster(matrix: PermissionMatrix, perm: string): boolean {
  return Object.values(matrix).some((perms) => matchAny(perms, perm))
}

// A route asking cluster keys cannot be answered before a cluster is chosen (the picker chooses one after a first
// sign-in): it waits when no key passes yet and some cluster holds one, or a bookmark would be sent away.
export function waitsForCluster(keys: string[], currentCluster: string, matrix: PermissionMatrix): boolean {
  if (currentCluster || keys.some((k) => hasPermission(matrix, k))) return false
  return keys.some((k) => !k.startsWith('admin.') && holdsOnAnyCluster(matrix, k))
}

// What k8s-service's lists and details ask (handler/read_gate.go). resource.*.read covers it.
export const LISTS_AND_DETAILS = 'resource.objects.read'

// A role whose screens would stay empty: it gives something on a cluster and no list. A role of admin keys opens pages,
// and an empty one reaches no cluster.
export function roleReadsNoList(perms: Iterable<string>): boolean {
  const list = [...perms]
  return list.some((p) => !p.startsWith('admin.')) && !matchAny(list, LISTS_AND_DETAILS)
}

// What the new role form starts with: a new role reads the lists its group is bound to, if its author may hand that out
// (the permission ceiling refuses a key the author holds nowhere).
export function newRolePermissions(matrix: PermissionMatrix): string[] {
  return holdsOnAnyCluster(matrix, LISTS_AND_DETAILS) ? [LISTS_AND_DETAILS] : []
}

// parsePermissions accepts only the per-cluster map form. A flat array or a
// missing/!object value yields an empty matrix (deny-all), matching the
// backend's reject-and-relogin behavior on the UI side.
export function parsePermissions(raw: unknown): PermissionMatrix {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {}
  const out: PermissionMatrix = {}
  for (const [cid, v] of Object.entries(raw as Record<string, unknown>)) {
    if (Array.isArray(v)) {
      out[cid] = v.filter((p): p is string => typeof p === 'string')
    }
  }
  return out
}

// permResource is the <name> in resource.<name>.<verb> for a kind, as the
// backend names it (PermResource in services/pkg/auth/perm_resource.go — keep
// the lists the same): the lower-cased kind, a short
// name for six kinds, and "customresource" for any kind without its own name.
// The short names and the drawer's CustomResourceInstance are accepted too.
const PERM_RESOURCE_ALIASES: Record<string, string> = {
  horizontalpodautoscaler: 'hpa',
  verticalpodautoscaler: 'vpa',
  poddisruptionbudget: 'pdb',
  persistentvolume: 'pv',
  persistentvolumeclaim: 'pvc',
  customresourcedefinition: 'crd',
  customresourceinstance: 'customresource',
}

const PERM_RESOURCES = new Set([
  'pod', 'deployment', 'statefulset', 'daemonset', 'replicaset', 'job', 'cronjob',
  'service', 'endpoints', 'endpointslice', 'ingress', 'ingressclass', 'networkpolicy',
  'configmap', 'secret', 'serviceaccount',
  'role', 'rolebinding', 'clusterrole', 'clusterrolebinding',
  'namespace', 'node', 'storageclass', 'volumeattachment',
  'resourcequota', 'limitrange', 'priorityclass', 'runtimeclass', 'lease',
  'mutatingwebhookconfiguration', 'validatingwebhookconfiguration',
  'validatingadmissionpolicy', 'validatingadmissionpolicybinding', 'mutatingadmissionpolicy', 'mutatingadmissionpolicybinding',
  'gateway', 'gatewayclass', 'httproute', 'grpcroute', 'referencegrant', 'backendtlspolicy',
  'deviceclass', 'resourceclaim', 'resourceclaimtemplate', 'resourceslice',
  'cost', 'policyreport', 'networkflow',
  'hpa', 'vpa', 'pdb', 'pv', 'pvc', 'crd',
])

export function permResource(kind: string): string {
  const k = kind.toLowerCase()
  const name = PERM_RESOURCE_ALIASES[k] ?? k
  return PERM_RESOURCES.has(name) ? name : 'customresource'
}
