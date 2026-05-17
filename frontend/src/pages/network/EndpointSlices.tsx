import { useEffect, useMemo, useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { useTranslation } from 'react-i18next'
import { api, type EndpointSliceInfo } from '@/services/api'
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
  formatEndpointPreview,
  formatPorts,
  parseAgeSeconds,
  resolveNotReadyCount,
  type SortKey,
} from './endpointslices/endpointSliceHelpers'
import { applyEndpointSliceWatchEvent } from './endpointslices/endpointSliceWatchNormalize'
import { EndpointSliceFilters } from './endpointslices/EndpointSliceFilters'
import { EndpointSliceTable } from './endpointslices/EndpointSliceTable'

type SummaryCard = [label: string, value: number, boxClass: string, labelClass: string]

export default function EndpointSlices() {
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

  const { data: endpointSlices, isLoading } = useQuery({
    queryKey: ['network', 'endpointslices', selectedNamespace],
    queryFn: () => (
      selectedNamespace === 'all'
        ? api.getAllEndpointSlices(false)
        : api.getEndpointSlices(selectedNamespace, false)
    ),
  })
  const { has } = usePermission()
  const canCreate = has('resource.endpointslice.create')

  useKubeWatchList({
    enabled: true,
    queryKey: ['network', 'endpointslices', selectedNamespace],
    path: selectedNamespace === 'all'
      ? '/api/v1/endpointslices'
      : `/api/v1/namespaces/${selectedNamespace}/endpointslices`,
    query: 'watch=1',
    applyEvent: (prev, event) => applyEndpointSliceWatchEvent(prev as EndpointSliceInfo[] | undefined, event),
    onEvent: (event) => {
      if (event?.type === 'DELETED') return
      const name = event?.object?.name || event?.object?.metadata?.name
      const ns = event?.object?.namespace || event?.object?.metadata?.namespace
      if (name && ns) {
        queryClient.invalidateQueries({ queryKey: ['endpointslice-describe', ns, name] })
      }
    },
  })

  const filteredEndpointSlices = useMemo(() => {
    if (!Array.isArray(endpointSlices)) return [] as EndpointSliceInfo[]
    if (!searchQuery.trim()) return endpointSlices
    const q = searchQuery.toLowerCase()
    return endpointSlices.filter((es) => (
      es.name.toLowerCase().includes(q)
      || es.namespace.toLowerCase().includes(q)
      || String(es.service_name || '').toLowerCase().includes(q)
      || String(es.address_type || '').toLowerCase().includes(q)
      || formatEndpointPreview(es).toLowerCase().includes(q)
      || formatPorts(es.ports).toLowerCase().includes(q)
      || String(es.endpoints_total).includes(q)
      || String(es.endpoints_ready).includes(q)
      || String(resolveNotReadyCount(es)).includes(q)
    ))
  }, [endpointSlices, searchQuery])

  const summary = useMemo(() => {
    const total = filteredEndpointSlices.length
    let withReady = 0
    let withNotReady = 0
    let totalEndpoints = 0

    for (const es of filteredEndpointSlices) {
      const ready = es.endpoints_ready || 0
      const notReady = resolveNotReadyCount(es)
      if (ready > 0) withReady += 1
      if (notReady > 0) withNotReady += 1
      totalEndpoints += (es.endpoints_total || 0)
    }

    return { total, withReady, withNotReady, totalEndpoints }
  }, [filteredEndpointSlices])

  const summaryCards = useMemo<SummaryCard[]>(
    () => [
      [tr('endpointSlicesPage.stats.total', 'Total'), summary.total, 'border-slate-700 bg-slate-900/50', 'text-slate-400'],
      [tr('endpointSlicesPage.stats.withReady', 'With Ready'), summary.withReady, 'border-emerald-700/40 bg-emerald-900/10', 'text-emerald-300'],
      [tr('endpointSlicesPage.stats.withNotReady', 'With Not Ready'), summary.withNotReady, 'border-amber-700/40 bg-amber-900/10', 'text-amber-300'],
      [tr('endpointSlicesPage.stats.totalEndpoints', 'Total Endpoints'), summary.totalEndpoints, 'border-cyan-700/40 bg-cyan-900/10', 'text-cyan-300'],
    ],
    [summary.total, summary.totalEndpoints, summary.withNotReady, summary.withReady, tr],
  )

  const sortedEndpointSlices = useMemo(() => {
    if (!sortKey) return filteredEndpointSlices
    const list = [...filteredEndpointSlices]

    const getValue = (es: EndpointSliceInfo): string | number => {
      switch (sortKey) {
        case 'name':
          return es.name
        case 'namespace':
          return es.namespace
        case 'service':
          return es.service_name || ''
        case 'addressType':
          return es.address_type || ''
        case 'endpoints':
          return es.endpoints_total || 0
        case 'ready':
          return es.endpoints_ready || 0
        case 'notReady':
          return resolveNotReadyCount(es)
        case 'ports':
          return formatPorts(es.ports)
        case 'age':
          return parseAgeSeconds(es.created_at)
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
  }, [filteredEndpointSlices, sortDir, sortKey])

  const { containerRef: tableContainerRef, bodyRef: tableBodyRef, theadRef, firstRowRef, rowsPerPage } = useAdaptiveTable({
    recalculationKey: sortedEndpointSlices.length,
  })
  const totalPages = Math.max(1, Math.ceil(sortedEndpointSlices.length / rowsPerPage))

  useEffect(() => {
    setCurrentPage(1)
  }, [searchQuery, selectedNamespace])

  useEffect(() => {
    if (currentPage > totalPages) setCurrentPage(totalPages)
  }, [currentPage, totalPages])

  const pagedEndpointSlices = useMemo(() => {
    const start = (currentPage - 1) * rowsPerPage
    return sortedEndpointSlices.slice(start, start + rowsPerPage)
  }, [sortedEndpointSlices, currentPage, rowsPerPage])

  // 플로팅 AI 위젯용 스냅샷
  const aiSnapshot = useMemo(() => {
    if (!Array.isArray(endpointSlices) || endpointSlices.length === 0) return null
    const nsLabel = selectedNamespace === 'all' ? '전체 네임스페이스' : selectedNamespace
    const total = endpointSlices.length
    const notReady = endpointSlices.filter(
      (e) => (e.endpoints_total ?? 0) - (e.endpoints_ready ?? 0) > 0,
    ).length
    const prefix = notReady > 0 ? '⚠️ ' : ''
    return {
      source: 'base' as const,
      summary: `${prefix}${nsLabel} EndpointSlice ${total}개${notReady ? ` (NotReady 포함 ${notReady})` : ''}`,
      data: {
        filters: { namespace: selectedNamespace, search: searchQuery || undefined },
        stats: { total, with_not_ready: notReady },
        ...summarizeList(pagedEndpointSlices as unknown as Record<string, unknown>[], {
          total: sortedEndpointSlices.length,
          currentPage,
          pageSize: rowsPerPage,
          topN: rowsPerPage,
          pickFields: ['name', 'namespace', 'service_name', 'address_type', 'endpoints_total', 'endpoints_ready', 'endpoints_not_ready'],
          filterProblematic: (e) => {
            const es = e as unknown as EndpointSliceInfo
            return (es.endpoints_total ?? 0) - (es.endpoints_ready ?? 0) > 0
          },
          linkBuilder: (e) => {
            const es = e as unknown as EndpointSliceInfo
            return buildResourceLink('EndpointSlice', es.namespace, es.name)
          },
        }),
      },
    }
  }, [endpointSlices, pagedEndpointSlices, sortedEndpointSlices.length, currentPage, rowsPerPage, selectedNamespace, searchQuery])

  useAIContext(aiSnapshot, [aiSnapshot])

  const handleRefresh = async () => {
    if (isRefreshing) return
    setIsRefreshing(true)
    try {
      const data = selectedNamespace === 'all'
        ? await api.getAllEndpointSlices(true)
        : await api.getEndpointSlices(selectedNamespace, true)
      queryClient.removeQueries({ queryKey: ['network', 'endpointslices', selectedNamespace] })
      queryClient.setQueryData(['network', 'endpointslices', selectedNamespace], data)
    } catch (error) {
      console.error('EndpointSlices refresh failed:', error)
    }
    setTimeout(() => setIsRefreshing(false), 500)
  }

  const createEndpointSliceYamlTemplate = useMemo(() => {
    const ns = selectedNamespace !== 'all' ? selectedNamespace : 'default'
    return `apiVersion: discovery.k8s.io/v1
kind: EndpointSlice
metadata:
  name: sample-endpointslice
  namespace: ${ns}
  labels:
    kubernetes.io/service-name: sample-service
addressType: IPv4
ports:
  - name: http
    protocol: TCP
    port: 80
endpoints:
  - addresses:
      - 10.0.0.10
    conditions:
      ready: true
`
  }, [selectedNamespace])

  const showNamespaceColumn = selectedNamespace === 'all'

  return (
    <div className="flex flex-col h-[calc(100vh-4rem)] gap-4">
      <div className="flex items-center justify-between shrink-0">
        <div>
          <h1 className="text-3xl font-bold text-white">{tr('endpointSlicesPage.title', 'Endpoint Slices')}</h1>
          <p className="mt-2 text-slate-400">{tr('endpointSlicesPage.subtitle', 'Inspect and manage EndpointSlices across namespaces.')}</p>
        </div>
        <div className="flex items-center gap-2">
          {canCreate && (
            <button
              type="button"
              onClick={() => setCreateDialogOpen(true)}
              className="btn btn-primary flex items-center gap-2"
            >
              <Plus className="w-4 h-4" />
              {tr('endpointSlicesPage.create', 'Create EndpointSlice')}
            </button>
          )}
          <button
            type="button"
            onClick={handleRefresh}
            disabled={isRefreshing}
            title={tr('endpointSlicesPage.refreshTitle', 'Force refresh')}
            className="btn btn-primary flex items-center gap-2 disabled:opacity-50 disabled:cursor-not-allowed"
          >
            <RefreshCw className={`w-4 h-4 ${isRefreshing ? 'animate-spin' : ''}`} />
            {tr('endpointSlicesPage.refresh', 'Refresh')}
          </button>
        </div>
      </div>

      <EndpointSliceFilters
        searchQuery={searchQuery}
        setSearchQuery={setSearchQuery}
        selectedNamespace={selectedNamespace}
        setSelectedNamespace={setSelectedNamespace}
        namespaces={namespaces}
        searchPlaceholder={tr('endpointSlicesPage.searchPlaceholder', 'Search endpoint slices by name...')}
        allNamespacesLabel={tr('endpointSlicesPage.allNamespaces', 'All namespaces')}
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
          {tr('endpointSlicesPage.matchCount', '{{count}} endpoint slice{{suffix}} match.', {
            count: filteredEndpointSlices.length,
            suffix: filteredEndpointSlices.length === 1 ? '' : 's',
          })}
        </p>
      )}

      <EndpointSliceTable
        pagedEndpointSlices={pagedEndpointSlices}
        sortedEndpointSlicesLength={sortedEndpointSlices.length}
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
          title={tr('endpointSlicesPage.createTitle', 'Create EndpointSlice from YAML')}
          initialYaml={createEndpointSliceYamlTemplate}
          namespace={selectedNamespace !== 'all' ? selectedNamespace : undefined}
          onClose={() => setCreateDialogOpen(false)}
          onCreated={() => {
            queryClient.invalidateQueries({ queryKey: ['network', 'endpointslices'] })
          }}
        />
      )}
    </div>
  )
}
