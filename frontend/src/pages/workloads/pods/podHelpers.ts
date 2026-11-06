// Pods 페이지의 순수 helper 함수 / 타입 모음
//
// Status 열과 요약 카드 숫자는 k8s-service 가 계산해 보낸다 (pods_page.go, podrow 의 ListView).

export type SortKey = null | 'name' | 'ready' | 'status' | 'restarts' | 'pod_ip' | 'node_name' | 'age'
export type SummaryCard = [label: string, value: number, boxClass: string, labelClass: string]

export { formatAge } from '@/utils/time'

/**
 * A Running pod whose containers are not all ready. kubectl's STATUS says Running there (readiness is the READY
 * column), so the list keeps that word and draws it yellow, with the ready count on hover.
 */
export function runningNotReady(pod: { status?: string | null; ready?: string | null }): boolean {
  if ((pod.status || '').toLowerCase() !== 'running') return false
  const m = /^(\d+)\/(\d+)$/.exec(pod.ready || '')
  return !!m && Number(m[2]) > 0 && Number(m[1]) !== Number(m[2])
}

/**
 * The Pod drawer's Status tile. A pod initializing or being deleted reads the server's Status (kubectl's). Otherwise a
 * reason the pod or a container names comes first, a container's last crash too, which the drawer shows nowhere else;
 * with none named, the server's word (SchedulingGated), else the phase. A Running pod not ready stays Running, as
 * kubectl and the Pods list say, and the tile draws it yellow.
 */
export function podDrawerStatus(
  describe: { status?: unknown; status_reason?: unknown } | null | undefined,
  containers: any[],
  phase: string,
): string {
  const server = typeof describe?.status === 'string' ? describe.status : ''
  if (server.startsWith('Init:') || server === 'Terminating') return server
  if (typeof describe?.status_reason === 'string' && describe.status_reason) return describe.status_reason
  const reasons = containers
    .map((c: any) => c?.state?.waiting?.reason || c?.state?.terminated?.reason || c?.last_state?.terminated?.reason)
    .filter(Boolean)
  if (reasons.length > 0) return String(reasons[0])
  return server || phase
}

export function getStatusColor(status: string): string {
  const lower = (status || '').toLowerCase()
  if (lower.includes('running') || lower.includes('succeeded') || lower.includes('completed')) return 'badge-success'
  if (
    lower.includes('pending') ||
    lower.includes('init') ||
    lower.includes('creating') ||
    lower.includes('notready') ||
    lower.includes('terminating') ||
    lower.includes('gated')
  ) return 'badge-warning'
  if (
    lower.includes('error') ||
    lower.includes('failed') ||
    lower.includes('backoff') ||
    lower.includes('oomkilled') ||
    lower.includes('errimagepull') ||
    lower.startsWith('signal:') ||
    /^exitcode:[1-9]/.test(lower)
  ) return 'badge-error'
  return 'badge-info'
}
