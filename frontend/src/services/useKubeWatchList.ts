import { useEffect, useRef } from 'react'
import { focusManager, notifyManager, useQueryClient, type QueryClient } from '@tanstack/react-query'
import { watchMultiplexer } from './watchMultiplexer'
import { getCurrentClusterID } from './clusterRef'

type WatchEvent = {
  type?: string
  object?: any
}

type ApplyEvent = (prev: any[] | undefined, event: WatchEvent) => any[]

// A list that opens with thousands of objects gathers its frames this long: too short to see, and one pass over the rows.
export const LIST_GATHER_MS = 100

// A server back from a failure starts every watch over at one moment: each browser reads each list within this time, its rows on screen until then.
const RESYNC_READ_WITHIN_MS = 5000
// A list the limit refused is read this often until it has its place, each at its own time.
const LIMIT_READ_MS = 45_000
const LIMIT_READ_SPREAD_MS = 30_000

const resyncWait = () => Math.random() * RESYNC_READ_WITHIN_MS

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
  applyEvent?: ApplyEvent,
  onEvent?: (event: WatchEvent) => void,
  onResync?: () => void,
  listensOnly = false,
  readLater: (read: () => void) => void = (read) => void setTimeout(read, resyncWait()),
) {
  // The rows stay on screen until the list answers.
  if (message?.type === 'RESYNC') {
    readLater(() => {
      void queryClient.invalidateQueries({ queryKey })
      onResync?.()
    })
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

const rowKeyOf = (row: any): string | undefined => {
  const name = row?.name || row?.metadata?.name
  if (!name) return undefined
  const namespace = row?.namespace || row?.metadata?.namespace
  return namespace ? `${namespace}/${name}` : name
}

const listedAfter = (row: any, other: any) => {
  const namespace = rowNamespace(row)
  const otherNamespace = rowNamespace(other)
  return namespace > otherNamespace || (namespace === otherNamespace && rowName(row) > rowName(other))
}

// placeNewRow for many at once, in one pass over the rows.
function placeNewRows(rows: any[], added: any[]): any[] {
  if (added.length === 0) return rows
  const sorted = [...added].sort((a, b) => (listedAfter(a, b) ? 1 : listedAfter(b, a) ? -1 : 0))
  const placed: any[] = []
  let next = 0
  for (const row of rows) {
    while (next < sorted.length && listedAfter(row, sorted[next])) placed.push(sorted[next++])
    placed.push(row)
  }
  while (next < sorted.length) placed.push(sorted[next++])
  return placed
}

// What applying the events one by one leaves, in one pass over the rows: a kind's applyEvent runs over the one row an event names.
function mergeEvents(prev: any[], events: WatchEvent[], applyEvent: ApplyEvent): any[] {
  const gone = Symbol('gone')
  const rows: any[] = [...prev]
  const at = new Map<string, number>()
  rows.forEach((row, index) => {
    const key = rowKeyOf(row)
    if (key) at.set(key, index)
  })
  let removed = false
  for (const event of events) {
    const key = rowKeyOf(event?.object)
    if (!key) continue
    const index = at.get(key)
    const [row] = applyEvent(index === undefined ? [] : [rows[index]], event)
    if (row === undefined) {
      if (index !== undefined) {
        rows[index] = gone
        at.delete(key)
        removed = true
      }
    } else if (index === undefined) {
      at.set(key, rows.length)
      rows.push(row)
    } else {
      rows[index] = row
    }
  }
  if (rows.length === prev.length) return removed ? rows.filter((row) => row !== gone) : rows
  const kept = rows.slice(0, prev.length)
  const added = rows.slice(prev.length)
  return placeNewRows(removed ? kept.filter((row) => row !== gone) : kept, removed ? added.filter((row) => row !== gone) : added)
}

// applyWatchFrames is what a gathered delivery of frames does to the list they feed: one change, which the screen draws once.
export function applyWatchFrames(
  queryClient: QueryClient,
  queryKey: any[],
  messages: any[],
  applyEvent?: ApplyEvent,
  onEvent?: (event: WatchEvent) => void,
  onResync?: () => void,
  listensOnly = false,
  readLater?: (read: () => void) => void,
) {
  let events: WatchEvent[] = []
  const flush = () => {
    if (events.length === 0) return
    const applying = events
    events = []
    if (!listensOnly) queryClient.setQueryData(queryKey, (prev: any[] | undefined) => (prev === undefined ? undefined : mergeEvents(prev, applying, applyEvent ?? applyWatchEvent)))
    if (onEvent) applying.forEach(onEvent)
  }
  for (const message of messages) {
    if (message?.type === 'DATA') {
      events.push(message.data)
      continue
    }
    flush()
    applyWatchMessage(queryClient, queryKey, message, applyEvent, onEvent, onResync, listensOnly, readLater)
  }
  flush()
}

// frameHolder gathers a list's frames and delivers them together, which the screen draws once. For a kind that writes
// itself all the time and whose objects are many (every node renews its Lease every ten seconds): one drawing per frame
// is a hundred a second at a thousand nodes.
export function frameHolder(deliver: (message: any) => void, everyMs: number, deliverAll?: (messages: any[]) => void) {
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
        notifyManager.batch(() => (deliverAll ? deliverAll(frames) : frames.forEach(deliver)))
      }, everyMs)
    },
    stop() {
      if (timer !== undefined) clearTimeout(timer)
      timer = undefined
      held = []
    },
  }
}

