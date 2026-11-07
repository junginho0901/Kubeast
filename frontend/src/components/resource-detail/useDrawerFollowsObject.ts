import { useEffect, useRef } from 'react'
import { useQueryClient, type QueryClient, type QueryKey } from '@tanstack/react-query'
import { useKubeWatchList } from '@/services/useKubeWatchList'

type WatchEvent = { type?: string; object?: any }

// A rollout writes a workload's status many times a second, and each read of a drawer's answer lists its events too.
const READ_AT_MOST_EVERY_MS = 1000

// Whether a frame says something else than the answer does, in what both hold: the answer is the row with more in it.
function differsFromAnswer(frame: Record<string, unknown>, answer: unknown): boolean {
  if (!answer || typeof answer !== 'object') return false
  const held = answer as Record<string, unknown>
  return Object.keys(frame).some((key) => key in held && JSON.stringify(frame[key]) !== JSON.stringify(held[key]))
}

// objectFollower reads a drawer's answer again when its object changes. The answer holds more than a frame (events,
// conditions, settings), so it is read rather than replaced; the drawer keeps showing the last one until it comes. The
// tables in `alsoRead` hang on the same object and are read with it, each at its own pace.
export function objectFollower(client: QueryClient, describeKey: QueryKey, everyMs = READ_AT_MOST_EVERY_MS, alsoRead: QueryKey[] = []) {
  let timer: ReturnType<typeof setTimeout> | undefined
  let started = false
  let waiting: QueryKey[] = []

  const read = () => {
    timer = undefined
    // A read under way may have missed the change, and restarting it on each frame might never let one finish.
    const underWay = waiting.filter((queryKey) => client.isFetching({ queryKey }) > 0)
    for (const queryKey of waiting) {
      if (!underWay.includes(queryKey)) void client.invalidateQueries({ queryKey })
    }
    waiting = underWay
    if (waiting.length > 0) timer = setTimeout(read, everyMs)
  }

  const readSoon = (keys: QueryKey[]) => {
    waiting = keys
    if (timer === undefined) timer = setTimeout(read, everyMs)
  }

  const stop = () => {
    if (timer !== undefined) clearTimeout(timer)
    timer = undefined
    waiting = []
  }

  return {
    onEvent(event: WatchEvent) {
      if (!event?.object) return
      // A deleted object leaves the last answer on screen until the drawer closes: a read now would only say 404.
      if (event.type === 'DELETED') {
        stop()
        return
      }
      // A watch opens with the object as it is, which the answer the drawer just asked for says too.
      const opening = !started && event.type === 'ADDED'
      started = true
      if (opening && !differsFromAnswer(event.object, client.getQueryData(describeKey))) return
      readSoon([describeKey, ...alsoRead])
    },
    // The watch cannot say what changed while it was gone, and its RESYNC reads only the answer.
    onResync() {
      if (alsoRead.length > 0) readSoon(alsoRead)
    },
    stop,
  }
}

// useDrawerFollowsObject keeps an open drawer on its object as it changes, whichever screen opened it: a page's own
// watch is not there for a drawer opened by a link from another page.
export function useDrawerFollowsObject(options: { enabled: boolean; describeKey: QueryKey; path: string; name: string; alsoRead?: QueryKey[] }) {
  const client = useQueryClient()
  const keyDep = JSON.stringify(options.describeKey)
  const alsoDep = JSON.stringify(options.alsoRead ?? [])
  const follower = useRef<ReturnType<typeof objectFollower> | null>(null)

  useEffect(() => {
    if (!options.enabled) return
    const current = objectFollower(client, JSON.parse(keyDep) as QueryKey, READ_AT_MOST_EVERY_MS, JSON.parse(alsoDep) as QueryKey[])
    follower.current = current
    return () => {
      current.stop()
      follower.current = null
    }
  }, [client, keyDep, alsoDep, options.enabled])

  useKubeWatchList({
    enabled: options.enabled,
    queryKey: options.describeKey as any[],
    path: options.path,
    query: `watch=1&fieldSelector=${encodeURIComponent(`metadata.name=${options.name}`)}`,
    // the frame is not the answer: it stays until it is read again, which a RESYNC of this watch asks for too
    applyEvent: (prev) => prev as any[],
    onEvent: (event) => follower.current?.onEvent(event),
    onResync: () => follower.current?.onResync(),
  })
}
