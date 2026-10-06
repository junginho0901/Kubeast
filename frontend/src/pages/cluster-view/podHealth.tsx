// Pod 상태 판정 + health icon 렌더. ClusterView.tsx 에서 추출 (Phase 3.1.b).
//
// pickReason / isCompletedReason / getPodHealth 는 순수 함수 — pod 의 phase /
// container state 들을 보고 ok/warn/error 레벨 + 사람용 reason 결정. 우선순위
// 리스트 (errorPriority / warnPriority) 가 같이 있어 hardcoded 정책.
//
// getHealthIcon 은 React 컴포넌트 반환이라 .tsx — ClusterView 본체와 Pod 상세
// 모달 (Summary 탭) 양쪽에서 사용.

import i18next from 'i18next'
import { CheckCircle, XCircle, AlertCircle } from 'lucide-react'

export const pickReason = (reasons: string[], priority: string[]) => {
  for (const p of priority) {
    if (reasons.includes(p)) return p
  }
  return reasons[0] || ''
}

export const isCompletedReason = (reason?: string | null) => {
  if (!reason) return false
  return reason === 'Completed' || reason === 'Succeeded'
}

export interface PodHealth {
  level: 'ok' | 'warn' | 'error'
  reason: string
  phase: string
}

export const getPodHealth = (pod: any): PodHealth => {
  const phase = pod?.phase || pod?.status || 'Unknown'

  // deletionTimestamp 가 셋되었으면 phase 가 여전히 'Running' 이라도 graceful
  // shutdown 중인 Terminating 상태. ReplicaSet 이 새 pod 즉시 만들고 이전
  // pod 가 잠시 살아있는 정상 K8s 동작을 사용자에게 명확히 표시.
  if (pod?.deletion_timestamp) {
    return { level: 'warn' as const, reason: 'Terminating', phase }
  }

  const containers = Array.isArray(pod?.containers) ? pod.containers : []
  const initContainers = Array.isArray(pod?.init_containers) ? pod.init_containers : []
  const statusReason = isCompletedReason(pod?.status_reason) ? null : pod?.status_reason
  const waitingReasons = containers
    .map((c: any) => c?.state?.waiting?.reason)
    .filter((r: any) => typeof r === 'string' && r.trim()) as string[]
  const terminatedReasons = containers
    .map((c: any) => ({
      reason: c?.state?.terminated?.reason,
      exitCode: c?.state?.terminated?.exit_code,
    }))
    .filter((r: any) => typeof r?.reason === 'string' && r.reason.trim())
    .filter((r: any) => !isCompletedReason(r.reason))
    .map((r: any) => r.reason) as string[]
  const initWaitingReasons = initContainers
    .map((c: any) => c?.state?.waiting?.reason)
    .filter((r: any) => typeof r === 'string' && r.trim()) as string[]
  const initTerminatedReasons = initContainers
    .map((c: any) => ({
      reason: c?.state?.terminated?.reason,
      exitCode: c?.state?.terminated?.exit_code,
    }))
    .filter((r: any) => typeof r?.reason === 'string' && r.reason.trim())
    .filter((r: any) => !isCompletedReason(r.reason))
    .map((r: any) => r.reason) as string[]

  const errorPriority = [
    'CrashLoopBackOff',
    'ImagePullBackOff',
    'ErrImagePull',
    'CreateContainerConfigError',
    'CreateContainerError',
    'RunContainerError',
    'ContainerCannotRun',
    'InvalidImageName',
    'ImageInspectError',
    'RegistryUnavailable',
    'ErrImageNeverPull',
    'OOMKilled',
    'Error',
  ]

  const warnPriority = [
    'ContainerCreating',
    'PodInitializing',
    'Pending',
    'NotReady',
  ]

  const errorReason = pickReason(
    [
      ...(statusReason ? [statusReason] : []),
      ...initWaitingReasons,
      ...initTerminatedReasons,
      ...waitingReasons,
      ...terminatedReasons,
    ],
    errorPriority
  )
  if (errorReason || phase === 'Failed') {
    return { level: 'error' as const, reason: errorReason || 'Failed', phase }
  }

  const readyCount = containers.filter((c: any) => c?.ready).length
  const totalCount = containers.length
  const notReady = totalCount > 0 && readyCount < totalCount
  const initNotReady = initContainers.length > 0 && initContainers.some((c: any) => {
    const state = c?.state || {}
    if (state.waiting) return true
    if (state.running) return true
    if (state.terminated) {
      const code = state.terminated.exit_code
      return typeof code === 'number' ? code !== 0 : true
    }
    return false
  })

  if (phase === 'Pending' || phase === 'Unknown') {
    return { level: 'warn' as const, reason: phase, phase }
  }

  // A completed pod (Job/CronJob) has no ready container by design — that is
  // not a NotReady warning.
  if (phase === 'Succeeded') {
    return { level: 'ok' as const, reason: 'Succeeded', phase }
  }

  if (initNotReady) {
    const initReason = pickReason(initWaitingReasons, warnPriority) || 'PodInitializing'
    return { level: 'warn' as const, reason: initReason, phase }
  }

  if (notReady) {
    const warnReason = pickReason(waitingReasons, warnPriority) || 'NotReady'
    return { level: 'warn' as const, reason: warnReason, phase }
  }

  const warnReason = pickReason(waitingReasons, warnPriority)
  if (warnReason) {
    return { level: 'warn' as const, reason: warnReason, phase }
  }

  return { level: 'ok' as const, reason: phase, phase }
}

export const getHealthIcon = (level: 'ok' | 'warn' | 'error', reason?: string) => {
  if (reason === 'Terminating') {
    return (
      <span
        className="inline-block h-5 w-5 animate-spin rounded-full border-2 border-amber-400 border-t-transparent"
        aria-label={i18next.t('clusterView.health.terminating', 'terminating')}
      />
    )
  }
  if (reason === 'PodInitializing' || reason === 'ContainerCreating') {
    return (
      <span
        className="inline-block h-5 w-5 animate-spin rounded-full border-2 border-sky-400 border-t-transparent"
        aria-label={i18next.t('common.loading', 'loading')}
      />
    )
  }
  if (level === 'ok') {
    return <CheckCircle className="w-5 h-5 text-green-400" />
  }
  if (level === 'error') {
    return <XCircle className="w-5 h-5 text-red-400" />
  }
  return <AlertCircle className="w-5 h-5 text-yellow-400" />
}
