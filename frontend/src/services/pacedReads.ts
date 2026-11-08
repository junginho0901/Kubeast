import { useEffect, useMemo } from 'react'
import { focusManager, hashKey, useQueryClient, type QueryClient, type QueryKey } from '@tanstack/react-query'

// A rollout writes many times a second and each read lists events, for everyone with the drawer open.
export const READ_AT_MOST_EVERY_MS = 5000
// A change after a quiet time is read this soon. Its writes come close together, and every open drawer gets them at one moment.
export const FIRST_READ_MS = 250
const FIRST_READ_SPREAD_MS = 750

// At most one read in `everyMs`, soon after a quiet time; a read under way may have missed the change, and restarting it might never let one finish.
export function pacedReads(client: QueryClient, everyMs: number) {
  let timer: ReturnType<typeof setTimeout> | undefined
  let lastRead = -Infinity
  let waiting: QueryKey[] = []
  let stopWaitingToShow: (() => void) | undefined

  const read = () => {
    timer = undefined
    // A hidden tab draws nothing and takes no read of anybody's: it reads once when it shows again.
    if (!focusManager.isFocused()) {
      stopWaitingToShow = focusManager.subscribe(() => {
        if (!focusManager.isFocused()) return
        stopWaitingToShow?.()
        stopWaitingToShow = undefined
        read()
      })
      return
    }
    const underWay = waiting.filter((queryKey) => client.isFetching({ queryKey }) > 0)
    for (const queryKey of waiting) {
      if (!underWay.includes(queryKey)) void client.invalidateQueries({ queryKey })
    }
    if (underWay.length < waiting.length) lastRead = Date.now()
    waiting = underWay
    if (waiting.length > 0) timer = setTimeout(read, everyMs)
  }

  return {
    ask(keys: QueryKey[]) {
      const asked = new Set(waiting.map((key) => hashKey(key)))
      waiting = [...waiting, ...keys.filter((key) => !asked.has(hashKey(key)))]
      if (timer !== undefined || stopWaitingToShow) return
      const soon = FIRST_READ_MS + Math.random() * FIRST_READ_SPREAD_MS
      timer = setTimeout(read, Math.max(soon, lastRead + everyMs - Date.now()))
    },
    clear() {
      if (timer !== undefined) clearTimeout(timer)
      timer = undefined
      waiting = []
      stopWaitingToShow?.()
      stopWaitingToShow = undefined
    },
  }
}

// What a list's frames ask of the answer of the object they name: looks at that one query, since a list opens with a frame
// per object. An open drawer reads at the pace above; an answer a closed drawer left reads when it opens again.
export function describeReads(client: QueryClient, everyMs = READ_AT_MOST_EVERY_MS) {
  const reads = pacedReads(client, everyMs)
  const held = (key: QueryKey) => client.getQueryCache().get(hashKey(key))
  return {
    changed(key: QueryKey) {
      const query = held(key)
      if (!query) return
      if (query.getObserversCount() > 0) reads.ask([key])
      else query.invalidate()
    },
    // For a drawer that follows the object by itself (useDrawerFollowsObject), at that pace.
    changedFollowed(key: QueryKey) {
      const query = held(key)
      if (query && query.getObserversCount() === 0) query.invalidate()
    },
    stop: () => reads.clear(),
  }
}

export function useDescribeReads() {
  const client = useQueryClient()
  const reads = useMemo(() => describeReads(client), [client])
  useEffect(() => reads.stop, [reads])
  return reads
}
