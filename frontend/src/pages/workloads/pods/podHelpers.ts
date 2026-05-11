// Pods 페이지의 순수 helper 함수 / 타입 모음
//
// frontend/src/pages/workloads/Pods.tsx 의 상단 5 함수 + 2 type 추출.
// 모두 순수 함수 (외부 상태 의존 X). watch event 정규화는 podWatchNormalize.ts.

import type { PodInfo } from '@/services/api'

export type SortKey = null | 'name' | 'ready' | 'status' | 'restarts' | 'pod_ip' | 'node_name' | 'age'
export type SummaryCard = [label: string, value: number, boxClass: string, labelClass: string]

export function parseReadyPair(ready?: string | null): [number, number] {
  if (!ready) return [0, 0]
  const m = String(ready).match(/^(\d+)\/(\d+)$/)
  if (!m) return [0, 0]
  return [Number(m[1]) || 0, Number(m[2]) || 0]
}

export function parseAgeSeconds(createdAt?: string | null): number {
  if (!createdAt) return 0
  const ms = new Date(createdAt).getTime()
  if (!Number.isFinite(ms)) return 0
  return Math.max(0, Math.floor((Date.now() - ms) / 1000))
}

export function formatAge(createdAt?: string | null): string {
  const diffSec = parseAgeSeconds(createdAt)
  const days = Math.floor(diffSec / 86400)
  const hours = Math.floor((diffSec % 86400) / 3600)
  const minutes = Math.floor((diffSec % 3600) / 60)
  if (days > 0) return `${days}d ${hours}h`
  if (hours > 0) return `${hours}h ${minutes}m`
  return `${minutes}m`
}

export function pickPodDisplayStatus(pod: PodInfo): string {
  if (pod.status_reason) return String(pod.status_reason)

  const reasons: string[] = []
  for (const c of pod.containers || []) {
    const waitingReason = c?.state?.waiting?.reason
    if (waitingReason) reasons.push(String(waitingReason))
    // last_state 는 무시 — 이전에 종료됐던 기록은 현재 상태와 무관.
    // 한 번 Error 로 죽고 재시작되어 현재 Running 인 정상 pod 가 list 에
    // "Error" 로 잘못 표시되는 버그 방지 (detail 화면은 phase 기반이라 정상).
    const terminatedReason = c?.state?.terminated?.reason
    if (terminatedReason) reasons.push(String(terminatedReason))
  }
  if (reasons.length > 0) return reasons[0]

  const phase = pod.phase || pod.status || 'Unknown'
  if (phase === 'Running') {
    const [readyCount, total] = parseReadyPair(pod.ready)
    if (total > 0 && readyCount !== total) return 'NotReady'
  }
  return phase
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
