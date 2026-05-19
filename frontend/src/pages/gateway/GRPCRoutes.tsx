import { useEffect, useMemo, useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { useTranslation } from 'react-i18next'
import { api, type GRPCRouteInfo } from '@/services/api'
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
  formatHostnames,
  type SortKey,
} from './grpcroutes/grpcRouteHelpers'
import { applyGRPCRouteWatchEvent } from './grpcroutes/grpcRouteWatchNormalize'
import { GRPCRouteFilters } from './grpcroutes/GRPCRouteFilters'
import { GRPCRouteTable } from './grpcroutes/GRPCRouteTable'

export default function GRPCRoutes() {
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

  const { data: grpcRoutes, isLoading } = useQuery({
    queryKey: ['gateway', 'grpcroutes', selectedNamespace],
    queryFn: () => (
      selectedNamespace === 'all'
        ? api.getAllGRPCRoutes(false)
        : api.getGRPCRoutes(selectedNamespace, false)
    ),
  })
  const { has } = usePermission()
  const canCreate = has('resource.grpcroute.create')

  useKubeWatchList({
    enabled: true,
    queryKey: ['gateway', 'grpcroutes', selectedNamespace],
    path: selectedNamespace === 'all'
      ? '/api/v1/grpcroutes'
      : `/api/v1/namespaces/${selectedNamespace}/grpcroutes`,
    query: 'watch=1',
    applyEvent: (prev, event) => applyGRPCRouteWatchEvent(prev as GRPCRouteInfo[] | undefined, event),
    onEvent: (event) => {
      if (event?.type === 'DELETED') return
      const name = event?.object?.name || event?.object?.metadata?.name
      const ns = event?.object?.namespace || event?.object?.metadata?.namespace
      if (name && ns) {
        queryClient.invalidateQueries({ queryKey: ['grpcroute-describe', ns, name] })
      }
    },
  })

  const filteredGRPCRoutes = useMemo(() => {
    if (!Array.isArray(grpcRoutes)) return [] as GRPCRouteInfo[]
    if (!searchQuery.trim()) return grpcRoutes
    const q = searchQuery.toLowerCase()
    return grpcRoutes.filter((item) => (
      item.name.toLowerCase().includes(q)
      || item.namespace.toLowerCase().includes(q)
      || formatHostnames(item).toLowerCase().includes(q)
      || String(item.status || '').toLowerCase().includes(q)
    ))
  }, [grpcRoutes, searchQuery])

  const summary = useMemo(() => {
    const total = filteredGRPCRoutes.length
    let accepted = 0
    let resolvedRefs = 0
    let withHostnames = 0

    for (const item of filteredGRPCRoutes) {
      if (item.accepted) accepted += 1
      if (item.resolved_refs) resolvedRefs += 1
      if ((item.hostnames || []).length > 0) withHostnames += 1
    }

    return { total, accepted, resolvedRefs, withHostnames }
  }, [filteredGRPCRoutes])

  const sortedGRPCRoutes = useMemo(() => {
    if (!sortKey) return filteredGRPCRoutes
    const list = [...filteredGRPCRoutes]

    const getValue = (item: GRPCRouteInfo): string | number => {
      switch (sortKey) {
        case 'name':
          return item.name
        case 'namespace':
          return item.namespace
        case 'hostnames':
          return formatHostnames(item)
        case 'parents':
          return item.parent_refs_count || 0
        case 'rules':
          return item.rule_count || 0
        case 'backends':
          return item.backend_refs_count || 0
        case 'status':
          return item.status || ''
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
  }, [filteredGRPCRoutes, sortDir, sortKey])

  const { containerRef: tableContainerRef, bodyRef: tableBodyRef, theadRef, firstRowRef, rowsPerPage } = useAdaptiveTable({
    recalculationKey: sortedGRPCRoutes.length,
  })
  const totalPages = Math.max(1, Math.ceil(sortedGRPCRoutes.length / rowsPerPage))

  useEffect(() => {
    setCurrentPage(1)
  }, [searchQuery, selectedNamespace])

  useEffect(() => {
    if (currentPage > totalPages) setCurrentPage(totalPages)
  }, [currentPage, totalPages])

  const pagedGRPCRoutes = useMemo(() => {
    const start = (currentPage - 1) * rowsPerPage
    return sortedGRPCRoutes.slice(start, start + rowsPerPage)
  }, [sortedGRPCRoutes, currentPage, rowsPerPage])

  // 플로팅 AI 위젯용 스냅샷
  const aiSnapshot = useMemo(() => {
    if (!Array.isArray(grpcRoutes) || grpcRoutes.length === 0) return null
    const nsLabel = selectedNamespace === 'all' ? '전체 네임스페이스' : selectedNamespace
    const total = grpcRoutes.length
    const unresolved = grpcRoutes.filter((r) => r.resolved_refs === false).length
    const prefix = unresolved > 0 ? '⚠️ ' : ''
    return {
      source: 'base' as const,
      summary: `${prefix}${nsLabel} GRPCRoute ${total}개${unresolved ? ` (참조 해결 실패 ${unresolved})` : ''}`,
      data: {
        filters: { namespace: selectedNamespace, search: searchQuery || undefined },
        stats: { total, unresolved_refs: unresolved },
        ...summarizeList(pagedGRPCRoutes as unknown as Record<string, unknown>[], {
          total: sortedGRPCRoutes.length,
          currentPage,
          pageSize: rowsPerPage,
          topN: rowsPerPage,
          pickFields: ['name', 'namespace', 'hostnames', 'parent_refs_count', 'rule_count', 'backend_refs_count', 'accepted', 'resolved_refs', 'status'],
          filterProblematic: (r) => (r as unknown as GRPCRouteInfo).resolved_refs === false,
          linkBuilder: (r) => {
            const gr = r as unknown as GRPCRouteInfo
            return buildResourceLink('GRPCRoute', gr.namespace, gr.name)
          },
        }),
      },
    }
  }, [grpcRoutes, pagedGRPCRoutes, sortedGRPCRoutes.length, currentPage, rowsPerPage, selectedNamespace, searchQuery])

  useAIContext(aiSnapshot, [aiSnapshot])

  const handleRefresh = async () => {
    if (isRefreshing) return
    setIsRefreshing(true)
    try {
      const data = selectedNamespace === 'all'
        ? await api.getAllGRPCRoutes(true)
        : await api.getGRPCRoutes(selectedNamespace, true)
      queryClient.removeQueries({ queryKey: ['gateway', 'grpcroutes', selectedNamespace] })
      queryClient.setQueryData(['gateway', 'grpcroutes', selectedNamespace], data)
    } catch (error) {
      console.error('GRPCRoutes refresh failed:', error)
    }
    setTimeout(() => setIsRefreshing(false), 500)
  }

  const createGRPCRouteYamlTemplate = useMemo(() => {
    const ns = selectedNamespace !== 'all' ? selectedNamespace : 'default'
    return `apiVersion: gateway.networking.k8s.io/v1
kind: GRPCRoute
metadata:
  name: sample-grpcroute
  namespace: ${ns}
spec:
  parentRefs:
    - name: sample-gateway
  rules:
    - matches:
        - method:
            service: example.ExampleService
            method: GetExample
      backendRefs:
        - name: sample-grpc-service
          port: 50051
`
  }, [selectedNamespace])

  const showNamespaceColumn = selectedNamespace === 'all'

  return (
    <div className="flex flex-col h-[calc(100vh-4rem)] gap-4">
      <div className="flex items-center justify-between shrink-0">
        <div>
          <h1 className="text-3xl font-bold text-white">{tr('grpcRoutesPage.title', 'GRPC Routes')}</h1>
          <p className="mt-2 text-slate-400">{tr('grpcRoutesPage.subtitle', 'Inspect and manage Gateway API GRPCRoute resources across namespaces.')}</p>
        </div>
        <div className="flex items-center gap-2">
          {canCreate && (
            <button
              type="button"
              onClick={() => setCreateDialogOpen(true)}
              className="btn btn-primary flex items-center gap-2"
            >
              <Plus className="w-4 h-4" />
              {tr('grpcRoutesPage.create', 'Create GRPCRoute')}
            </button>
          )}
          <button
            type="button"
            onClick={handleRefresh}
            disabled={isRefreshing}
            title={tr('grpcRoutesPage.refreshTitle', 'Force refresh')}
            className="btn btn-primary flex items-center gap-2 disabled:opacity-50 disabled:cursor-not-allowed"
          >
            <RefreshCw className={`w-4 h-4 ${isRefreshing ? 'animate-spin' : ''}`} />
            {tr('grpcRoutesPage.refresh', 'Refresh')}
          </button>
        </div>
      </div>

      <GRPCRouteFilters
        searchQuery={searchQuery}
        setSearchQuery={setSearchQuery}
        selectedNamespace={selectedNamespace}
        setSelectedNamespace={setSelectedNamespace}
        namespaces={namespaces}
        searchPlaceholder={tr('grpcRoutesPage.searchPlaceholder', 'Search GRPCRoutes by name...')}
        allNamespacesLabel={tr('grpcRoutesPage.allNamespaces', 'All namespaces')}
      />

      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3 shrink-0">
        <div className="rounded-lg border border-slate-700 bg-slate-900/50 px-4 py-3">
          <p className="text-[11px] sm:text-xs leading-4 whitespace-nowrap text-slate-400">{tr('grpcRoutesPage.stats.total', 'Total')}</p>
          <p className="text-lg text-white font-semibold mt-1">{summary.total}</p>
        </div>
        <div className="rounded-lg border border-emerald-700/40 bg-emerald-900/10 px-4 py-3">
          <p className="text-[11px] sm:text-xs leading-4 whitespace-nowrap text-emerald-300">{tr('grpcRoutesPage.stats.accepted', 'Accepted')}</p>
          <p className="text-lg text-white font-semibold mt-1">{summary.accepted}</p>
        </div>
        <div className="rounded-lg border border-cyan-700/40 bg-cyan-900/10 px-4 py-3">
          <p className="text-[11px] sm:text-xs leading-4 whitespace-nowrap text-cyan-300">{tr('grpcRoutesPage.stats.resolvedRefs', 'ResolvedRefs')}</p>
          <p className="text-lg text-white font-semibold mt-1">{summary.resolvedRefs}</p>
        </div>
        <div className="rounded-lg border border-amber-700/40 bg-amber-900/10 px-4 py-3">
          <p className="text-[11px] sm:text-xs leading-4 whitespace-nowrap text-amber-300">{tr('grpcRoutesPage.stats.withHostnames', 'With Hostnames')}</p>
          <p className="text-lg text-white font-semibold mt-1">{summary.withHostnames}</p>
        </div>
      </div>

      {searchQuery && (
        <p className="text-sm text-slate-400 shrink-0">
          {tr('grpcRoutesPage.matchCount', '{{count}} GRPCRoute{{suffix}} match.', {
            count: filteredGRPCRoutes.length,
            suffix: filteredGRPCRoutes.length === 1 ? '' : 's',
          })}
        </p>
      )}

      <GRPCRouteTable
        pagedGRPCRoutes={pagedGRPCRoutes}
        sortedGRPCRoutesLength={sortedGRPCRoutes.length}
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
          title={tr('grpcRoutesPage.createTitle', 'Create GRPCRoute from YAML')}
          initialYaml={createGRPCRouteYamlTemplate}
          namespace={selectedNamespace !== 'all' ? selectedNamespace : undefined}
          onClose={() => setCreateDialogOpen(false)}
          onCreated={() => {
            queryClient.invalidateQueries({ queryKey: ['gateway', 'grpcroutes'] })
          }}
        />
      )}
    </div>
  )
}
