// One summary-status vocabulary for the workload lists. The server sends the Deployment
// conditions (Available / Progressing / Failed) and a computed state for StatefulSet,
// DaemonSet and ReplicaSet (Healthy / Idle / Degraded / Unavailable); the screen shows
// one set in the UI language and keeps the server value in the tooltip.

export type WorkloadStatus = 'Healthy' | 'Progressing' | 'Degraded' | 'Idle' | 'Unavailable' | 'Failed'

type Tr = (key: string, fallback: string) => string

export function workloadStatus(raw?: string | null): WorkloadStatus | null {
  switch (raw) {
    case 'Available':
    case 'Healthy':
      return 'Healthy'
    case 'Progressing':
    case 'Degraded':
    case 'Idle':
    case 'Unavailable':
    case 'Failed':
      return raw
    default:
      return null
  }
}

export function workloadStatusLabel(tr: Tr, raw?: string | null): string {
  const status = workloadStatus(raw)
  return status ? tr(`workloadStatus.${status}`, status) : raw || '-'
}

// Search box text: the server value and the label on screen both match.
export function workloadStatusText(tr: Tr, raw?: string | null): string {
  return `${raw ?? ''} ${workloadStatusLabel(tr, raw)}`.toLowerCase()
}

// Tooltip: the value the server sent, and the condition reason when the rollout failed.
export function workloadStatusTitle(raw?: string | null, reason?: string | null): string {
  if (!raw) return ''
  return reason ? `${raw}: ${reason}` : raw
}
