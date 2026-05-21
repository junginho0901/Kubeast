import { useEffect, useMemo, useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { useTranslation } from 'react-i18next'
import { api, type ResourceClaimItem } from '@/services/api'
import { useKubeWatchList } from '@/services/useKubeWatchList'
import { useResourceDetail } from '@/components/ResourceDetailContext'
import ResourceYamlCreateDialog from '@/components/ResourceYamlCreateDialog'
import { useAdaptiveTable } from '@/hooks/useAdaptiveTable'
import { useAIContext } from '@/hooks/useAIContext'
import { usePermission } from '@/hooks/usePermission'
import { summarizeList } from '@/utils/aiContext/summarizeList'
import { buildResourceLink } from '@/utils/resourceLink'
import { Plus, RefreshCw } from 'lucide-react'
import { parseAgeSeconds, type SortKey } from './resourceclaims/resourceClaimsHelpers'
import { applyResourceClaimWatchEvent } from './resourceclaims/resourceClaimsWatchNormalize'
import { ResourceClaimsFilters } from './resourceclaims/ResourceClaimsFilters'
import { ResourceClaimsTable } from './resourceclaims/ResourceClaimsTable'

export default function ResourceClaims() {
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

  const { data: resourceClaims, isLoading } = useQuery({
    queryKey: ['gpu', 'resourceclaims', selectedNamespace],
    queryFn: () => (
      selectedNamespace === 'all'
        ? api.getAllResourceClaims(false)
        : api.getResourceClaims(selectedNamespace, false)
    ),
  })
  const { has } = usePermission()
  const canCreate = has('resource.resourceclaim.create')

  useKubeWatchList({
    enabled: true,
    queryKey: ['gpu', 'resourceclaims', selectedNamespace],
    path: selectedNamespace === 'all'
      ? '/api/v1/resourceclaims'
      : `/api/v1/namespaces/${selectedNamespace}/resourceclaims`,
    query: 'watch=1',
    applyEvent: (prev, event) => applyResourceClaimWatchEvent(prev as ResourceClaimItem[] | undefined, event),
    onEvent: (event) => {
      if (event?.type === 'DELETED') return
      const name = event?.object?.name || event?.object?.metadata?.name
      const ns = event?.object?.namespace || event?.object?.metadata?.namespace
      if (name && ns) {
        queryClient.invalidateQueries({ queryKey: ['resourceclaim-describe', ns, name] })
      }
    },
  })

  const filteredResourceClaims = useMemo(() => {
    if (!Array.isArray(resourceClaims)) return [] as ResourceClaimItem[]
    if (!searchQuery.trim()) return resourceClaims
    const q = searchQuery.toLowerCase()
    return resourceClaims.filter((item) => (
      item.name.toLowerCase().includes(q)
      || item.namespace.toLowerCase().includes(q)
      || String(item.allocation_status || 'Pending').toLowerCase().includes(q)
    ))
  }, [resourceClaims, searchQuery])

  const summary = useMemo(() => {
    const total = filteredResourceClaims.length
    let allocated = 0
    let reserved = 0
    let pending = 0

    for (const item of filteredResourceClaims) {
      if (item.allocation_status === 'Allocated') allocated += 1
      else if (item.allocation_status === 'Reserved') reserved += 1
      else pending += 1
    }

    return { total, allocated, reserved, pending }
  }, [filteredResourceClaims])

  const sortedResourceClaims = useMemo(() => {
    if (!sortKey) return filteredResourceClaims
    const list = [...filteredResourceClaims]

    const getValue = (item: ResourceClaimItem): string | number => {
      switch (sortKey) {
        case 'name':
          return item.name
        case 'namespace':
          return item.namespace
        case 'status':
          return item.allocation_status || 'Pending'
        case 'requests':
          return item.request_count || 0
        case 'age':
          return parseAgeSeconds(item.created_at)
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
  }, [filteredResourceClaims, sortDir, sortKey])

  const { containerRef: tableContainerRef, bodyRef: tableBodyRef, theadRef, firstRowRef, rowsPerPage } = useAdaptiveTable({
    recalculationKey: sortedResourceClaims.length,
  })
  const totalPages = Math.max(1, Math.ceil(sortedResourceClaims.length / rowsPerPage))

  useEffect(() => {
    setCurrentPage(1)
  }, [searchQuery, selectedNamespace])

  useEffect(() => {
    if (currentPage > totalPages) setCurrentPage(totalPages)
  }, [currentPage, totalPages])

  const pagedResourceClaims = useMemo(() => {
    const start = (currentPage - 1) * rowsPerPage
    return sortedResourceClaims.slice(start, start + rowsPerPage)
  }, [sortedResourceClaims, currentPage, rowsPerPage])

  // 플로팅 AI 위젯용 스냅샷 (DRA)
  const aiSnapshot = useMemo(() => {
    if (!Array.isArray(resourceClaims) || resourceClaims.length === 0) return null
    const nsLabel = selectedNamespace === 'all' ? '전체 네임스페이스' : selectedNamespace
    const total = resourceClaims.length
    return {
      source: 'base' as const,
      summary: `${nsLabel} ResourceClaim ${total}개 (DRA)`,
      data: {
        filters: { namespace: selectedNamespace, search: searchQuery || undefined },
        stats: { total },
        ...summarizeList(pagedResourceClaims as unknown as Record<string, unknown>[], {
          total: sortedResourceClaims.length,
          currentPage,
          pageSize: rowsPerPage,
          topN: rowsPerPage,
          pickFields: ['name', 'namespace', 'status'],
          linkBuilder: (r) => {
            const rc = r as unknown as ResourceClaimItem
            return buildResourceLink('ResourceClaim', rc.namespace, rc.name)
          },
        }),
      },
    }
  }, [resourceClaims, pagedResourceClaims, sortedResourceClaims.length, currentPage, rowsPerPage, selectedNamespace, searchQuery])

  useAIContext(aiSnapshot, [aiSnapshot])

  const handleRefresh = async () => {
    if (isRefreshing) return
    setIsRefreshing(true)
    try {
      const data = selectedNamespace === 'all'
        ? await api.getAllResourceClaims(true)
        : await api.getResourceClaims(selectedNamespace, true)
      queryClient.removeQueries({ queryKey: ['gpu', 'resourceclaims', selectedNamespace] })
      queryClient.setQueryData(['gpu', 'resourceclaims', selectedNamespace], data)
    } catch (error) {
      console.error('ResourceClaims refresh failed:', error)
    }
    setTimeout(() => setIsRefreshing(false), 500)
  }

  const createResourceClaimYamlTemplate = useMemo(() => {
    const ns = selectedNamespace !== 'all' ? selectedNamespace : 'default'
    return `apiVersion: resource.k8s.io/v1beta1
kind: ResourceClaim
metadata:
  name: example-gpu-claim
  namespace: ${ns}
spec:
  devices:
    requests:
      - name: gpu
        deviceClassName: example-gpu-class
`
  }, [selectedNamespace])

  const showNamespaceColumn = selectedNamespace === 'all'

  return (
    <div className="flex flex-col h-[calc(100vh-4rem)] gap-4">
      <div className="flex items-center justify-between shrink-0">
        <div>
          <h1 className="text-3xl font-bold text-white">{tr('resourceClaimsPage.title', 'Resource Claims')}</h1>
          <p className="mt-2 text-slate-400">{tr('resourceClaimsPage.subtitle', 'Manage DRA ResourceClaim resources.')}</p>
        </div>
        <div className="flex items-center gap-2">
          {canCreate && (
            <button
              type="button"
              onClick={() => setCreateDialogOpen(true)}
              className="btn btn-primary flex items-center gap-2"
            >
              <Plus className="w-4 h-4" />
              {tr('resourceClaimsPage.create', 'Create ResourceClaim')}
            </button>
          )}
          <button
            type="button"
            onClick={handleRefresh}
            disabled={isRefreshing}
            title={tr('resourceClaimsPage.refreshTitle', 'Force refresh')}
            className="btn btn-primary flex items-center gap-2 disabled:opacity-50 disabled:cursor-not-allowed"
          >
            <RefreshCw className={`w-4 h-4 ${isRefreshing ? 'animate-spin' : ''}`} />
            {tr('resourceClaimsPage.refresh', 'Refresh')}
          </button>
        </div>
      </div>

      <ResourceClaimsFilters
        searchQuery={searchQuery}
        setSearchQuery={setSearchQuery}
        selectedNamespace={selectedNamespace}
        setSelectedNamespace={setSelectedNamespace}
        namespaces={namespaces}
        searchPlaceholder={tr('resourceClaimsPage.searchPlaceholder', 'Search ResourceClaims by name...')}
        allNamespacesLabel={tr('resourceClaimsPage.allNamespaces', 'All namespaces')}
      />

      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3 shrink-0">
        <div className="rounded-lg border border-slate-700 bg-slate-900/50 px-4 py-3">
          <p className="text-[11px] sm:text-xs leading-4 whitespace-nowrap text-slate-400">{tr('resourceClaimsPage.stats.total', 'Total')}</p>
          <p className="text-lg text-white font-semibold mt-1">{summary.total}</p>
        </div>
        <div className="rounded-lg border border-emerald-700/40 bg-emerald-900/10 px-4 py-3">
          <p className="text-[11px] sm:text-xs leading-4 whitespace-nowrap text-emerald-300">{tr('resourceClaimsPage.stats.allocated', 'Allocated')}</p>
          <p className="text-lg text-white font-semibold mt-1">{summary.allocated}</p>
        </div>
        <div className="rounded-lg border border-cyan-700/40 bg-cyan-900/10 px-4 py-3">
          <p className="text-[11px] sm:text-xs leading-4 whitespace-nowrap text-cyan-300">{tr('resourceClaimsPage.stats.reserved', 'Reserved')}</p>
          <p className="text-lg text-white font-semibold mt-1">{summary.reserved}</p>
        </div>
        <div className="rounded-lg border border-amber-700/40 bg-amber-900/10 px-4 py-3">
          <p className="text-[11px] sm:text-xs leading-4 whitespace-nowrap text-amber-300">{tr('resourceClaimsPage.stats.pending', 'Pending')}</p>
          <p className="text-lg text-white font-semibold mt-1">{summary.pending}</p>
        </div>
      </div>

      {searchQuery && (
        <p className="text-sm text-slate-400 shrink-0">
          {tr('resourceClaimsPage.matchCount', '{{count}} ResourceClaim{{suffix}} match.', {
            count: filteredResourceClaims.length,
            suffix: filteredResourceClaims.length === 1 ? '' : 's',
          })}
        </p>
      )}

      <ResourceClaimsTable
        pagedResourceClaims={pagedResourceClaims}
        sortedResourceClaimsLength={sortedResourceClaims.length}
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
          title={tr('resourceClaimsPage.createTitle', 'Create ResourceClaim from YAML')}
          initialYaml={createResourceClaimYamlTemplate}
          namespace={selectedNamespace !== 'all' ? selectedNamespace : undefined}
          onClose={() => setCreateDialogOpen(false)}
          onCreated={() => {
            queryClient.invalidateQueries({ queryKey: ['gpu', 'resourceclaims'] })
          }}
        />
      )}
    </div>
  )
}
