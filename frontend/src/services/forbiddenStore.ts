// Which cluster resources the current page could not list because the API
// answered 403. Fed by the FORBIDDEN_EVENT the API client dispatches; read by
// the ForbiddenBanner (one line above the page) and by every list table so its
// empty row can say "no permission" instead of "no … found". Layout resets it
// whenever the route or the selected cluster changes.

import { useSyncExternalStore } from 'react'
import { FORBIDDEN_EVENT } from './api/client'
import { forbiddenResourceFromUrl, listSegmentFromUrl as segmentFromUrl } from '@/utils/forbiddenResource'

const segments = new Set<string>()
const labels = new Set<string>()
const listeners = new Set<() => void>()
let version = 0

const notify = () => {
  version += 1
  for (const l of listeners) l()
}

if (typeof window !== 'undefined') {
  window.addEventListener(FORBIDDEN_EVENT, (e: Event) => {
    const url = String((e as CustomEvent<{ url?: string }>).detail?.url || '')
    const seg = segmentFromUrl(url)
    const label = forbiddenResourceFromUrl(url)
    if (seg && segments.has(seg) && labels.has(label)) return
    if (seg) segments.add(seg)
    labels.add(label)
    notify()
  })
}

export function resetForbidden(): void {
  if (segments.size === 0 && labels.size === 0) return
  segments.clear()
  labels.clear()
  notify()
}

const subscribe = (l: () => void) => {
  listeners.add(l)
  return () => { listeners.delete(l) }
}
const getVersion = () => version

/** Display names of every resource the page was refused, in a stable order. */
export function useForbiddenLabels(): string[] {
  useSyncExternalStore(subscribe, getVersion, getVersion)
  return Array.from(labels).sort()
}

/** True when the list request for this API segment ("pods", "vpas", "helm") answered 403. */
export function useForbidden(segment: string): boolean {
  useSyncExternalStore(subscribe, getVersion, getVersion)
  return segments.has(segment)
}
