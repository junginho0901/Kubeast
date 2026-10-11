import { ageSeconds, formatAge } from '@/utils/time'

export { formatAge }

export interface NodeInfo {
  name: string
  status: string
  roles: string[]
  age: string
  created_at?: string | null
  version?: string | null
  internal_ip?: string | null
  external_ip?: string | null
}

export interface NodeMetric {
  name: string
  cpu: string
  cpu_percent: string
  memory: string
  memory_percent: string
  timestamp?: string | null
  window?: string | null
}

export type SortKey =
  | null
  | 'name'
  | 'status'
  | 'roles'
  | 'cpu'
  | 'memory'
  | 'version'
  | 'internal_ip'
  | 'external_ip'
  | 'age'

export type SortDir = 'asc' | 'desc'

export const nodeYamlTemplate = `apiVersion: v1
kind: Node
metadata:
  name: sample-node
  labels:
    node-role.kubernetes.io/worker: ""
`

export function getStatusColor(status: string): string {
  const lower = (status || '').toLowerCase().trim()
  if (lower === 'ready') return 'badge-success'
  if (lower === 'schedulingdisabled') return 'badge-warning'
  if (lower.includes('notready') || lower.includes('unknown')) return 'badge-error'
  if (lower.includes('ready')) return 'badge-success'
  return 'badge-info'
}

export function sortNodes(
  nodes: NodeInfo[],
  metricsMap: Map<string, NodeMetric>,
  sortKey: SortKey,
  sortDir: SortDir,
): NodeInfo[] {
  if (!sortKey) return nodes
  const list = [...nodes]
  const getValue = (node: NodeInfo) => {
    switch (sortKey) {
      case 'name':
        return node.name
      case 'status':
        return node.status || ''
      case 'roles':
        return (node.roles || []).join(',')
      case 'cpu': {
        const metric = metricsMap.get(node.name)
        return metric ? parseFloat(metric.cpu_percent) || 0 : 0
      }
      case 'memory': {
        const metric = metricsMap.get(node.name)
        return metric ? parseFloat(metric.memory_percent) || 0 : 0
      }
      case 'version':
        return node.version || ''
      case 'internal_ip':
        return node.internal_ip || ''
      case 'external_ip':
        return node.external_ip || ''
      case 'age':
        return ageSeconds(node.created_at)
      default:
        return ''
    }
  }
  list.sort((a, b) => {
    const av = getValue(a)
    const bv = getValue(b)
    if (typeof av === 'number' && typeof bv === 'number') {
      return sortDir === 'asc' ? av - bv : bv - av
    }
    const as = String(av)
    const bs = String(bv)
    return sortDir === 'asc' ? as.localeCompare(bs) : bs.localeCompare(as)
  })
  return list
}
