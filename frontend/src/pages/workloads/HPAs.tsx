import { useEffect, useMemo, useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { useTranslation } from 'react-i18next'
import { api, type HPAInfo } from '@/services/api'
import { useKubeWatchList } from '@/services/useKubeWatchList'
import { useResourceDetail } from '@/components/ResourceDetailContext'
import ResourceYamlCreateDialog from '@/components/ResourceYamlCreateDialog'
import { useAdaptiveTable } from '@/hooks/useAdaptiveTable'
import { useAIContext } from '@/hooks/useAIContext'
import { usePermission } from '@/hooks/usePermission'
import { summarizeList } from '@/utils/aiContext/summarizeList'
import { buildResourceLink } from '@/utils/resourceLink'
import { Plus, RefreshCw } from 'lucide-react'
import { parseAgeSeconds, type SortKey } from './hpas/hpaHelpers'
import { applyHPAWatchEvent } from './hpas/hpaWatchNormalize'
import { HPAFilters } from './hpas/HPAFilters'
import { HPATable } from './hpas/HPATable'

export default function HPAs() {
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

  const { data: hpas, isLoading } = useQuery({
    queryKey: ['workloads', 'hpas', selectedNamespace],
    queryFn: () => (
      selectedNamespace === 'all'
        ? api.getAllHPAs(false)
        : api.getHPAs(selectedNamespace, false)
    ),
  })
  const { has } = usePermission()
  const canCreate = has('resource.hpa.create')

  useKubeWatchList({
    enabled: true,
    queryKey: ['workloads', 'hpas', selectedNamespace],
    path: selectedNamespace === 'all'
      ? '/apis/autoscaling/v2/horizontalpodautoscalers'
      : `/apis/autoscaling/v2/namespaces/${selectedNamespace}/horizontalpodautoscalers`,
    query: 'watch=1',
    applyEvent: (prev, event) => applyHPAWatchEvent(prev as HPAInfo[] | undefined, event),
  })

  const filteredHPAs = useMemo(() => {
    if (!Array.isArray(hpas)) return [] as HPAInfo[]
    if (!searchQuery.trim()) return hpas
    const q = searchQuery.toLowerCase()
    return hpas.filter((h) =>
      h.name.toLowerCase().includes(q) ||
      h.namespace.toLowerCase().includes(q) ||
      (h.target_ref || '').toLowerCase().includes(q),
    )
  }, [hpas, searchQuery])

  const summary = useMemo(() => {
    const total = filteredHPAs.length
    let active = 0
    let inactive = 0

    for (const h of filteredHPAs) {
      if ((h.current_replicas ?? 0) > 0) active += 1
      else inactive += 1
    }

    return { total, active, inactive }
  }, [filteredHPAs])

  const sortedHPAs = useMemo(() => {
    if (!sortKey) return filteredHPAs
    const list = [...filteredHPAs]

    const getValue = (h: HPAInfo): string | number => {
      switch (sortKey) {
        case 'name': return h.name
        case 'target': return h.target_ref || ''
        case 'minReplicas': return h.min_replicas ?? 0
        case 'maxReplicas': return h.max_replicas
        case 'currentReplicas': return h.current_replicas ?? 0
        case 'desiredReplicas': return h.desired_replicas ?? 0
        case 'age': return parseAgeSeconds(h.created_at)
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
  }, [filteredHPAs, sortDir, sortKey])

  const { containerRef: tableContainerRef, bodyRef: tableBodyRef, theadRef, firstRowRef, rowsPerPage } = useAdaptiveTable({
    recalculationKey: sortedHPAs.length,
  })
  const totalPages = Math.max(1, Math.ceil(sortedHPAs.length / rowsPerPage))

  useEffect(() => {
    setCurrentPage(1)
  }, [searchQuery, selectedNamespace])

  useEffect(() => {
    if (currentPage > totalPages) {
      setCurrentPage(totalPages)
    }
  }, [currentPage, totalPages])

  const pagedHPAs = useMemo(() => {
    const start = (currentPage - 1) * rowsPerPage
    return sortedHPAs.slice(start, start + rowsPerPage)
  }, [sortedHPAs, currentPage, rowsPerPage])

  // 플로팅 AI 위젯용 스냅샷
  const aiSnapshot = useMemo(() => {
    if (!Array.isArray(hpas) || hpas.length === 0) return null
    const nsLabel = selectedNamespace === 'all' ? '전체 네임스페이스' : selectedNamespace
    const total = hpas.length
    return {
      source: 'base' as const,
      summary: `${nsLabel} HPA ${total}개`,
      data: {
        filters: { namespace: selectedNamespace, search: searchQuery || undefined },
        stats: { total },
        ...summarizeList(pagedHPAs as unknown as Record<string, unknown>[], {
          total: sortedHPAs.length,
          currentPage,
          pageSize: rowsPerPage,
          topN: rowsPerPage,
          pickFields: ['name', 'namespace', 'target_ref', 'min_replicas', 'max_replicas', 'current_replicas', 'desired_replicas'],
          linkBuilder: (h) => {
            const hpa = h as unknown as HPAInfo
            return buildResourceLink('HorizontalPodAutoscaler', hpa.namespace, hpa.name)
          },
        }),
      },
    }
  }, [hpas, pagedHPAs, sortedHPAs.length, currentPage, rowsPerPage, selectedNamespace, searchQuery])

  useAIContext(aiSnapshot, [aiSnapshot])

  const handleRefresh = async () => {
    if (isRefreshing) return
    setIsRefreshing(true)
    try {
      const data = selectedNamespace === 'all'
        ? await api.getAllHPAs(true)
        : await api.getHPAs(selectedNamespace, true)
      queryClient.removeQueries({ queryKey: ['workloads', 'hpas', selectedNamespace] })
      queryClient.setQueryData(['workloads', 'hpas', selectedNamespace], data)
    } catch (error) {
      console.error('HPAs refresh failed:', error)
    }
    setTimeout(() => setIsRefreshing(false), 500)
  }

  const createHPAYamlTemplate = useMemo(() => {
    const ns = selectedNamespace !== 'all' ? selectedNamespace : 'default'
    return `apiVersion: autoscaling/v2
kind: HorizontalPodAutoscaler
metadata:
  name: sample-hpa
  namespace: ${ns}
spec:
  scaleTargetRef:
    apiVersion: apps/v1
    kind: Deployment
    name: sample-deployment
  minReplicas: 1
  maxReplicas: 10
  metrics:
    - type: Resource
      resource:
        name: cpu
        target:
          type: Utilization
          averageUtilization: 80
`
  }, [selectedNamespace])

  const showNamespaceColumn = selectedNamespace === 'all'

  return (
    <div className="flex flex-col h-[calc(100vh-4rem)] gap-4">
      <div className="flex items-center justify-between shrink-0">
        <div>
          <h1 className="text-3xl font-bold text-white">{tr('hpas.title', 'Horizontal Pod Autoscalers')}</h1>
          <p className="mt-2 text-slate-400">
            {tr('hpas.subtitle', 'Manage horizontal pod autoscaling policies across namespaces.')}
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
              {tr('hpas.create', 'Create HPA')}
            </button>
          )}
          <button
            type="button"
            onClick={handleRefresh}
            disabled={isRefreshing}
            title={tr('hpas.refreshTitle', 'Force refresh')}
            className="btn btn-primary flex items-center gap-2 disabled:opacity-50 disabled:cursor-not-allowed"
          >
            <RefreshCw className={`w-4 h-4 ${isRefreshing ? 'animate-spin' : ''}`} />
            {tr('hpas.refresh', 'Refresh')}
          </button>
        </div>
      </div>

      <HPAFilters
        searchQuery={searchQuery}
        setSearchQuery={setSearchQuery}
        selectedNamespace={selectedNamespace}
        setSelectedNamespace={setSelectedNamespace}
        namespaces={namespaces}
        searchPlaceholder={tr('hpas.searchPlaceholder', 'Search HPAs by name...')}
        allNamespacesLabel={tr('hpas.allNamespaces', 'All namespaces')}
      />

      <div className="grid grid-cols-2 lg:grid-cols-3 gap-3 shrink-0">
        <div className="rounded-lg border border-slate-700 bg-slate-900/50 px-4 py-3">
          <p className="text-[11px] sm:text-xs leading-4 whitespace-nowrap text-slate-400">{tr('hpas.stats.total', 'Total')}</p>
          <p className="text-lg text-white font-semibold mt-1">{summary.total}</p>
        </div>
        <div className="rounded-lg border border-emerald-700/40 bg-emerald-900/10 px-4 py-3">
          <p className="text-[11px] sm:text-xs leading-4 whitespace-nowrap text-emerald-300">{tr('hpas.stats.active', 'Active')}</p>
          <p className="text-lg text-white font-semibold mt-1">{summary.active}</p>
        </div>
        <div className="rounded-lg border border-slate-700 bg-slate-900/50 px-4 py-3">
          <p className="text-[11px] sm:text-xs leading-4 whitespace-nowrap text-slate-400">{tr('hpas.stats.inactive', 'Inactive')}</p>
          <p className="text-lg text-white font-semibold mt-1">{summary.inactive}</p>
        </div>
      </div>

      {searchQuery && (
        <p className="text-sm text-slate-400 shrink-0">
          {tr('hpas.matchCount', '{{count}} HPA{{suffix}} match.', {
            count: filteredHPAs.length,
            suffix: filteredHPAs.length === 1 ? '' : 's',
          })}
        </p>
      )}

      <HPATable
        pagedHPAs={pagedHPAs}
        sortedHPAsLength={sortedHPAs.length}
        isLoading={isLoading}
        showNamespaceColumn={showNamespaceColumn}
        sortKey={sortKey}
        setSortKey={setSortKey}
        sortDir={sortDir}
        setSortDir={setSortDir}
        currentPage={currentPage}
        setCurrentPage={setCurrentPage}
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
          title={tr('hpas.createTitle', 'Create HPA from YAML')}
          initialYaml={createHPAYamlTemplate}
          namespace={selectedNamespace !== 'all' ? selectedNamespace : undefined}
          onClose={() => setCreateDialogOpen(false)}
          onCreated={() => {
            queryClient.invalidateQueries({ queryKey: ['workloads', 'hpas'] })
          }}
        />
      )}
    </div>
  )
}
