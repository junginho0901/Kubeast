import { useEffect, useRef } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import type { HelmReleaseSummary } from './api'

// Helm release watch — separate WebSocket per (cluster, namespace) pair.
// Not multiplexed with the K8s native watch socket on purpose: the
// backend decodes & enriches each Helm Secret before sending it on, so
// it lives on its own dedicated endpoint at /api/v1/helm/releases/watch.
//
// Replaces the prior 30s polling on the Releases / ReleaseDetail pages.

type HelmWatchEventType = 'ADDED' | 'MODIFIED' | 'DELETED'

interface HelmWatchEvent {
  type: HelmWatchEventType
  object: HelmReleaseSummary
}

export interface UseHelmWatchListOptions {
  /**
   * cluster id. Today only "default" is meaningful — kept as a parameter
   * so the multi-cluster transition (see prereq doc) is a one-line
   * change at the call site rather than a hook signature change.
   */
  cluster: string
  /**
   * namespace filter. Empty/undefined = cluster-wide watch.
   */
  namespace?: string
  /**
   * gate the connection (e.g. wait until the initial REST list resolves).
   */
  enabled?: boolean
  /**
   * react-query key whose cache the hook should mutate. The page's
   * useQuery must use the same key for the watch to take effect. Pass
   * `null` to disable list-cache mutation entirely (useful for the
   * detail page, which uses onEvent to invalidate sibling queries
   * instead of patching a list).
   */
  queryKey: readonly unknown[] | null
  /**
   * Called for every release event after the cache has been mutated.
   * Useful to invalidate dependent queries (detail/history/resources)
   * on the ReleaseDetail page. Captured by ref so changing this prop
   * does not tear down the WebSocket.
   */
  onEvent?: (event: HelmWatchEvent) => void
}

export type { HelmWatchEvent }

const RECONNECT_BASE_MS = 1_000
const RECONNECT_MAX_MS = 30_000

const buildHelmWatchURL = (cluster: string, namespace?: string): string => {
  const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:'
  const base = `${protocol}//${window.location.host}`
  const params = new URLSearchParams({ cluster })
  if (namespace) params.set('namespace', namespace)
  return `${base}/api/v1/helm/releases/watch?${params.toString()}`
}

const releaseKey = (rel: HelmReleaseSummary): string =>
  `${rel.namespace}/${rel.name}`

const applyHelmWatchEvent = (
  prev: HelmReleaseSummary[] | undefined,
  event: HelmWatchEvent,
): HelmReleaseSummary[] => {
  const items = Array.isArray(prev) ? [...prev] : []
  const obj = event.object
  if (!obj?.name || !obj?.namespace) return items
  const key = releaseKey(obj)
  const idx = items.findIndex((item) => releaseKey(item) === key)

  if (event.type === 'DELETED') {
    if (idx >= 0) items.splice(idx, 1)
    return items
  }

  // Helm increments revision on every install/upgrade/rollback. Only
  // accept ADDED/MODIFIED if the revision is at least the cached one —
  // out-of-order delivery from a re-list would otherwise rewind the UI
  // to a stale state.
  if (idx >= 0) {
    const existing = items[idx]
    if (existing.revision > obj.revision) return items
    items[idx] = obj
  } else {
    items.push(obj)
  }

  return items
}

/**
 * useHelmWatchList — subscribes to /api/v1/helm/releases/watch and keeps
 * the named react-query cache entry in lockstep with the cluster's
 * Helm release Secrets.
 *
 * Reconnects with exponential backoff on disconnect, capped at
 * RECONNECT_MAX_MS. JWT auth piggybacks on the cookie that the rest of
 * the app already uses — no token plumbing needed here.
 */
export function useHelmWatchList(options: UseHelmWatchListOptions): void {
  const queryClient = useQueryClient()
  const { cluster, namespace, enabled = true, queryKey } = options

  // Stringify queryKey for the dep array — array identity is unstable
  // across renders, but the contents are what we care about.
  const queryKeyDep = JSON.stringify(queryKey)

  // Capture onEvent in a ref so changing it does not retrigger the
  // effect (which would tear down the WebSocket).
  const onEventRef = useRef(options.onEvent)
  useEffect(() => {
    onEventRef.current = options.onEvent
  }, [options.onEvent])

  useEffect(() => {
    if (!enabled) return

    let socket: WebSocket | null = null
    let reconnectTimer: ReturnType<typeof setTimeout> | null = null
    let attempt = 0
    let cancelled = false

    const handleEvent = (raw: MessageEvent) => {
      try {
        const msg = JSON.parse(raw.data) as HelmWatchEvent | { type: 'ERROR'; error?: string }
        if (msg.type === 'ERROR') {
          // Backend signalled an unrecoverable error for this stream.
          // Logging only — the close that follows will trigger reconnect.
          console.warn('helm watch error frame', (msg as { error?: string }).error)
          return
        }
        if (queryKey !== null) {
          queryClient.setQueryData(queryKey, (prev: HelmReleaseSummary[] | undefined) =>
            applyHelmWatchEvent(prev, msg),
          )
        }
        onEventRef.current?.(msg)
      } catch (err) {
        console.warn('helm watch parse error', err)
      }
    }

    const connect = () => {
      if (cancelled) return
      const url = buildHelmWatchURL(cluster, namespace)
      const ws = new WebSocket(url)
      socket = ws

      ws.onopen = () => {
        attempt = 0 // success resets the backoff
      }
      ws.onmessage = handleEvent
      ws.onerror = (e) => {
        console.warn('helm watch socket error', e)
      }
      ws.onclose = () => {
        if (cancelled) return
        // Exponential backoff with jitter — avoid hammering the server
        // when many tabs reconnect simultaneously after a deploy.
        const delay = Math.min(
          RECONNECT_MAX_MS,
          RECONNECT_BASE_MS * 2 ** Math.min(attempt, 5),
        )
        const jitter = Math.random() * 250
        attempt += 1
        reconnectTimer = setTimeout(connect, delay + jitter)
      }
    }

    connect()

    return () => {
      cancelled = true
      if (reconnectTimer) clearTimeout(reconnectTimer)
      if (socket) {
        // Drop our handlers first so the in-flight close doesn't trigger
        // a reconnect after unmount.
        socket.onclose = null
        socket.onerror = null
        socket.onmessage = null
        socket.onopen = null
        socket.close()
      }
    }
  }, [cluster, namespace, enabled, queryClient, queryKeyDep])
}
