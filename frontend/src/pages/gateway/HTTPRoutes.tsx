import { useEffect, useMemo, useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { useTranslation } from 'react-i18next'
import { api, type HTTPRouteInfo } from '@/services/api'
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
} from './httproutes/httpRouteHelpers'
import { applyHTTPRouteWatchEvent } from './httproutes/httpRouteWatchNormalize'
import { HTTPRouteFilters } from './httproutes/HTTPRouteFilters'
import { HTTPRouteTable } from './httproutes/HTTPRouteTable'

export default function HTTPRoutes() {
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

  const { data: httpRoutes, isLoading } = useQuery({
    queryKey: ['gateway', 'httproutes', selectedNamespace],
    queryFn: () => (
      selectedNamespace === 'all'
        ? api.getAllHTTPRoutes(false)
        : api.getHTTPRoutes(selectedNamespace, false)
    ),
  })
  const { has } = usePermission()
  const canCreate = has('resource.httproute.create')

  useKubeWatchList({
    enabled: true,
    queryKey: ['gateway', 'httproutes', selectedNamespace],
    path: selectedNamespace === 'all'
      ? '/api/v1/httproutes'
      : `/api/v1/namespaces/${selectedNamespace}/httproutes`,
    query: 'watch=1',
    applyEvent: (prev, event) => applyHTTPRouteWatchEvent(prev as HTTPRouteInfo[] | undefined, event),
    onEvent: (event) => {
      if (event?.type === 'DELETED') return
      const name = event?.object?.name || event?.object?.metadata?.name
      const ns = event?.object?.namespace || event?.object?.metadata?.namespace
      if (name && ns) {
        queryClient.invalidateQueries({ queryKey: ['httproute-describe', ns, name] })
      }
    },
  })

  const filteredHTTPRoutes = useMemo(() => {
    if (!Array.isArray(httpRoutes)) return [] as HTTPRouteInfo[]
    if (!searchQuery.trim()) return httpRoutes
    const q = searchQuery.toLowerCase()
    return httpRoutes.filter((item) => (
      item.name.toLowerCase().includes(q)
      || item.namespace.toLowerCase().includes(q)
      || formatHostnames(item).toLowerCase().includes(q)
      || String(item.status || '').toLowerCase().includes(q)
      || String(item.rule_count || 0).includes(q)
      || String(item.parent_refs_count || 0).includes(q)
      || String(item.backend_refs_count || 0).includes(q)
    ))
  }, [httpRoutes, searchQuery])

  const summary = useMemo(() => {
    const total = filteredHTTPRoutes.length
    let accepted = 0
    let resolvedRefs = 0
    let withHostnames = 0

    for (const item of filteredHTTPRoutes) {
      if (item.accepted) accepted += 1
      if (item.resolved_refs) resolvedRefs += 1
      if ((item.hostnames || []).length > 0) withHostnames += 1
    }

    return { total, accepted, resolvedRefs, withHostnames }
  }, [filteredHTTPRoutes])

  const sortedHTTPRoutes = useMemo(() => {
    if (!sortKey) return filteredHTTPRoutes
    const list = [...filteredHTTPRoutes]

    const getValue = (item: HTTPRouteInfo): string | number => {
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
  }, [filteredHTTPRoutes, sortDir, sortKey])

  const { containerRef: tableContainerRef, bodyRef: tableBodyRef, theadRef, firstRowRef, rowsPerPage } = useAdaptiveTable({
    recalculationKey: sortedHTTPRoutes.length,
  })
  const totalPages = Math.max(1, Math.ceil(sortedHTTPRoutes.length / rowsPerPage))

  useEffect(() => {
    setCurrentPage(1)
  }, [searchQuery, selectedNamespace])

  useEffect(() => {
    if (currentPage > totalPages) setCurrentPage(totalPages)
  }, [currentPage, totalPages])

  const pagedHTTPRoutes = useMemo(() => {
    const start = (currentPage - 1) * rowsPerPage
    return sortedHTTPRoutes.slice(start, start + rowsPerPage)
  }, [sortedHTTPRoutes, currentPage, rowsPerPage])

  // 플로팅 AI 위젯용 스냅샷
  const aiSnapshot = useMemo(() => {
    if (!Array.isArray(httpRoutes) || httpRoutes.length === 0) return null
    const nsLabel = selectedNamespace === 'all' ? '전체 네임스페이스' : selectedNamespace
    const total = httpRoutes.length
    const unresolved = httpRoutes.filter((r) => r.resolved_refs === false).length
    const prefix = unresolved > 0 ? '⚠️ ' : ''
    return {
      source: 'base' as const,
      summary: `${prefix}${nsLabel} HTTPRoute ${total}개${unresolved ? ` (참조 해결 실패 ${unresolved})` : ''}`,
      data: {
        filters: { namespace: selectedNamespace, search: searchQuery || undefined },
        stats: { total, unresolved_refs: unresolved },
        ...summarizeList(pagedHTTPRoutes as unknown as Record<string, unknown>[], {
          total: sortedHTTPRoutes.length,
          currentPage,
          pageSize: rowsPerPage,
          topN: rowsPerPage,
          pickFields: ['name', 'namespace', 'hostnames', 'parent_refs_count', 'rule_count', 'backend_refs_count', 'accepted', 'resolved_refs', 'status'],
          filterProblematic: (r) => (r as unknown as HTTPRouteInfo).resolved_refs === false,
          linkBuilder: (r) => {
            const ht = r as unknown as HTTPRouteInfo
            return buildResourceLink('HTTPRoute', ht.namespace, ht.name)
          },
        }),
      },
    }
  }, [httpRoutes, pagedHTTPRoutes, sortedHTTPRoutes.length, currentPage, rowsPerPage, selectedNamespace, searchQuery])

  useAIContext(aiSnapshot, [aiSnapshot])

  const handleRefresh = async () => {
    if (isRefreshing) return
    setIsRefreshing(true)
    try {
      const data = selectedNamespace === 'all'
        ? await api.getAllHTTPRoutes(true)
        : await api.getHTTPRoutes(selectedNamespace, true)
      queryClient.removeQueries({ queryKey: ['gateway', 'httproutes', selectedNamespace] })
      queryClient.setQueryData(['gateway', 'httproutes', selectedNamespace], data)
    } catch (error) {
      console.error('HTTPRoutes refresh failed:', error)
    }
    setTimeout(() => setIsRefreshing(false), 500)
  }

  const createHTTPRouteYamlTemplate = useMemo(() => {
    const ns = selectedNamespace !== 'all' ? selectedNamespace : 'default'
    return `apiVersion: gateway.networking.k8s.io/v1
kind: HTTPRoute
metadata:
  name: sample-httproute
  namespace: ${ns}
spec:
  parentRefs:
    - name: sample-gateway
  hostnames:
    - example.com
  rules:
    - matches:
        - path:
            type: PathPrefix
            value: /
      backendRefs:
        - name: sample-service
          port: 80
`
  }, [selectedNamespace])

  const showNamespaceColumn = selectedNamespace === 'all'

  return (
    <div className="flex flex-col h-[calc(100vh-4rem)] gap-4">
      <div className="flex items-center justify-between shrink-0">
        <div>
          <h1 className="text-3xl font-bold text-white">{tr('httpRoutesPage.title', 'HTTP Routes')}</h1>
          <p className="mt-2 text-slate-400">{tr('httpRoutesPage.subtitle', 'Inspect and manage Gateway API HTTPRoute resources across namespaces.')}</p>
        </div>
        <div className="flex items-center gap-2">
          {canCreate && (
            <button
              type="button"
              onClick={() => setCreateDialogOpen(true)}
              className="btn btn-primary flex items-center gap-2"
            >
              <Plus className="w-4 h-4" />
              {tr('httpRoutesPage.create', 'Create HTTPRoute')}
            </button>
          )}
          <button
            type="button"
            onClick={handleRefresh}
            disabled={isRefreshing}
            title={tr('httpRoutesPage.refreshTitle', 'Force refresh')}
            className="btn btn-primary flex items-center gap-2 disabled:opacity-50 disabled:cursor-not-allowed"
          >
            <RefreshCw className={`w-4 h-4 ${isRefreshing ? 'animate-spin' : ''}`} />
            {tr('httpRoutesPage.refresh', 'Refresh')}
          </button>
        </div>
      </div>

      <HTTPRouteFilters
        searchQuery={searchQuery}
        setSearchQuery={setSearchQuery}
        selectedNamespace={selectedNamespace}
        setSelectedNamespace={setSelectedNamespace}
        namespaces={namespaces}
        searchPlaceholder={tr('httpRoutesPage.searchPlaceholder', 'Search HTTPRoutes by name...')}
        allNamespacesLabel={tr('httpRoutesPage.allNamespaces', 'All namespaces')}
      />

      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3 shrink-0">
        <div className="rounded-lg border border-slate-700 bg-slate-900/50 px-4 py-3">
          <p className="text-[11px] sm:text-xs leading-4 whitespace-nowrap text-slate-400">{tr('httpRoutesPage.stats.total', 'Total')}</p>
          <p className="text-lg text-white font-semibold mt-1">{summary.total}</p>
        </div>
        <div className="rounded-lg border border-emerald-700/40 bg-emerald-900/10 px-4 py-3">
          <p className="text-[11px] sm:text-xs leading-4 whitespace-nowrap text-emerald-300">{tr('httpRoutesPage.stats.accepted', 'Accepted')}</p>
          <p className="text-lg text-white font-semibold mt-1">{summary.accepted}</p>
        </div>
        <div className="rounded-lg border border-cyan-700/40 bg-cyan-900/10 px-4 py-3">
          <p className="text-[11px] sm:text-xs leading-4 whitespace-nowrap text-cyan-300">{tr('httpRoutesPage.stats.resolvedRefs', 'ResolvedRefs')}</p>
          <p className="text-lg text-white font-semibold mt-1">{summary.resolvedRefs}</p>
        </div>
        <div className="rounded-lg border border-amber-700/40 bg-amber-900/10 px-4 py-3">
          <p className="text-[11px] sm:text-xs leading-4 whitespace-nowrap text-amber-300">{tr('httpRoutesPage.stats.withHostnames', 'With Hostnames')}</p>
          <p className="text-lg text-white font-semibold mt-1">{summary.withHostnames}</p>
        </div>
      </div>

      {searchQuery && (
        <p className="text-sm text-slate-400 shrink-0">
          {tr('httpRoutesPage.matchCount', '{{count}} HTTPRoute{{suffix}} match.', {
            count: filteredHTTPRoutes.length,
            suffix: filteredHTTPRoutes.length === 1 ? '' : 's',
          })}
        </p>
      )}

      <HTTPRouteTable
        pagedHTTPRoutes={pagedHTTPRoutes}
        sortedHTTPRoutesLength={sortedHTTPRoutes.length}
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
          title={tr('httpRoutesPage.createTitle', 'Create HTTPRoute from YAML')}
          initialYaml={createHTTPRouteYamlTemplate}
          namespace={selectedNamespace !== 'all' ? selectedNamespace : undefined}
          onClose={() => setCreateDialogOpen(false)}
          onCreated={() => {
            queryClient.invalidateQueries({ queryKey: ['gateway', 'httproutes'] })
          }}
        />
      )}
    </div>
  )
}
