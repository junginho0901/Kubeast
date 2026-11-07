// Why the live updates of what is on screen stopped, read from the watch socket's ERROR frames: the rows stay as they
// were, so the page has to say they may be old. A kind the cluster does not serve and a kind with no live updates are
// not here: the first page says so itself and the second never had any to lose.

import { useSyncExternalStore } from 'react'

export type WatchProblem = 'forbidden' | 'limit' | 'unreachable' | 'failed'

type WatchFrame = { type: string; error?: { message?: string; reason?: string } }

const SERIOUS_FIRST: WatchProblem[] = ['forbidden', 'limit', 'unreachable', 'failed']
const SILENT = new Set(['not_served', 'unsupported'])

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
  set(key, SERIOUS_FIRST.includes(reason as WatchProblem) ? (reason as WatchProblem) : 'failed')
}

export function getWatchProblem(): WatchProblem | undefined {
  const present = new Set(problems.values())
  return SERIOUS_FIRST.find((p) => present.has(p))
}

const subscribe = (l: () => void) => {
  listeners.add(l)
  return () => { listeners.delete(l) }
}
const getVersion = () => version

export function useWatchProblem(): WatchProblem | undefined {
  useSyncExternalStore(subscribe, getVersion, getVersion)
  return getWatchProblem()
}
