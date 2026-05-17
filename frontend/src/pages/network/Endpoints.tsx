import { useEffect, useMemo, useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { useTranslation } from 'react-i18next'
import { api, type EndpointInfo } from '@/services/api'
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
  formatAddresses,
  formatPorts,
  getEndpointAddressCount,
  parseAgeSeconds,
  type SortKey,
} from './endpoints/endpointHelpers'
import { applyEndpointWatchEvent } from './endpoints/endpointWatchNormalize'
import { EndpointFilters } from './endpoints/EndpointFilters'
import { EndpointTable } from './endpoints/EndpointTable'

type SummaryCard = [label: string, value: number, boxClass: string, labelClass: string]

export default function Endpoints() {
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

  const { data: endpoints, isLoading } = useQuery({
    queryKey: ['network', 'endpoints', selectedNamespace],
    queryFn: () => (
      selectedNamespace === 'all'
        ? api.getAllEndpoints(false)
        : api.getEndpoints(selectedNamespace, false)
    ),
  })
  const { has } = usePermission()
  const canCreate = has('resource.endpoints.create')

  useKubeWatchList({
    enabled: true,
    queryKey: ['network', 'endpoints', selectedNamespace],
    path: selectedNamespace === 'all'
      ? '/api/v1/endpoints'
      : `/api/v1/namespaces/${selectedNamespace}/endpoints`,
    query: 'watch=1',
    applyEvent: (prev, event) => applyEndpointWatchEvent(prev as EndpointInfo[] | undefined, event),
    onEvent: (event) => {
      if (event?.type === 'DELETED') return
      const name = event?.object?.name || event?.object?.metadata?.name
      const ns = event?.object?.namespace || event?.object?.metadata?.namespace
      if (name && ns) {
        queryClient.invalidateQueries({ queryKey: ['endpoint-describe', ns, name] })
      }
    },
  })

  const filteredEndpoints = useMemo(() => {
    if (!Array.isArray(endpoints)) return [] as EndpointInfo[]
    if (!searchQuery.trim()) return endpoints
    const q = searchQuery.toLowerCase()
    return endpoints.filter((ep) => (
      ep.name.toLowerCase().includes(q)
      || ep.namespace.toLowerCase().includes(q)
      || formatAddresses(ep).toLowerCase().includes(q)
      || formatPorts(ep.ports).toLowerCase().includes(q)
      || String(ep.ready_count).includes(q)
      || String(ep.not_ready_count).includes(q)
    ))
  }, [endpoints, searchQuery])

  const summary = useMemo(() => {
    const total = filteredEndpoints.length
    let withReady = 0
    let withNotReady = 0
    let totalAddresses = 0

    for (const ep of filteredEndpoints) {
      if ((ep.ready_count || 0) > 0) withReady += 1
      if ((ep.not_ready_count || 0) > 0) withNotReady += 1
      totalAddresses += getEndpointAddressCount(ep)
    }

    return { total, withReady, withNotReady, totalAddresses }
  }, [filteredEndpoints])

  const summaryCards = useMemo<SummaryCard[]>(
    () => [
      [tr('endpointsPage.stats.total', 'Total'), summary.total, 'border-slate-700 bg-slate-900/50', 'text-slate-400'],
      [tr('endpointsPage.stats.withReady', 'With Ready'), summary.withReady, 'border-emerald-700/40 bg-emerald-900/10', 'text-emerald-300'],
      [tr('endpointsPage.stats.withNotReady', 'With NotReady'), summary.withNotReady, 'border-amber-700/40 bg-amber-900/10', 'text-amber-300'],
      [tr('endpointsPage.stats.totalAddresses', 'Total Addresses'), summary.totalAddresses, 'border-cyan-700/40 bg-cyan-900/10', 'text-cyan-300'],
    ],
    [summary.total, summary.totalAddresses, summary.withNotReady, summary.withReady, tr],
  )

  const sortedEndpoints = useMemo(() => {
    if (!sortKey) return filteredEndpoints
    const list = [...filteredEndpoints]

    const getValue = (ep: EndpointInfo): string | number => {
      switch (sortKey) {
        case 'name':
          return ep.name
        case 'namespace':
          return ep.namespace
        case 'ready':
          return ep.ready_count || 0
        case 'notReady':
          return ep.not_ready_count || 0
        case 'addresses':
          return getEndpointAddressCount(ep)
        case 'ports':
          return formatPorts(ep.ports)
        case 'age':
          return parseAgeSeconds(ep.created_at)
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
  }, [filteredEndpoints, sortDir, sortKey])

  const { containerRef: tableContainerRef, bodyRef: tableBodyRef, theadRef, firstRowRef, rowsPerPage } = useAdaptiveTable({
    recalculationKey: sortedEndpoints.length,
  })
  const totalPages = Math.max(1, Math.ceil(sortedEndpoints.length / rowsPerPage))

  useEffect(() => {
    setCurrentPage(1)
  }, [searchQuery, selectedNamespace])

  useEffect(() => {
    if (currentPage > totalPages) setCurrentPage(totalPages)
  }, [currentPage, totalPages])

  const pagedEndpoints = useMemo(() => {
    const start = (currentPage - 1) * rowsPerPage
    return sortedEndpoints.slice(start, start + rowsPerPage)
  }, [sortedEndpoints, currentPage, rowsPerPage])

  // 플로팅 AI 위젯용 스냅샷
  const aiSnapshot = useMemo(() => {
    if (!Array.isArray(endpoints) || endpoints.length === 0) return null
    const nsLabel = selectedNamespace === 'all' ? '전체 네임스페이스' : selectedNamespace
    const total = endpoints.length
    const notReady = endpoints.filter((e) => e.not_ready_count > 0).length
    const prefix = notReady > 0 ? '⚠️ ' : ''
    return {
      source: 'base' as const,
      summary: `${prefix}${nsLabel} Endpoints ${total}개${notReady ? ` (NotReady ${notReady})` : ''}`,
      data: {
        filters: { namespace: selectedNamespace, search: searchQuery || undefined },
        stats: { total, with_not_ready: notReady },
        ...summarizeList(pagedEndpoints as unknown as Record<string, unknown>[], {
          total: sortedEndpoints.length,
          currentPage,
          pageSize: rowsPerPage,
          topN: rowsPerPage,
          pickFields: ['name', 'namespace', 'ready_count', 'not_ready_count', 'ports'],
          filterProblematic: (e) => (e as unknown as EndpointInfo).not_ready_count > 0,
          linkBuilder: (e) => {
            const ep = e as unknown as EndpointInfo
            return buildResourceLink('Endpoints', ep.namespace, ep.name)
          },
        }),
      },
    }
  }, [endpoints, pagedEndpoints, sortedEndpoints.length, currentPage, rowsPerPage, selectedNamespace, searchQuery])

  useAIContext(aiSnapshot, [aiSnapshot])

  const handleRefresh = async () => {
    if (isRefreshing) return
    setIsRefreshing(true)
    try {
      const data = selectedNamespace === 'all'
        ? await api.getAllEndpoints(true)
        : await api.getEndpoints(selectedNamespace, true)
      queryClient.removeQueries({ queryKey: ['network', 'endpoints', selectedNamespace] })
      queryClient.setQueryData(['network', 'endpoints', selectedNamespace], data)
    } catch (error) {
      console.error('Endpoints refresh failed:', error)
    }
    setTimeout(() => setIsRefreshing(false), 500)
  }

  const createEndpointYamlTemplate = useMemo(() => {
    const ns = selectedNamespace !== 'all' ? selectedNamespace : 'default'
    return `apiVersion: v1
kind: Endpoints
metadata:
  name: sample-endpoints
  namespace: ${ns}
subsets:
  - addresses:
      - ip: 10.0.0.10
    ports:
      - name: http
        port: 80
        protocol: TCP
`
  }, [selectedNamespace])

  const showNamespaceColumn = selectedNamespace === 'all'

  return (
    <div className="flex flex-col h-[calc(100vh-4rem)] gap-4">
      <div className="flex items-center justify-between shrink-0">
        <div>
          <h1 className="text-3xl font-bold text-white">{tr('endpointsPage.title', 'Endpoints')}</h1>
          <p className="mt-2 text-slate-400">{tr('endpointsPage.subtitle', 'Inspect and manage Endpoints across namespaces.')}</p>
        </div>
        <div className="flex items-center gap-2">
          {canCreate && (
            <button
              type="button"
              onClick={() => setCreateDialogOpen(true)}
              className="btn btn-primary flex items-center gap-2"
            >
              <Plus className="w-4 h-4" />
              {tr('endpointsPage.create', 'Create Endpoints')}
            </button>
          )}
          <button
            type="button"
            onClick={handleRefresh}
            disabled={isRefreshing}
            title={tr('endpointsPage.refreshTitle', 'Force refresh')}
            className="btn btn-primary flex items-center gap-2 disabled:opacity-50 disabled:cursor-not-allowed"
          >
            <RefreshCw className={`w-4 h-4 ${isRefreshing ? 'animate-spin' : ''}`} />
            {tr('endpointsPage.refresh', 'Refresh')}
          </button>
        </div>
      </div>

      <EndpointFilters
        searchQuery={searchQuery}
        setSearchQuery={setSearchQuery}
        selectedNamespace={selectedNamespace}
        setSelectedNamespace={setSelectedNamespace}
        namespaces={namespaces}
        searchPlaceholder={tr('endpointsPage.searchPlaceholder', 'Search endpoints by name...')}
        allNamespacesLabel={tr('endpointsPage.allNamespaces', 'All namespaces')}
      />

      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3 shrink-0">
        {summaryCards.map(([label, value, boxClass, labelClass]) => (
          <div key={label} className={`rounded-lg border px-4 py-3 ${boxClass}`}>
            <p className={`text-[11px] sm:text-xs leading-4 whitespace-nowrap ${labelClass}`}>{label}</p>
            <p className="text-lg text-white font-semibold mt-1">{value}</p>
          </div>
        ))}
      </div>

      {searchQuery && (
        <p className="text-sm text-slate-400 shrink-0">
          {tr('endpointsPage.matchCount', '{{count}} endpoint{{suffix}} match.', {
            count: filteredEndpoints.length,
            suffix: filteredEndpoints.length === 1 ? '' : 's',
          })}
        </p>
      )}

      <EndpointTable
        pagedEndpoints={pagedEndpoints}
        sortedEndpointsLength={sortedEndpoints.length}
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
          title={tr('endpointsPage.createTitle', 'Create Endpoints from YAML')}
          initialYaml={createEndpointYamlTemplate}
          namespace={selectedNamespace !== 'all' ? selectedNamespace : undefined}
          onClose={() => setCreateDialogOpen(false)}
          onCreated={() => {
            queryClient.invalidateQueries({ queryKey: ['network', 'endpoints'] })
          }}
        />
      )}
    </div>
  )
}
