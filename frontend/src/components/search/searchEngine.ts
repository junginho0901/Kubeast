import jsep from 'jsep'
import evaluate from 'simple-eval'
import { formatAge } from '@/utils/time'

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

function tryParse(query: string): ReturnType<typeof jsep> | null {
  try {
    return jsep(query)
  } catch {
    return null
  }
}

export async function searchWithExpression(
  items: Record<string, unknown>[],
  query: string,
  interruptRef: { current: boolean },
): Promise<{ results: Record<string, unknown>[]; timeMs: number }> {
  const start = performance.now()
  if (!query.trim()) return { results: [], timeMs: 0 }

  const parsed = tryParse(query)
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

export { formatAge }

// The server sends each object's kubectl STATUS beside the list (printer_status, the Status column of kubectl get's
// table); it is kept per object here because the objects go into the expressions as the API wrote them.
const printerStatus = new WeakMap<object, string>()

export function rememberPrinterStatus(item: object, status: string) {
  printerStatus.set(item, status)
}

// kubectl's STATUS where the kind prints one; otherwise the phase or the Ready/Available condition.
export function extractStatus(item: Record<string, unknown>): string {
  const printed = printerStatus.get(item)
  if (printed !== undefined) return printed || '-'
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

export type SearchSortKey = 'kind' | 'name' | 'namespace' | 'status' | 'age'

const createdAt = (r: SearchResult) => {
  const ts = Date.parse(String((r.raw?.metadata as Record<string, unknown> | undefined)?.creationTimestamp ?? ''))
  return Number.isNaN(ts) ? -Infinity : ts
}

// The results table's ascending order: Age by creation time, the youngest first as a smaller AGE (an object without
// one last), the other columns as text — the Age text ("9h", "10d") does not sort as text.
export function compareResults(a: SearchResult, b: SearchResult, key: SearchSortKey): number {
  if (key === 'age') {
    const ta = createdAt(a)
    const tb = createdAt(b)
    return ta === tb ? 0 : tb > ta ? 1 : -1
  }
  return String(a[key] ?? '').localeCompare(String(b[key] ?? ''))
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
