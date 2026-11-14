import { buildResourceLink } from '@/utils/resourceLink'
import type { SearchResult } from './searchEngine'

// One finished search of Advanced Search: the expression it answers, the read of the objects it went over (which says the
// namespace and resource types it listed) and what it found.
export interface Searched {
  query: string
  over: unknown
  namespace: string
  types: string[]
  results: SearchResult[]
  timeMs: number
}

export type Shown =
  | { state: 'idle' }
  | { state: 'searching' }
  | { state: 'done'; results: SearchResult[]; timeMs: number }

// What the page shows for the expression in the box over the objects it has read: the results of a search of that
// expression over that read, else that it is searching — the results of the expression before do not stand for it.
export function searchShown(searched: Searched | null, query: string, read: { items: unknown[] } | undefined): Shown {
  if (!query.trim() || !read || read.items.length === 0) return { state: 'idle' }
  if (searched && searched.query === query && searched.over === read) return { state: 'done', results: searched.results, timeMs: searched.timeMs }
  return { state: 'searching' }
}

// What the floating chat is told: the results with the expression, namespace and resource types they answer, and, while
// a search of the expression in the box over the objects read now has not finished, what is being searched; nothing
// once the box is emptied.
export function searchLayer(searched: Searched | null, typed: string, now: { namespace: string; types: string[]; read: { items: unknown[] } | undefined }) {
  if (!typed.trim()) return null
  const asked = { query: typed, namespace: now.namespace || undefined, selected_resource_types: now.types }
  // the read listed nothing: there is nothing to search, and no earlier result stands for it
  if (now.read && now.read.items.length === 0) {
    return { source: 'base' as const, summary: `고급 검색 0건 — 쿼리: "${typed}"`, data: { ...asked, total: 0, by_kind: {}, top_results: [] } }
  }
  if (!searched) {
    return { source: 'base' as const, summary: `고급 검색 — 쿼리: "${typed}" 검색 중`, data: { ...asked, searching: true } }
  }
  const current = searched.query === typed && searched.over === now.read
  const { results } = searched
  const byKind: Record<string, number> = {}
  for (const r of results) byKind[r.kind] = (byKind[r.kind] ?? 0) + 1
  return {
    source: 'base' as const,
    summary: `고급 검색 ${results.length}건 — 쿼리: "${searched.query}"${searched.namespace ? ` · namespace=${searched.namespace}` : ''}${
      current ? '' : ` · 검색 중: "${typed}"${now.namespace ? ` · namespace=${now.namespace}` : ''}`
    }`,
    data: {
      query: searched.query,
      namespace: searched.namespace || undefined,
      selected_resource_types: searched.types,
      total: results.length,
      by_kind: byKind,
      top_results: results.slice(0, 20).map((r) => {
        const link = buildResourceLink(r.kind, r.namespace, r.name)
        return {
          kind: r.kind,
          api_version: typeof r.raw?.apiVersion === 'string' ? r.raw.apiVersion : undefined,
          name: r.name,
          namespace: r.namespace || undefined,
          status: r.status,
          age: r.age,
          ...(link ? { _link: link } : {}),
        }
      }),
      // the search under way, which these results do not answer yet
      ...(current ? {} : { searching: asked }),
    },
  }
}
