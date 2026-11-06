// ServiceAccount watch event → the list's row, and applying it to the list.

import type { ServiceAccountInfo } from '@/services/api'

const namesOf = (list: unknown): string[] =>
  Array.isArray(list) ? list.map((s: any) => s?.name).filter(Boolean) : []

export function normalizeWatchServiceAccountObject(obj: any): ServiceAccountInfo {
  if (
    typeof obj?.name === 'string' &&
    typeof obj?.namespace === 'string' &&
    typeof obj?.secrets === 'number'
  ) {
    return obj as ServiceAccountInfo
  }

  const metadata = obj?.metadata ?? {}
  const secrets = Array.isArray(obj?.secrets) ? obj.secrets : []

  return {
    name: metadata?.name ?? obj?.name ?? '',
    namespace: metadata?.namespace ?? obj?.namespace ?? '',
    secrets: secrets.length,
    secrets_list: namesOf(secrets),
    image_pull_secrets: namesOf(obj?.imagePullSecrets),
    created_at: metadata?.creationTimestamp ?? obj?.created_at ?? '',
    labels: metadata?.labels ?? obj?.labels ?? null,
    annotations: metadata?.annotations ?? obj?.annotations ?? null,
  }
}

export function applyServiceAccountWatchEvent(
  prev: ServiceAccountInfo[] | undefined,
  event: { type?: string; object?: any },
): ServiceAccountInfo[] {
  const items = Array.isArray(prev) ? [...prev] : []
  const obj = event?.object
  if (!obj) return items

  const normalized = normalizeWatchServiceAccountObject(obj)
  const name = normalized?.name
  const namespace = normalized?.namespace
  if (!name || !namespace) return items

  const key = `${namespace}/${name}`
  const index = items.findIndex((item) => `${item.namespace}/${item.name}` === key)

  if (event.type === 'DELETED') {
    if (index >= 0) items.splice(index, 1)
    return items
  }

  // the server sends the whole row (sarow.Info), so it replaces: a pull Secret or label that went away shows that instead
  // of keeping the old one
  if (index >= 0) items[index] = normalized
  else items.push(normalized)

  return items
}
