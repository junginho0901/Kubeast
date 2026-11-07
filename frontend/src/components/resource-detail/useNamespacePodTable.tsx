import { useEffect, useMemo, useState, type ReactNode } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { api } from '@/services/api'
import type { PodInfo, PodListRow, PodPage } from '@/services/api'
import { podPagePollEvery } from '@/services/podPageRead'
import { LIST_GATHER_MS, useKubeWatchList } from '@/services/useKubeWatchList'
import { applyPodWatchEvent } from '@/pages/workloads/pods/podWatchNormalize'
import { Tx } from './DetailCommon'
import { drawerPodsKey, pagerNav, useServerPodPage, type ServerPodFilter } from './useServerPods'
import { PodPageNotFiltered, isClientError, podPageApplied, podTableNote, podTableReadEvery, podTableReadsPages, podTableReadsWhole, podTableShows } from './namespacePodTable'

const PAGE_SIZE = 10

export type PodTableRow = PodListRow | PodInfo

// A drawer's table of the pods that use its object: whole and live when the server's first page says they are few, else the server's pages (namespacePodTable.ts).
export function useNamespacePodTable(options: {
  enabled: boolean
  namespace: string
  // what the server keeps, the same pods as `keeps`
  filter: Omit<ServerPodFilter, 'namespace'>
  // the whole read's key, and what the table keeps of it
  queryKey: unknown[]
  keeps: (pod: PodInfo) => boolean
  // the whole read's label selector, which its watch takes too
  selector?: string
  // false: the whole read is read when the table opens and not followed
  follows?: boolean
  staleTime?: number
  // past this many pods it reads pages (POD_TABLE_WATCH_MAX when not given)
  line?: number
}): {
  items: PodTableRow[]
  total: number
  loading: boolean
  nav: ReactNode
  note: ReactNode
  // what the rows shown come from: every kept row of the whole read, or the server's page
  whole?: PodInfo[]
  page?: PodPage
} {
  const { enabled, namespace, selector, queryKey, keeps, follows = true, staleTime = 5_000, line } = options
  const client = useQueryClient()
  const bySelector = selector !== undefined
  const serverFilter: ServerPodFilter | null = enabled ? { namespace, ...options.filter } : null
  const tableKey = JSON.stringify(serverFilter)
  const [page, setPage] = useState(1)
  useEffect(() => setPage(1), [tableKey])

  // Once it reads pages it keeps to them while it shows this object.
  const [pagesFor, setPagesFor] = useState<string | null>(null)
  const firstPage = enabled ? client.getQueryData<PodPage>(drawerPodsKey(serverFilter, 1, PAGE_SIZE)) : undefined
  const heldNow = enabled ? client.getQueryData<PodInfo[]>(queryKey) : undefined
  const pagesWanted = pagesFor === tableKey || podTableReadsPages({ answered: firstPage, held: heldNow?.length }, bySelector, line)

  const pageQuery = useServerPodPage(serverFilter, pagesWanted ? page : 1, PAGE_SIZE, {
    readEvery: (data, error) => podTableReadEvery(pagesWanted, data, error),
    retry: (failures, error) => !isClientError(error) && !(error instanceof PodPageNotFiltered) && failures < 1,
    check: (answer) => {
      if (!podPageApplied(serverFilter ?? {}, answer)) throw new PodPageNotFiltered()
    },
  })
  // A server that did not apply the condition is read the old way, whole and live.
  const notFiltered = pageQuery.error instanceof PodPageNotFiltered
  const pages = pagesWanted && !notFiltered
  useEffect(() => {
    if (pages && pagesFor !== tableKey) setPagesFor(tableKey)
  }, [pages, pagesFor, tableKey])
  const pageRows = notFiltered ? undefined : pageQuery.data
  const answered = pageRows !== undefined && !pageQuery.isPlaceholderData
  const refused = pageQuery.data === undefined && isClientError(pageQuery.error)
  const readsWhole = enabled && podTableReadsWhole(pages, answered, refused || notFiltered)

  const whole = useQuery({
    queryKey,
    queryFn: () => (selector === undefined ? api.getPods(namespace) : api.getPods(namespace, selector)),
    enabled: readsWhole,
    staleTime,
  })
  useKubeWatchList({
    enabled: readsWhole && follows,
    queryKey,
    path: `/api/v1/namespaces/${namespace}/pods`,
    query: selector === undefined ? 'watch=1' : `watch=1&labelSelector=${encodeURIComponent(selector)}`,
    applyEvent: (prev, event) => applyPodWatchEvent(prev as PodInfo[] | undefined, event),
    gatherEveryMs: LIST_GATHER_MS,
  })

  // Past the line while open: the page on hand is older than the rows, so it is read now.
  const crossed = pages && whole.data !== undefined && pageQuery.dataUpdatedAt < whole.dataUpdatedAt
  const { refetch } = pageQuery
  useEffect(() => {
    if (crossed) void refetch({ cancelRefetch: false })
  }, [crossed, refetch])

  const shows = podTableShows({ pages, held: whole.data !== undefined, answered, pageAt: pageQuery.dataUpdatedAt, heldAt: whole.dataUpdatedAt })
  const wholeRows = whole.data
  const kept = useMemo(() => (shows === 'whole' ? (wholeRows ?? []).filter(keeps) : undefined), [shows, wholeRows, keeps])
  const total = kept ? kept.length : (pageRows?.total ?? 0)
  const items: PodTableRow[] = kept ? kept.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE) : (pageRows?.items ?? [])
  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE))
  useEffect(() => {
    if (page > totalPages) setPage(totalPages)
  }, [page, totalPages])

  const every = pages && pageRows ? podPagePollEvery(pageRows) : false
  const noteText = podTableNote(options.filter.owner, bySelector)
  const note = every ? (
    <p className="mb-2 text-[11px] text-slate-400" data-testid="drawer-pods-read-every">
      <Tx text={noteText.text} values={{ ...noteText.values, seconds: every / 1000 }} />
    </p>
  ) : null
  // with no page rows to show: waiting for the page, or for the whole read when that is the way
  const loading = enabled && whole.data === undefined && pageRows === undefined && (readsWhole ? !whole.isError : !pageQuery.isError)
  return { items, total, loading, nav: pagerNav(page, PAGE_SIZE, total, setPage), note, whole: kept, page: kept ? undefined : pageRows }
}
