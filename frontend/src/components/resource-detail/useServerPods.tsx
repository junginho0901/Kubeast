import { useEffect, useState } from 'react'
import type { ReactNode } from 'react'
import { keepPreviousData, useQuery, useQueryClient } from '@tanstack/react-query'
import type { PodListRow, PodPage, PodPageParams } from '@/services/api'
import { readPodPageSince } from '@/services/podPageRead'
import { Tx } from './DetailCommon'

export type ServerPodFilter = Omit<PodPageParams, 'offset' | 'limit'>

export const drawerPodsKey = (filter: ServerPodFilter | null, page: number, pageSize: number) => ['drawer-pods', JSON.stringify(filter), page, pageSize]

// A drawer's pod list from the Pods page's server page (filtered on the server, a page at a time), with the same
// pager as usePagination — so a drawer does not take every pod of the cluster to show the few that match.
// `null` filter: nothing to ask yet.
export function useServerPods(filter: ServerPodFilter | null, pageSize = 10): {
  items: PodListRow[]
  total: number
  isLoading: boolean
  nav: ReactNode
} {
  const [page, setPage] = useState(1)
  const key = JSON.stringify(filter)
  useEffect(() => setPage(1), [key])
  const query = useServerPodPage(filter, page, pageSize)
  const total = query.data?.total ?? 0
  const totalPages = Math.max(1, Math.ceil(total / pageSize))
  useEffect(() => {
    if (page > totalPages) setPage(totalPages)
  }, [page, totalPages])
  return { items: query.data?.items ?? [], total, isLoading: query.isLoading, nav: pagerNav(page, pageSize, total, setPage) }
}

// One page of a drawer's pods; `readEvery` reads it again with the revision it holds, `retry` says whether a failure is asked again at once, `check` throws on an answer the caller cannot take.
export function useServerPodPage(
  filter: ServerPodFilter | null,
  page: number,
  pageSize: number,
  options: {
    readEvery?: (data: PodPage | undefined, error: unknown) => number | false
    retry?: (failures: number, error: unknown) => boolean
    check?: (answer: PodPage) => void
  } = {},
) {
  const client = useQueryClient()
  const queryKey = drawerPodsKey(filter, page, pageSize)
  const { readEvery, retry, check } = options
  return useQuery({
    queryKey,
    queryFn: async () => {
      const answer = await readPodPageSince(client, queryKey, { ...filter!, offset: (page - 1) * pageSize, limit: pageSize })
      check?.(answer)
      return answer
    },
    enabled: filter !== null,
    staleTime: 30_000,
    placeholderData: keepPreviousData,
    refetchInterval: readEvery ? (query) => readEvery(query.state.data, query.state.error) : undefined,
    ...(retry ? { retry } : {}),
  })
}

// The pager of a drawer's table, as usePagination draws it: nothing while the rows fit one page.
export function pagerNav(page: number, pageSize: number, total: number, setPage: (next: (page: number) => number) => void): ReactNode {
  if (total <= pageSize) return null
  const totalPages = Math.max(1, Math.ceil(total / pageSize))
  const start = (page - 1) * pageSize + 1
  const end = Math.min(page * pageSize, total)
  return (
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
}
