import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { RefreshCw, Search, BarChart3 } from 'lucide-react'
import { useGPUNodesData } from './gpu-nodes/useGPUNodesData'
import type { SortKey } from './gpu-nodes/gpuNodesHelpers'
import GPUNodesModelDistribution from './gpu-nodes/GPUNodesModelDistribution'
import GPUNodesRealtimeMetrics from './gpu-nodes/GPUNodesRealtimeMetrics'
import GPUNodesTable from './gpu-nodes/GPUNodesTable'

export default function GPUNodes() {
  const { t } = useTranslation()
  const tr = (key: string, fallback: string, options?: Record<string, any>) =>
    t(key, { defaultValue: fallback, ...options })

  const [searchQuery, setSearchQuery] = useState('')
  const [sortKey, setSortKey] = useState<SortKey>(null)
  const [sortDir, setSortDir] = useState<'asc' | 'desc'>('asc')
  const [currentPage, setCurrentPage] = useState(1)
  const [showCharts, setShowCharts] = useState(false)

  const {
    isLoading,
    isRefreshing,
    handleRefresh,
    metricsAvailable,
    gpusByHost,
    summaryCards,
    modelDistribution,
    sortedNodes,
    pagedNodes,
    rowsPerPage,
    totalPages,
    tableContainerRef,
    tableBodyRef,
    theadRef,
    firstRowRef,
  } = useGPUNodesData({ searchQuery, sortKey, sortDir, currentPage })

  useEffect(() => {
    setCurrentPage(1)
  }, [searchQuery])

  useEffect(() => {
    if (currentPage > totalPages) setCurrentPage(totalPages)
  }, [currentPage, totalPages])

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
    setSortKey(null)
  }

  return (
    <div className={`flex flex-col gap-4 ${showCharts ? 'min-h-[calc(100vh-4rem)] overflow-y-auto' : 'h-[calc(100vh-4rem)]'}`}>
      {/* Header */}
      <div className="flex items-center justify-between shrink-0">
        <div>
          <h1 className="text-3xl font-bold text-white">{tr('gpuNodes.title', 'GPU Nodes')}</h1>
          <p className="mt-2 text-slate-400">{tr('gpuNodes.subtitle', 'GPU node status, capacity, and model information.')}</p>
        </div>
        <div className="flex items-center gap-2">
          <button
            onClick={() => setShowCharts((prev) => !prev)}
            className={`btn flex items-center gap-2 ${showCharts ? 'btn-primary' : 'btn-secondary'}`}
          >
            <BarChart3 className="w-4 h-4" />
            {tr('gpuNodes.metrics', 'Metrics')}
          </button>
          <button
            onClick={handleRefresh}
            disabled={isRefreshing}
            className="btn btn-primary flex items-center gap-2 disabled:opacity-50 disabled:cursor-not-allowed"
          >
            <RefreshCw className={`w-4 h-4 ${isRefreshing ? 'animate-spin' : ''}`} />
            {tr('gpuNodes.refresh', 'Refresh')}
          </button>
        </div>
      </div>

      {/* Search */}
      <div className="relative shrink-0">
        <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-5 h-5 text-slate-400" />
        <input
          type="text"
          placeholder={tr('gpuNodes.searchPlaceholder', 'Search by node name, GPU model, driver version...')}
          value={searchQuery}
          onChange={(e) => setSearchQuery(e.target.value)}
          className="w-full pl-10 pr-4 py-3 bg-slate-700 border border-slate-600 rounded-lg text-white placeholder-slate-400 focus:outline-none focus:ring-2 focus:ring-primary-500 focus:border-transparent"
        />
      </div>

      {/* Summary Cards */}
      <div className="grid grid-cols-2 md:grid-cols-3 xl:grid-cols-6 gap-3 shrink-0">
        {summaryCards.map(([label, value, boxClass, labelColor]) => (
          <div key={label} className={`rounded-lg border px-3 py-2.5 ${boxClass}`}>
            <div className={`text-[11px] sm:text-xs leading-4 whitespace-nowrap ${labelColor}`}>{label}</div>
            <div className="mt-1 text-lg font-semibold text-white">{value}</div>
          </div>
        ))}
      </div>

      {showCharts && (
        <GPUNodesModelDistribution modelDistribution={modelDistribution} />
      )}

      {showCharts && metricsAvailable && (
        <GPUNodesRealtimeMetrics gpusByHost={gpusByHost} />
      )}

      <GPUNodesTable
        sortedNodes={sortedNodes}
        pagedNodes={pagedNodes}
        isLoading={isLoading}
        sortKey={sortKey}
        sortDir={sortDir}
        onSort={handleSort}
        currentPage={currentPage}
        totalPages={totalPages}
        rowsPerPage={rowsPerPage}
        setCurrentPage={setCurrentPage}
        tableContainerRef={tableContainerRef}
        tableBodyRef={tableBodyRef}
        theadRef={theadRef}
        firstRowRef={firstRowRef}
        showCharts={showCharts}
      />
    </div>
  )
}
