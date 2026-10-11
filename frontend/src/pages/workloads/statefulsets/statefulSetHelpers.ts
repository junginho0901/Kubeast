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

export { ageSeconds as parseAgeSeconds, formatAge } from '@/utils/time'

export function getStatusColor(status?: string | null): string {
  const s = String(status || '').toLowerCase()
  if (s.includes('healthy')) return 'badge-success'
  if (s.includes('degraded')) return 'badge-warning'
  if (s.includes('idle')) return 'badge-neutral'
  if (s.includes('unavailable') || s.includes('error') || s.includes('failed')) return 'badge-error'
  return 'badge-info'
}
