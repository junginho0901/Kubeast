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

type Tr = (key: string, fallback: string, options?: Record<string, unknown>) => string
const englishTr: Tr = (_key, fallback, options) => fallback.replace(/\{\{(\w+)\}\}/g, (_, k: string) => String(options?.[k] ?? ''))

// The Pods window is chosen by phase, but a row says what the Pods list says of the pod (kubectl's STATUS and its colour),
// so a crashing pod in the Running bar is not a green Running. The phase that put it here stays on hover, in the UI
// language when the screen passes its tr.
export function podWindowBadge(pod: PodRow, tr: Tr = englishTr): PodWindowBadge {
  const text = pod.status || pod.phase || '-'
  const notReady = runningNotReady(pod)
  const badge = notReady ? 'badge-warning' : getStatusColor(text)
  const level = badge === 'badge-success' ? 'ok' : badge === 'badge-error' ? 'error' : 'warn'
  return { text, badge, level, notReady, title: pod.phase ? tr('pods.table.phaseHint', 'Phase: {{phase}}', { phase: pod.phase }) : undefined }
}

// The floating chat reads the badge's word, and the phase that put the pod in this window.
export function podWindowAIFields(pod: PodRow): Record<string, unknown> {
  return { status: podWindowBadge(pod).text, phase: pod.phase, ready: pod.ready }
}
