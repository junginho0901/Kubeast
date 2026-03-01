import { useEffect, useMemo, useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { useTranslation } from 'react-i18next'
import { api } from '@/services/api'
import { ChevronDown, ChevronUp, RefreshCw, Search, Server, X } from 'lucide-react'
import { ModalOverlay } from '@/components/ModalOverlay'

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

interface NodeDescribe {
  name: string
  created_at?: string | null
  labels?: Record<string, string>
  annotations?: Record<string, string>
  conditions: Array<{
    type: string
    status: string
    reason?: string | null
    message?: string | null
    last_transition_time?: string | null
    last_update_time?: string | null
  }>
  pod_cidr?: string | null
  pod_cidrs?: string[] | null
  unschedulable?: boolean | null
  addresses: Array<{ type: string; address: string }>
  taints: Array<{ key?: string | null; value?: string | null; effect?: string | null }>
  system_info: {
    architecture?: string | null
    operating_system?: string | null
    os_image?: string | null
    kernel_version?: string | null
    container_runtime?: string | null
    kubelet_version?: string | null
    kube_proxy_version?: string | null
  }
}

export default function ClusterNodes() {
  const queryClient = useQueryClient()
  const { t } = useTranslation()
  const tr = (key: string, fallback: string, options?: Record<string, any>) =>
    t(key, { defaultValue: fallback, ...options })

  const [searchQuery, setSearchQuery] = useState('')
  const [isRefreshing, setIsRefreshing] = useState(false)
  const [selectedNodeName, setSelectedNodeName] = useState<string | null>(null)

  const { data: nodes, isLoading: isLoadingNodes } = useQuery({
    queryKey: ['cluster', 'nodes'],
    queryFn: () => api.getNodes(false),
  })

  const { data: metrics, isLoading: isLoadingMetrics, isError: isMetricsError } = useQuery({
    queryKey: ['cluster', 'node-metrics'],
    queryFn: () => api.getNodeMetrics(),
  })

  const { data: nodeDescribe, isLoading: isLoadingDescribe, isError: isDescribeError } = useQuery({
    queryKey: ['cluster', 'nodes', 'describe', selectedNodeName],
    queryFn: () => api.describeNode(selectedNodeName as string),
    enabled: Boolean(selectedNodeName),
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
    const lower = (status || '').toLowerCase()
    if (lower.includes('ready')) return 'badge-success'
    if (lower.includes('notready') || lower.includes('unknown')) return 'badge-warning'
    return 'badge-info'
  }

  const handleRefresh = async () => {
    if (isRefreshing) return
    setIsRefreshing(true)
    try {
      const [nodesData, metricsData] = await Promise.all([api.getNodes(true), api.getNodeMetrics()])
      queryClient.removeQueries({ queryKey: ['cluster', 'nodes'] })
      queryClient.setQueryData(['cluster', 'nodes'], nodesData)
      queryClient.setQueryData(['cluster', 'node-metrics'], metricsData)
    } catch (error) {
      console.error('Nodes refresh failed:', error)
    }
    setTimeout(() => setIsRefreshing(false), 500)
  }

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-3xl font-bold text-white">{tr('nodes.title', 'Nodes')}</h1>
          <p className="mt-2 text-slate-400">{tr('nodes.subtitle', 'Inspect cluster node status and capacity.')}</p>
        </div>
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

      <div className="relative">
        <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-5 h-5 text-slate-400" />
        <input
          type="text"
          placeholder={tr('nodes.searchPlaceholder', 'Search nodes by name...')}
          value={searchQuery}
          onChange={(e) => setSearchQuery(e.target.value)}
          className="w-full pl-10 pr-4 py-3 bg-slate-700 border border-slate-600 rounded-lg text-white placeholder-slate-400 focus:outline-none focus:ring-2 focus:ring-primary-500 focus:border-transparent"
        />
      </div>

      <div className="card">
        <div className="flex items-center justify-between mb-4">
          <h2 className="text-sm font-semibold text-white">
            {tr('nodes.top.title', 'Top nodes by resource usage')}
          </h2>
          <Server className="w-4 h-4 text-slate-400" />
        </div>
        {isLoadingMetrics ? (
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

      <div className="card overflow-x-auto">
        <table className="w-full text-sm min-w-[980px]">
          <thead className="text-slate-400">
            <tr>
              <th className="text-left py-3 px-4">{tr('nodes.table.name', 'Name')}</th>
              <th className="text-left py-3 px-4">{tr('nodes.table.status', 'Status')}</th>
              <th className="text-left py-3 px-4">{tr('nodes.table.roles', 'Roles')}</th>
              <th className="text-left py-3 px-4">{tr('nodes.table.cpu', 'CPU')}</th>
              <th className="text-left py-3 px-4">{tr('nodes.table.memory', 'Memory')}</th>
              <th className="text-left py-3 px-4">{tr('nodes.table.version', 'Version')}</th>
              <th className="text-left py-3 px-4">{tr('nodes.table.internalIp', 'Internal IP')}</th>
              <th className="text-left py-3 px-4">{tr('nodes.table.externalIp', 'External IP')}</th>
              <th className="text-left py-3 px-4">{tr('nodes.table.age', 'Age')}</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-700">
            {filteredNodes.map((node) => {
              const metric = metricsMap.get(node.name)
              return (
                <tr
                  key={node.name}
                  className="text-slate-200 hover:bg-slate-800/60 cursor-pointer"
                  onClick={() => setSelectedNodeName(node.name)}
                >
                  <td className="py-3 px-4 font-medium text-white">{node.name}</td>
                  <td className="py-3 px-4">
                    <span className={`badge ${getStatusColor(node.status)}`}>{node.status}</span>
                  </td>
                  <td className="py-3 px-4 text-xs font-mono">
                    {node.roles && node.roles.length > 0 ? node.roles.join(', ') : '-'}
                  </td>
                  <td className="py-3 px-4 text-xs font-mono">
                    {metric ? `${metric.cpu} (${metric.cpu_percent})` : '-'}
                  </td>
                  <td className="py-3 px-4 text-xs font-mono">
                    {metric ? `${metric.memory} (${metric.memory_percent})` : '-'}
                  </td>
                  <td className="py-3 px-4 text-xs font-mono">{node.version || '-'}</td>
                  <td className="py-3 px-4 text-xs font-mono">{node.internal_ip || '-'}</td>
                  <td className="py-3 px-4 text-xs font-mono">{node.external_ip || '-'}</td>
                  <td className="py-3 px-4 text-xs font-mono">{node.age}</td>
                </tr>
              )
            })}
            {filteredNodes.length === 0 && !isLoadingNodes && (
              <tr>
                <td colSpan={9} className="py-6 px-4 text-slate-400">
                  {tr('nodes.noResults', 'No nodes found.')}
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      {selectedNodeName && (
        <ModalOverlay onClose={() => setSelectedNodeName(null)}>
          <div
            className="bg-slate-900 border border-slate-700 rounded-xl max-w-3xl w-full max-h-[80vh] overflow-hidden shadow-xl"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-center justify-between px-4 py-3 border-b border-slate-700">
              <div>
                <h2 className="text-lg font-semibold text-white">
                  {tr('nodes.detail.title', 'Node details')}: {selectedNodeName}
                </h2>
                <p className="text-xs text-slate-400">
                  {tr('nodes.detail.subtitle', 'Details from kubectl describe node {{name}}', {
                    name: selectedNodeName,
                  })}
                </p>
              </div>
              <button
                onClick={() => setSelectedNodeName(null)}
                className="text-slate-400 hover:text-white"
              >
                <X className="w-4 h-4" />
              </button>
            </div>
            <div className="p-4 max-h-[60vh] overflow-y-auto text-sm space-y-4">
              {isLoadingDescribe ? (
                <p className="text-slate-400">{tr('nodes.detail.loading', 'Loading node details...')}</p>
              ) : isDescribeError ? (
                <p className="text-red-400">{tr('nodes.detail.error', 'Failed to load node details.')}</p>
              ) : nodeDescribe ? (
                <>
                  <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                    <div>
                      <p className="text-xs text-slate-400 mb-1">{tr('nodes.detail.conditions', 'Conditions')}</p>
                      <pre className="bg-slate-800 rounded-md p-2 text-xs whitespace-pre-wrap text-slate-200">
                        {nodeDescribe.conditions && nodeDescribe.conditions.length > 0
                          ? nodeDescribe.conditions
                              .map(
                                (c: NodeDescribe['conditions'][number]) =>
                                  `${c.type}: ${c.status}${c.reason ? ` (${c.reason})` : ''}`
                              )
                              .join('\n')
                          : tr('common.none', '(none)')}
                      </pre>
                    </div>
                    <div>
                      <p className="text-xs text-slate-400 mb-1">{tr('nodes.detail.taints', 'Taints')}</p>
                      <pre className="bg-slate-800 rounded-md p-2 text-xs whitespace-pre-wrap text-slate-200">
                        {nodeDescribe.taints && nodeDescribe.taints.length > 0
                          ? nodeDescribe.taints
                              .map((t) => `${t.key || ''}=${t.value || ''}:${t.effect || ''}`)
                              .join('\n')
                          : tr('common.none', '(none)')}
                      </pre>
                    </div>
                  </div>

                  <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                    <div>
                      <p className="text-xs text-slate-400 mb-1">{tr('nodes.detail.addresses', 'Addresses')}</p>
                      <pre className="bg-slate-800 rounded-md p-2 text-xs whitespace-pre-wrap text-slate-200">
                        {nodeDescribe.addresses && nodeDescribe.addresses.length > 0
                          ? nodeDescribe.addresses.map((a) => `${a.type}: ${a.address}`).join('\n')
                          : tr('common.none', '(none)')}
                      </pre>
                    </div>
                    <div>
                      <p className="text-xs text-slate-400 mb-1">{tr('nodes.detail.version', 'Versions')}</p>
                      <pre className="bg-slate-800 rounded-md p-2 text-xs whitespace-pre-wrap text-slate-200">
                        {`kubelet: ${nodeDescribe.system_info?.kubelet_version || '-'}\n` +
                        `kube-proxy: ${nodeDescribe.system_info?.kube_proxy_version || '-'}`}
                      </pre>
                    </div>
                  </div>

                  <div>
                    <p className="text-xs text-slate-400 mb-1">{tr('nodes.detail.system', 'System info')}</p>
                    <pre className="bg-slate-800 rounded-md p-2 text-xs whitespace-pre-wrap text-slate-200">
{`OS: ${nodeDescribe.system_info?.operating_system || '-'}\n` +
`Arch: ${nodeDescribe.system_info?.architecture || '-'}\n` +
`OS Image: ${nodeDescribe.system_info?.os_image || '-'}\n` +
`Kernel: ${nodeDescribe.system_info?.kernel_version || '-'}\n` +
`Container Runtime: ${nodeDescribe.system_info?.container_runtime || '-'}`}
                    </pre>
                  </div>
                </>
              ) : (
                <p className="text-slate-400">{tr('nodes.detail.notFound', 'Node details not found.')}</p>
              )}
            </div>
          </div>
        </ModalOverlay>
      )}
    </div>
  )
}
