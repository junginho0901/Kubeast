// CustomResourceDefinition watch event → the list's row, and applying it to the list.

import type { CRDInfo } from '@/services/api'
import { servedVersions } from './crdVersions'

export function normalizeWatchCRDObject(obj: any): CRDInfo {
  if (
    typeof obj?.name === 'string' &&
    typeof obj?.group === 'string'
  ) {
    return obj as CRDInfo
  }

  const metadata = obj?.metadata ?? {}
  const spec = obj?.spec ?? {}
  const names = spec?.names ?? {}

  let version = ''
  if (Array.isArray(spec?.versions)) {
    const storageVer = spec.versions.find((v: any) => v.storage)
    version = storageVer?.name ?? spec.versions[0]?.name ?? ''
  }

  return {
    name: metadata?.name ?? obj?.name ?? '',
    group: spec?.group ?? '',
    version,
    served_versions: servedVersions(spec?.versions),
    scope: spec?.scope ?? '',
    kind: names?.kind ?? '',
    created_at: metadata?.creationTimestamp ?? obj?.created_at ?? '',
    labels: metadata?.labels ?? obj?.labels ?? null,
    annotations: metadata?.annotations ?? obj?.annotations ?? null,
  }
}

export function applyCRDWatchEvent(
  prev: CRDInfo[] | undefined,
  event: { type?: string; object?: any },
): CRDInfo[] {
  const items = Array.isArray(prev) ? [...prev] : []
  const obj = event?.object
  if (!obj) return items

  const normalized = normalizeWatchCRDObject(obj)
  const name = normalized?.name
  if (!name) return items

  const index = items.findIndex((item) => item.name === name)

  if (event.type === 'DELETED') {
    if (index >= 0) items.splice(index, 1)
    return items
  }

  // the server sends the whole row (crdrow.Info), so it replaces: a version no longer served goes from the list
  if (index >= 0) items[index] = normalized
  else items.push(normalized)

  return items
}
