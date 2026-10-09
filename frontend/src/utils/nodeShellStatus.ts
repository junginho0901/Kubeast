import type { TFunction } from 'i18next'

// Status frames the node shell socket sends while the debug pod comes up
// (k8s-service node_shell.go shellStatus). Reason and message are Kubernetes
// values (ImagePullBackOff, the kubelet's text) and stay as they are.
export interface NodeShellStatus {
  type: 'status'
  status: string
  reason?: string
  message?: string
  seconds?: number
}

export function parseNodeShellStatus(data: string): NodeShellStatus | null {
  if (!data.startsWith('{')) return null
  try {
    const v = JSON.parse(data)
    return v && v.type === 'status' && typeof v.status === 'string' ? (v as NodeShellStatus) : null
  } catch {
    return null
  }
}

// The terminal lines for a status, in the user's language. An unknown status
// shows its raw fields rather than nothing.
export function nodeShellStatusLines(s: NodeShellStatus, t: TFunction): string[] {
  const detail = [s.reason, s.message].filter(Boolean).join(' — ')
  const k = (key: string, fallback: string, opts: Record<string, unknown> = {}) =>
    t(`nodes.shell.status.${key}`, { defaultValue: fallback, ...opts }) as string
  switch (s.status) {
    case 'waiting':
      return [detail ? k('waitingReason', 'Waiting: {{detail}}', { detail }) : k('waiting', 'Waiting for the debug Pod to start...')]
    case 'starting':
      return [k('starting', 'The debug Pod is running. Attaching...')]
    case 'timeout': {
      const lines = [k('timeout', 'The debug Pod did not start within {{seconds}} s.', { seconds: s.seconds ?? 0 })]
      if (detail) lines.push(k('lastState', 'Last state: {{detail}}', { detail }))
      return lines
    }
    case 'exited':
      return [k('exited', 'The debug Pod ended before the shell opened: {{detail}}', { detail })]
    case 'failed':
      return [k('failed', 'Could not start the debug Pod: {{detail}}', { detail })]
    case 'image-rejected':
      return [k('imageRejected', 'Image not allowed: {{detail}}', { detail })]
    case 'audit-unavailable':
      return [k('auditUnavailable', 'The audit log is unavailable, so the shell was not opened.')]
    default:
      return [[s.status, detail].filter(Boolean).join(': ')]
  }
}
