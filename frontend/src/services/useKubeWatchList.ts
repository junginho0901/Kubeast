import { useEffect, useRef } from 'react'
import { notifyManager, useQueryClient, type QueryClient } from '@tanstack/react-query'
import { watchMultiplexer } from './watchMultiplexer'
import { getCurrentClusterID } from './clusterRef'

type WatchEvent = {
  type?: string
  object?: any
}

export const applyWatchEvent = (prev: any[] | undefined, event: WatchEvent) => {
  const items = Array.isArray(prev) ? [...prev] : []
  const obj = event?.object
  if (!obj) return items

  const name = obj?.name || obj?.metadata?.name
  const namespace = obj?.namespace || obj?.metadata?.namespace
  if (!name) return items

  const key = namespace ? `${namespace}/${name}` : name
  const index = items.findIndex((item) => {
    const itemName = item?.name || item?.metadata?.name
    const itemNs = item?.namespace || item?.metadata?.namespace
    const itemKey = itemNs ? `${itemNs}/${itemName}` : itemName
    return itemKey === key
  })

  if (event.type === 'DELETED') {
    if (index >= 0) items.splice(index, 1)
    return items
  }

  if (index >= 0) {
    items[index] = obj
  } else {
    items.push(obj)
  }

  return items
}

// The kinds no namespace holds: the server's clusterWideWatch, held to this list by TestTheScreenKnowsTheKindsWithNoNamespace.
const KINDS_OF_THE_CLUSTER = new Set([
  'clusterroles',
  'clusterrolebindings',
  'priorityclasses',
  'runtimeclasses',
  'validatingwebhookconfigurations',
  'mutatingwebhookconfigurations',
  'customresourcedefinitions',
  'nodes',
  'namespaces',
  'persistentvolumes',
  'pvs',
  'ingressclasses',
  'storageclasses',
  'volumeattachments',
  'gatewayclasses',
  'deviceclasses',
  'resourceslices',
])

// scopedPaths turns an all-namespaces watch path into one path per granted
// namespace for a namespace-scoped grant (the server refuses the cluster-wide
// watch for them): /api/v1/pods → /api/v1/namespaces/<ns>/pods,
// /apis/apps/v1/deployments → /apis/apps/v1/namespaces/<ns>/deployments.
// A path that already names a namespace, an unscoped caller, or a kind no namespace
// holds, whose watch the server answers by the cluster's RBAC, is unchanged.
export function scopedPaths(path: string, scope: string[] | undefined): string[] {
  if (!scope || scope.length === 0 || path.includes('/namespaces/')) return [path]
  const cut = path.lastIndexOf('/')
  if (cut <= 0 || KINDS_OF_THE_CLUSTER.has(path.slice(cut + 1))) return [path]
  return scope.map((ns) => `${path.slice(0, cut)}/namespaces/${ns}${path.slice(cut)}`)
}

const rowName = (row: any): string => row?.name || row?.metadata?.name || ''
const rowNamespace = (row: any): string => row?.namespace || row?.metadata?.namespace || ''

// A row an apply added at the end goes where the list's next read puts it, by namespace and name as the API server lists
// them: at the end it would jump there on that read. Only a new row pays for this; a frame of a row the list has returns
// at the first check.
function placeNewRow(prev: any, next: any): any {
  if (!Array.isArray(prev) || !Array.isArray(next) || prev.length === 0 || next.length !== prev.length + 1) return next
  if (next[next.length - 2] !== prev[prev.length - 1]) return next
  const row = next[next.length - 1]
  const name = rowName(row)
  if (!name) return next
  const namespace = rowNamespace(row)
  const place = prev.findIndex((other) => {
    const otherNamespace = rowNamespace(other)
    return otherNamespace > namespace || (otherNamespace === namespace && rowName(other) > name)
  })
  return place < 0 ? next : [...prev.slice(0, place), row, ...prev.slice(place)]
}

