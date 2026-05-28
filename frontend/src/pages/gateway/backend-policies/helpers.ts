import { mergeWatchUpdate } from '@/services/mergeWatchUpdate'

export interface BackendPolicyLike {
  name: string
  namespace: string
  target_refs?: Array<Record<string, any>>
  conditions?: Array<Record<string, any>>
  labels?: Record<string, string>
  annotations?: Record<string, string>
  created_at?: string | null
}

export type SortKey = null | 'name' | 'namespace' | 'targetRef' | 'age'

export function parseAgeSeconds(createdAt?: string | null): number {
  if (!createdAt) return 0
  const ms = new Date(createdAt).getTime()
  if (!Number.isFinite(ms)) return 0
  return Math.max(0, Math.floor((Date.now() - ms) / 1000))
}

export function formatAge(createdAt?: string | null): string {
  const sec = parseAgeSeconds(createdAt)
  const d = Math.floor(sec / 86400)
  const h = Math.floor((sec % 86400) / 3600)
  const m = Math.floor((sec % 3600) / 60)
  if (d > 0) return `${d}d ${h}h`
  if (h > 0) return `${h}h ${m}m`
  return `${m}m`
}

export function formatTargetRefs(item: BackendPolicyLike): string {
  const refs = Array.isArray(item.target_refs) ? item.target_refs : []
  if (refs.length === 0) return '-'
  return refs.map((r) => `${r.kind || 'Service'}/${r.name || '-'}`).join(', ')
}

export function formatConditionStatus(item: BackendPolicyLike): string {
  const conds = Array.isArray(item.conditions) ? item.conditions : []
  if (conds.length === 0) return '-'
  const accepted = conds.find((c) => c.type === 'Accepted')
  if (accepted) return accepted.status === 'True' ? 'Accepted' : accepted.reason || 'Not Accepted'
  return conds[0]?.type || '-'
}

export function normalizeWatchObject<T extends BackendPolicyLike>(obj: any): T {
  if (typeof obj?.name === 'string' && typeof obj?.namespace === 'string') {
    return {
      ...obj,
      target_refs: Array.isArray(obj.target_refs) ? obj.target_refs : [],
      labels: obj.labels || {},
      annotations: obj.annotations || {},
    } as T
  }
  const metadata = obj?.metadata ?? {}
  const spec = obj?.spec ?? {}
  let targetRefs = Array.isArray(spec?.targetRefs) ? spec.targetRefs : []
  if (targetRefs.length === 0 && spec?.targetRef) targetRefs = [spec.targetRef]
  return {
    name: metadata?.name ?? obj?.name ?? '',
    namespace: metadata?.namespace ?? obj?.namespace ?? '',
    target_refs: targetRefs,
    labels: metadata?.labels ?? obj?.labels ?? {},
    annotations: metadata?.annotations ?? obj?.annotations ?? {},
    created_at: metadata?.creationTimestamp ?? obj?.created_at ?? null,
  } as T
}

export function applyWatchEvent<T extends BackendPolicyLike>(
  prev: T[] | undefined,
  event: { type?: string; object?: any },
): T[] {
  const items = Array.isArray(prev) ? [...prev] : []
  const obj = event?.object
  if (!obj) return items
  const normalized = normalizeWatchObject<T>(obj)
  const name = normalized?.name
  const namespace = normalized?.namespace
  if (!name || !namespace) return items
  const key = `${namespace}/${name}`
  const index = items.findIndex((item) => `${item.namespace}/${item.name}` === key)
  if (event.type === 'DELETED') {
    if (index >= 0) items.splice(index, 1)
    return items
  }
  if (index >= 0) items[index] = mergeWatchUpdate(items[index], normalized) as T
  else items.push(normalized)
  return items
}

export function toRawJson(item: BackendPolicyLike, apiVersion: string, kind: string): Record<string, unknown> {
  return {
    apiVersion,
    kind,
    metadata: {
      name: item.name,
      namespace: item.namespace,
      labels: item.labels || {},
      annotations: item.annotations || {},
      creationTimestamp: item.created_at,
    },
    spec: { targetRefs: item.target_refs || [] },
  }
}
