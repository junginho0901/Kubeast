import { useEffect, useMemo, useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { useTranslation } from 'react-i18next'
import { api } from '@/services/api'
import { useKubeWatchList } from '@/services/useKubeWatchList'
import { Plus, RefreshCw, Search } from 'lucide-react'
import { useResourceDetail } from '@/components/ResourceDetailContext'
import { useAdaptiveTable } from '@/hooks/useAdaptiveTable'
import { usePermission } from '@/hooks/usePermission'
import ResourceYamlCreateDialog from '@/components/ResourceYamlCreateDialog'
import {
  nodeYamlTemplate,
  sortNodes,
  type NodeInfo,
  type NodeMetric,
  type SortKey,
  type SortDir,
} from './cluster-nodes/clusterNodeHelpers'
import { useClusterNodesAISnapshot } from './cluster-nodes/useClusterNodesAISnapshot'
import NodeTopUsageCard from './cluster-nodes/NodeTopUsageCard'
import NodeTable from './cluster-nodes/NodeTable'

export default function ClusterNodes() {
  const queryClient = useQueryClient()
  const { t } = useTranslation()
  const tr = (key: string, fallback: string, options?: Record<string, any>) =>
    t(key, { defaultValue: fallback, ...options })
  const { open: openDetail } = useResourceDetail()

  const [searchQuery, setSearchQuery] = useState('')
  const [isRefreshing, setIsRefreshing] = useState(false)
  const [metricsAvailable] = useState(true)
  const [sortKey, setSortKey] = useState<SortKey>(null)
  const [sortDir, setSortDir] = useState<SortDir>('asc')
  const [currentPage, setCurrentPage] = useState(1)
  const [createDialogOpen, setCreateDialogOpen] = useState(false)

  const { data: nodes, isLoading: isLoadingNodes } = useQuery({
    queryKey: ['cluster', 'nodes'],
    queryFn: () => api.getNodes(false),
  })
  const { has } = usePermission()
  const canCreate = has('resource.node.create')

  useKubeWatchList({
    enabled: true,
    queryKey: ['cluster', 'nodes'],
    path: '/api/v1/nodes',
    query: 'watch=1',
    onEvent: (event) => {
      const name = event?.object?.name
      if (name) {
        queryClient.invalidateQueries({ queryKey: ['cluster', 'nodes', 'describe', name] })
      }
    },
  })

  const { data: metrics, isLoading: isLoadingMetrics, isError: isMetricsError } = useQuery({
    queryKey: ['cluster', 'node-metrics'],
    queryFn: () => api.getNodeMetrics(),
    enabled: metricsAvailable,
  })

  const metricsMap = useMemo(() => {
    const map = new Map<string, NodeMetric>()
    if (Array.isArray(metrics)) {
      for (const metric of metrics) {
        map.set(metric.name, metric)
      }
    }
    return map
  }, [metrics])

  const filteredNodes = useMemo(() => {
    if (!Array.isArray(nodes)) return [] as NodeInfo[]
    if (!searchQuery.trim()) return nodes as NodeInfo[]
    const q = searchQuery.toLowerCase()
    return (nodes as NodeInfo[]).filter((node) => node.name.toLowerCase().includes(q))
  }, [nodes, searchQuery])

  const handleSort = (key: NonNullable<SortKey>) => {
    if (key !== sortKey) {
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

  const sortedNodes = useMemo(
    () => sortNodes(filteredNodes, metricsMap, sortKey, sortDir),
    [filteredNodes, metricsMap, sortDir, sortKey],
  )

  const { containerRef: tableContainerRef, bodyRef: tableBodyRef, theadRef, firstRowRef, rowsPerPage } = useAdaptiveTable({
    recalculationKey: sortedNodes.length,
  })
  const totalPages = Math.max(1, Math.ceil(sortedNodes.length / rowsPerPage))

  useEffect(() => {
    setCurrentPage(1)
  }, [searchQuery])

  useEffect(() => {
    if (currentPage > totalPages) {
      setCurrentPage(totalPages)
    }
  }, [currentPage, totalPages])

  const pagedNodes = useMemo(() => {
    const start = (currentPage - 1) * rowsPerPage
    return sortedNodes.slice(start, start + rowsPerPage)
  }, [sortedNodes, currentPage, rowsPerPage])

  useClusterNodesAISnapshot({
    nodes: nodes as NodeInfo[] | undefined,
    pagedNodes,
    sortedNodesCount: sortedNodes.length,
    currentPage,
    rowsPerPage,
    searchQuery,
    metricsMap,
  })

  const handleRefresh = async () => {
    if (isRefreshing) return
    setIsRefreshing(true)
    try {
      const [nodesData, metricsData] = await Promise.all([
        api.getNodes(true),
        metricsAvailable ? api.getNodeMetrics() : Promise.resolve([]),
      ])
      queryClient.removeQueries({ queryKey: ['cluster', 'nodes'] })
      queryClient.setQueryData(['cluster', 'nodes'], nodesData)
      if (metricsAvailable) {
        queryClient.setQueryData(['cluster', 'node-metrics'], metricsData)
      }
    } catch (error) {
      console.error('Nodes refresh failed:', error)
    }
    setTimeout(() => setIsRefreshing(false), 500)
  }

  return (
    <div className="flex flex-col h-[calc(100vh-4rem)] gap-4">
      <div className="flex items-center justify-between shrink-0">
        <div>
          <h1 className="text-3xl font-bold text-white">{tr('nodes.title', 'Nodes')}</h1>
          <p className="mt-2 text-slate-400">{tr('nodes.subtitle', 'Inspect cluster node status and capacity.')}</p>
        </div>
        <div className="flex items-center gap-2">
          {canCreate && (
            <button
              type="button"
              onClick={() => setCreateDialogOpen(true)}
              className="btn btn-primary flex items-center gap-2"
            >
              <Plus className="w-4 h-4" />
              {tr('nodes.create', 'Create Node')}
            </button>
          )}
          <button
            onClick={handleRefresh}
            disabled={isRefreshing}
            title={tr('nodes.refreshTitle', 'Force refresh')}
            className="btn btn-primary flex items-center gap-2 disabled:opacity-50 disabled:cursor-not-allowed"
          >
            <RefreshCw className={`w-4 h-4 ${isRefreshing ? 'animate-spin' : ''}`} />
            {tr('nodes.refresh', 'Refresh')}
          </button>
        </div>
      </div>

      <div className="relative shrink-0">
        <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-5 h-5 text-slate-400" />
        <input
          type="text"
          placeholder={tr('nodes.searchPlaceholder', 'Search nodes by name...')}
          value={searchQuery}
          onChange={(e) => setSearchQuery(e.target.value)}
          className="w-full pl-10 pr-4 py-3 bg-slate-700 border border-slate-600 rounded-lg text-white placeholder-slate-400 focus:outline-none focus:ring-2 focus:ring-primary-500 focus:border-transparent"
        />
      </div>

      <NodeTopUsageCard
        metrics={metrics}
        metricsAvailable={metricsAvailable}
        isLoadingMetrics={isLoadingMetrics}
        isMetricsError={isMetricsError}
        tr={tr}
      />

      <NodeTable
        pagedNodes={pagedNodes}
        sortedNodesCount={sortedNodes.length}
        metricsMap={metricsMap}
        isLoadingNodes={isLoadingNodes}
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
        onRowClick={(name) => openDetail({ kind: 'Node', name })}
        tr={tr}
      />

      {createDialogOpen && (
        <ResourceYamlCreateDialog
          title={tr('nodes.createTitle', 'Create Node from YAML')}
          initialYaml={nodeYamlTemplate}
          onClose={() => setCreateDialogOpen(false)}
          onCreated={() => {
            queryClient.invalidateQueries({ queryKey: ['cluster', 'nodes'] })
          }}
        />
      )}
    </div>
  )
}
