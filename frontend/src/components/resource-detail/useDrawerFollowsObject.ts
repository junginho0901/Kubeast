import { useContext, useEffect, useMemo, useRef } from 'react'
import { hashKey, useQueryClient, type QueryClient, type QueryKey } from '@tanstack/react-query'
import { getCurrentClusterID } from '@/services/clusterRef'
import { FIRST_READ_MS, pacedReads, READ_AT_MOST_EVERY_MS } from '@/services/pacedReads'
import { useKubeWatchList } from '@/services/useKubeWatchList'
import { watchMultiplexer } from '@/services/watchMultiplexer'
import { OBJECT_READ_EVERY_MS } from './drawerObjectLayer'
import { DrawerObjectReadContext } from './drawerObjectRead'

type WatchEvent = { type?: string; object?: any }
type Fields = Record<string, unknown>

// What the answer has under names of its own for counts a frame says under the list's.
const MIRRORED: Record<string, Record<string, string>> = {
  replicas_status: { desired: 'replicas', current: 'current_replicas', ready: 'ready_replicas', updated: 'updated_replicas', available: 'available_replicas' },
  daemonset_status: { desired: 'desired', current: 'current', ready: 'ready', updated: 'updated', available: 'available', misscheduled: 'misscheduled', unavailable: 'unavailable' },
}

// A Job with no completions: the row says 1, as kubectl's table does, and the answer says none.
const ROW_DEFAULTS = new Set(['completions'])
// A row that could not be converted has other shapes under the same names.
const sameKind = (a: unknown, b: unknown) => a == null || b == null || (typeof a === typeof b && Array.isArray(a) === Array.isArray(b))
const frameSpeaksFor = (frame: Fields, held: Fields, key: string) => !ROW_DEFAULTS.has(key) && sameKind(frame[key], held[key])

// Whether a frame says something else than the answer does, in what both hold: the answer is the row with more in it.
function differsFromAnswer(frame: Fields, answer: unknown): boolean {
  if (!answer || typeof answer !== 'object') return false
  const held = answer as Fields
  return Object.keys(frame).some((key) => key in held && frameSpeaksFor(frame, held, key) && JSON.stringify(frame[key]) !== JSON.stringify(held[key]))
}

// The answer with what a frame says over it (TestAnAnswerAndALiveUpdateOfOneObjectSayTheSameUnderOneName).
function answerWithFrame(answer: Fields, frame: Fields): Fields {
  const next = { ...answer }
  for (const key of Object.keys(frame)) {
    if (frameSpeaksFor(frame, answer, key)) next[key] = frame[key]
  }
  for (const [section, names] of Object.entries(MIRRORED)) {
    const held = answer[section]
    if (!held || typeof held !== 'object') continue
    const moved = { ...(held as Fields) }
    for (const [part, name] of Object.entries(names)) {
      if (frame[name] !== undefined) moved[part] = frame[name]
    }
    next[section] = moved
  }
  return next
}

