// Pods 페이지의 순수 helper 함수 / 타입 모음
//
// Status 열과 요약 카드 숫자는 k8s-service 가 계산해 보낸다 (pods_page.go, podrow 의 ListView).

export type SortKey = null | 'name' | 'ready' | 'status' | 'restarts' | 'pod_ip' | 'node_name' | 'age'
export type SummaryCard = [label: string, value: number | string, boxClass: string, labelClass: string]

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
 * The Pod drawer's Status tile: the server's Status, kubectl's word as the Pods list shows it, else the phase. A Running
 * pod not ready stays Running and the tile draws it yellow. The pod's own reason and a container's last crash have rows
 * of their own (status_reason, podLastStates).
 */
export function podDrawerStatus(describe: Record<string, unknown> | null | undefined, phase: string): string {
  return typeof describe?.status === 'string' && describe.status ? describe.status : phase
}

/**
 * The Status of a drawer's pod table: kubectl's word as the Pods list shows it (k8s-service podListView), the phase only
 * for a row without one, so one pod reads the same in every window.
 */
export function podTableStatus(pod: { status?: unknown; phase?: unknown } | null | undefined): string {
  return String(pod?.status || pod?.phase || '-')
}

export interface PodLastState {
  container: string
  reason: string
  exit_code?: number
  finished_at?: string
}

/** The containers that ended before, kubectl describe's "Last State: Terminated". */
export function podLastStates(containers: any[]): PodLastState[] {
  return containers.flatMap((c: any) => {
    const ended = c?.last_state?.terminated
    if (!ended) return []
    return [{ container: String(c.name ?? ''), reason: String(ended.reason ?? ''), exit_code: ended.exit_code, finished_at: ended.finished_at }]
  })
}

/** The Last State row: why and how each ended, with the container's name when there are several. */
export function podLastStateText(
  states: PodLastState[],
  words: { exitCode?: (code: number) => string; time?: (at: string) => string } = {},
): string {
  const exitCode = words.exitCode ?? ((code: number) => `exit code ${code}`)
  const one = (s: PodLastState) => {
    const details = [s.exit_code != null ? exitCode(s.exit_code) : '', s.finished_at && words.time ? words.time(s.finished_at) : ''].filter(Boolean).join(', ')
    if (!s.reason) return details || '-'
    return details ? `${s.reason} (${details})` : s.reason
  }
  if (states.length === 0) return '-'
  if (states.length === 1) return one(states[0])
  return states.map((s) => `${s.container}: ${one(s)}`).join(', ')
}

export function getStatusColor(status: string): string {
  const lower = (status || '').toLowerCase()
  if (lower.includes('running') || lower.includes('succeeded') || lower.includes('completed')) return 'badge-success'
  // before the waiting words: Init:Error is in the Error card, as any status naming an error is
  if (
    lower.includes('error') ||
    lower.includes('failed') ||
    lower.includes('backoff') ||
    lower.includes('oomkilled') ||
    lower.includes('errimagepull') ||
    lower.startsWith('signal:') ||
    /^exitcode:[1-9]/.test(lower)
  ) return 'badge-error'
  if (
    lower.includes('pending') ||
    lower.includes('init') ||
    lower.includes('creating') ||
    lower.includes('notready') ||
    lower.includes('terminating') ||
    lower.includes('gated')
  ) return 'badge-warning'
  return 'badge-info'
}
