// GPU Dashboard sub-component 들이 공유하는 helpers — 추출 출처 GPUDashboard.tsx (Phase 4.11).

export function formatAge(createdAt?: string | null): string {
  if (!createdAt) return '-'
  const sec = Math.max(0, Math.floor((Date.now() - new Date(createdAt).getTime()) / 1000))
  const d = Math.floor(sec / 86400)
  const h = Math.floor((sec % 86400) / 3600)
  const m = Math.floor((sec % 3600) / 60)
  if (d > 0) return `${d}d ${h}h`
  if (h > 0) return `${h}h ${m}m`
  return `${m}m`
}

export function getStatusColor(status: string): string {
  const lower = (status || '').toLowerCase()
  if (lower === 'running' || lower === 'succeeded' || lower === 'completed' || lower === 'ready') return 'badge-success'
  if (lower === 'pending') return 'badge-warning'
  if (lower === 'failed' || lower.includes('error') || lower.includes('backoff') || lower.includes('notready')) return 'badge-error'
  return 'badge-info'
}
