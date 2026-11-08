// Why the live updates of what is on screen stopped, read from the watch socket's ERROR frames: the rows stay as they
// were, so the page has to say they may be old. A kind the cluster does not serve and a kind with no live updates are
// not here: the first page says so itself and the second never had any to lose.

import { useSyncExternalStore } from 'react'

export type WatchProblem = 'forbidden' | 'limit' | 'server_limit' | 'unreachable' | 'failed' | 'scope'

type WatchFrame = { type: string; error?: { message?: string; reason?: string } }

const SERIOUS_FIRST: WatchProblem[] = ['forbidden', 'limit', 'server_limit', 'unreachable', 'failed', 'scope']
const SILENT = new Set(['not_served', 'unsupported'])

// The server gives both limits one reason and says which in its message (multiplexer.go; multiplexer_watch_test.go holds the words).
const limitOf = (frame: WatchFrame): WatchProblem => (frame.error?.message?.includes('for the server') ? 'server_limit' : 'limit')

// The kinds a watch names otherwise than the REST list it feeds does (forbiddenStore's segments).
const LIST_OF_KIND: Record<string, string> = {
  customresourcedefinitions: 'crds',
  persistentvolumes: 'pvs',
  persistentvolumeclaims: 'pvcs',
  horizontalpodautoscalers: 'hpas',
  verticalpodautoscalers: 'vpas',
  poddisruptionbudgets: 'pdbs',
}

function listOfWatch(key: string): string {
  const path = key.slice(key.indexOf('\n') + 1).split('?')[0]
  const kind = path.slice(path.lastIndexOf('/') + 1)
  return LIST_OF_KIND[kind] ?? kind
}

const problems = new Map<string, WatchProblem>()
const listeners = new Set<() => void>()
let version = 0

const notify = () => {
  version += 1
  for (const l of listeners) l()
}

const set = (key: string, problem: WatchProblem) => {
  if (problems.get(key) === problem) return
  problems.set(key, problem)
  notify()
}

export function clearWatchProblem(key: string): void {
  if (problems.delete(key)) notify()
}

export function resetWatchProblems(): void {
  if (problems.size === 0) return
  problems.clear()
  notify()
}

// One frame of a watch: an ERROR sets its problem, anything else means it answers again.
export function recordWatchFrame(key: string, frame: WatchFrame): void {
  if (frame.type !== 'ERROR') {
    clearWatchProblem(key)
    return
  }
  const reason = frame.error?.reason ?? ''
  if (SILENT.has(reason)) return
  if (reason === 'limit') {
    set(key, limitOf(frame))
    return
  }
  set(key, SERIOUS_FIRST.includes(reason as WatchProblem) ? (reason as WatchProblem) : 'failed')
}

// The most serious problem, past the lists the page already says it was refused: those have no rows to go old.
export function getWatchProblem(refusedLists?: ReadonlySet<string>): WatchProblem | undefined {
  const present = new Set<WatchProblem>()
  for (const [key, problem] of problems) {
    if (!refusedLists?.has(listOfWatch(key))) present.add(problem)
  }
  return SERIOUS_FIRST.find((p) => present.has(p))
}

const subscribe = (l: () => void) => {
  listeners.add(l)
  return () => { listeners.delete(l) }
}
const getVersion = () => version

export function useWatchProblem(refusedLists?: ReadonlySet<string>): WatchProblem | undefined {
  useSyncExternalStore(subscribe, getVersion, getVersion)
  return getWatchProblem(refusedLists)
}
