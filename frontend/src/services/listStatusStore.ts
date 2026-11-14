// How the current page's cluster list requests ended, per API segment, beyond
// 403 (forbiddenStore): "notInstalled" when the server says the cluster does
// not serve the kind (its CRD is missing — X-Kubeast-Not-Installed on an empty
// list) and "error" when the request failed on the server or the network
// (5xx, timeout). A later successful read of the segment clears it. Fed by
// LIST_STATUS_EVENT from the API client; read by the list tables' empty row
// and by the create buttons of CRD-backed pages, which wait for the segment's
// first answer (a 403 counts, FORBIDDEN_EVENT) so a cluster without the CRD
// never shows them for the moment before its list says so. Reset with the
// forbidden store on every route or cluster change.

import { useSyncExternalStore } from 'react'
import { FORBIDDEN_EVENT, LIST_STATUS_EVENT, ofSelectedCluster, type ForbiddenDetail, type ListStatusDetail } from './api/client'
import { listSegmentFromUrl } from '@/utils/forbiddenResource'

export type ListStatus = { state: 'notInstalled' } | { state: 'error'; code?: number; reason?: string }

const statuses = new Map<string, ListStatus>()
const answered = new Set<string>()
const listeners = new Set<() => void>()
let version = 0

const notify = () => {
  version += 1
  for (const l of listeners) l()
}

// the segment's list has answered on this page; true when that is news
const markAnswered = (seg: string): boolean => {
  if (answered.has(seg)) return false
  answered.add(seg)
  return true
}

export function recordListStatus(d: ListStatusDetail): void {
  const seg = listSegmentFromUrl(d.url)
  if (!seg) return
  const first = markAnswered(seg)
  const prev = statuses.get(seg)
  if (d.state === 'ok') {
    if (prev) statuses.delete(seg)
    else if (!first) return
  } else if (d.state === 'notInstalled') {
    if (prev?.state === 'notInstalled' && !first) return
    statuses.set(seg, { state: 'notInstalled' })
  } else {
    if (prev?.state === 'error' && prev.code === d.code && prev.reason === d.reason && !first) return
    statuses.set(seg, { state: 'error', code: d.code, reason: d.reason })
  }
  notify()
}

/** A 403 on the segment's list: answered, with no status of its own (forbiddenStore keeps it). */
export function recordListForbidden(url: string): void {
  const seg = listSegmentFromUrl(url)
  if (seg && markAnswered(seg)) notify()
}

// An outcome of a request sent while another cluster was selected is not this cluster's (a late timeout, 403 or answer
// of the cluster just left), so it is dropped.
if (typeof window !== 'undefined') {
  window.addEventListener(LIST_STATUS_EVENT, (e: Event) => {
    const d = (e as CustomEvent<ListStatusDetail>).detail
    if (d?.url && ofSelectedCluster(d)) recordListStatus(d)
  })
  window.addEventListener(FORBIDDEN_EVENT, (e: Event) => {
    const d = (e as CustomEvent<Partial<ForbiddenDetail>>).detail
    // a refused read beside the list (`listStatus: false`) is not the list's answer
    if (d?.url && d.list !== false && ofSelectedCluster(d)) recordListForbidden(d.url)
  })
}

export function resetListStatus(): void {
  if (statuses.size === 0 && answered.size === 0) return
  statuses.clear()
  answered.clear()
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

/** True once this segment's list has answered on the page and the cluster serves its kind (its CRD is installed). */
export function isKindServed(segment: string): boolean {
  return answered.has(segment) && statuses.get(segment)?.state !== 'notInstalled'
}

/** isKindServed for a CRD-backed page's create button, which shows only then. */
export function useKindServed(segment: string): boolean {
  useSyncExternalStore(subscribe, getVersion, getVersion)
  return isKindServed(segment)
}
