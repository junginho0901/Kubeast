// StatefulSets 페이지의 helper 함수 및 type
//
// frontend/src/pages/workloads/StatefulSets.tsx 의 parseAgeSeconds /
// formatAge / getStatusColor + SortKey 타입 추출. 순수 함수 + 타입 정의.

export type SortKey =
  | null
  | 'name'
  | 'ready'
  | 'upToDate'
  | 'available'
  | 'status'
  | 'age'
  | 'service'

export function parseAgeSeconds(iso?: string | null): number {
  if (!iso) return 0
  const ms = new Date(iso).getTime()
  if (!Number.isFinite(ms)) return 0
  return Math.max(0, Math.floor((Date.now() - ms) / 1000))
}

export function formatAge(iso?: string | null): string {
  if (!iso) return '-'
  const diffSec = parseAgeSeconds(iso)
  if (diffSec === 0 && !iso) return '-'
  const days = Math.floor(diffSec / 86400)
  const hours = Math.floor((diffSec % 86400) / 3600)
  const minutes = Math.floor((diffSec % 3600) / 60)
  if (days > 0) return `${days}d ${hours}h`
  if (hours > 0) return `${hours}h ${minutes}m`
  return `${minutes}m`
}

export function getStatusColor(status?: string | null): string {
  const s = String(status || '').toLowerCase()
  if (s.includes('healthy')) return 'badge-success'
  if (s.includes('degraded') || s.includes('idle')) return 'badge-warning'
  if (s.includes('unavailable') || s.includes('error') || s.includes('failed')) return 'badge-error'
  return 'badge-info'
}