// The reads a list's RESYNCs ask for: one at a time, and none once the list is gone.
function resyncReads() {
  let timer: ReturnType<typeof setTimeout> | undefined
  return {
    later(read: () => void) {
      if (timer !== undefined) return
      timer = setTimeout(() => {
        timer = undefined
        read()
      }, resyncWait())
    },
    stop() {
      if (timer !== undefined) clearTimeout(timer)
      timer = undefined
    },
  }
}

// Reads a list on the clock while the limit refuses any of its watches; a hidden tab reads it when it shows again.
function limitReads(read: () => void) {
  const refused = new Set<string>()
  let timer: ReturnType<typeof setTimeout> | undefined
  const stop = () => {
    if (timer !== undefined) clearTimeout(timer)
    timer = undefined
  }
  const next = () => {
    timer = setTimeout(() => {
      if (focusManager.isFocused()) read()
      next()
    }, LIMIT_READ_MS + Math.random() * LIMIT_READ_SPREAD_MS)
  }
  return {
    onFrame(message: any) {
      if (message?.type === 'ERROR' && message.error?.reason === 'limit') {
        refused.add(message.path)
        if (timer === undefined) next()
      } else {
        refused.delete(message?.path)
        if (refused.size === 0) stop()
      }
    },
    // the next socket asks for every watch again, and is told again what it may not have
    forget() {
      refused.clear()
      stop()
    },
    stop,
  }
}

// followList follows a list until the function it returns is called; the callbacks are read as each frame comes, since they change between drawings.
export function followList(
  queryClient: QueryClient,
  options: {
    clusterId: string
    paths: string[]
    query: string
    queryKey: any[]
    gatherEveryMs?: number
    listensOnly?: boolean
    applyEvent?: () => ApplyEvent | undefined
    onEvent?: () => ((event: WatchEvent) => void) | undefined
    onResync?: () => (() => void) | undefined
    onAnswering?: () => ((answers: boolean) => void) | undefined
  },
) {
  const { clusterId, paths, query, queryKey, gatherEveryMs, listensOnly } = options
  const resync = resyncReads()
  const poll = limitReads(() => void queryClient.invalidateQueries({ queryKey }))
  const deliver = (message: any) =>
    applyWatchMessage(queryClient, queryKey, message, options.applyEvent?.(), options.onEvent?.(), options.onResync?.(), listensOnly, resync.later)
  const deliverAll = (messages: any[]) =>
    applyWatchFrames(queryClient, queryKey, messages, options.applyEvent?.(), options.onEvent?.(), options.onResync?.(), listensOnly, resync.later)
  const holder = gatherEveryMs ? frameHolder(deliver, gatherEveryMs, deliverAll) : null
  const answering = (answers: boolean) => options.onAnswering?.()?.(answers)
  const handle = (message: any) => {
    poll.onFrame(message)
    if (message?.type === 'DATA' || message?.type === 'RESYNC') answering(true)
    else if (message?.type === 'ERROR') answering(false)
    if (holder) holder.push(message)
    else deliver(message)
  }

  // Unsubscribed by message, not by the function subscribe resolves to: that
  // comes only once the socket is open, and a cleanup before it (the key
  // changing while the socket connects) would leave this watch feeding the list.
  const msgs = paths.map((path) => ({ type: 'REQUEST' as const, clusterId, path, query }))
  for (const msg of msgs) void watchMultiplexer.subscribe(msg, handle)
  // A list already open has said what it opens with.
  if (msgs.every((msg) => watchMultiplexer.answers(clusterId, msg.path, query))) answering(true)
  const stopClosed = watchMultiplexer.onSocketClosed(() => {
    poll.forget()
    answering(false)
  })

  return () => {
    holder?.stop()
    resync.stop()
    poll.stop()
    stopClosed()
    answering(false)
    for (const msg of msgs) watchMultiplexer.unsubscribe(msg, handle)
  }
}

export function useKubeWatchList(options: {
  enabled: boolean
  queryKey: any[]
  path: string
  query?: string
  applyEvent?: ApplyEvent
  onEvent?: (event: WatchEvent) => void
  // the watch started over and cannot say what changed meanwhile
  onResync?: () => void
  // gathers the frames this often instead of drawing each (frameHolder)
  gatherEveryMs?: number
  // frames go to onEvent and nothing is written to the query: the frame is not its answer, and on a shared list most are others'
  listensOnly?: boolean
  // whether the watch answers: a frame came, or it was refused or lost its socket
  onAnswering?: (answers: boolean) => void
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
  const onAnsweringRef = useRef(options.onAnswering)
  const queryKeyRef = useRef(options.queryKey)
  useEffect(() => {
    applyEventRef.current = options.applyEvent
    onEventRef.current = options.onEvent
    onResyncRef.current = options.onResync
    onAnsweringRef.current = options.onAnswering
    queryKeyRef.current = options.queryKey
  })
  const queryKeyDep = JSON.stringify(options.queryKey)

  useEffect(() => {
    if (!options.enabled) return
    return followList(queryClient, {
      clusterId,
      paths: scopedPaths(options.path, (JSON.parse(scopeKey) as string[] | null) ?? undefined),
      query,
      // the list this subscription feeds; a later key gets its own subscription
      queryKey: queryKeyRef.current,
      gatherEveryMs,
      listensOnly,
      applyEvent: () => applyEventRef.current,
      onEvent: () => onEventRef.current,
      onResync: () => onResyncRef.current,
      onAnswering: () => onAnsweringRef.current,
    })
  }, [options.enabled, options.path, query, queryClient, queryKeyDep, clusterId, scopeKey, gatherEveryMs, listensOnly])
}
