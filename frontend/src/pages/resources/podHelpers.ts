// Resources 페이지의 Pod / PDB 카드 공통 helper. Resources.tsx 에서 추출
// (Phase 3.5.d).
//
// 모두 순수 함수 — pod 의 phase / containers / labels 등 데이터만 보고 결정.
// state 의존 X.

export function getPodReason(pod: any): string {
  const phase = (pod?.phase || '').toString()
  if (phase && phase !== 'Running') return phase

  const ready = (pod?.ready || '').toString()
  const m = ready.match(/^(\d+)\/(\d+)$/)
  const isNotReady = (() => {
    if (!m) return false
    const a = Number(m[1])
    const b = Number(m[2])
    if (Number.isNaN(a) || Number.isNaN(b) || b <= 0) return false
    return a !== b
  })()

  const containers = Array.isArray(pod?.containers) ? pod.containers : []
  const reasons: string[] = []

  for (const c of containers) {
    const waitingReason = c?.state?.waiting?.reason
    if (waitingReason) reasons.push(String(waitingReason))
  }
  for (const c of containers) {
    const terminatedReason = c?.state?.terminated?.reason || c?.last_state?.terminated?.reason
    if (terminatedReason) reasons.push(String(terminatedReason))
  }

  if (reasons.length > 0) {
    const priority = [
      'ImagePullBackOff',
      'ErrImagePull',
      'CrashLoopBackOff',
      'CreateContainerConfigError',
      'CreateContainerError',
      'RunContainerError',
      'OOMKilled',
      'Error',
      'ContainerCreating',
      'PodInitializing',
    ]
    const best = reasons
      .slice()
      .sort((a, b) => {
        const ai = priority.indexOf(a)
        const bi = priority.indexOf(b)
        const aa = ai === -1 ? 999 : ai
        const bb = bi === -1 ? 999 : bi
        if (aa !== bb) return aa - bb
        return a.localeCompare(b)
      })[0]
    return best || 'Unknown'
  }

  if (isNotReady) return 'NotReady'
  return 'Running'
}

export function compactSelector(selectorObj: Record<string, string> | undefined | null) {
  const obj = selectorObj || {}
  const entries = Object.entries(obj)
  if (entries.length === 0) return {}

  // ReplicaSet/Deployment 등에서 자주 붙는 "버전/해시" 라벨은 노이즈가 되기 쉬워 숨긴다.
  const noisyKeys = new Set([
    'pod-template-hash',
    'controller-revision-hash',
  ])

  const compact = Object.fromEntries(entries.filter(([k]) => !noisyKeys.has(k)))
  return Object.keys(compact).length > 0 ? compact : obj
}

export function podMatchesSelector(pod: any, selectorObj: Record<string, string> | undefined | null) {
  const sel = selectorObj || {}
  const entries = Object.entries(sel)
  if (entries.length === 0) return false
  const labels = pod?.labels || {}
  return entries.every(([k, v]) => labels?.[k] === v)
}

export function selectorToString(selectorObj: Record<string, string> | undefined | null) {
  const obj = selectorObj || {}
  return Object.entries(obj)
    .map(([k, v]) => `${k}=${v}`)
    .join(',')
}

export function isPodReady(pod: any) {
  const ready = (pod?.ready || '').toString()
  const m = ready.match(/^(\d+)\/(\d+)$/)
  if (m) {
    const a = Number(m[1])
    const b = Number(m[2])
    if (!Number.isNaN(a) && !Number.isNaN(b) && b > 0) return a === b
  }
  return pod?.phase === 'Running'
}
