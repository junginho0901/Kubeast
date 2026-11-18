import { buildResourceLink } from '@/utils/resourceLink'
import type { SearchResult } from './searchEngine'
import { searchReadGaps, searchReadGapsText, type SearchRead } from './searchReadGaps'

// One finished search of Advanced Search: the expression it answers, the read of the objects it went over (which says the
// namespace and resource types it listed) and what it found, or why the expression could not be read (`unreadable`).
export interface Searched {
  query: string
  over: unknown
  namespace: string
  types: string[]
  results: SearchResult[]
  timeMs: number
  unreadable?: string
}

export type Shown =
  | { state: 'idle' }
  | { state: 'searching' }
  | { state: 'done'; results: SearchResult[]; timeMs: number }
  | { state: 'unreadable'; reason: string }

// What the page shows for the expression in the box over the objects it has read: the results of a search of that
// expression over that read (or why the expression could not be read, a read that listed nothing too), else that it is
// searching — the results of the expression before do not stand for it.
export function searchShown(searched: Searched | null, query: string, read: { items: unknown[] } | undefined): Shown {
  if (!query.trim() || !read) return { state: 'idle' }
  const current = searched && searched.query === query && searched.over === read ? searched : null
  if (current?.unreadable !== undefined) return { state: 'unreadable', reason: current.unreadable }
  if (read.items.length === 0) return { state: 'idle' }
  if (current) return { state: 'done', results: current.results, timeMs: current.timeMs }
  return { state: 'searching' }
}

// What the floating chat is told: the results with the expression, namespace and resource types they answer, and, while
// a search of the expression in the box over the objects read now has not finished, what is being searched; nothing
// once the box is emptied. The types the read behind the numbers failed or cut ("N failed", "the first N only" in the
// toolbar) go with them, so a count over part of the objects is not told as complete. An expression that could not be
// read is told with the reason and no count, over a read that listed nothing too, and with what that read left out; an
// earlier one that could not be read gives no results to tell beside a new one.
export function searchLayer(searched: Searched | null, typed: string, now: { namespace: string; types: string[]; read: ({ items: unknown[] } & Partial<SearchRead>) | undefined }) {
  if (!typed.trim()) return null
  const asked = { query: typed, namespace: now.namespace || undefined, selected_resource_types: now.types }
  const current = !!searched && searched.query === typed && searched.over === now.read
  if (searched && current && searched.unreadable !== undefined) {
    return {
      source: 'base' as const,
      summary: `고급 검색 — 쿼리: "${typed}" 식을 읽지 못했습니다: ${searched.unreadable}${searchReadGapsText(now.read)}`,
      data: { ...asked, expression_unreadable: searched.unreadable, ...searchReadGaps(now.read) },
    }
  }
  // the read listed nothing: there is nothing to search, and no earlier result stands for it
  if (now.read && now.read.items.length === 0) {
    return {
      source: 'base' as const,
      summary: `고급 검색 0건 — 쿼리: "${typed}"${searchReadGapsText(now.read)}`,
      data: { ...asked, total: 0, by_kind: {}, ...searchReadGaps(now.read), top_results: [] },
    }
  }
  if (!searched || searched.unreadable !== undefined) {
    return { source: 'base' as const, summary: `고급 검색 — 쿼리: "${typed}" 검색 중${searchReadGapsText(now.read)}`, data: { ...asked, searching: true, ...searchReadGaps(now.read) } }
  }
  const { results } = searched
  const over = searched.over as Partial<SearchRead> | undefined
  const byKind: Record<string, number> = {}
  for (const r of results) byKind[r.kind] = (byKind[r.kind] ?? 0) + 1
  return {
    source: 'base' as const,
    summary: `고급 검색 ${results.length}건 — 쿼리: "${searched.query}"${searched.namespace ? ` · namespace=${searched.namespace}` : ''}${searchReadGapsText(over)}${
      current ? '' : ` · 검색 중: "${typed}"${now.namespace ? ` · namespace=${now.namespace}` : ''}`
    }`,
    data: {
      query: searched.query,
      namespace: searched.namespace || undefined,
      selected_resource_types: searched.types,
      total: results.length,
      by_kind: byKind,
      // the toolbar's "N failed" and "the first N only" of the read these results went over
      ...searchReadGaps(over),
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
