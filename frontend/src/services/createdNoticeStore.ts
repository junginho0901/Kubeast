import { useSyncExternalStore } from 'react'

// What a Create from YAML made (components/CreatedNotice): kept for the page it was made on, until closed or another
// page opens. The window closes on success, and an object made in another namespace is not in the list on screen.
export type CreatedObject = { kind: string; name: string; namespace?: string | null }
export type CreatedNotice = { path: string; objects: CreatedObject[] }

let current: CreatedNotice | null = null
const listeners = new Set<() => void>()
const emit = () => listeners.forEach((l) => l())

export function announceCreated(path: string, objects: CreatedObject[]): void {
  current = objects.length ? { path, objects } : null
  emit()
}

export function clearCreated(): void {
  if (!current) return
  current = null
  emit()
}

export function useCreatedNotice(): CreatedNotice | null {
  return useSyncExternalStore(
    (l) => { listeners.add(l); return () => { listeners.delete(l) } },
    () => current,
    () => null,
  )
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
