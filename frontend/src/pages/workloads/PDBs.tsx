import { useEffect, useMemo, useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { useTranslation } from 'react-i18next'
import { api, type PDBInfo } from '@/services/api'
import { useKubeWatchList } from '@/services/useKubeWatchList'
import { useResourceDetail } from '@/components/ResourceDetailContext'
import ResourceYamlCreateDialog from '@/components/ResourceYamlCreateDialog'
import { useAdaptiveTable } from '@/hooks/useAdaptiveTable'
import { useAIContext } from '@/hooks/useAIContext'
import { usePermission } from '@/hooks/usePermission'
import { summarizeList } from '@/utils/aiContext/summarizeList'
import { buildResourceLink } from '@/utils/resourceLink'
import { Plus, RefreshCw } from 'lucide-react'
import { parseAgeSeconds, type SortKey } from './pdbs/pdbHelpers'
import { applyPDBWatchEvent } from './pdbs/pdbWatchNormalize'
import { PDBFilters } from './pdbs/PDBFilters'
import { PDBTable } from './pdbs/PDBTable'

export default function PDBs() {
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

  const { data: pdbs, isLoading } = useQuery({
    queryKey: ['workloads', 'pdbs', selectedNamespace],
    queryFn: () => (
      selectedNamespace === 'all'
        ? api.getAllPDBs(false)
        : api.getPDBs(selectedNamespace, false)
    ),
  })
  const { has } = usePermission()
  const canCreate = has('resource.pdb.create')

  useKubeWatchList({
    enabled: true,
    queryKey: ['workloads', 'pdbs', selectedNamespace],
    path: selectedNamespace === 'all'
      ? '/apis/policy/v1/poddisruptionbudgets'
      : `/apis/policy/v1/namespaces/${selectedNamespace}/poddisruptionbudgets`,
    query: 'watch=1',
    applyEvent: (prev, event) => applyPDBWatchEvent(prev as PDBInfo[] | undefined, event),
  })

  const filteredPDBs = useMemo(() => {
    if (!Array.isArray(pdbs)) return [] as PDBInfo[]
    if (!searchQuery.trim()) return pdbs
    const q = searchQuery.toLowerCase()
    return pdbs.filter((p) =>
      p.name.toLowerCase().includes(q) ||
      p.namespace.toLowerCase().includes(q),
    )
  }, [pdbs, searchQuery])

  const summary = useMemo(() => {
    const total = filteredPDBs.length
    let healthy = 0
    let disrupted = 0

    for (const p of filteredPDBs) {
      if (p.disruptions_allowed > 0 || p.current_healthy >= p.desired_healthy) healthy += 1
      else disrupted += 1
    }

    return { total, healthy, disrupted }
  }, [filteredPDBs])

  const sortedPDBs = useMemo(() => {
    if (!sortKey) return filteredPDBs
    const list = [...filteredPDBs]

    const getValue = (p: PDBInfo): string | number => {
      switch (sortKey) {
        case 'name': return p.name
        case 'minAvailable': return p.min_available ?? ''
        case 'maxUnavailable': return p.max_unavailable ?? ''
        case 'allowedDisruptions': return p.disruptions_allowed
        case 'currentHealthy': return p.current_healthy
        case 'desiredHealthy': return p.desired_healthy
        case 'age': return parseAgeSeconds(p.created_at)
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
  }, [filteredPDBs, sortDir, sortKey])

  const { containerRef: tableContainerRef, bodyRef: tableBodyRef, theadRef, firstRowRef, rowsPerPage } = useAdaptiveTable({
    recalculationKey: sortedPDBs.length,
  })
  const totalPages = Math.max(1, Math.ceil(sortedPDBs.length / rowsPerPage))

  useEffect(() => {
    setCurrentPage(1)
  }, [searchQuery, selectedNamespace])

  useEffect(() => {
    if (currentPage > totalPages) {
      setCurrentPage(totalPages)
    }
  }, [currentPage, totalPages])

  const pagedPDBs = useMemo(() => {
    const start = (currentPage - 1) * rowsPerPage
    return sortedPDBs.slice(start, start + rowsPerPage)
  }, [sortedPDBs, currentPage, rowsPerPage])

  // 플로팅 AI 위젯용 스냅샷
  const aiSnapshot = useMemo(() => {
    if (!Array.isArray(pdbs) || pdbs.length === 0) return null
    const nsLabel = selectedNamespace === 'all' ? '전체 네임스페이스' : selectedNamespace
    const total = pdbs.length
    const unhealthy = pdbs.filter((p) => p.current_healthy < p.desired_healthy).length
    const prefix = unhealthy > 0 ? '⚠️ ' : ''
    return {
      source: 'base' as const,
      summary: `${prefix}${nsLabel} PDB ${total}개${unhealthy ? ` (미달 ${unhealthy})` : ''}`,
      data: {
        filters: { namespace: selectedNamespace, search: searchQuery || undefined },
        stats: { total, unhealthy },
        ...summarizeList(pagedPDBs as unknown as Record<string, unknown>[], {
          total: sortedPDBs.length,
          currentPage,
          pageSize: rowsPerPage,
          topN: rowsPerPage,
          pickFields: ['name', 'namespace', 'min_available', 'max_unavailable', 'current_healthy', 'desired_healthy', 'disruptions_allowed', 'expected_pods'],
          filterProblematic: (p) => {
            const pdb = p as unknown as PDBInfo
            return pdb.current_healthy < pdb.desired_healthy
          },
          linkBuilder: (p) => {
            const pdb = p as unknown as PDBInfo
            return buildResourceLink('PodDisruptionBudget', pdb.namespace, pdb.name)
          },
        }),
      },
    }
  }, [pdbs, pagedPDBs, sortedPDBs.length, currentPage, rowsPerPage, selectedNamespace, searchQuery])

  useAIContext(aiSnapshot, [aiSnapshot])

  const handleRefresh = async () => {
    if (isRefreshing) return
    setIsRefreshing(true)
    try {
      const data = selectedNamespace === 'all'
        ? await api.getAllPDBs(true)
        : await api.getPDBs(selectedNamespace, true)
      queryClient.removeQueries({ queryKey: ['workloads', 'pdbs', selectedNamespace] })
      queryClient.setQueryData(['workloads', 'pdbs', selectedNamespace], data)
    } catch (error) {
      console.error('PDBs refresh failed:', error)
    }
    setTimeout(() => setIsRefreshing(false), 500)
  }

  const createPDBYamlTemplate = useMemo(() => {
    const ns = selectedNamespace !== 'all' ? selectedNamespace : 'default'
    return `apiVersion: policy/v1
kind: PodDisruptionBudget
metadata:
  name: sample-pdb
  namespace: ${ns}
spec:
  minAvailable: 1
  selector:
    matchLabels:
      app: sample
`
  }, [selectedNamespace])

  const showNamespaceColumn = selectedNamespace === 'all'

  return (
    <div className="flex flex-col h-[calc(100vh-4rem)] gap-4">
      <div className="flex items-center justify-between shrink-0">
        <div>
          <h1 className="text-3xl font-bold text-white">{tr('pdbs.title', 'Pod Disruption Budgets')}</h1>
          <p className="mt-2 text-slate-400">
            {tr('pdbs.subtitle', 'Manage pod disruption budgets across namespaces.')}
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
              {tr('pdbs.create', 'Create PDB')}
            </button>
          )}
          <button
            type="button"
            onClick={handleRefresh}
            disabled={isRefreshing}
            title={tr('pdbs.refreshTitle', 'Force refresh')}
            className="btn btn-primary flex items-center gap-2 disabled:opacity-50 disabled:cursor-not-allowed"
          >
            <RefreshCw className={`w-4 h-4 ${isRefreshing ? 'animate-spin' : ''}`} />
            {tr('pdbs.refresh', 'Refresh')}
          </button>
        </div>
      </div>

      <PDBFilters
        searchQuery={searchQuery}
        setSearchQuery={setSearchQuery}
        selectedNamespace={selectedNamespace}
        setSelectedNamespace={setSelectedNamespace}
        namespaces={namespaces}
        searchPlaceholder={tr('pdbs.searchPlaceholder', 'Search PDBs by name...')}
        allNamespacesLabel={tr('pdbs.allNamespaces', 'All namespaces')}
      />

      <div className="grid grid-cols-2 lg:grid-cols-3 gap-3 shrink-0">
        <div className="rounded-lg border border-slate-700 bg-slate-900/50 px-4 py-3">
          <p className="text-[11px] sm:text-xs leading-4 whitespace-nowrap text-slate-400">{tr('pdbs.stats.total', 'Total')}</p>
          <p className="text-lg text-white font-semibold mt-1">{summary.total}</p>
        </div>
        <div className="rounded-lg border border-emerald-700/40 bg-emerald-900/10 px-4 py-3">
          <p className="text-[11px] sm:text-xs leading-4 whitespace-nowrap text-emerald-300">{tr('pdbs.stats.healthy', 'Healthy')}</p>
          <p className="text-lg text-white font-semibold mt-1">{summary.healthy}</p>
        </div>
        <div className="rounded-lg border border-red-700/40 bg-red-900/10 px-4 py-3">
          <p className="text-[11px] sm:text-xs leading-4 whitespace-nowrap text-red-300">{tr('pdbs.stats.disrupted', 'Disrupted')}</p>
          <p className="text-lg text-white font-semibold mt-1">{summary.disrupted}</p>
        </div>
      </div>

      {searchQuery && (
        <p className="text-sm text-slate-400 shrink-0">
          {tr('pdbs.matchCount', '{{count}} PDB{{suffix}} match.', {
            count: filteredPDBs.length,
            suffix: filteredPDBs.length === 1 ? '' : 's',
          })}
        </p>
      )}

      <PDBTable
        pagedPDBs={pagedPDBs}
        sortedPDBsLength={sortedPDBs.length}
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
          title={tr('pdbs.createTitle', 'Create PDB from YAML')}
          initialYaml={createPDBYamlTemplate}
          namespace={selectedNamespace !== 'all' ? selectedNamespace : undefined}
          onClose={() => setCreateDialogOpen(false)}
          onCreated={() => {
            queryClient.invalidateQueries({ queryKey: ['workloads', 'pdbs'] })
          }}
        />
      )}
    </div>
  )
}
