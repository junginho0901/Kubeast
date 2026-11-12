import { useSyncExternalStore } from 'react'

// What a Create from YAML made and what a delete removed (components/CreatedNotice): kept for the page it was done on,
// until closed or another page opens. The window and the drawer close on success, and an object of another namespace
// is not in the list on screen.
export type CreatedObject = { kind: string; name: string; namespace?: string | null }
export type CreatedNotice = { path: string; objects: CreatedObject[]; deleted: CreatedObject[] }

let current: CreatedNotice | null = null
// CreatedNotice lines a page draws under its header; while there is none the layout draws one at the top
let placed = 0
const listeners = new Set<() => void>()
const emit = () => listeners.forEach((l) => l())
const subscribe = (l: () => void) => { listeners.add(l); return () => { listeners.delete(l) } }

export function announceCreated(path: string, objects: CreatedObject[]): void {
  current = objects.length ? { path, objects, deleted: [] } : null
  emit()
}

const sameObject = (a: CreatedObject, b: CreatedObject) => a.kind === b.kind && a.name === b.name && (a.namespace || null) === (b.namespace || null)

// A delete that went through: the object leaves the created list of this page and is named as deleted.
export function announceDeleted(path: string, object: CreatedObject): void {
  const here = current && current.path === path ? current : null
  const o = { kind: object.kind, name: object.name, namespace: object.namespace || null }
  current = {
    path,
    objects: (here?.objects ?? []).filter((c) => !sameObject(c, o)),
    deleted: [...(here?.deleted ?? []).filter((d) => !sameObject(d, o)), o],
  }
  emit()
}

export function clearCreated(): void {
  if (!current) return
  current = null
  emit()
}

export const createdNoticeNow = (): CreatedNotice | null => current

export function useCreatedNotice(): CreatedNotice | null {
  return useSyncExternalStore(subscribe, createdNoticeNow, () => null)
}

export function placeNotice(): () => void {
  placed += 1
  emit()
  return () => { placed -= 1; emit() }
}

export function useNoticePlaced(): boolean {
  return useSyncExternalStore(subscribe, () => placed > 0, () => false)
}

// "Kind/name (namespace)", as kubectl names an object and the namespace it is in; an object of the cluster has none
export const createdText = (o: CreatedObject): string => `${o.kind}/${o.name}${o.namespace ? ` (${o.namespace})` : ''}`

// the objects of an answer: the create's answer is the list, a refusal holds the ones made before it stopped
export function createdOf(answer: unknown): CreatedObject[] {
  const list = Array.isArray(answer) ? answer : (answer as { created?: unknown } | null)?.created
  if (!Array.isArray(list)) return []
  return list
    .filter((o): o is { kind: string; name: string; namespace?: string | null } => !!o && typeof o.kind === 'string' && typeof o.name === 'string')
    .map((o) => ({ kind: o.kind, name: o.name, namespace: o.namespace || null }))
}
