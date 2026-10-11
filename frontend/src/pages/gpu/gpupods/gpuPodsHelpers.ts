// GPUPods 페이지의 helper 함수 및 type
//
// frontend/src/pages/gpu/GPUPods.tsx 의 parseAgeSeconds / formatAge /
// getStatusColor + SortKey / SummaryCard 타입 추출. GPUPods 는 watch 없이
// useQuery (refetchInterval 30s) 로 동작.

export type SortKey =
  | null
  | 'namespace'
  | 'name'
  | 'node_name'
  | 'gpu_requested'
  | 'status'
  | 'age'

export type SummaryCard = [label: string, value: number | string, boxClass: string, labelClass: string]

export { ageSeconds as parseAgeSeconds, formatAge } from '@/utils/time'

export function getStatusColor(status: string): string {
  const lower = (status || '').toLowerCase()
  if (lower === 'running' || lower === 'succeeded' || lower === 'completed') return 'badge-success'
  if (lower === 'pending') return 'badge-warning'
  if (lower === 'failed' || lower.includes('error') || lower.includes('backoff')) return 'badge-error'
  return 'badge-info'
}
