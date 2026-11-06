import { getStatusColor, runningNotReady } from '@/pages/workloads/pods/podHelpers'

export interface PodWindowBadge {
  text: string
  badge: string
  level: 'ok' | 'warn' | 'error'
  notReady: boolean
  title?: string
}

interface PodRow {
  phase?: string | null
  status?: string | null
  ready?: string | null
}

// The Pods window is chosen by phase, but a row says what the Pods list says of the pod (kubectl's STATUS and its colour),
// so a crashing pod in the Running bar is not a green Running. The phase that put it here stays on hover.
export function podWindowBadge(pod: PodRow): PodWindowBadge {
  const text = pod.status || pod.phase || '-'
  const notReady = runningNotReady(pod)
  const badge = notReady ? 'badge-warning' : getStatusColor(text)
  const level = badge === 'badge-success' ? 'ok' : badge === 'badge-error' ? 'error' : 'warn'
  return { text, badge, level, notReady, title: pod.phase ? `Phase: ${pod.phase}` : undefined }
}

// The floating chat reads the badge's word, and the phase that put the pod in this window.
export function podWindowAIFields(pod: PodRow): Record<string, unknown> {
  return { status: podWindowBadge(pod).text, phase: pod.phase, ready: pod.ready }
}
