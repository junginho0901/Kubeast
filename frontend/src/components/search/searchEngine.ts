import jsep from 'jsep'
import evaluate from 'simple-eval'

export interface SearchResult {
  kind: string
  name: string
  namespace: string
  status?: string
  age?: string
  raw: Record<string, unknown>
}

function getTopLevelKeys(items: Record<string, unknown>[]): string[] {
  const keys = new Set<string>()
  for (const obj of items) {
    if (obj && typeof obj === 'object') {
      for (const key of Object.keys(obj)) keys.add(key)
    }
  }
  return Array.from(keys)
}

export async function searchWithExpression(
  items: Record<string, unknown>[],
  query: string,
  interruptRef: { current: boolean },
): Promise<{ results: Record<string, unknown>[]; timeMs: number }> {
  const start = performance.now()
  if (!query.trim()) return { results: [], timeMs: 0 }

  let parsed: ReturnType<typeof jsep> | null = null
  try {
    parsed = jsep(query)
  } catch {
    return { results: [], timeMs: 0 }
  }
  if (!parsed) return { results: [], timeMs: 0 }

  const dummyKeys: Record<string, undefined> = {}
  getTopLevelKeys(items).forEach(k => { dummyKeys[k] = undefined })

  const results: Record<string, unknown>[] = []
  const batchSize = 500

  for (let i = 0; i < items.length; i++) {
    const item = items[i]
    const meta = (item.metadata ?? {}) as Record<string, unknown>
    const shortcuts = {
      namespace: meta.namespace ?? '',
      name: meta.name ?? '',
      labels: meta.labels ?? {},
      annotations: meta.annotations ?? {},
    }
    try {
      const res = evaluate(parsed as any, { ...dummyKeys, ...shortcuts, ...item })
      if (res === true) results.push(item)
    } catch { /* expression doesn't match this item */ }

    if ((i + 1) % batchSize === 0 || i === items.length - 1) {
      await new Promise(r => setTimeout(r, 0))
      if (interruptRef.current) return { results: [], timeMs: 0 }
    }
  }

  return { results, timeMs: performance.now() - start }
}

export function formatAge(creationTimestamp: string | undefined): string {
  if (!creationTimestamp) return '-'
  const diff = Date.now() - new Date(creationTimestamp).getTime()
  const seconds = Math.floor(diff / 1000)
  if (seconds < 60) return `${seconds}s`
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return `${minutes}m`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours}h`
  const days = Math.floor(hours / 24)
  return `${days}d`
}

export function extractStatus(item: Record<string, unknown>): string {
  const status = item.status as Record<string, unknown> | undefined
  if (!status) return '-'
  if (typeof status.phase === 'string') return status.phase
  const conditions = status.conditions as Array<Record<string, unknown>> | undefined
  if (Array.isArray(conditions)) {
    const ready = conditions.find(c => c.type === 'Ready' || c.type === 'Available')
    if (ready) return ready.status === 'True' ? 'Ready' : 'NotReady'
  }
  return '-'
}

export function toSearchResult(item: Record<string, unknown>): SearchResult {
  const meta = (item.metadata ?? {}) as Record<string, unknown>
  return {
    kind: (item.kind as string) ?? '-',
    name: (meta.name as string) ?? '-',
    namespace: (meta.namespace as string) ?? '-',
    status: extractStatus(item),
    age: formatAge(meta.creationTimestamp as string | undefined),
    raw: item,
  }
}
