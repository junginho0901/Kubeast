import { useEffect, useState } from 'react'
import type { ReactNode } from 'react'
import { keepPreviousData, useQuery } from '@tanstack/react-query'
import { api, type PodListRow, type PodPageParams } from '@/services/api'
import { Tx } from './DetailCommon'

// A drawer's pod list from the Pods page's server page (filtered on the server, a page at a time), with the same
// pager as usePagination — so a drawer does not take every pod of the cluster to show the few that match.
// `null` filter: nothing to ask yet.
export function useServerPods(filter: Omit<PodPageParams, 'offset' | 'limit'> | null, pageSize = 10): {
  items: PodListRow[]
  total: number
  isLoading: boolean
  nav: ReactNode
} {
  const [page, setPage] = useState(1)
  const key = JSON.stringify(filter)
  useEffect(() => setPage(1), [key])
  const query = useQuery({
    queryKey: ['drawer-pods', key, page, pageSize],
    queryFn: () => api.getPodPage({ ...filter!, offset: (page - 1) * pageSize, limit: pageSize }),
    enabled: filter !== null,
    staleTime: 30_000,
    placeholderData: keepPreviousData,
  })
  const total = query.data?.total ?? 0
  const totalPages = Math.max(1, Math.ceil(total / pageSize))
  useEffect(() => {
    if (page > totalPages) setPage(totalPages)
  }, [page, totalPages])

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
  return { items: query.data?.items ?? [], total, isLoading: query.isLoading, nav }
}
