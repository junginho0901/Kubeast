export interface NamespaceInfo {
  name: string
  status: string
  created_at: string
  labels: Record<string, string>
  resource_count: Record<string, number>
}

export type SummaryCard = [label: string, value: number, boxClass: string, labelClass: string]

export type SortKey = null | 'name' | 'status' | 'age'

export type SortDir = 'asc' | 'desc'

const nsNameRegex = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/

export function isValidNsName(name: string): boolean {
  if (!name) return false
  if (name.length > 63) return false
  return nsNameRegex.test(name)
}

export function formatRelative(iso?: string | null): string {
  if (!iso) return '-'
  const date = new Date(iso)
  const diffMs = Date.now() - date.getTime()
  if (!Number.isFinite(diffMs) || diffMs < 0) return '-'
  const minutes = Math.floor(diffMs / 60000)
  const hours = Math.floor(minutes / 60)
  const days = Math.floor(hours / 24)
  if (days >= 30) {
    const months = Math.floor(days / 30)
    return `${months}mo`
  }
  if (days > 0) return `${days}d`
  if (hours > 0) return `${hours}h`
  return `${minutes}m`
}

export function parseCreatedDays(createdAt?: string | null): number {
  if (!createdAt) return 0
  const date = new Date(createdAt)
  const diffMs = Date.now() - date.getTime()
  return Math.floor(diffMs / 86400000)
}

export function getStatusColor(status: string): string {
  const lower = (status || '').toLowerCase()
  if (lower === 'active') return 'badge-success'
  if (lower === 'terminating') return 'badge-warning'
  return 'badge-info'
}

export function sortNamespaces(
  list: NamespaceInfo[],
  sortKey: SortKey,
  sortDir: SortDir,
): NamespaceInfo[] {
  if (!sortKey) return list
  const out = [...list]
  const getValue = (ns: NamespaceInfo) => {
    switch (sortKey) {
      case 'name':
        return ns.name
      case 'status':
        return ns.status || ''
      case 'age':
        return parseCreatedDays(ns.created_at)
      default:
        return ''
    }
  }
  out.sort((a, b) => {
    const av = getValue(a)
    const bv = getValue(b)
    if (typeof av === 'number' && typeof bv === 'number') {
      return sortDir === 'asc' ? av - bv : bv - av
    }
    const as = String(av)
    const bs = String(bv)
    return sortDir === 'asc' ? as.localeCompare(bs) : bs.localeCompare(as)
  })
  return out
}
