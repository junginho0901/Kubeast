import { useEffect, useMemo, useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { useTranslation } from 'react-i18next'
import { api, type PVCInfo } from '@/services/api'
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
  parseQuantityToBytes,
  type SortKey,
} from './pvcs/pvcHelpers'
import { applyPvcWatchEvent } from './pvcs/pvcWatchNormalize'
import { PVCFilters } from './pvcs/PVCFilters'
import { PVCTable } from './pvcs/PVCTable'

export default function PersistentVolumeClaims() {
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

  const { data: pvcs, isLoading } = useQuery({
    queryKey: ['storage', 'pvcs', selectedNamespace],
    queryFn: () => api.getPVCs(selectedNamespace === 'all' ? undefined : selectedNamespace, false),
  })
  const { has } = usePermission()
  const canCreate = has('resource.pvc.create')

  useKubeWatchList({
    enabled: true,
    queryKey: ['storage', 'pvcs', selectedNamespace],
    path: selectedNamespace === 'all'
      ? '/api/v1/pvcs'
      : `/api/v1/namespaces/${selectedNamespace}/pvcs`,
    query: 'watch=1',
    applyEvent: (prev, event) => applyPvcWatchEvent(prev as PVCInfo[] | undefined, event),
  })

  const filteredPVCs = useMemo(() => {
    if (!Array.isArray(pvcs)) return [] as PVCInfo[]
    if (!searchQuery.trim()) return pvcs
    const q = searchQuery.toLowerCase()
    return pvcs.filter((pvc) => {
      return pvc.name.toLowerCase().includes(q)
        || pvc.namespace.toLowerCase().includes(q)
        || String(pvc.status || '').toLowerCase().includes(q)
        || String(pvc.storage_class || '').toLowerCase().includes(q)
        || String(pvc.volume_name || '').toLowerCase().includes(q)
        || String(pvc.requested || '').toLowerCase().includes(q)
        || String(pvc.capacity || '').toLowerCase().includes(q)
        || (pvc.access_modes || []).join(',').toLowerCase().includes(q)
    })
  }, [pvcs, searchQuery])

  const summary = useMemo(() => {
    const total = filteredPVCs.length
    let bound = 0
    let pending = 0
    let lost = 0

    for (const pvc of filteredPVCs) {
      const status = String(pvc.status || '').toLowerCase()
      if (status === 'bound') bound += 1
      else if (status === 'pending') pending += 1
      else if (status === 'lost') lost += 1
    }

    return { total, bound, pending, lost }
  }, [filteredPVCs])

  const sortedPVCs = useMemo(() => {
    if (!sortKey) return filteredPVCs
    const list = [...filteredPVCs]

    const getValue = (pvc: PVCInfo): string | number => {
      switch (sortKey) {
        case 'namespace':
          return pvc.namespace
        case 'name':
          return pvc.name
        case 'status':
          return pvc.status || ''
        case 'storageClass':
          return pvc.storage_class || ''
        case 'volume':
          return pvc.volume_name || ''
        case 'requested':
          return parseQuantityToBytes(pvc.requested) ?? -1
        case 'capacity':
          return parseQuantityToBytes(pvc.capacity) ?? -1
        case 'accessModes':
          return (pvc.access_modes || []).join(',')
        case 'age':
          return parseAgeSeconds(pvc.created_at)
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
      return sortDir === 'asc'
        ? String(av).localeCompare(String(bv))
        : String(bv).localeCompare(String(av))
    })

    return list
  }, [filteredPVCs, sortDir, sortKey])

  const { containerRef: tableContainerRef, bodyRef: tableBodyRef, theadRef, firstRowRef, rowsPerPage } = useAdaptiveTable({
    recalculationKey: sortedPVCs.length,
  })
  const totalPages = Math.max(1, Math.ceil(sortedPVCs.length / rowsPerPage))

  useEffect(() => {
    setCurrentPage(1)
  }, [searchQuery, selectedNamespace])

  useEffect(() => {
    if (currentPage > totalPages) {
      setCurrentPage(totalPages)
    }
  }, [currentPage, totalPages])

  const pagedPVCs = useMemo(() => {
    const start = (currentPage - 1) * rowsPerPage
    return sortedPVCs.slice(start, start + rowsPerPage)
  }, [sortedPVCs, currentPage, rowsPerPage])

  // 플로팅 AI 위젯용 스냅샷
  const aiSnapshot = useMemo(() => {
    if (!Array.isArray(pvcs) || pvcs.length === 0) return null
    const nsLabel = selectedNamespace === 'all' ? '전체 네임스페이스' : selectedNamespace
    const total = pvcs.length
    const pending = pvcs.filter((p) => /pending/i.test(p.status)).length
    const lost = pvcs.filter((p) => /lost/i.test(p.status)).length
    const prefix = pending > 0 || lost > 0 ? '⚠️ ' : ''
    return {
      source: 'base' as const,
      summary: `${prefix}${nsLabel} PVC ${total}개${pending ? `, Pending ${pending}` : ''}${lost ? `, Lost ${lost}` : ''}`,
      data: {
        filters: { namespace: selectedNamespace, search: searchQuery || undefined },
        stats: { total, pending, lost },
        ...summarizeList(pagedPVCs as unknown as Record<string, unknown>[], {
          total: sortedPVCs.length,
          currentPage,
          pageSize: rowsPerPage,
          topN: rowsPerPage,
          pickFields: ['name', 'namespace', 'status', 'volume', 'capacity', 'access_modes', 'storage_class'],
          filterProblematic: (p) => {
            const pvc = p as unknown as PVCInfo
            return /pending|lost/i.test(pvc.status)
          },
          linkBuilder: (p) => {
            const pvc = p as unknown as PVCInfo
            return buildResourceLink('PersistentVolumeClaim', pvc.namespace, pvc.name)
          },
        }),
      },
    }
  }, [pvcs, pagedPVCs, sortedPVCs.length, currentPage, rowsPerPage, selectedNamespace, searchQuery])

  useAIContext(aiSnapshot, [aiSnapshot])

  const handleRefresh = async () => {
    if (isRefreshing) return
    setIsRefreshing(true)
    try {
      const data = await api.getPVCs(selectedNamespace === 'all' ? undefined : selectedNamespace, true)
      queryClient.removeQueries({ queryKey: ['storage', 'pvcs', selectedNamespace] })
      queryClient.setQueryData(['storage', 'pvcs', selectedNamespace], data)
    } catch (error) {
      console.error('PVC refresh failed:', error)
    }
    setTimeout(() => setIsRefreshing(false), 500)
  }

  const createPvcYamlTemplate = useMemo(() => {
    const ns = selectedNamespace !== 'all' ? selectedNamespace : 'default'
    return `apiVersion: v1
kind: PersistentVolumeClaim
metadata:
  name: sample-pvc
  namespace: ${ns}
spec:
  accessModes:
    - ReadWriteOnce
  resources:
    requests:
      storage: 5Gi
`
  }, [selectedNamespace])

  const showNamespaceColumn = selectedNamespace === 'all'

  return (
    <div className="flex flex-col h-[calc(100vh-4rem)] gap-4">
      <div className="flex items-center justify-between shrink-0">
        <div>
          <h1 className="text-3xl font-bold text-white">{tr('pvcs.title', 'Persistent Volume Claims')}</h1>
          <p className="mt-2 text-slate-400">{tr('pvcs.subtitle', 'Inspect and manage PVCs across namespaces.')}</p>
        </div>
        <div className="flex items-center gap-2">
          {canCreate && (
            <button
              type="button"
              onClick={() => setCreateDialogOpen(true)}
              className="btn btn-primary flex items-center gap-2"
            >
              <Plus className="w-4 h-4" />
              {tr('pvcs.create', 'Create PVC')}
            </button>
          )}
          <button
            type="button"
            onClick={handleRefresh}
            disabled={isRefreshing}
            title={tr('pvcs.refreshTitle', 'Force refresh')}
            className="btn btn-primary flex items-center gap-2 disabled:opacity-50 disabled:cursor-not-allowed"
          >
            <RefreshCw className={`w-4 h-4 ${isRefreshing ? 'animate-spin' : ''}`} />
            {tr('pvcs.refresh', 'Refresh')}
          </button>
        </div>
      </div>

      <PVCFilters
        searchQuery={searchQuery}
        setSearchQuery={setSearchQuery}
        selectedNamespace={selectedNamespace}
        setSelectedNamespace={setSelectedNamespace}
        namespaces={namespaces}
        searchPlaceholder={tr('pvcs.searchPlaceholder', 'Search PVCs by name...')}
        allNamespacesLabel={tr('pvcs.allNamespaces', 'All namespaces')}
      />

      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3 shrink-0">
        <div className="rounded-lg border border-slate-700 bg-slate-900/50 px-4 py-3">
          <p className="text-[11px] sm:text-xs leading-4 whitespace-nowrap text-slate-400">{tr('pvcs.stats.total', 'Total')}</p>
          <p className="text-lg text-white font-semibold mt-1">{summary.total}</p>
        </div>
        <div className="rounded-lg border border-emerald-700/40 bg-emerald-900/10 px-4 py-3">
          <p className="text-[11px] sm:text-xs leading-4 whitespace-nowrap text-emerald-300">{tr('pvcs.stats.bound', 'Bound')}</p>
          <p className="text-lg text-white font-semibold mt-1">{summary.bound}</p>
        </div>
        <div className="rounded-lg border border-amber-700/40 bg-amber-900/10 px-4 py-3">
          <p className="text-[11px] sm:text-xs leading-4 whitespace-nowrap text-amber-300">{tr('pvcs.stats.pending', 'Pending')}</p>
          <p className="text-lg text-white font-semibold mt-1">{summary.pending}</p>
        </div>
        <div className="rounded-lg border border-red-700/40 bg-red-900/10 px-4 py-3">
          <p className="text-[11px] sm:text-xs leading-4 whitespace-nowrap text-red-300">{tr('pvcs.stats.lost', 'Lost')}</p>
          <p className="text-lg text-white font-semibold mt-1">{summary.lost}</p>
        </div>
      </div>

      {searchQuery && (
        <p className="text-sm text-slate-400 shrink-0">
          {tr('pvcs.matchCount', '{{count}} pvc{{suffix}} match.', {
            count: filteredPVCs.length,
            suffix: filteredPVCs.length === 1 ? '' : 's',
          })}
        </p>
      )}

      <PVCTable
        pagedPVCs={pagedPVCs}
        sortedPVCsLength={sortedPVCs.length}
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
          title={tr('pvcs.createTitle', 'Create PersistentVolumeClaim from YAML')}
          initialYaml={createPvcYamlTemplate}
          namespace={selectedNamespace !== 'all' ? selectedNamespace : undefined}
          onClose={() => setCreateDialogOpen(false)}
          onCreated={() => {
            queryClient.invalidateQueries({ queryKey: ['storage', 'pvcs'] })
          }}
        />
      )}
    </div>
  )
}
