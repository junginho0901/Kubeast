import { useEffect, useMemo, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { useTranslation } from 'react-i18next'
import { Loader2, RefreshCw } from 'lucide-react'
import { api, type HelmReleaseSummary } from '@/services/api'
import { useAdaptiveTable } from '@/hooks/useAdaptiveTable'
import { useHelmWatchList } from '@/services/useHelmWatchList'
import { useCluster } from '@/contexts/ClusterContext'
import {
  sortReleases,
  type SortKey,
  type SortDir,
  type SummaryCard,
} from './releases/releaseHelpers'
import { useReleasesAISnapshot } from './releases/useReleasesAISnapshot'
import ReleaseFilters from './releases/ReleaseFilters'
import ReleaseTable from './releases/ReleaseTable'

export default function HelmReleasesPage() {
  const { t } = useTranslation()
  const { currentCluster } = useCluster()
  const cluster = currentCluster || 'default'
  const [namespace, setNamespace] = useState<string>('')
  const [q, setQ] = useState<string>('')
  const [sortKey, setSortKey] = useState<SortKey>(null)
  const [sortDir, setSortDir] = useState<SortDir>('asc')
  const [currentPage, setCurrentPage] = useState(1)

  // Initial REST fetch primes the cache; the watch below keeps it fresh
  // event-by-event, so refetchInterval is gone and staleTime is Infinity.
  // refetch() (used by the manual "Refresh" button) still does a full
  // list which is useful as a recovery hatch if the WS ever desyncs.
  // Cluster is part of the key so a switch is a distinct query (no cross-cluster
  // bleed) and the watch below writes events into the right cluster's cache.
  const queryKey = useMemo(
    () => ['helm-releases', cluster, namespace] as const,
    [cluster, namespace],
  )

  const { data, isLoading, isFetching, refetch } = useQuery({
    queryKey,
    queryFn: () => api.helm.listReleases(namespace ? { namespace } : undefined),
    // keepPreviousData for smooth namespace-filter changes, but only within the
    // same cluster so a switch never lingers on the prior cluster's releases.
    placeholderData: (prev, prevQuery) =>
      prevQuery && prevQuery.queryKey[1] === cluster ? prev : undefined,
    staleTime: Infinity,
  })

  useHelmWatchList({
    cluster,
    namespace: namespace || undefined,
    enabled: !isLoading,
    queryKey,
  })

  const items: HelmReleaseSummary[] = data ?? []

  // Client-side name filtering only — the server already narrows by
  // namespace which is the big cardinality reducer. Keeping the text
  // filter local means typing does not thrash the API.
  const filtered = useMemo(() => {
    if (!q.trim()) return items
    const needle = q.trim().toLowerCase()
    return items.filter(
      (r) =>
        r.name.toLowerCase().includes(needle) ||
        r.chart.toLowerCase().includes(needle),
    )
  }, [items, q])

  // Stats count across *unfiltered* items so the header numbers stay
  // stable while the user narrows the table with the search box.
  const stats = useMemo(() => {
    let total = 0
    let deployed = 0
    let failed = 0
    let pending = 0
    let superseded = 0
    for (const r of items) {
      total += 1
      const s = r.status.toLowerCase()
      if (s === 'deployed') deployed += 1
      else if (s === 'failed') failed += 1
      else if (s.startsWith('pending')) pending += 1
      else if (s === 'superseded') superseded += 1
    }
    return { total, deployed, failed, pending, superseded }
  }, [items])

  const summaryCards = useMemo<SummaryCard[]>(
    () => [
      [t('helmReleases.stats.total'), stats.total, 'border-slate-700 bg-slate-900/50', 'text-slate-400'],
      [t('helmReleases.stats.deployed'), stats.deployed, 'border-emerald-700/40 bg-emerald-900/10', 'text-emerald-300'],
      [t('helmReleases.stats.failed'), stats.failed, 'border-rose-700/40 bg-rose-900/10', 'text-rose-300'],
      [t('helmReleases.stats.pending'), stats.pending, 'border-amber-700/40 bg-amber-900/10', 'text-amber-300'],
      [t('helmReleases.stats.superseded'), stats.superseded, 'border-slate-700 bg-slate-900/50', 'text-slate-400'],
    ],
    [stats, t],
  )

  // Derive namespace dropdown from the release list itself — no need
  // for a separate /namespaces call, and it keeps the selector in sync
  // with what the user can actually pick.
  const namespaces = useMemo(() => {
    const set = new Set<string>()
    for (const r of items) set.add(r.namespace)
    return Array.from(set).sort()
  }, [items])

  const handleSort = (key: NonNullable<SortKey>) => {
    if (sortKey !== key) {
      setSortKey(key)
      setSortDir('asc')
      return
    }
    if (sortDir === 'asc') {
      setSortDir('desc')
      return
    }
    // Third click on same column clears the sort — returns natural order.
    setSortKey(null)
  }

  const sorted = useMemo(
    () => sortReleases(filtered, sortKey, sortDir),
    [filtered, sortKey, sortDir],
  )

  const { containerRef: tableContainerRef, bodyRef: tableBodyRef, theadRef, firstRowRef, rowsPerPage } = useAdaptiveTable({
    recalculationKey: sorted.length,
  })
  const totalPages = Math.max(1, Math.ceil(sorted.length / rowsPerPage))

  // Reset to page 1 when filters change so the user isn't stranded on
  // an out-of-range page after the result set shrinks.
  useEffect(() => {
    setCurrentPage(1)
  }, [q, namespace])

  useEffect(() => {
    if (currentPage > totalPages) setCurrentPage(totalPages)
  }, [currentPage, totalPages])

  const paged = useMemo(() => {
    const start = (currentPage - 1) * rowsPerPage
    return sorted.slice(start, start + rowsPerPage)
  }, [sorted, currentPage, rowsPerPage])

  useReleasesAISnapshot({
    items,
    paged,
    sortedCount: sorted.length,
    currentPage,
    rowsPerPage,
    namespace,
    searchQuery: q,
  })

  return (
    <div className="flex flex-col h-[calc(100vh-4rem)] gap-4">
      <div className="flex items-center justify-between shrink-0">
        <div>
          <h1 className="text-3xl font-bold text-white">{t('helmReleases.title')}</h1>
          <p className="mt-2 text-slate-400">{t('helmReleases.subtitle')}</p>
        </div>
        <button
          onClick={() => refetch()}
          disabled={isFetching}
          className="btn btn-primary flex items-center gap-2 disabled:opacity-50 disabled:cursor-not-allowed"
        >
          <RefreshCw className={`w-4 h-4 ${isFetching ? 'animate-spin' : ''}`} />
          {t('helmReleases.refresh')}
        </button>
      </div>

      <ReleaseFilters
        searchQuery={q}
        onSearchChange={setQ}
        namespace={namespace}
        onNamespaceChange={setNamespace}
        namespaces={namespaces}
      />

      {/* Stats row — counts come from full items, not filtered, so the
          header numbers stay stable when the search input narrows the
          table. */}
      <div className="grid grid-cols-2 md:grid-cols-5 gap-3 shrink-0">
        {summaryCards.map(([label, value, boxClass, labelColor]) => (
          <div key={label} className={`rounded-lg border px-3 py-2.5 ${boxClass}`}>
            <div className={`text-[11px] sm:text-xs leading-4 whitespace-nowrap ${labelColor}`}>{label}</div>
            <div className="mt-1 text-lg font-semibold text-white">{value}</div>
          </div>
        ))}
      </div>

      {isLoading ? (
        <div className="flex items-center justify-center py-16 text-slate-400 flex-1">
          <Loader2 className="w-5 h-5 animate-spin" />
        </div>
      ) : (
        <ReleaseTable
          paged={paged}
          sortedCount={sorted.length}
          sortKey={sortKey}
          sortDir={sortDir}
          onSort={handleSort}
          currentPage={currentPage}
          totalPages={totalPages}
          rowsPerPage={rowsPerPage}
          onPageChange={setCurrentPage}
          tableContainerRef={tableContainerRef}
          tableBodyRef={tableBodyRef}
          theadRef={theadRef}
          firstRowRef={firstRowRef}
        />
      )}
    </div>
  )
}
