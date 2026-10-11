// How the current page's cluster list requests ended, per API segment, beyond
// 403 (forbiddenStore): "notInstalled" when the server says the cluster does
// not serve the kind (its CRD is missing — X-Kubeast-Not-Installed on an empty
// list) and "error" when the request failed on the server or the network
// (5xx, timeout). A later successful read of the segment clears it. Fed by
// LIST_STATUS_EVENT from the API client; read by the list tables' empty row
// and by the create buttons of CRD-backed pages. Reset with the forbidden
// store on every route or cluster change.

import { useSyncExternalStore } from 'react'
import { LIST_STATUS_EVENT, type ListStatusDetail } from './api/client'
import { listSegmentFromUrl } from '@/utils/forbiddenResource'

export type ListStatus = { state: 'notInstalled' } | { state: 'error'; code?: number }

const statuses = new Map<string, ListStatus>()
const listeners = new Set<() => void>()
let version = 0

const notify = () => {
  version += 1
  for (const l of listeners) l()
}

export function recordListStatus(d: ListStatusDetail): void {
  const seg = listSegmentFromUrl(d.url)
  if (!seg) return
  const prev = statuses.get(seg)
  if (d.state === 'ok') {
    if (!prev) return
    statuses.delete(seg)
  } else if (d.state === 'notInstalled') {
    if (prev?.state === 'notInstalled') return
    statuses.set(seg, { state: 'notInstalled' })
  } else {
    if (prev?.state === 'error' && prev.code === d.code) return
    statuses.set(seg, { state: 'error', code: d.code })
  }
  notify()
}

if (typeof window !== 'undefined') {
  window.addEventListener(LIST_STATUS_EVENT, (e: Event) => {
    const d = (e as CustomEvent<ListStatusDetail>).detail
    if (d?.url) recordListStatus(d)
  })
}

export function resetListStatus(): void {
  if (statuses.size === 0) return
  statuses.clear()
  notify()
}

const subscribe = (l: () => void) => {
  listeners.add(l)
  return () => { listeners.delete(l) }
}
const getVersion = () => version

export function getListStatus(segment: string): ListStatus | undefined {
  return statuses.get(segment)
}

/** The last non-ok outcome of this segment's list on the page, if any. */
export function useListStatus(segment: string): ListStatus | undefined {
  useSyncExternalStore(subscribe, getVersion, getVersion)
  return getListStatus(segment)
}

/** True when the cluster does not serve this segment's kind (CRD not installed). */
export function useNotInstalled(segment: string): boolean {
  return useListStatus(segment)?.state === 'notInstalled'
}
