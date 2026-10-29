import { useEffect, useMemo, useRef, useState, useCallback } from 'react'
import { keepPreviousData, useQuery, useQueryClient } from '@tanstack/react-query'
import { useTranslation } from 'react-i18next'
import { api, type PodListRow, type PodPage, type PodPageParams } from '@/services/api'
import { useResourceDetail } from '@/components/ResourceDetailContext'
import ResourceYamlCreateDialog from '@/components/ResourceYamlCreateDialog'
import { useAdaptiveTable } from '@/hooks/useAdaptiveTable'
import { useAIContext } from '@/hooks/useAIContext'
import { usePermission } from '@/hooks/usePermission'
import { summarizeList } from '@/utils/aiContext/summarizeList'
import { buildResourceLink } from '@/utils/resourceLink'
import { Plus, RefreshCw } from 'lucide-react'
import { type SortKey, type SummaryCard } from './pods/podHelpers'
import { PodFilters } from './pods/PodFilters'
import { PodTable } from './pods/PodTable'
import { useNamespaceParam } from '@/hooks/useNamespaceParam'

const PAGE_BLOCK = 50

export default function Pods() {
  const queryClient = useQueryClient()
  const { t } = useTranslation()
  const tr = useCallback((key: string, fallback: string, options?: Record<string, any>) => t(key, { defaultValue: fallback, ...options }), [t])
  const { open: openDetail } = useResourceDetail()

  const [searchQuery, setSearchQuery] = useState('')
  const [selectedNamespace, setSelectedNamespace] = useNamespaceParam()
  const [isRefreshing, setIsRefreshing] = useState(false)
  const [sortKey, setSortKey] = useState<SortKey>(null)
  const [sortDir, setSortDir] = useState<'asc' | 'desc'>('asc')
  const [currentPage, setCurrentPage] = useState(1)
  const [totalRows, setTotalRows] = useState(0)
  const [createDialogOpen, setCreateDialogOpen] = useState(false)

  const { data: namespaces } = useQuery({
    queryKey: ['namespaces'],
    queryFn: () => api.getNamespaces(),
    staleTime: 30000,
  })

  const { has } = usePermission()
  const canCreate = has('resource.pod.create')

  // The server filters, sorts, counts and pages (k8s-service pods_page.go): a large
  // cluster's pods never come to the browser whole. The search goes out after a pause.
  const [search, setSearch] = useState('')
  useEffect(() => {
    const id = setTimeout(() => setSearch(searchQuery.trim()), 250)
    return () => clearTimeout(id)
  }, [searchQuery])

  const { containerRef: tableContainerRef, bodyRef: tableBodyRef, theadRef, firstRowRef, rowsPerPage } = useAdaptiveTable({
    recalculationKey: totalRows,
  })

  // Rows are asked in blocks of PAGE_BLOCK, so the Fit row count settling while the
  // cards appear does not ask again; the page is cut from the block.
  const firstRow = (currentPage - 1) * rowsPerPage
  const blockStart = Math.floor(firstRow / PAGE_BLOCK) * PAGE_BLOCK
  const blockLimit = Math.min(500, Math.ceil((firstRow + rowsPerPage - blockStart) / PAGE_BLOCK) * PAGE_BLOCK)
  const pageParams = useMemo<PodPageParams>(() => ({
    namespace: selectedNamespace === 'all' ? undefined : selectedNamespace,
    q: search || undefined,
    sort: sortKey ?? undefined,
    dir: sortKey ? sortDir : undefined,
    offset: blockStart,
    limit: blockLimit,
  }), [selectedNamespace, search, sortKey, sortDir, blockStart, blockLimit])
  const pageKey = useMemo(() => ['workloads', 'pods-page', pageParams], [pageParams])

  // A poll sends the revision it has; while nothing a row shows changed the server
  // answers "unchanged" and the page keeps what it has.
  const { data: page, isLoading: isLoadingPods } = useQuery({
    queryKey: pageKey,
    queryFn: async () => {
      const prev = queryClient.getQueryData<PodPage>(pageKey)
      const next = await api.getPodPage({ ...pageParams, revision: prev?.revision || undefined })
      return next.unchanged && prev ? prev : next
    },
    placeholderData: keepPreviousData,
    // listed rows (no revision) cost the cluster a list: ask less often
    refetchInterval: (query) => {
      const d = query.state.data
      if (!d) return false
      if (!d.revision) return 30000
      return d.stats.total > 10000 ? 10000 : 3000
    },
  })
  useEffect(() => {
    if (page && page.total !== totalRows) setTotalRows(page.total)
  }, [page, totalRows])

  // An open Pod drawer follows the list: when a row changed, its describe is read again.
  const lastRevision = useRef('')
  useEffect(() => {
    const rev = page?.revision ?? ''
    if (rev && lastRevision.current && rev !== lastRevision.current) {
      queryClient.invalidateQueries({ queryKey: ['pod-describe'] })
    }
    lastRevision.current = rev
  }, [page?.revision, queryClient])

  const podStats = useMemo(() => {
    const st = page?.stats
    return {
      total: st?.total ?? 0,
      ready: st?.ready ?? 0,
      notReady: st?.not_ready ?? 0,
      pending: st?.pending ?? 0,
      error: st?.error ?? 0,
      restarted: st?.restarted ?? 0,
      completed: st?.completed ?? 0,
      topReasons: (st?.top_reasons ?? []).map((r) => [r.reason, r.count] as [string, number]),
    }
  }, [page?.stats])

  const summaryCards = useMemo<SummaryCard[]>(
    () => [
      [tr('pods.stats.total', 'Total'), podStats.total, 'border-slate-700 bg-slate-900/50', 'text-slate-400'],
      [tr('pods.stats.ready', 'Ready'), podStats.ready, 'border-emerald-700/40 bg-emerald-900/10', 'text-emerald-300'],
      [tr('pods.stats.notReady', 'Not Ready'), podStats.notReady, 'border-amber-700/40 bg-amber-900/10', 'text-amber-300'],
      [tr('pods.stats.pending', 'Pending'), podStats.pending, 'border-yellow-700/40 bg-yellow-900/10', 'text-yellow-300'],
      [tr('pods.stats.error', 'Error'), podStats.error, 'border-rose-700/40 bg-rose-900/10', 'text-rose-300'],
      [tr('pods.stats.restarted', 'Restarted'), podStats.restarted, 'border-slate-700 bg-slate-900/50', 'text-slate-400'],
      [tr('pods.stats.completed', 'Completed'), podStats.completed, 'border-slate-600/50 bg-slate-800/30', 'text-slate-300'],
    ],
    [podStats.completed, podStats.error, podStats.notReady, podStats.pending, podStats.ready, podStats.restarted, podStats.total, tr],
  )

  const createPodYamlTemplate = useMemo(() => {
    const ns = selectedNamespace !== 'all' ? selectedNamespace : 'default'
    return `apiVersion: v1
kind: Pod
metadata:
  name: sample-pod
  namespace: ${ns}
  labels:
    app: sample
spec:
  containers:
    - name: sample
      image: nginx:stable
      ports:
        - containerPort: 80
`
  }, [selectedNamespace])

  const totalPages = Math.max(1, Math.ceil(totalRows / rowsPerPage))

  useEffect(() => {
    setCurrentPage(1)
  }, [searchQuery, selectedNamespace])

  useEffect(() => {
    if (currentPage > totalPages) {
      setCurrentPage(totalPages)
    }
  }, [currentPage, totalPages])

  const pagedPods = useMemo<PodListRow[]>(
    () => (page?.items ?? []).slice(firstRow - blockStart, firstRow - blockStart + rowsPerPage),
    [page?.items, firstRow, blockStart, rowsPerPage],
  )

  // 플로팅 AI 위젯용 스냅샷 — Pod 목록 요약 + 문제 항목 + interpretations
  const aiSnapshot = useMemo(() => {
    if (!page) return null
    const nsLabel = selectedNamespace === 'all' ? '전체 네임스페이스' : selectedNamespace
    const alertParts: string[] = []
    if (podStats.error > 0) alertParts.push(`오류 ${podStats.error}`)
    if (podStats.notReady > 0) alertParts.push(`Not Ready ${podStats.notReady}`)
    if (podStats.pending > 0) alertParts.push(`Pending ${podStats.pending}`)
    const prefix = podStats.error > 0 ? '⚠️ ' : ''
    const alert = alertParts.length ? `, ${alertParts.join(', ')}` : ''
    const summary = `${prefix}${nsLabel} Pod ${podStats.total}개 (Ready ${podStats.ready}${alert})`

    const problematic = (p: PodListRow) => {
      if (p.phase && p.phase !== 'Running') return true
      if ((p.restart_count ?? 0) > 5) return true
      return /error|crashloop|oomkilled|errimagepull|backoff/i.test(p.status)
    }

    return {
      source: 'base' as const,
      summary,
      data: {
        filters: {
          namespace: selectedNamespace,
          search: searchQuery || undefined,
        },
        stats: {
          total: podStats.total,
          ready: podStats.ready,
          not_ready: podStats.notReady,
          pending: podStats.pending,
          error: podStats.error,
          restarted: podStats.restarted,
          top_reasons: podStats.topReasons.map(([reason, count]) => ({ reason, count })),
        },
        ...summarizeList(pagedPods as unknown as Record<string, unknown>[], {
          total: totalRows,
          currentPage,
          pageSize: rowsPerPage,
          topN: rowsPerPage,
          pickFields: ['name', 'namespace', 'phase', 'status', 'ready', 'restart_count', 'node_name'],
          filterProblematic: (p) => problematic(p as unknown as PodListRow),
          interpret: (items) => {
            const out: string[] = []
            const podsArr = items as unknown as PodListRow[]
            const crashLoop = podsArr.filter((p) => /crashloop/i.test(p.status)).length
            if (crashLoop > 0) out.push(`⚠️ ${crashLoop}개 Pod 이 CrashLoopBackOff 상태`)
            const oom = podsArr.filter((p) => /oomkilled/i.test(p.status)).length
            if (oom > 0) out.push(`⚠️ ${oom}개 Pod 이 OOMKilled`)
            const highRestart = podsArr.filter((p) => (p.restart_count ?? 0) > 5).length
            if (highRestart > 0) out.push(`⚠️ ${highRestart}개 Pod 의 재시작 횟수 5회 초과`)
            return out
          },
          linkBuilder: (p) => {
            const pod = p as unknown as PodListRow
            return buildResourceLink('Pod', pod.namespace, pod.name)
          },
        }),
      },
    }
  }, [page, pagedPods, totalRows, currentPage, rowsPerPage, selectedNamespace, searchQuery, podStats])

  useAIContext(aiSnapshot, [aiSnapshot])

  const handleRefresh = async () => {
    if (isRefreshing) return
    setIsRefreshing(true)
    try {
      // no revision: the page comes whole whatever changed
      queryClient.setQueryData(pageKey, await api.getPodPage(pageParams))
    } catch (error) {
      console.error('Pods refresh failed:', error)
    }
    setTimeout(() => setIsRefreshing(false), 500)
  }

  const showNamespaceColumn = selectedNamespace === 'all'

  return (
    <div className="flex flex-col h-[calc(100vh-4rem)] gap-4">
      <div className="flex items-center justify-between shrink-0">
        <div>
          <h1 className="text-3xl font-semibold text-ink">{tr('pods.title', 'Pods')}</h1>
          <p className="mt-2 text-slate-400">
            {tr('pods.subtitle', 'Inspect pod health and placement across namespaces.')}
          </p>
        </div>
        <div className="flex items-center gap-2">
          {canCreate && (
            <button
              type="button"
              onClick={() => setCreateDialogOpen(true)}
              className="btn btn-primary flex items-center gap-2"
            >
              <Plus className="w-4 h-4" />
              {tr('pods.create', 'Create Pod')}
            </button>
          )}
          <button
            onClick={handleRefresh}
            disabled={isRefreshing}
            title={tr('pods.forceRefreshTitle', 'Force refresh')}
            className="btn btn-primary flex items-center gap-2 disabled:opacity-50 disabled:cursor-not-allowed"
          >
            <RefreshCw className={`w-4 h-4 ${isRefreshing ? 'animate-spin' : ''}`} />
            {tr('pods.refresh', 'Refresh')}
          </button>
        </div>
      </div>

      <PodFilters
        searchQuery={searchQuery}
        setSearchQuery={setSearchQuery}
        selectedNamespace={selectedNamespace}
        setSelectedNamespace={setSelectedNamespace}
        namespaces={namespaces}
        searchPlaceholder={tr('pods.searchPlaceholder', 'Search pods by name...')}
        allNamespacesLabel={tr('pods.allNamespaces', 'All namespaces')}
      />

      {search && (
        <p className="text-sm text-slate-400 shrink-0">
          {tr('pods.matchCount', '{{count}} pod{{suffix}} match.', {
            count: totalRows,
            suffix: totalRows === 1 ? '' : 's',
          })}
        </p>
      )}

      <div className="grid grid-cols-2 md:grid-cols-4 xl:grid-cols-7 gap-3 shrink-0">
        {summaryCards.map(([label, value, boxClass, labelColor]) => (
          <div key={label} className={`rounded-lg border px-3 py-2.5 ${boxClass}`}>
            <div className={`text-[11px] sm:text-xs leading-4 whitespace-nowrap ${labelColor}`}>{label}</div>
            <div className="mt-1 text-lg font-semibold text-ink">{value}</div>
          </div>
        ))}
      </div>

      {podStats.topReasons.length > 0 && (
        <div className="rounded-lg border border-slate-700 bg-slate-900/40 p-3 shrink-0">
          <div className="text-xs text-slate-400 mb-2">{tr('pods.topStatusReasons', 'Top status reasons')}</div>
          <div className="flex flex-wrap gap-2">
            {podStats.topReasons.map(([reason, count]) => (
              <span key={reason} className="badge badge-info font-mono">
                {reason}: {count}
              </span>
            ))}
          </div>
        </div>
      )}

      <PodTable
        pagedPods={pagedPods}
        sortedPodsLength={totalRows}
        isLoadingPods={isLoadingPods}
        showNamespaceColumn={showNamespaceColumn}
        sortKey={sortKey}
        setSortKey={setSortKey}
        sortDir={sortDir}
        setSortDir={setSortDir}
        currentPage={currentPage}
        setCurrentPage={setCurrentPage}
        searching={!!search}
        totalPages={totalPages}
        rowsPerPage={rowsPerPage}
        tableContainerRef={tableContainerRef}
        tableBodyRef={tableBodyRef}
        theadRef={theadRef}
        firstRowRef={firstRowRef}
        openDetail={openDetail}
        tr={tr}
      />

      {createDialogOpen && (
        <ResourceYamlCreateDialog
          title={tr('pods.createTitle', 'Create Pod from YAML')}
          initialYaml={createPodYamlTemplate}
          namespace={selectedNamespace !== 'all' ? selectedNamespace : undefined}
          onClose={() => setCreateDialogOpen(false)}
          onCreated={() => {
            queryClient.invalidateQueries({ queryKey: ['workloads', 'pods-page'] })
          }}
        />
      )}
    </div>
  )
}
