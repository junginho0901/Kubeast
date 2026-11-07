import { MAX_LAYER_BYTES } from '@/utils/aiContext/tokenBudget'

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

// A refusal or a missing object answers the same on the next read; a failure of the server may pass.
export function objectReadInterval(follows: boolean, error: unknown): number | false {
  const status = (error as { response?: { status?: number } } | null)?.response?.status ?? 0
  return follows && !(status >= 400 && status < 500) ? OBJECT_READ_EVERY_MS : false
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
