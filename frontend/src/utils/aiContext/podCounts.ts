interface PodWords {
  status?: string | null
  phase?: string | null
  restart_count?: number | null
}

const NOTHING_TO_LOOK_AT = ['Running', 'Completed', 'Succeeded']

// Reads kubectl's STATUS, the phase only for a row without one: a crashing or leaving pod keeps the phase Running, and
// a finished one is not running but asks nothing.
export function podNotRunning(pod: PodWords): boolean {
  const word = pod.status || pod.phase
  return !!word && !NOTHING_TO_LOOK_AT.includes(word)
}

// So a list cut for the floating chat keeps the pods that need a look.
export function notRunningFirst<T extends PodWords>(pods: T[]): T[] {
  return [...pods.filter(podNotRunning), ...pods.filter((p) => !podNotRunning(p))]
}

export function podNeedsALook(pod: PodWords): boolean {
  return podNotRunning(pod) || (pod.restart_count ?? 0) > 5
}

// The counts a window tells the floating chat: each word its table shows, what is not running by those words, and the
// phases, which kubectl counts too (a crashing pod under Running) and which the windows' phase badges draw.
export function podCounts(pods: PodWords[]) {
  const byPhase: Record<string, number> = {}
  const byStatus: Record<string, number> = {}
  for (const pod of pods) {
    const phase = pod.phase || pod.status || 'Unknown'
    byPhase[phase] = (byPhase[phase] ?? 0) + 1
    const status = pod.status || pod.phase || 'Unknown'
    byStatus[status] = (byStatus[status] ?? 0) + 1
  }
  return { notRunning: pods.filter(podNotRunning).length, byPhase, byStatus }
}
