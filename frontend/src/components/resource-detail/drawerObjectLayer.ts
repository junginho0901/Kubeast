import { MAX_LAYER_BYTES } from '@/utils/aiContext/tokenBudget'

import { eventsForAI, eventsNewestFirst } from './detailFormat'
import { SELF_LOADING_KINDS, UNRESOLVABLE_KINDS } from './utils'

type RawObject = Record<string, unknown>

export const OBJECT_READ_EVERY_MS = 10_000

// Room left in the layer for the object, past the few fields beside it.
const RAW_BYTES = MAX_LAYER_BYTES - 512

// Whether an open drawer goes on reading its object for the floating chat. The generic read of a Secret is an audited
// reveal for whoever may reveal it; Node and Namespace load their own object; a custom resource is named by its CRD.
export function followsObjectForChat(kind: string): boolean {
  return kind !== 'Secret' && !SELF_LOADING_KINDS.has(kind) && !UNRESOLVABLE_KINDS.has(kind)
}

// A refusal or a missing object answers the same on the next read; a failure may pass; a watch that answers says when to read (useDrawerFollowsObject).
export function objectReadInterval(follows: boolean, error: unknown, watchAnswers = false): number | false {
  const status = (error as { response?: { status?: number } } | null)?.response?.status ?? 0
  if (!follows || (status >= 400 && status < 500)) return false
  return watchAnswers && !error ? false : OBJECT_READ_EVERY_MS
}

// The object as the floating chat gets it, without what is large or noise: managed fields, the annotations' values.
function forChat(object: RawObject, secret: boolean): RawObject {
  const meta = (object.metadata as RawObject | undefined) ?? {}
  const annotations = meta.annotations as RawObject | undefined
  return {
    ...object,
    metadata: { ...meta, managedFields: undefined, annotations: annotations ? Object.keys(annotations) : undefined },
    // A Secret's values never go to the model, even from a user who may reveal them on screen; the server strips them
    // again (defense in depth).
    ...(secret ? { data: undefined, stringData: undefined } : {}),
  }
}

const bytes = (value: unknown) => new Blob([JSON.stringify(value)]).size

// The fields the window of a kind with no drawer of its own draws: past the layer's limit these stay and the rest goes.
const pick = (from: RawObject, keys: string[]) => Object.fromEntries(keys.filter((key) => from[key] !== undefined).map((key) => [key, from[key]]))
const objectsOf = (value: unknown, keys: string[]) => (Array.isArray(value) ? value.map((item) => pick((item ?? {}) as RawObject, keys)) : value)

function drawnSpec(spec: RawObject): RawObject {
  const drawn = pick(spec, ['replicas', 'type', 'clusterIP', 'nodeName', 'serviceAccountName'])
  if (spec.containers !== undefined) drawn.containers = objectsOf(spec.containers, ['name', 'image'])
  if (spec.ports !== undefined) drawn.ports = objectsOf(spec.ports, ['name', 'port', 'targetPort', 'protocol'])
  return drawn
}
const drawnStatus = (status: RawObject) => pick(status, ['phase', 'replicas', 'readyReplicas', 'conditions'])

// What that window tells the floating chat of its object and events. Annotations go by name, as in drawerObjectLayer: one
// value can repeat the whole object. The token budget empties a layer past its limit, so the spec, then the status, come
// down to what the window draws, then the newest events stay, and `object_cut` says so; the YAML tab has the rest.
export function genericObjectLayer(object?: RawObject, describe?: { events?: unknown; events_error?: unknown }): RawObject {
  const meta = (object?.metadata ?? {}) as RawObject
  const annotations = meta.annotations as RawObject | undefined
  const layer: RawObject = {
    api_version: object?.apiVersion,
    created_at: meta.creationTimestamp,
    uid: meta.uid,
    labels: meta.labels,
    annotations: annotations ? Object.keys(annotations) : undefined,
    spec: (object?.spec ?? {}) as RawObject,
    status: (object?.status ?? {}) as RawObject,
    ...eventsForAI(describe),
  }
  const over = () => bytes(layer) > RAW_BYTES
  const cut: string[] = []
  if (over()) {
    layer.spec = drawnSpec(layer.spec as RawObject)
    cut.push('spec')
  }
  if (over()) {
    layer.status = drawnStatus(layer.status as RawObject)
    cut.push('status')
  }
  const events = over() ? eventsNewestFirst(layer.events) : undefined
  if (events) {
    layer.events_total = events.length
    cut.push('events')
    for (let keep = events.length; over() && keep > 0;) {
      keep = Math.floor(keep / 2)
      layer.events = events.slice(0, keep)
    }
  }
  return cut.length > 0 ? { ...layer, object_cut: cut } : layer
}

// What the drawer's layer says of its object. A list row is the list's answer when the drawer opened, so the object's
// own answer comes first and a row says it is one. The token budget empties a layer past its limit, which a list row
// never reached and a whole object can, so the object's largest parts go first, by name.
export function drawerObjectLayer({ row, live, secret, readStatus }: {
  row?: RawObject
  live?: RawObject
  secret: boolean
  readStatus?: number
}): RawObject {
  const status = readStatus ? { raw_read_status: readStatus } : {}
  const object = live ?? row
  if (!object) return status

  const raw = forChat(object, secret)
  const omitted: string[] = []
  for (const part of ['spec', 'status']) {
    if (bytes(raw) <= RAW_BYTES) break
    if (part in raw) {
      delete raw[part]
      omitted.push(part)
    }
  }
  return {
    raw,
    ...(live ? {} : { raw_from: 'list_row_when_opened' }),
    ...(omitted.length > 0 ? { raw_omitted: omitted } : {}),
    ...status,
  }
}
