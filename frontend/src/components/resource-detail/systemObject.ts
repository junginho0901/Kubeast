// Objects whose delete is hard to undo or that the cluster itself runs on
// (re-QA #38): their delete window warns and asks for the name. The API server
// refuses to delete the namespaces in IMMORTAL, so those get a notice instead
// of a delete button.

export type SystemReason = 'immortalNamespace' | 'systemNamespace' | 'node' | 'crd' | 'helm' | 'bootstrap' | 'systemRbac'

export interface SystemCheck {
  blocked: boolean
  reasons: SystemReason[]
}

const IMMORTAL = new Set(['default', 'kube-system', 'kube-public'])
const SYSTEM_NAMESPACES = new Set(['kube-system', 'kube-public', 'kube-node-lease'])
const RBAC_KINDS = new Set(['ClusterRole', 'ClusterRoleBinding', 'Role', 'RoleBinding'])

interface Meta {
  labels?: Record<string, string> | null
  annotations?: Record<string, string> | null
}

export function systemObject(kind: string, namespace: string | null | undefined, name: string, meta?: Meta | null): SystemCheck {
  if (kind === 'Namespace' && IMMORTAL.has(name)) return { blocked: true, reasons: ['immortalNamespace'] }
  const reasons = new Set<SystemReason>()
  if ((kind === 'Namespace' && SYSTEM_NAMESPACES.has(name)) || (namespace && SYSTEM_NAMESPACES.has(namespace))) reasons.add('systemNamespace')
  if (kind === 'Node') reasons.add('node')
  if (kind === 'CustomResourceDefinition') reasons.add('crd')
  const labels = meta?.labels ?? {}
  const annotations = meta?.annotations ?? {}
  if (annotations['meta.helm.sh/release-name'] || labels['app.kubernetes.io/managed-by'] === 'Helm') reasons.add('helm')
  if (labels['kubernetes.io/bootstrapping']) reasons.add('bootstrap')
  if (RBAC_KINDS.has(kind) && (name.startsWith('system:') || name === 'cluster-admin')) reasons.add('systemRbac')
  return { blocked: false, reasons: [...reasons] }
}
