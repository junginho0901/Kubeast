// GPU Dashboard sub-component 들이 공유하는 helpers — 추출 출처 GPUDashboard.tsx (Phase 4.11).

export { formatAge } from '@/utils/time'

export function getStatusColor(status: string): string {
  const lower = (status || '').toLowerCase()
  if (lower === 'running' || lower === 'succeeded' || lower === 'completed' || lower === 'ready') return 'badge-success'
  if (lower === 'pending') return 'badge-warning'
  if (lower === 'failed' || lower.includes('error') || lower.includes('backoff') || lower.includes('notready')) return 'badge-error'
  return 'badge-info'
}
