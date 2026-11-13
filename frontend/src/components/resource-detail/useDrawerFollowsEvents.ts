import type { QueryKey } from '@tanstack/react-query'
import { useKubeWatchList } from '@/services/useKubeWatchList'
import { eventsNewestFirst } from './detailFormat'

type WatchEvent = { type?: string; object?: any }

// formatDrawerEvent's source is the component, "" when the event names none (the scheduler and other events.k8s.io
// writers leave it empty); a frame carries { component, host }, its component null then.
const sourceOf = (source: any): string => (typeof source === 'string' ? source : source?.component) || ''

// A frame as the drawer's Events table reads an event (the server's eventToInfo against formatDrawerEvent).
function eventRow(frame: any) {
  return {
    type: frame.type,
    reason: frame.reason,
    message: frame.message,
    count: frame.count,
    first_timestamp: frame.first_timestamp,
    last_timestamp: frame.last_timestamp,
    source: sourceOf(frame.source),
  }
}

// The answer's rows carry no event name, which for a kind of the cluster would tell of events in other namespaces. What
// stays while an event counts up tells it from another: its recorder counts up one reason and message of one source.
const sameEvent = (a: any, b: any) => a?.reason === b?.reason && a?.message === b?.message && a?.first_timestamp === b?.first_timestamp && a?.source === b?.source
const sameRow = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b)

// One frame on a describe answer's events: the frame is the table's row, so nothing is read again. What a watch opens
// with says what the answer says, and leaves the answer as it is.
export function applyEventFrame(answer: any, event: WatchEvent): any {
  const frame = event?.object
  if (!answer || !Array.isArray(answer.events) || !frame) return answer
  const events: any[] = answer.events
  const row = eventRow(frame)
  const index = events.findIndex((e) => sameEvent(e, row))
  if (event.type === 'DELETED') {
    if (index < 0) return answer
    return { ...answer, events: events.filter((_, i) => i !== index) }
  }
  if (index >= 0 && sameRow(events[index], row)) return answer
  const next = index >= 0 ? events.map((e, i) => (i === index ? row : e)) : [...events, row]
  return { ...answer, events: eventsNewestFirst(next) }
}

// The field selector of the events about one object as kubectl describe writes it (client-go GetFieldSelector): its
// name and kind, and its UID when it has one, so an event of an earlier object of the same name is not about this one.
export function drawerEventSelector(kind: string, name: string, uid?: unknown): string {
  const fields = [`involvedObject.kind=${kind}`, `involvedObject.name=${name}`]
  if (typeof uid === 'string' && uid) fields.push(`involvedObject.uid=${uid}`)
  return fields.join(',')
}

// useDrawerFollowsEvents keeps a drawer's Events moving while its object stays as it is: a warning that repeats counts up
// on the event alone, which useDrawerFollowsObject never hears of. It opens once the answer has come, so what the watch
// opens with finds it, and not for an answer that says the events could not be read: the watch would be refused too.
// It follows the events naming the answer's UID (`uid` when the events name another, as a mirror pod's do), the ones the
// server kept in the answer.
export function useDrawerFollowsEvents(options: { describeKey: QueryKey; answer: any; kind: string; namespace?: string; name: string; uid?: string }) {
  const { describeKey, answer, kind, namespace, name } = options
  const uid = options.uid ?? answer?.uid
  useKubeWatchList({
    enabled: !!namespace && !!name && Array.isArray(answer?.events),
    queryKey: describeKey as any[],
    path: `/api/v1/namespaces/${namespace}/events`,
    query: `watch=1&fieldSelector=${encodeURIComponent(drawerEventSelector(kind, name, uid))}`,
    applyEvent: (prev, event) => applyEventFrame(prev, event),
  })
}

// Whether an event frame is about a node: it names the node's UID, or its name, which the kubelet writes in place of the
// UID (kubectl describe node lists both; the server's eventToInfo carries involved_object.uid).
export function nodeEventNamesNode(frame: any, name: string, nodeUid?: string): boolean {
  const uid = frame?.involved_object?.uid
  return typeof uid === 'string' && uid !== '' && (uid === name || uid === nodeUid)
}
