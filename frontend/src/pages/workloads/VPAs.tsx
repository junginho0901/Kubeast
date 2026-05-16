import { useEffect, useMemo, useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { useTranslation } from 'react-i18next'
import { api, type VPAInfo } from '@/services/api'
import { useKubeWatchList } from '@/services/useKubeWatchList'
import { useResourceDetail } from '@/components/ResourceDetailContext'
import ResourceYamlCreateDialog from '@/components/ResourceYamlCreateDialog'
import { useAdaptiveTable } from '@/hooks/useAdaptiveTable'
import { useAIContext } from '@/hooks/useAIContext'
import { usePermission } from '@/hooks/usePermission'
import { summarizeList } from '@/utils/aiContext/summarizeList'
import { buildResourceLink } from '@/utils/resourceLink'
import { Plus, RefreshCw } from 'lucide-react'
import { parseAgeSeconds, type SortKey } from './vpas/vpaHelpers'
import { applyVPAWatchEvent } from './vpas/vpaWatchNormalize'
import { VPAFilters } from './vpas/VPAFilters'
import { VPATable } from './vpas/VPATable'

export default function VPAs() {
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

  const { data: vpas, isLoading } = useQuery({
    queryKey: ['workloads', 'vpas', selectedNamespace],
    queryFn: () => (
      selectedNamespace === 'all'
        ? api.getAllVPAs(false)
        : api.getVPAs(selectedNamespace, false)
    ),
  })
  const { has } = usePermission()
  const canCreate = has('resource.vpa.create')

  useKubeWatchList({
    enabled: true,
    queryKey: ['workloads', 'vpas', selectedNamespace],
    path: selectedNamespace === 'all'
      ? '/apis/autoscaling.k8s.io/v1/verticalpodautoscalers'
      : `/apis/autoscaling.k8s.io/v1/namespaces/${selectedNamespace}/verticalpodautoscalers`,
    query: 'watch=1',
    applyEvent: (prev, event) => applyVPAWatchEvent(prev as VPAInfo[] | undefined, event),
  })

  const filteredVPAs = useMemo(() => {
    if (!Array.isArray(vpas)) return [] as VPAInfo[]
    if (!searchQuery.trim()) return vpas
    const q = searchQuery.toLowerCase()
    return vpas.filter((v) =>
      v.name.toLowerCase().includes(q) ||
      v.namespace.toLowerCase().includes(q) ||
      (v.target_ref || '').toLowerCase().includes(q),
    )
  }, [vpas, searchQuery])

  const summary = useMemo(() => {
    const total = filteredVPAs.length
    let provided = 0
    let notProvided = 0

    for (const v of filteredVPAs) {
      if (v.provided === 'True') provided += 1
      else notProvided += 1
    }

    return { total, provided, notProvided }
  }, [filteredVPAs])

  const sortedVPAs = useMemo(() => {
    if (!sortKey) return filteredVPAs
    const list = [...filteredVPAs]

    const getValue = (v: VPAInfo): string | number => {
      switch (sortKey) {
        case 'name': return v.name
        case 'target': return v.target_ref || ''
        case 'updateMode': return v.update_mode || ''
        case 'cpu': return v.cpu_target || ''
        case 'memory': return v.memory_target || ''
        case 'provided': return v.provided || ''
        case 'age': return parseAgeSeconds(v.created_at)
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
  }, [filteredVPAs, sortDir, sortKey])

  const { containerRef: tableContainerRef, bodyRef: tableBodyRef, theadRef, firstRowRef, rowsPerPage } = useAdaptiveTable({
    recalculationKey: sortedVPAs.length,
  })
  const totalPages = Math.max(1, Math.ceil(sortedVPAs.length / rowsPerPage))

  useEffect(() => {
    setCurrentPage(1)
  }, [searchQuery, selectedNamespace])

  useEffect(() => {
    if (currentPage > totalPages) {
      setCurrentPage(totalPages)
    }
  }, [currentPage, totalPages])

  const pagedVPAs = useMemo(() => {
    const start = (currentPage - 1) * rowsPerPage
    return sortedVPAs.slice(start, start + rowsPerPage)
  }, [sortedVPAs, currentPage, rowsPerPage])

  // 플로팅 AI 위젯용 스냅샷
  const aiSnapshot = useMemo(() => {
    if (!Array.isArray(vpas) || vpas.length === 0) return null
    const nsLabel = selectedNamespace === 'all' ? '전체 네임스페이스' : selectedNamespace
    const total = vpas.length
    return {
      source: 'base' as const,
      summary: `${nsLabel} VPA ${total}개`,
      data: {
        filters: { namespace: selectedNamespace, search: searchQuery || undefined },
        stats: { total },
        ...summarizeList(pagedVPAs as unknown as Record<string, unknown>[], {
          total: sortedVPAs.length,
          currentPage,
          pageSize: rowsPerPage,
          topN: rowsPerPage,
          pickFields: ['name', 'namespace', 'target_ref_kind', 'target_ref_name', 'update_mode', 'cpu_target', 'memory_target', 'provided'],
          linkBuilder: (v) => {
            const vpa = v as unknown as VPAInfo
            return buildResourceLink('VerticalPodAutoscaler', vpa.namespace, vpa.name)
          },
        }),
      },
    }
  }, [vpas, pagedVPAs, sortedVPAs.length, currentPage, rowsPerPage, selectedNamespace, searchQuery])

  useAIContext(aiSnapshot, [aiSnapshot])

  const handleRefresh = async () => {
    if (isRefreshing) return
    setIsRefreshing(true)
    try {
      const data = selectedNamespace === 'all'
        ? await api.getAllVPAs(true)
        : await api.getVPAs(selectedNamespace, true)
      queryClient.removeQueries({ queryKey: ['workloads', 'vpas', selectedNamespace] })
      queryClient.setQueryData(['workloads', 'vpas', selectedNamespace], data)
    } catch (error) {
      console.error('VPAs refresh failed:', error)
    }
    setTimeout(() => setIsRefreshing(false), 500)
  }

  const createVPAYamlTemplate = useMemo(() => {
    const ns = selectedNamespace !== 'all' ? selectedNamespace : 'default'
    return `apiVersion: autoscaling.k8s.io/v1
kind: VerticalPodAutoscaler
metadata:
  name: sample-vpa
  namespace: ${ns}
spec:
  targetRef:
    apiVersion: apps/v1
    kind: Deployment
    name: sample-deployment
  updatePolicy:
    updateMode: "Auto"
  resourcePolicy:
    containerPolicies:
      - containerName: "*"
        controlledResources:
          - cpu
          - memory
`
  }, [selectedNamespace])

  const showNamespaceColumn = selectedNamespace === 'all'

  return (
    <div className="flex flex-col h-[calc(100vh-4rem)] gap-4">
      <div className="flex items-center justify-between shrink-0">
        <div>
          <h1 className="text-3xl font-bold text-white">{tr('vpas.title', 'Vertical Pod Autoscalers')}</h1>
          <p className="mt-2 text-slate-400">
            {tr('vpas.subtitle', 'Manage vertical pod autoscaling recommendations across namespaces.')}
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
              {tr('vpas.create', 'Create VPA')}
            </button>
          )}
          <button
            type="button"
            onClick={handleRefresh}
            disabled={isRefreshing}
            title={tr('vpas.refreshTitle', 'Force refresh')}
            className="btn btn-primary flex items-center gap-2 disabled:opacity-50 disabled:cursor-not-allowed"
          >
            <RefreshCw className={`w-4 h-4 ${isRefreshing ? 'animate-spin' : ''}`} />
            {tr('vpas.refresh', 'Refresh')}
          </button>
        </div>
      </div>

      <VPAFilters
        searchQuery={searchQuery}
        setSearchQuery={setSearchQuery}
        selectedNamespace={selectedNamespace}
        setSelectedNamespace={setSelectedNamespace}
        namespaces={namespaces}
        searchPlaceholder={tr('vpas.searchPlaceholder', 'Search VPAs by name...')}
        allNamespacesLabel={tr('vpas.allNamespaces', 'All namespaces')}
      />

      <div className="grid grid-cols-2 lg:grid-cols-3 gap-3 shrink-0">
        <div className="rounded-lg border border-slate-700 bg-slate-900/50 px-4 py-3">
          <p className="text-[11px] sm:text-xs leading-4 whitespace-nowrap text-slate-400">{tr('vpas.stats.total', 'Total')}</p>
          <p className="text-lg text-white font-semibold mt-1">{summary.total}</p>
        </div>
        <div className="rounded-lg border border-emerald-700/40 bg-emerald-900/10 px-4 py-3">
          <p className="text-[11px] sm:text-xs leading-4 whitespace-nowrap text-emerald-300">{tr('vpas.stats.provided', 'Provided')}</p>
          <p className="text-lg text-white font-semibold mt-1">{summary.provided}</p>
        </div>
        <div className="rounded-lg border border-amber-700/40 bg-amber-900/10 px-4 py-3">
          <p className="text-[11px] sm:text-xs leading-4 whitespace-nowrap text-amber-300">{tr('vpas.stats.notProvided', 'Not Provided')}</p>
          <p className="text-lg text-white font-semibold mt-1">{summary.notProvided}</p>
        </div>
      </div>

      {searchQuery && (
        <p className="text-sm text-slate-400 shrink-0">
          {tr('vpas.matchCount', '{{count}} VPA{{suffix}} match.', {
            count: filteredVPAs.length,
            suffix: filteredVPAs.length === 1 ? '' : 's',
          })}
        </p>
      )}

      <VPATable
        pagedVPAs={pagedVPAs}
        sortedVPAsLength={sortedVPAs.length}
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
          title={tr('vpas.createTitle', 'Create VPA from YAML')}
          initialYaml={createVPAYamlTemplate}
          namespace={selectedNamespace !== 'all' ? selectedNamespace : undefined}
          onClose={() => setCreateDialogOpen(false)}
          onCreated={() => {
            queryClient.invalidateQueries({ queryKey: ['workloads', 'vpas'] })
          }}
        />
      )}
    </div>
  )
}
