// Which cluster resources the current page could not list because the API
// answered 403. Fed by the FORBIDDEN_EVENT the API client dispatches; read by
// the ForbiddenBanner (one line above the page) and by every list table so its
// empty row can say "no permission" instead of "no … found". A refused read beside
// a list (`listStatus: false`, the GPU metrics) is named in the banner only. The banner resets it
// whenever the route changes and ClusterProvider when the cluster does, and a refusal of a request sent
// while another cluster was selected is dropped; a refusal in a namespace
// goes when the page reads the kind in the namespace it now shows (forgetRefusedElsewhere).

import { useSyncExternalStore } from 'react'
import { FORBIDDEN_EVENT, LIST_STATUS_EVENT, ofSelectedCluster, type ForbiddenDetail, type ListStatusDetail } from './api/client'
import { forbiddenResourceFromUrl, listNamespaceFromUrl, listSegmentFromUrl as segmentFromUrl } from '@/utils/forbiddenResource'

type Refusal = { segment: string; label: string; namespace: string | null; list: boolean }

const refusals = new Map<string, Refusal>()
let segments = new Set<string>()
let labels = new Set<string>()
const listeners = new Set<() => void>()
let version = 0

const notify = () => {
  segments = new Set(Array.from(refusals.values()).filter((r) => r.list).map((r) => r.segment).filter(Boolean))
  labels = new Set(Array.from(refusals.values(), (r) => r.label))
  version += 1
  for (const l of listeners) l()
}

/** A 403 on a cluster read; `list` false for a read beside the list, which refuses no list of its segment. */
export function recordForbidden(url: string, list = true): void {
  const refusal = { segment: segmentFromUrl(url), label: forbiddenResourceFromUrl(url), namespace: listNamespaceFromUrl(url), list }
  const key = `${refusal.segment}\n${refusal.label}\n${refusal.namespace ?? ''}\n${list}`
  if (refusals.has(key)) return
  refusals.set(key, refusal)
  notify()
}

/**
 * A read of the kind that answered, made in the namespace the page shows (`shown`, 'all' for every namespace):
 * the kind's refusals in other namespaces were for a choice the page has left, so they go. A read the page did
 * not choose — another namespace, or several read side by side as the Resource Graph does — leaves them.
 */
export function forgetRefusedElsewhere(url: string, shown: string): void {
  const segment = segmentFromUrl(url)
  const namespace = listNamespaceFromUrl(url)
  if (!segment || (namespace ?? 'all') !== shown) return
  let gone = false
  for (const [key, r] of refusals) {
    if (r.segment === segment && r.namespace !== null && r.namespace !== namespace) {
      refusals.delete(key)
      gone = true
    }
  }
  if (gone) notify()
}

const shownNamespace = () => new URLSearchParams(window.location.search).get('namespace') || 'all'

if (typeof window !== 'undefined') {
  window.addEventListener(FORBIDDEN_EVENT, (e: Event) => {
    const d = (e as CustomEvent<Partial<ForbiddenDetail>>).detail
    // a refusal of a request sent while another cluster was selected is not this cluster's
    if (ofSelectedCluster(d)) recordForbidden(String(d?.url || ''), d?.list !== false)
  })
  window.addEventListener(LIST_STATUS_EVENT, (e: Event) => {
    const d = (e as CustomEvent<ListStatusDetail>).detail
    if (d?.url && d.state !== 'error' && ofSelectedCluster(d)) forgetRefusedElsewhere(d.url, shownNamespace())
  })
}

export function resetForbidden(): void {
  if (refusals.size === 0) return
  refusals.clear()
  notify()
}

/** Display names of every resource the page was refused, in a stable order (outside React: tests). */
export function forbiddenLabels(): string[] {
  return Array.from(labels).sort()
}

const subscribe = (l: () => void) => {
  listeners.add(l)
  return () => { listeners.delete(l) }
}
const getVersion = () => version

/** Display names of every resource the page was refused, in a stable order. */
export function useForbiddenLabels(): string[] {
  useSyncExternalStore(subscribe, getVersion, getVersion)
  return forbiddenLabels()
}

/** The API segments of every list the page was refused. */
export function useForbiddenLists(): ReadonlySet<string> {
  useSyncExternalStore(subscribe, getVersion, getVersion)
  return segments
}

/** True when the list request for this API segment answered 403 (outside React: tests). */
export function isListForbidden(segment: string): boolean {
  return segments.has(segment)
}

/** True when the list request for this API segment ("pods", "vpas", "helm") answered 403. */
export function useForbidden(segment: string): boolean {
  useSyncExternalStore(subscribe, getVersion, getVersion)
  return isListForbidden(segment)
}
