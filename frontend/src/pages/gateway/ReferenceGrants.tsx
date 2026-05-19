import { useEffect, useMemo, useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { useTranslation } from 'react-i18next'
import { api, type ReferenceGrantInfo } from '@/services/api'
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
  formatFrom,
  formatTo,
  type SortKey,
} from './referencegrants/referenceGrantHelpers'
import { applyReferenceGrantWatchEvent } from './referencegrants/referenceGrantWatchNormalize'
import { ReferenceGrantFilters } from './referencegrants/ReferenceGrantFilters'
import { ReferenceGrantTable } from './referencegrants/ReferenceGrantTable'

export default function ReferenceGrants() {
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

  const { data: referenceGrants, isLoading } = useQuery({
    queryKey: ['gateway', 'referencegrants', selectedNamespace],
    queryFn: () => (
      selectedNamespace === 'all'
        ? api.getAllReferenceGrants(false)
        : api.getReferenceGrants(selectedNamespace, false)
    ),
  })
  const { has } = usePermission()
  const canCreate = has('resource.referencegrant.create')

  useKubeWatchList({
    enabled: true,
    queryKey: ['gateway', 'referencegrants', selectedNamespace],
    path: selectedNamespace === 'all'
      ? '/api/v1/referencegrants'
      : `/api/v1/namespaces/${selectedNamespace}/referencegrants`,
    query: 'watch=1',
    applyEvent: (prev, event) => applyReferenceGrantWatchEvent(prev as ReferenceGrantInfo[] | undefined, event),
    onEvent: (event) => {
      if (event?.type === 'DELETED') return
      const name = event?.object?.name || event?.object?.metadata?.name
      const ns = event?.object?.namespace || event?.object?.metadata?.namespace
      if (name && ns) {
        queryClient.invalidateQueries({ queryKey: ['referencegrant-describe', ns, name] })
      }
    },
  })

  const filteredReferenceGrants = useMemo(() => {
    if (!Array.isArray(referenceGrants)) return [] as ReferenceGrantInfo[]
    if (!searchQuery.trim()) return referenceGrants
    const q = searchQuery.toLowerCase()
    return referenceGrants.filter((item) => (
      item.name.toLowerCase().includes(q)
      || item.namespace.toLowerCase().includes(q)
      || formatFrom(item).toLowerCase().includes(q)
      || formatTo(item).toLowerCase().includes(q)
    ))
  }, [referenceGrants, searchQuery])

  const summary = useMemo(() => {
    const total = filteredReferenceGrants.length
    let withFrom = 0
    let withTo = 0
    let withLabels = 0

    for (const item of filteredReferenceGrants) {
      if ((item.from || []).length > 0) withFrom += 1
      if ((item.to || []).length > 0) withTo += 1
      if (Object.keys(item.labels || {}).length > 0) withLabels += 1
    }

    return { total, withFrom, withTo, withLabels }
  }, [filteredReferenceGrants])

  const sortedReferenceGrants = useMemo(() => {
    if (!sortKey) return filteredReferenceGrants
    const list = [...filteredReferenceGrants]

    const getValue = (item: ReferenceGrantInfo): string | number => {
      switch (sortKey) {
        case 'name':
          return item.name
        case 'namespace':
          return item.namespace
        case 'from':
          return (item.from || []).length
        case 'to':
          return (item.to || []).length
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
  }, [filteredReferenceGrants, sortDir, sortKey])

  const { containerRef: tableContainerRef, bodyRef: tableBodyRef, theadRef, firstRowRef, rowsPerPage } = useAdaptiveTable({
    recalculationKey: sortedReferenceGrants.length,
  })
  const totalPages = Math.max(1, Math.ceil(sortedReferenceGrants.length / rowsPerPage))

  useEffect(() => {
    setCurrentPage(1)
  }, [searchQuery, selectedNamespace])

  useEffect(() => {
    if (currentPage > totalPages) setCurrentPage(totalPages)
  }, [currentPage, totalPages])

  const pagedReferenceGrants = useMemo(() => {
    const start = (currentPage - 1) * rowsPerPage
    return sortedReferenceGrants.slice(start, start + rowsPerPage)
  }, [sortedReferenceGrants, currentPage, rowsPerPage])

  // 플로팅 AI 위젯용 스냅샷
  const aiSnapshot = useMemo(() => {
    if (!Array.isArray(referenceGrants) || referenceGrants.length === 0) return null
    const nsLabel = selectedNamespace === 'all' ? '전체 네임스페이스' : selectedNamespace
    const total = referenceGrants.length
    return {
      source: 'base' as const,
      summary: `${nsLabel} ReferenceGrant ${total}개`,
      data: {
        filters: { namespace: selectedNamespace, search: searchQuery || undefined },
        stats: { total },
        ...summarizeList(pagedReferenceGrants as unknown as Record<string, unknown>[], {
          total: sortedReferenceGrants.length,
          currentPage,
          pageSize: rowsPerPage,
          topN: rowsPerPage,
          pickFields: ['name', 'namespace', 'from', 'to'],
          linkBuilder: (r) => {
            const rg = r as unknown as ReferenceGrantInfo
            return buildResourceLink('ReferenceGrant', rg.namespace, rg.name)
          },
        }),
      },
    }
  }, [referenceGrants, pagedReferenceGrants, sortedReferenceGrants.length, currentPage, rowsPerPage, selectedNamespace, searchQuery])

  useAIContext(aiSnapshot, [aiSnapshot])

  const handleRefresh = async () => {
    if (isRefreshing) return
    setIsRefreshing(true)
    try {
      const data = selectedNamespace === 'all'
        ? await api.getAllReferenceGrants(true)
        : await api.getReferenceGrants(selectedNamespace, true)
      queryClient.removeQueries({ queryKey: ['gateway', 'referencegrants', selectedNamespace] })
      queryClient.setQueryData(['gateway', 'referencegrants', selectedNamespace], data)
    } catch (error) {
      console.error('ReferenceGrants refresh failed:', error)
    }
    setTimeout(() => setIsRefreshing(false), 500)
  }

  const createReferenceGrantYamlTemplate = useMemo(() => {
    const ns = selectedNamespace !== 'all' ? selectedNamespace : 'default'
    return `apiVersion: gateway.networking.k8s.io/v1beta1
kind: ReferenceGrant
metadata:
  name: sample-referencegrant
  namespace: ${ns}
spec:
  from:
    - group: gateway.networking.k8s.io
      kind: HTTPRoute
      namespace: ${ns}
  to:
    - group: ""
      kind: Service
`
  }, [selectedNamespace])

  const showNamespaceColumn = selectedNamespace === 'all'

  return (
    <div className="flex flex-col h-[calc(100vh-4rem)] gap-4">
      <div className="flex items-center justify-between shrink-0">
        <div>
          <h1 className="text-3xl font-bold text-white">{tr('referenceGrantsPage.title', 'Reference Grants')}</h1>
          <p className="mt-2 text-slate-400">{tr('referenceGrantsPage.subtitle', 'Inspect and manage Gateway API ReferenceGrant resources across namespaces.')}</p>
        </div>
        <div className="flex items-center gap-2">
          {canCreate && (
            <button
              type="button"
              onClick={() => setCreateDialogOpen(true)}
              className="btn btn-primary flex items-center gap-2"
            >
              <Plus className="w-4 h-4" />
              {tr('referenceGrantsPage.create', 'Create ReferenceGrant')}
            </button>
          )}
          <button
            type="button"
            onClick={handleRefresh}
            disabled={isRefreshing}
            title={tr('referenceGrantsPage.refreshTitle', 'Force refresh')}
            className="btn btn-primary flex items-center gap-2 disabled:opacity-50 disabled:cursor-not-allowed"
          >
            <RefreshCw className={`w-4 h-4 ${isRefreshing ? 'animate-spin' : ''}`} />
            {tr('referenceGrantsPage.refresh', 'Refresh')}
          </button>
        </div>
      </div>

      <ReferenceGrantFilters
        searchQuery={searchQuery}
        setSearchQuery={setSearchQuery}
        selectedNamespace={selectedNamespace}
        setSelectedNamespace={setSelectedNamespace}
        namespaces={namespaces}
        searchPlaceholder={tr('referenceGrantsPage.searchPlaceholder', 'Search ReferenceGrants by name...')}
        allNamespacesLabel={tr('referenceGrantsPage.allNamespaces', 'All namespaces')}
      />

      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3 shrink-0">
        <div className="rounded-lg border border-slate-700 bg-slate-900/50 px-4 py-3">
          <p className="text-[11px] sm:text-xs leading-4 whitespace-nowrap text-slate-400">{tr('referenceGrantsPage.stats.total', 'Total')}</p>
          <p className="text-lg text-white font-semibold mt-1">{summary.total}</p>
        </div>
        <div className="rounded-lg border border-emerald-700/40 bg-emerald-900/10 px-4 py-3">
          <p className="text-[11px] sm:text-xs leading-4 whitespace-nowrap text-emerald-300">{tr('referenceGrantsPage.stats.withFrom', 'With From')}</p>
          <p className="text-lg text-white font-semibold mt-1">{summary.withFrom}</p>
        </div>
        <div className="rounded-lg border border-cyan-700/40 bg-cyan-900/10 px-4 py-3">
          <p className="text-[11px] sm:text-xs leading-4 whitespace-nowrap text-cyan-300">{tr('referenceGrantsPage.stats.withTo', 'With To')}</p>
          <p className="text-lg text-white font-semibold mt-1">{summary.withTo}</p>
        </div>
        <div className="rounded-lg border border-amber-700/40 bg-amber-900/10 px-4 py-3">
          <p className="text-[11px] sm:text-xs leading-4 whitespace-nowrap text-amber-300">{tr('referenceGrantsPage.stats.withLabels', 'With Labels')}</p>
          <p className="text-lg text-white font-semibold mt-1">{summary.withLabels}</p>
        </div>
      </div>

      {searchQuery && (
        <p className="text-sm text-slate-400 shrink-0">
          {tr('referenceGrantsPage.matchCount', '{{count}} ReferenceGrant{{suffix}} match.', {
            count: filteredReferenceGrants.length,
            suffix: filteredReferenceGrants.length === 1 ? '' : 's',
          })}
        </p>
      )}

      <ReferenceGrantTable
        pagedReferenceGrants={pagedReferenceGrants}
        sortedReferenceGrantsLength={sortedReferenceGrants.length}
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
          title={tr('referenceGrantsPage.createTitle', 'Create ReferenceGrant from YAML')}
          initialYaml={createReferenceGrantYamlTemplate}
          namespace={selectedNamespace !== 'all' ? selectedNamespace : undefined}
          onClose={() => setCreateDialogOpen(false)}
          onCreated={() => {
            queryClient.invalidateQueries({ queryKey: ['gateway', 'referencegrants'] })
          }}
        />
      )}
    </div>
  )
}
