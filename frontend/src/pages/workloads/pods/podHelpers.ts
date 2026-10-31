// Pods 페이지의 순수 helper 함수 / 타입 모음
//
// Status 열과 요약 카드 숫자는 k8s-service 가 계산해 보낸다 (pods_page.go, pod_index.go 의 podListStatus).

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

export function getStatusColor(status: string): string {
  const lower = (status || '').toLowerCase()
  if (lower.includes('running') || lower.includes('succeeded') || lower.includes('completed')) return 'badge-success'
  if (lower.includes('pending') || lower.includes('init') || lower.includes('creating') || lower.includes('notready')) return 'badge-warning'
  if (
    lower.includes('error') ||
    lower.includes('failed') ||
    lower.includes('backoff') ||
    lower.includes('oomkilled') ||
    lower.includes('errimagepull')
  ) return 'badge-error'
  return 'badge-info'
}
