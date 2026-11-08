import { useEffect, useMemo } from 'react'
import { useQueryClient, type QueryClient, type QueryKey } from '@tanstack/react-query'
import { getCurrentClusterID } from './clusterRef'
import { scopedPaths } from './useKubeWatchList'
import { watchMultiplexer } from './watchMultiplexer'

// However fast things change a table is read at most this often...
const READ_GAP_MS = 5_000
// ...and this many times the last read's own time apart, so the read of a big list keeps to a share of the server's time.
const READ_GAP_PER_READ_TIME = 10
// A socket that comes back tells every tab at once: their reads are spread over this long.
const MISSED_SPREAD_MS = 5_000

// Past this many rows a table is not read again by itself: each read costs the server all of them, for each person
// looking, and such a kind changes all the time. It stays at what it read and says so.
export const LIVE_ROWS_MAX = 2_000

// changeReader reads queries again when what they show changed. The rows stay on screen until the answer comes.
export function changeReader(client: QueryClient, keys: QueryKey[], now: () => number = Date.now) {
  let timer: ReturnType<typeof setTimeout> | undefined
  let stopped = false
  let lastEnd = -Infinity
  let gap = READ_GAP_MS

  const later = (wait: number) => {
    timer = setTimeout(() => void read(), wait)
  }

  const read = async () => {
    timer = undefined
    if (stopped) return
    const wait = lastEnd + gap - now()
    if (wait > 0) {
      later(wait)
      return
    }
    // A read under way may have missed the change, and restarting it could keep one from ever finishing.
    if (keys.some((queryKey) => client.isFetching({ queryKey }) > 0)) {
      later(READ_GAP_MS)
      return
    }
    const start = now()
    await Promise.all(keys.map((queryKey) => client.invalidateQueries({ queryKey })))
    lastEnd = now()
    gap = Math.max(READ_GAP_MS, (lastEnd - start) * READ_GAP_PER_READ_TIME)
  }

  const schedule = (wait: number) => {
    if (!stopped && timer === undefined) later(wait)
  }

  return {
    changed: () => schedule(0),
    // Nothing says what changed while the watch was gone.
    missed: () => schedule(Math.random() * MISSED_SPREAD_MS),
    stop: () => {
      stopped = true
      if (timer !== undefined) clearTimeout(timer)
      timer = undefined
    },
  }
}

// A reader that lives as long as the component, for a watch that decides itself what counts as a change.
export function useChangeReader(keys: QueryKey[]) {
  const client = useQueryClient()
  const keysDep = JSON.stringify(keys)
  const reader = useMemo(() => changeReader(client, JSON.parse(keysDep) as QueryKey[]), [client, keysDep])
  useEffect(() => reader.stop, [reader])
  return reader
}

// useWatchChanges reads tables again when the objects they come from change, for a table a frame cannot fill: one worked
// out on the server (a pod's RBAC, the rows of a CRD's printer columns), or one too big to hear of each object. The watch
// starts from now, sends no object and tells at most once a second (notify=1, the server's forwardChanges).
export function useWatchChanges(options: {
  enabled: boolean
  // /apis/<group>/<version>[/namespaces/<ns>]/<plural>
  paths: string[]
  read: QueryKey[]
  fieldSelector?: string
  // a custom resource of no namespace, which scopedPaths cannot tell from its name
  clusterWide?: boolean
}) {
  const client = useQueryClient()
  const clusterId = getCurrentClusterID() || 'default'
  const me = client.getQueryData<{ cluster_namespaces?: Record<string, string[]> }>(['me'])
  const scopeKey = JSON.stringify(me?.cluster_namespaces?.[clusterId] ?? null)
  const pathsDep = JSON.stringify(options.paths)
  const readDep = JSON.stringify(options.read)
  const query = `watch=1&notify=1${options.fieldSelector ? `&fieldSelector=${encodeURIComponent(options.fieldSelector)}` : ''}`
  const clusterWide = !!options.clusterWide

  useEffect(() => {
    if (!options.enabled) return
    const scope = clusterWide ? undefined : ((JSON.parse(scopeKey) as string[] | null) ?? undefined)
    const paths = (JSON.parse(pathsDep) as string[]).flatMap((path) => scopedPaths(path, scope))
    const reader = changeReader(client, JSON.parse(readDep) as QueryKey[])
    const listener = (message: { type: string }) => {
      if (message.type === 'CHANGED') reader.changed()
      else if (message.type === 'RESYNC') reader.missed()
    }
    const msgs = paths.map((path) => ({ type: 'REQUEST' as const, clusterId, path, query }))
    for (const msg of msgs) void watchMultiplexer.subscribe(msg, listener)
    return () => {
      reader.stop()
      for (const msg of msgs) watchMultiplexer.unsubscribe(msg, listener)
    }
  }, [options.enabled, client, clusterId, scopeKey, pathsDep, readDep, query, clusterWide])
}
