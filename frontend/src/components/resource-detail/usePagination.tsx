import { useEffect, useMemo, useState } from 'react'
import type { ReactNode } from 'react'
import { Tx } from './DetailCommon'

// Paginate a list inline. Returns the current page slice + a navigation node
// that hides itself when the list fits in one page. Matches NamespaceInfo's
// existing pager UX so all detail-modal inner tables look consistent.
export function usePagination<T>(items: T[], pageSize = 10): {
  items: T[]
  page: number
  totalPages: number
  total: number
  nav: ReactNode
} {
  const [page, setPage] = useState(1)
  const total = Array.isArray(items) ? items.length : 0
  const totalPages = Math.max(1, Math.ceil(total / pageSize))

  useEffect(() => {
    if (page > totalPages) setPage(totalPages)
  }, [page, totalPages])

  const paged = useMemo(() => {
    if (!Array.isArray(items)) return [] as T[]
    const start = (page - 1) * pageSize
    return items.slice(start, start + pageSize)
  }, [items, page, pageSize])

  const start = total === 0 ? 0 : (page - 1) * pageSize + 1
  const end = Math.min(page * pageSize, total)
  const nav = total <= pageSize ? null : (
    <div className="flex items-center justify-between text-[11px] text-slate-400 pt-1 border-t border-slate-800 mt-2">
      <span>{start}-{end} / {total}</span>
      <div className="flex gap-1">
        <button
          type="button"
          onClick={() => setPage((p) => Math.max(1, p - 1))}
          disabled={page <= 1}
          className="px-2 py-0.5 rounded-sm border border-slate-700 disabled:opacity-40"
        >
          <Tx>Prev</Tx></button>
        <button
          type="button"
          onClick={() => setPage((p) => Math.min(totalPages, p + 1))}
          disabled={page >= totalPages}
          className="px-2 py-0.5 rounded-sm border border-slate-700 disabled:opacity-40"
        >
          <Tx>Next</Tx></button>
      </div>
    </div>
  )

  return { items: paged, page, totalPages, total, nav }
}
