import { useEffect, useMemo, useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { useTranslation } from 'react-i18next'
import { api } from '@/services/api'
import { useKubeWatchList } from '@/services/useKubeWatchList'
import { Loader2, ChevronDown, ChevronUp, Plus, RefreshCw, Search, Server } from 'lucide-react'
import { useResourceDetail } from '@/components/ResourceDetailContext'
import { useAdaptiveTable } from '@/hooks/useAdaptiveTable'
import { AdaptiveTableFillerRows } from '@/components/AdaptiveTableFillerRows'
import { useAIContext } from '@/hooks/useAIContext'
import { usePermission } from '@/hooks/usePermission'
import ResourceYamlCreateDialog from '@/components/ResourceYamlCreateDialog'
import { summarizeList } from '@/utils/aiContext/summarizeList'
import { buildResourceLink } from '@/utils/resourceLink'

interface NodeInfo {
  name: string
  status: string
  roles: string[]
  age: string
  version?: string | null
  internal_ip?: string | null
  external_ip?: string | null
}

interface NodeMetric {
  name: string
  cpu: string
  cpu_percent: string
  memory: string
  memory_percent: string
  timestamp?: string | null
  window?: string | null
}

export default function ClusterNodes() {
  const queryClient = useQueryClient()
  const { t } = useTranslation()
  const tr = (key: string, fallback: string, options?: Record<string, any>) =>
    t(key, { defaultValue: fallback, ...options })
  const { open: openDetail } = useResourceDetail()

  const [searchQuery, setSearchQuery] = useState('')
  const [isRefreshing, setIsRefreshing] = useState(false)
  const [metricsAvailable] = useState(true)
  const [sortKey, setSortKey] = useState<null | 'name' | 'status' | 'roles' | 'cpu' | 'memory' | 'version' | 'internal_ip' | 'external_ip' | 'age'>(null)
  const [sortDir, setSortDir] = useState<'asc' | 'desc'>('asc')
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

  const parseAgeDays = (age?: string | null) => {
    if (!age) return 0
    const match = age.match(/(\d+)\s+day/)
    if (match) return Number(match[1]) || 0
    const compactMatch = age.match(/^(\d+)d$/i)
    if (compactMatch) return Number(compactMatch[1]) || 0
    const hourMatch = age.match(/^(\d+)h$/i)
    if (hourMatch) return Number(hourMatch[1]) / 24
    return 0
  }

  const formatAge = (age?: string | null) => {
    if (!age) return '-'
    return age
  }

  const handleSort = (key: typeof sortKey) => {
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

  const renderSortIcon = (key: NonNullable<typeof sortKey>) => {
    if (sortKey !== key) return null
    return sortDir === 'asc' ? (
      <ChevronUp className="w-3.5 h-3.5 text-slate-300" />
    ) : (
      <ChevronDown className="w-3.5 h-3.5 text-slate-300" />
    )
  }

  const sortedNodes = useMemo(() => {
    if (!sortKey) return filteredNodes
    const list = [...filteredNodes]
    const getValue = (node: NodeInfo) => {
      switch (sortKey) {
        case 'name':
          return node.name
        case 'status':
          return node.status || ''
        case 'roles':
          return (node.roles || []).join(',')
        case 'cpu': {
          const metric = metricsMap.get(node.name)
          return metric ? parseFloat(metric.cpu_percent) || 0 : 0
        }
        case 'memory': {
          const metric = metricsMap.get(node.name)
          return metric ? parseFloat(metric.memory_percent) || 0 : 0
        }
        case 'version':
          return node.version || ''
        case 'internal_ip':
          return node.internal_ip || ''
        case 'external_ip':
          return node.external_ip || ''
        case 'age':
          return parseAgeDays(node.age)
        default:
          return ''
      }
    }
    list.sort((a, b) => {
      const av = getValue(a)
      const bv = getValue(b)
      if (typeof av === 'number' && typeof bv === 'number') {
        return sortDir === 'asc' ? av - bv : bv - av
      }
      const as = String(av)
      const bs = String(bv)
      return sortDir === 'asc' ? as.localeCompare(bs) : bs.localeCompare(as)
    })
    return list
  }, [filteredNodes, metricsMap, sortDir, sortKey])

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

  // 플로팅 AI 위젯용 스냅샷
  const aiSnapshot = useMemo(() => {
    if (!Array.isArray(nodes) || nodes.length === 0) return null
    const nodeList = nodes as NodeInfo[]

    const parsePercent = (v?: string | null): number | null => {
      if (!v) return null
      const m = String(v).match(/(-?\d+(?:\.\d+)?)/)
      return m ? Number(m[1]) : null
    }

    const readyCount = nodeList.filter((n) => /ready/i.test(n.status) && !/notready/i.test(n.status)).length
    const notReadyCount = nodeList.length - readyCount

    const highCpu: string[] = []
    const highMem: string[] = []
    for (const n of nodeList) {
      const metric = metricsMap.get(n.name)
      const cpu = parsePercent(metric?.cpu_percent)
      const mem = parsePercent(metric?.memory_percent)
      if (cpu !== null && cpu > 85) highCpu.push(n.name)
      if (mem !== null && mem > 85) highMem.push(n.name)
    }

    const prefix = notReadyCount > 0 || highCpu.length > 0 || highMem.length > 0 ? '⚠️ ' : ''
    const alerts: string[] = []
    if (notReadyCount > 0) alerts.push(`NotReady ${notReadyCount}`)
    if (highCpu.length > 0) alerts.push(`CPU 85%+ ${highCpu.length}`)
    if (highMem.length > 0) alerts.push(`Mem 85%+ ${highMem.length}`)
    const alertStr = alerts.length ? `, ${alerts.join(', ')}` : ''
    const summary = `${prefix}노드 ${nodeList.length}개 (Ready ${readyCount}${alertStr})`

    const nodesWithMetric = pagedNodes.map((n) => {
      const nn = n as NodeInfo
      const metric = metricsMap.get(nn.name)
      return {
        ...nn,
        cpu_percent: metric?.cpu_percent,
        memory_percent: metric?.memory_percent,
      }
    })

    return {
      source: 'base' as const,
      summary,
      data: {
        filters: { search: searchQuery || undefined },
        stats: {
          total: nodeList.length,
          ready: readyCount,
          not_ready: notReadyCount,
          high_cpu_count: highCpu.length,
          high_memory_count: highMem.length,
        },
        ...summarizeList(nodesWithMetric as unknown as Record<string, unknown>[], {
          total: sortedNodes.length,
          currentPage,
          pageSize: rowsPerPage,
          topN: rowsPerPage,
          pickFields: ['name', 'status', 'roles', 'version', 'age', 'cpu_percent', 'memory_percent', 'internal_ip'],
          filterProblematic: (n) => {
            const node = n as unknown as NodeInfo & { cpu_percent?: string; memory_percent?: string }
            if (!/ready/i.test(node.status) || /notready/i.test(node.status)) return true
            const cpu = parsePercent(node.cpu_percent)
            const mem = parsePercent(node.memory_percent)
            return (cpu !== null && cpu > 85) || (mem !== null && mem > 85)
          },
          interpret: () => {
            const out: string[] = []
            if (notReadyCount > 0) out.push(`⚠️ ${notReadyCount}개 노드가 Ready 상태 아님`)
            if (highCpu.length > 0) out.push(`⚠️ ${highCpu.length}개 노드 CPU 85% 초과: ${highCpu.slice(0, 5).join(', ')}`)
            if (highMem.length > 0) out.push(`⚠️ ${highMem.length}개 노드 메모리 85% 초과: ${highMem.slice(0, 5).join(', ')}`)
            return out
          },
          linkBuilder: (n) => {
            const node = n as unknown as NodeInfo
            return buildResourceLink('Node', undefined, node.name)
          },
        }),
      },
    }
  }, [nodes, pagedNodes, sortedNodes.length, currentPage, rowsPerPage, searchQuery, metricsMap])

  useAIContext(aiSnapshot, [aiSnapshot])

  const topNodes = useMemo(() => {
    if (!Array.isArray(metrics) || metrics.length === 0) return [] as NodeMetric[]
    const parsePercent = (value: string | undefined) => {
      if (!value) return 0
      const numeric = Number(String(value).replace('%', ''))
      return Number.isFinite(numeric) ? numeric : 0
    }
    return [...metrics]
      .map((node) => {
        const cpuPercent = parsePercent(node.cpu_percent)
        const memPercent = parsePercent(node.memory_percent)
        return {
          ...node,
          _score: cpuPercent * 0.7 + memPercent * 0.3,
        } as NodeMetric & { _score: number }
      })
      .sort((a, b) => b._score - a._score)
      .slice(0, 3)
  }, [metrics])

  const getStatusColor = (status: string) => {
    const lower = (status || '').toLowerCase().trim()
    if (lower === 'ready') return 'badge-success'
    if (lower === 'schedulingdisabled') return 'badge-warning'
    if (lower.includes('notready') || lower.includes('unknown')) return 'badge-error'
    if (lower.includes('ready')) return 'badge-success'
    return 'badge-info'
  }

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

  const nodeYamlTemplate = `apiVersion: v1
kind: Node
metadata:
  name: sample-node
  labels:
    node-role.kubernetes.io/worker: ""
`

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

      <div className="card shrink-0">
        <div className="flex items-center justify-between mb-4">
          <h2 className="text-sm font-semibold text-white">
            {tr('nodes.top.title', 'Top nodes by resource usage')}
          </h2>
          <Server className="w-4 h-4 text-slate-400" />
        </div>
        {!metricsAvailable ? (
          <p className="text-sm text-slate-400">{tr('nodes.top.unavailable', 'Metrics server not available for this cluster')}</p>
        ) : isLoadingMetrics ? (
          <p className="text-sm text-slate-400">{tr('nodes.top.loading', 'Loading metrics...')}</p>
        ) : isMetricsError ? (
          <p className="text-sm text-slate-400">{tr('nodes.top.error', 'Metrics unavailable')}</p>
        ) : topNodes.length > 0 ? (
          <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
            {topNodes.map((node, index) => {
              const cpuPercent = parseFloat(node.cpu_percent)
              const memPercent = parseFloat(node.memory_percent)
              return (
                <div key={node.name} className="rounded-lg border border-slate-700 bg-slate-900/40 px-4 py-3">
                  <div className="flex items-center justify-between text-sm text-white">
                    <span className="font-medium">#{index + 1} {node.name}</span>
                    <span className="text-xs text-slate-400">{node.cpu} / {node.memory}</span>
                  </div>
                  <div className="mt-3 space-y-2">
                    <div className="text-xs text-slate-400 flex items-center justify-between">
                      <span>CPU</span>
                      <span className="font-medium text-emerald-300">{node.cpu_percent}</span>
                    </div>
                    <div className="w-full h-2.5 bg-slate-800 rounded-full overflow-hidden">
                      <div
                        className={`h-full rounded-full ${cpuPercent >= 80 ? 'bg-red-500' : cpuPercent >= 60 ? 'bg-amber-500' : 'bg-emerald-500'}`}
                        style={{ width: `${Math.min(cpuPercent, 100)}%` }}
                      />
                    </div>
                    <div className="text-xs text-slate-400 flex items-center justify-between">
                      <span>MEM</span>
                      <span className="font-medium text-blue-300">{node.memory_percent}</span>
                    </div>
                    <div className="w-full h-2.5 bg-slate-800 rounded-full overflow-hidden">
                      <div
                        className={`h-full rounded-full ${memPercent >= 80 ? 'bg-red-500' : memPercent >= 60 ? 'bg-amber-500' : 'bg-blue-500'}`}
                        style={{ width: `${Math.min(memPercent, 100)}%` }}
                      />
                    </div>
                  </div>
                </div>
              )
            })}
          </div>
        ) : (
          <p className="text-sm text-slate-400">{tr('nodes.top.empty', 'No metrics available')}</p>
        )}
      </div>

      <div ref={tableContainerRef} className="card flex-1 min-h-0 flex flex-col">
        <div ref={tableBodyRef} className="overflow-x-auto flex-1 min-h-0">
          <table className="w-full text-sm min-w-[980px] table-fixed">
            <thead ref={theadRef} className="text-slate-400">
              <tr>
                <th className="text-left py-3 px-4 w-[260px] cursor-pointer" onClick={() => handleSort('name')}>
                  <span className="inline-flex items-center gap-1">{tr('nodes.table.name', 'Name')}{renderSortIcon('name')}</span>
                </th>
                <th className="text-left py-3 px-4 w-[120px] cursor-pointer" onClick={() => handleSort('status')}>
                  <span className="inline-flex items-center gap-1">{tr('nodes.table.status', 'Status')}{renderSortIcon('status')}</span>
                </th>
                <th className="text-left py-3 px-4 w-[180px] cursor-pointer" onClick={() => handleSort('roles')}>
                  <span className="inline-flex items-center gap-1">{tr('nodes.table.roles', 'Roles')}{renderSortIcon('roles')}</span>
                </th>
                <th className="text-left py-3 px-4 w-[150px] cursor-pointer" onClick={() => handleSort('cpu')}>
                  <span className="inline-flex items-center gap-1">{tr('nodes.table.cpu', 'CPU')}{renderSortIcon('cpu')}</span>
                </th>
                <th className="text-left py-3 px-4 w-[170px] cursor-pointer" onClick={() => handleSort('memory')}>
                  <span className="inline-flex items-center gap-1">{tr('nodes.table.memory', 'Memory')}{renderSortIcon('memory')}</span>
                </th>
                <th className="text-left py-3 px-4 w-[160px] cursor-pointer" onClick={() => handleSort('version')}>
                  <span className="inline-flex items-center gap-1">{tr('nodes.table.version', 'Version')}{renderSortIcon('version')}</span>
                </th>
                <th className="text-left py-3 px-4 w-[150px] cursor-pointer" onClick={() => handleSort('internal_ip')}>
                  <span className="inline-flex items-center gap-1">{tr('nodes.table.internalIp', 'Internal IP')}{renderSortIcon('internal_ip')}</span>
                </th>
                <th className="text-left py-3 px-4 w-[150px] cursor-pointer" onClick={() => handleSort('external_ip')}>
                  <span className="inline-flex items-center gap-1">{tr('nodes.table.externalIp', 'External IP')}{renderSortIcon('external_ip')}</span>
                </th>
                <th className="text-left py-3 px-4 w-[110px] cursor-pointer" onClick={() => handleSort('age')}>
                  <span className="inline-flex items-center gap-1">{tr('nodes.table.age', 'Age')}{renderSortIcon('age')}</span>
                </th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-700">
              {pagedNodes.map((node, idx) => {
                const metric = metricsMap.get(node.name)
                return (
                  <tr
                      ref={idx === 0 ? firstRowRef : undefined}
                    key={node.name}
                    className="text-slate-200 hover:bg-slate-800/60 cursor-pointer"
                    onClick={() => openDetail({ kind: 'Node', name: node.name })}
                  >
                    <td className="py-3 px-4 font-medium text-white"><span className="block truncate">{node.name}</span></td>
                    <td className="py-3 px-4">
                      <div className="flex flex-wrap gap-1">
                        {node.status.split(',').map((s: string, i: number) => (
                          <span key={i} className={`badge ${getStatusColor(s.trim())}`}>{s.trim()}</span>
                        ))}
                      </div>
                    </td>
                    <td className="py-3 px-4 text-xs font-mono"><span className="block truncate">{node.roles && node.roles.length > 0 ? node.roles.join(', ') : '-'}</span></td>
                    <td className="py-3 px-4 text-xs font-mono"><span className="block truncate">{metric ? `${metric.cpu} (${metric.cpu_percent})` : '-'}</span></td>
                    <td className="py-3 px-4 text-xs font-mono"><span className="block truncate">{metric ? `${metric.memory} (${metric.memory_percent})` : '-'}</span></td>
                    <td className="py-3 px-4 text-xs font-mono"><span className="block truncate">{node.version || '-'}</span></td>
                    <td className="py-3 px-4 text-xs font-mono"><span className="block truncate">{node.internal_ip || '-'}</span></td>
                    <td className="py-3 px-4 text-xs font-mono"><span className="block truncate">{node.external_ip || '-'}</span></td>
                    <td className="py-3 px-4 text-xs font-mono"><span className="block truncate">{formatAge(node.age)}</span></td>
                  </tr>
                )
              })}
              {isLoadingNodes && (
                <tr>
                  <td colSpan={9} className="py-10 px-4 text-center text-slate-400">
                    <div className="inline-flex items-center gap-2">
                      <Loader2 className="w-4 h-4 animate-spin" />
                      Loading...
                    </div>
                  </td>
                </tr>
              )}

              {sortedNodes.length === 0 && !isLoadingNodes && (
                <tr>
                  <td colSpan={9} className="py-6 px-4 text-center text-slate-400">
                    {tr('nodes.noResults', 'No nodes found.')}
                  </td>
                </tr>
              )}
            </tbody>
              <AdaptiveTableFillerRows count={rowsPerPage - pagedNodes.length} columnCount={9} />
          </table>
        </div>
        {sortedNodes.length > 0 && (
          <div className="flex items-center justify-between px-4 py-3 border-t border-slate-700 shrink-0">
            <div className="text-xs text-slate-400">
              {tr('common.paginationRange', 'Showing {{start}}-{{end}} of {{total}}', {
                start: (currentPage - 1) * rowsPerPage + 1,
                end: Math.min(currentPage * rowsPerPage, sortedNodes.length),
                total: sortedNodes.length,
              })}
            </div>
            <div className="flex items-center gap-2">
              <button
                type="button"
                onClick={() => setCurrentPage((prev) => Math.max(1, prev - 1))}
                disabled={currentPage <= 1}
                className="px-3 py-1.5 text-xs rounded border border-slate-600 text-slate-300 disabled:opacity-40 disabled:cursor-not-allowed hover:text-white hover:border-slate-500"
              >
                {tr('common.prev', 'Prev')}
              </button>
              <span className="text-xs text-slate-300 min-w-[72px] text-center">
                {currentPage} / {totalPages}
              </span>
              <button
                type="button"
                onClick={() => setCurrentPage((prev) => Math.min(totalPages, prev + 1))}
                disabled={currentPage >= totalPages}
                className="px-3 py-1.5 text-xs rounded border border-slate-600 text-slate-300 disabled:opacity-40 disabled:cursor-not-allowed hover:text-white hover:border-slate-500"
              >
                {tr('common.next', 'Next')}
              </button>
            </div>
          </div>
        )}
      </div>

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