// objectFollower keeps a drawer on its object: a frame goes over the answer at once, and the rest of the answer, the tables in `alsoRead` and the floating chat's object (`chatKey`) are read at their pace.
export function objectFollower(client: QueryClient, describeKey: QueryKey, everyMs = READ_AT_MOST_EVERY_MS, alsoRead: QueryKey[] = [], chatKey?: QueryKey) {
  const reads = pacedReads(client, everyMs)
  const chatReads = chatKey ? pacedReads(client, OBJECT_READ_EVERY_MS) : undefined
  const openedAt = Date.now()
  const describeHash = hashKey(describeKey)
  let started = false
  let lastFrame: Fields | undefined
  let frames = 0
  let framesAtReadStart = 0
  let joining: ReturnType<typeof setTimeout> | undefined

  const heldFromBefore = (key: QueryKey) => {
    const held = client.getQueryState(key)
    return !!held && held.dataUpdatedAt > 0 && held.dataUpdatedAt < openedAt && held.fetchStatus === 'idle'
  }

  // A read that started before a frame may answer what the frame moved on from: what is on screen does not go back.
  const stopWatchingReads = client.getQueryCache().subscribe((event) => {
    if (event.type !== 'updated' || event.query.queryHash !== describeHash) return
    if (event.action.type === 'fetch') {
      framesAtReadStart = frames
    } else if (event.action.type === 'success' && !event.action.manual && lastFrame && frames > framesAtReadStart) {
      client.setQueryData(describeKey, answerWithFrame(event.query.state.data as Fields, lastFrame))
    }
  })

  const stopReads = () => {
    reads.clear()
    chatReads?.clear()
  }

  return {
    onEvent(event: WatchEvent) {
      if (!event?.object) return
      // The last answer stays on screen until the drawer closes: a read would only say 404, which the floating chat is told.
      if (event.type === 'DELETED') {
        stopReads()
        lastFrame = undefined
        if (chatKey) chatReads?.ask([chatKey])
        return
      }
      // A watch opens with the object as it is, which the answer the drawer just asked for says too.
      const opening = !started && event.type === 'ADDED'
      started = true
      const answer = client.getQueryData(describeKey) as Fields | undefined
      const differs = differsFromAnswer(event.object, answer)
      if (opening && !differs) {
        // What the chat holds may be from before this watch, the tab away and back: nothing else would read it again.
        if (chatKey && heldFromBefore(chatKey)) chatReads?.ask([chatKey])
        return
      }
      frames += 1
      lastFrame = event.object
      if (differs) client.setQueryData(describeKey, answerWithFrame(answer as Fields, event.object))
      reads.ask([describeKey, ...alsoRead])
      if (chatKey) chatReads?.ask([chatKey])
    },
    // The watch cannot say what changed while it was gone, and its RESYNC reads only the answer.
    onResync() {
      if (alsoRead.length > 0) reads.ask(alsoRead)
      if (chatKey) chatReads?.ask([chatKey])
    },
    // A list already open opens with nothing for this drawer, so what is held from before, the tab away and back, is read here; the screen's own reads have started by then.
    onJoinedList() {
      joining = setTimeout(() => {
        if (heldFromBefore(describeKey)) reads.ask([describeKey])
        if (chatKey && heldFromBefore(chatKey)) chatReads?.ask([chatKey])
      }, FIRST_READ_MS)
    },
    stop() {
      if (joining !== undefined) clearTimeout(joining)
      stopReads()
      stopWatchingReads()
    },
  }
}

// The list that already brings this object's frames: the page behind the drawer, of its namespace or of every namespace.
// Sharing it saves a place in the server's limit of watches and a watcher on the API server.
export function openListOf(path: string, isOpen: (path: string) => boolean): string | null {
  const everyNamespace = path.replace(/\/namespaces\/[^/]+\//, '/')
  return [path, everyNamespace].find(isOpen) ?? null
}

// useDrawerFollowsObject keeps an open drawer on its object as it changes, whichever screen opened it: a page's own
// watch is not there for a drawer opened by a link from another page.
export function useDrawerFollowsObject(options: { enabled: boolean; describeKey: QueryKey; path: string; name: string; alsoRead?: QueryKey[] }) {
  const client = useQueryClient()
  const clusterId = getCurrentClusterID() || 'default'
  // Decided as the drawer opens, and the drawer's listener then keeps that list's watch open when the page leaves.
  const openList = useMemo(
    () => (options.enabled ? openListOf(options.path, (path) => watchMultiplexer.follows(clusterId, path, 'watch=1')) : null),
    [options.enabled, options.path, clusterId],
  )
  const objectRead = useContext(DrawerObjectReadContext)
  const chatKey = objectRead?.key
  const keyDep = JSON.stringify(options.describeKey)
  const alsoDep = JSON.stringify(options.alsoRead ?? [])
  const follower = useRef<ReturnType<typeof objectFollower> | null>(null)

  useEffect(() => {
    if (!options.enabled) return
    const current = objectFollower(client, JSON.parse(keyDep) as QueryKey, READ_AT_MOST_EVERY_MS, JSON.parse(alsoDep) as QueryKey[], chatKey)
    follower.current = current
    if (openList) current.onJoinedList()
    return () => {
      current.stop()
      follower.current = null
    }
  }, [client, keyDep, alsoDep, chatKey, openList, options.enabled])

  const namespace = /\/namespaces\/([^/]+)\//.exec(options.path)?.[1]
  useKubeWatchList({
    enabled: options.enabled,
    queryKey: options.describeKey as any[],
    path: openList ?? options.path,
    query: openList ? 'watch=1' : `watch=1&fieldSelector=${encodeURIComponent(`metadata.name=${options.name}`)}`,
    // what the frame says goes through the follower, which compares it first; a RESYNC of this watch asks for the answer too
    listensOnly: true,
    onEvent: (event) => {
      if (!openList || frameOfObject(event, options.name, namespace)) follower.current?.onEvent(event)
    },
    onResync: () => follower.current?.onResync(),
    onAnswering: (answers) => objectRead?.setWatchAnswers(answers),
  })
}

// On a shared list most frames are of other objects.
export function frameOfObject(event: WatchEvent, name: string, namespace: string | undefined): boolean {
  const object = event?.object
  return (object?.name ?? object?.metadata?.name) === name && (!namespace || (object?.namespace ?? object?.metadata?.namespace) === namespace)
}
