type WatchEvent = { type?: string; object?: any }

const ended = (pod: any) => pod?.phase === 'Succeeded' || pod?.phase === 'Failed'
const sizes = (pod: any) => JSON.stringify((pod?.containers ?? []).map((c: any) => c?.resources ?? null))
const sameFrame = (row: any, pod: any) => row?.name === pod?.name && (row?.namespace ?? '') === (pod?.namespace ?? '')

// Whether a frame of the node's pods moves what kubectl describe node adds up as Allocated Resources: a pod arriving or
// leaving, ending, or resized. A pod's status changes much more often than that, and each read lists the node's pods.
export function changesAllocated(rows: any[] | undefined, event: WatchEvent): boolean {
  const pod = event?.object
  if (!Array.isArray(rows) || !pod?.name) return false
  const known = rows.find((row) => sameFrame(row, pod))
  if (event.type === 'DELETED') return !!known && !ended(known)
  if (!known) return !ended(pod)
  return ended(known) !== ended(pod) || sizes(known) !== sizes(pod)
}