// applyWatchMessage is what one frame of a subscription does to the list it feeds.
export function applyWatchMessage(
  queryClient: QueryClient,
  queryKey: any[],
  message: any,
  applyEvent?: (prev: any[] | undefined, event: WatchEvent) => any[],
  onEvent?: (event: WatchEvent) => void,
  onResync?: () => void,
  listensOnly = false,
) {
  // The rows stay on screen until the list answers.
  if (message?.type === 'RESYNC') {
    void queryClient.invalidateQueries({ queryKey })
    onResync?.()
    return
  }
  if (message?.type !== 'DATA') return
  const event = message?.data as WatchEvent
  if (listensOnly) {
    onEvent?.(event)
    return
  }
  queryClient.setQueryData(queryKey, (prev: any[] | undefined) => {
    // list 가 도착하기 전 (prev=undefined) 의 watch event 는 무시.
    // K8s watch with resourceVersion="" 는 LIST 의 모든 item 을 ADDED
    // event 로 stream 하는데, list 응답보다 일부 event 가 먼저 도착하면
    // setQueryData 가 빈 prev → 부분 array 를 만들어 useQuery 의 list
    // 응답을 race 로 덮어쓰거나 partial render 발생. list 가 정상적으로
    // 도착하면 그 시점부터의 watch event 만 apply 해야 정합성 유지.
    if (prev === undefined) return undefined
    return placeNewRow(prev, (applyEvent ?? applyWatchEvent)(prev, event))
  })
  onEvent?.(event)
}

// frameHolder gathers a list's frames and delivers them together, which the screen draws once. For a kind that writes
// itself all the time and whose objects are many (every node renews its Lease every ten seconds): one drawing per frame
// is a hundred a second at a thousand nodes.
export function frameHolder(deliver: (message: any) => void, everyMs: number) {
  let held: any[] = []
  let timer: ReturnType<typeof setTimeout> | undefined
  return {
    push(message: any) {
      held.push(message)
      if (timer !== undefined) return
      timer = setTimeout(() => {
        timer = undefined
        const frames = held
        held = []
        notifyManager.batch(() => frames.forEach(deliver))
      }, everyMs)
    },
    stop() {
      if (timer !== undefined) clearTimeout(timer)
      timer = undefined
      held = []
    },
  }
}

export function useKubeWatchList(options: {
  enabled: boolean
  queryKey: any[]
  path: string
  query?: string
  applyEvent?: (prev: any[] | undefined, event: WatchEvent) => any[]
  onEvent?: (event: WatchEvent) => void
  // the watch started over and cannot say what changed meanwhile
  onResync?: () => void
  // gathers the frames this often instead of drawing each (frameHolder)
  gatherEveryMs?: number
  // frames go to onEvent and nothing is written to the query: the frame is not its answer, and on a shared list most are others'
  listensOnly?: boolean
}) {
  const queryClient = useQueryClient()
  const query = options.query ?? 'watch=1'
  const gatherEveryMs = options.gatherEveryMs
  const listensOnly = !!options.listensOnly
  const clusterId = getCurrentClusterID() || 'default'
  // A namespace-scoped grant (me.cluster_namespaces) watches per namespace; the
  // scope is keyed by content so a re-render with the same list keeps the watch.
  const me = queryClient.getQueryData<{ cluster_namespaces?: Record<string, string[]> }>(['me'])
  const scopeKey = JSON.stringify(me?.cluster_namespaces?.[clusterId] ?? null)

  // 콜백과 queryKey 는 ref 로 읽는다 — identity 가 render 마다 바뀌어도 watch 를
  // 끊지 않고, queryKey 는 contents(queryKeyDep)가 바뀔 때만 재구독.
  const applyEventRef = useRef(options.applyEvent)
  const onEventRef = useRef(options.onEvent)
  const onResyncRef = useRef(options.onResync)
  const queryKeyRef = useRef(options.queryKey)
  useEffect(() => {
    applyEventRef.current = options.applyEvent
    onEventRef.current = options.onEvent
    onResyncRef.current = options.onResync
    queryKeyRef.current = options.queryKey
  })
  const queryKeyDep = JSON.stringify(options.queryKey)

  useEffect(() => {
    if (!options.enabled) return

    const paths = scopedPaths(options.path, (JSON.parse(scopeKey) as string[] | null) ?? undefined)
    // the list this subscription feeds; a later key gets its own subscription
    const queryKey = queryKeyRef.current

    const deliver = (message: any) => applyWatchMessage(queryClient, queryKey, message, applyEventRef.current, onEventRef.current, onResyncRef.current, listensOnly)
    const holder = gatherEveryMs ? frameHolder(deliver, gatherEveryMs) : null
    const handle = holder ? holder.push : deliver

    // Unsubscribed by message, not by the function subscribe resolves to: that
    // comes only once the socket is open, and a cleanup before it (the key
    // changing while the socket connects) would leave this watch feeding the list.
    const msgs = paths.map((path) => ({ type: 'REQUEST' as const, clusterId, path, query }))
    for (const msg of msgs) void watchMultiplexer.subscribe(msg, handle)

    return () => {
      holder?.stop()
      for (const msg of msgs) watchMultiplexer.unsubscribe(msg, handle)
    }
  }, [options.enabled, options.path, query, queryClient, queryKeyDep, clusterId, scopeKey, gatherEveryMs, listensOnly])
}
