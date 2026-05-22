import { useEffect, useMemo, useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { useTranslation } from 'react-i18next'
import { api, type ResourceQuotaInfo } from '@/services/api'
import { useKubeWatchList } from '@/services/useKubeWatchList'
import { useResourceDetail } from '@/components/ResourceDetailContext'
import ResourceYamlCreateDialog from '@/components/ResourceYamlCreateDialog'
import { useAdaptiveTable } from '@/hooks/useAdaptiveTable'
import { useAIContext } from '@/hooks/useAIContext'
import { usePermission } from '@/hooks/usePermission'
import { summarizeList } from '@/utils/aiContext/summarizeList'
import { buildResourceLink } from '@/utils/resourceLink'
import { Plus, RefreshCw } from 'lucide-react'
import {
  parseAgeSeconds,
  resourceQuotaToRawJson,
  type SortKey,
} from './resourcequotas/resourceQuotaHelpers'
import { applyResourceQuotaWatchEvent } from './resourcequotas/resourceQuotaWatchNormalize'
import { ResourceQuotaFilters } from './resourcequotas/ResourceQuotaFilters'
import { ResourceQuotaTable } from './resourcequotas/ResourceQuotaTable'

export default function ResourceQuotas() {
  const queryClient = useQueryClient()
  const { t } = useTranslation()
  const tr = (key: string, fallback: string, options?: Record<string, any>) =>
    t(key, { defaultValue: fallback, ...options })
  const { open: openDetail } = useResourceDetail()

  const [searchQuery, setSearchQuery] = useState('')
  const [selectedNamespace, setSelectedNamespace] = useState<string>('all')
  const [isRefreshing, setIsRefreshing] = useState(false)
  const [sortKey, setSortKey] = useState<SortKey>(null)
  const [sortDir, setSortDir] = useState<'asc' | 'desc'>('asc')
  const [currentPage, setCurrentPage] = useState(1)
  const [createDialogOpen, setCreateDialogOpen] = useState(false)

  const { data: namespaces } = useQuery({
    queryKey: ['namespaces'],
    queryFn: () => api.getNamespaces(),
    staleTime: 30000,
  })

  const { data: resourceQuotas, isLoading } = useQuery({
    queryKey: ['cluster', 'resourcequotas', selectedNamespace],
    queryFn: () => (
      selectedNamespace === 'all'
        ? api.getAllResourceQuotas(false)
        : api.getResourceQuotas(selectedNamespace, false)
    ),
  })
  const { has } = usePermission()
  const canCreate = has('resource.resourcequota.create')

  useKubeWatchList({
    enabled: true,
    queryKey: ['cluster', 'resourcequotas', selectedNamespace],
    path: selectedNamespace === 'all'
      ? '/api/v1/resourcequotas'
      : `/api/v1/namespaces/${selectedNamespace}/resourcequotas`,
    query: 'watch=1',
    applyEvent: (prev, event) => applyResourceQuotaWatchEvent(prev as ResourceQuotaInfo[] | undefined, event),
  })

  const filteredResourceQuotas = useMemo(() => {
    if (!Array.isArray(resourceQuotas)) return [] as ResourceQuotaInfo[]
    if (!searchQuery.trim()) return resourceQuotas
    const q = searchQuery.toLowerCase()
    return resourceQuotas.filter((rq) =>
      rq.name.toLowerCase().includes(q) ||
      rq.namespace.toLowerCase().includes(q),
    )
  }, [resourceQuotas, searchQuery])

  const summary = useMemo(() => {
    const total = filteredResourceQuotas.length
    let withCpu = 0
    let withMemory = 0
    for (const rq of filteredResourceQuotas) {
      const keys = Object.keys(rq.status_hard || {})
      if (keys.includes('cpu') || keys.includes('requests.cpu')) withCpu += 1
      if (keys.includes('memory') || keys.includes('requests.memory')) withMemory += 1
    }
    return { total, withCpu, withMemory }
  }, [filteredResourceQuotas])

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

  const sortedResourceQuotas = useMemo(() => {
    if (!sortKey) return filteredResourceQuotas
    const list = [...filteredResourceQuotas]

    const getValue = (rq: ResourceQuotaInfo): string | number => {
      switch (sortKey) {
        case 'name': return rq.name
        case 'namespace': return rq.namespace
        case 'requests': return Object.keys(rq.status_hard || {}).length
        case 'age': return parseAgeSeconds(rq.created_at)
        default: return ''
      }
    }

    list.sort((a, b) => {
      const av = getValue(a)
      const bv = getValue(b)
      if (typeof av === 'number' && typeof bv === 'number') {
        return sortDir === 'asc' ? av - bv : bv - av
      }
      return sortDir === 'asc'
        ? String(av).localeCompare(String(bv))
        : String(bv).localeCompare(String(av))
    })
    return list
  }, [filteredResourceQuotas, sortDir, sortKey])

  const { containerRef: tableContainerRef, bodyRef: tableBodyRef, theadRef, firstRowRef, rowsPerPage } = useAdaptiveTable({
    recalculationKey: sortedResourceQuotas.length,
  })
  const totalPages = Math.max(1, Math.ceil(sortedResourceQuotas.length / rowsPerPage))

  useEffect(() => {
    setCurrentPage(1)
  }, [searchQuery, selectedNamespace])

  useEffect(() => {
    if (currentPage > totalPages) {
      setCurrentPage(totalPages)
    }
  }, [currentPage, totalPages])

  const pagedResourceQuotas = useMemo(() => {
    const start = (currentPage - 1) * rowsPerPage
    return sortedResourceQuotas.slice(start, start + rowsPerPage)
  }, [sortedResourceQuotas, currentPage, rowsPerPage])

  // 플로팅 AI 위젯용 스냅샷
  const aiSnapshot = useMemo(() => {
    if (!Array.isArray(resourceQuotas) || resourceQuotas.length === 0) return null
    const nsLabel = selectedNamespace === 'all' ? '전체 네임스페이스' : selectedNamespace
    const total = resourceQuotas.length
    return {
      source: 'base' as const,
      summary: `${nsLabel} ResourceQuota ${total}개`,
      data: {
        filters: { namespace: selectedNamespace, search: searchQuery || undefined },
        stats: { total },
        ...summarizeList(pagedResourceQuotas as unknown as Record<string, unknown>[], {
          total: sortedResourceQuotas.length,
          currentPage,
          pageSize: rowsPerPage,
          topN: rowsPerPage,
          pickFields: ['name', 'namespace'],
          linkBuilder: (q) => {
            const rq = q as unknown as ResourceQuotaInfo
            return buildResourceLink('ResourceQuota', rq.namespace, rq.name)
          },
        }),
      },
    }
  }, [resourceQuotas, pagedResourceQuotas, sortedResourceQuotas.length, currentPage, rowsPerPage, selectedNamespace, searchQuery])

  useAIContext(aiSnapshot, [aiSnapshot])

  const handleRefresh = async () => {
    if (isRefreshing) return
    setIsRefreshing(true)
    try {
      const data = selectedNamespace === 'all'
        ? await api.getAllResourceQuotas(true)
        : await api.getResourceQuotas(selectedNamespace, true)
      queryClient.removeQueries({ queryKey: ['cluster', 'resourcequotas', selectedNamespace] })
      queryClient.setQueryData(['cluster', 'resourcequotas', selectedNamespace], data)
    } catch (error) {
      console.error('ResourceQuotas refresh failed:', error)
    }
    setTimeout(() => setIsRefreshing(false), 500)
  }

  const createResourceQuotaYamlTemplate = useMemo(() => {
    const ns = selectedNamespace !== 'all' ? selectedNamespace : 'default'
    return `apiVersion: v1
kind: ResourceQuota
metadata:
  name: sample-quota
  namespace: ${ns}
spec:
  hard:
    pods: "10"
    requests.cpu: "4"
    requests.memory: 8Gi
    limits.cpu: "8"
    limits.memory: 16Gi
`
  }, [selectedNamespace])

  const showNamespaceColumn = selectedNamespace === 'all'

  return (
    <div className="flex flex-col h-[calc(100vh-4rem)] gap-4">
      <div className="flex items-center justify-between shrink-0">
        <div>
          <h1 className="text-3xl font-bold text-white">{tr('resourceQuotas.title', 'Resource Quotas')}</h1>
          <p className="mt-2 text-slate-400">
            {tr('resourceQuotas.subtitle', 'Manage resource quotas across namespaces.')}
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
              {tr('resourceQuotas.create', 'Create Resource Quota')}
            </button>
          )}
          <button
            type="button"
            onClick={handleRefresh}
            disabled={isRefreshing}
            title={tr('resourceQuotas.refreshTitle', 'Force refresh')}
            className="btn btn-primary flex items-center gap-2 disabled:opacity-50 disabled:cursor-not-allowed"
          >
            <RefreshCw className={`w-4 h-4 ${isRefreshing ? 'animate-spin' : ''}`} />
            {tr('resourceQuotas.refresh', 'Refresh')}
          </button>
        </div>
      </div>

      <ResourceQuotaFilters
        searchQuery={searchQuery}
        onSearchChange={setSearchQuery}
        selectedNamespace={selectedNamespace}
        onNamespaceChange={setSelectedNamespace}
        namespaces={namespaces}
      />

      <div className="grid grid-cols-2 lg:grid-cols-3 gap-3 shrink-0">
        <div className="rounded-lg border border-slate-700 bg-slate-900/50 px-4 py-3">
          <p className="text-[11px] sm:text-xs leading-4 whitespace-nowrap text-slate-400">{tr('resourceQuotas.stats.total', 'Total')}</p>
          <p className="text-lg text-white font-semibold mt-1">{summary.total}</p>
        </div>
        <div className="rounded-lg border border-emerald-700/40 bg-emerald-900/10 px-4 py-3">
          <p className="text-[11px] sm:text-xs leading-4 whitespace-nowrap text-emerald-300">{tr('resourceQuotas.stats.withCpu', 'With CPU Quotas')}</p>
          <p className="text-lg text-white font-semibold mt-1">{summary.withCpu}</p>
        </div>
        <div className="rounded-lg border border-slate-700 bg-slate-900/50 px-4 py-3">
          <p className="text-[11px] sm:text-xs leading-4 whitespace-nowrap text-slate-400">{tr('resourceQuotas.stats.withMemory', 'With Memory Quotas')}</p>
          <p className="text-lg text-white font-semibold mt-1">{summary.withMemory}</p>
        </div>
      </div>

      {searchQuery && (
        <p className="text-sm text-slate-400 shrink-0">
          {tr('resourceQuotas.matchCount', '{{count}} resource quota{{suffix}} match.', {
            count: filteredResourceQuotas.length,
            suffix: filteredResourceQuotas.length === 1 ? '' : 's',
          })}
        </p>
      )}

      <ResourceQuotaTable
        pagedResourceQuotas={pagedResourceQuotas}
        sortedResourceQuotasLength={sortedResourceQuotas.length}
        isLoading={isLoading}
        showNamespaceColumn={showNamespaceColumn}
        sortKey={sortKey}
        sortDir={sortDir}
        onSort={handleSort}
        currentPage={currentPage}
        totalPages={totalPages}
        rowsPerPage={rowsPerPage}
        onPageChange={setCurrentPage}
        onOpenDetail={(rq) => openDetail({
          kind: 'ResourceQuota',
          name: rq.name,
          namespace: rq.namespace,
          rawJson: resourceQuotaToRawJson(rq),
        })}
        containerRef={tableContainerRef}
        bodyRef={tableBodyRef}
        theadRef={theadRef}
        firstRowRef={firstRowRef}
      />

      {createDialogOpen && (
        <ResourceYamlCreateDialog
          title={tr('resourceQuotas.createTitle', 'Create Resource Quota from YAML')}
          initialYaml={createResourceQuotaYamlTemplate}
          onClose={() => setCreateDialogOpen(false)}
          onCreated={() => {
            queryClient.invalidateQueries({ queryKey: ['cluster', 'resourcequotas'] })
          }}
        />
      )}
    </div>
  )
}
