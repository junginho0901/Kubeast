import { useEffect, useMemo, useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { useTranslation } from 'react-i18next'
import { api, type GatewayInfo } from '@/services/api'
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
  type SortKey,
} from './gateways/gatewayHelpers'
import { applyGatewayWatchEvent } from './gateways/gatewayWatchNormalize'
import { GatewayFilters } from './gateways/GatewayFilters'
import { GatewayTable } from './gateways/GatewayTable'

export default function Gateways() {
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

  const { data: gateways, isLoading } = useQuery({
    queryKey: ['gateway', 'gateways', selectedNamespace],
    queryFn: () => (
      selectedNamespace === 'all'
        ? api.getAllGateways(false)
        : api.getGateways(selectedNamespace, false)
    ),
  })
  const { has } = usePermission()
  const canCreate = has('resource.gateway.create')

  useKubeWatchList({
    enabled: true,
    queryKey: ['gateway', 'gateways', selectedNamespace],
    path: selectedNamespace === 'all'
      ? '/api/v1/gateways'
      : `/api/v1/namespaces/${selectedNamespace}/gateways`,
    query: 'watch=1',
    applyEvent: (prev, event) => applyGatewayWatchEvent(prev as GatewayInfo[] | undefined, event),
    onEvent: (event) => {
      if (event?.type === 'DELETED') return
      const name = event?.object?.name || event?.object?.metadata?.name
      const ns = event?.object?.namespace || event?.object?.metadata?.namespace
      if (name && ns) {
        queryClient.invalidateQueries({ queryKey: ['gateway-describe', ns, name] })
      }
    },
  })

  const filteredGateways = useMemo(() => {
    if (!Array.isArray(gateways)) return [] as GatewayInfo[]
    if (!searchQuery.trim()) return gateways
    const q = searchQuery.toLowerCase()
    return gateways.filter((gateway) => (
      gateway.name.toLowerCase().includes(q)
      || gateway.namespace.toLowerCase().includes(q)
      || String(gateway.gateway_class_name || '').toLowerCase().includes(q)
      || String(gateway.status || '').toLowerCase().includes(q)
      || String(gateway.listeners_count || 0).includes(q)
      || String(gateway.attached_routes || 0).includes(q)
      || String(gateway.addresses_count || 0).includes(q)
    ))
  }, [gateways, searchQuery])

  const summary = useMemo(() => {
    const total = filteredGateways.length
    let programmed = 0
    let accepted = 0
    let withAddress = 0
    for (const gateway of filteredGateways) {
      if (gateway.programmed) programmed += 1
      if (gateway.accepted) accepted += 1
      if ((gateway.addresses_count || 0) > 0) withAddress += 1
    }
    return { total, programmed, accepted, withAddress }
  }, [filteredGateways])

  const sortedGateways = useMemo(() => {
    if (!sortKey) return filteredGateways
    const list = [...filteredGateways]

    const getValue = (gateway: GatewayInfo): string | number => {
      switch (sortKey) {
        case 'name':
          return gateway.name
        case 'namespace':
          return gateway.namespace
        case 'class':
          return gateway.gateway_class_name || ''
        case 'status':
          return gateway.status || ''
        case 'listeners':
          return gateway.listeners_count || 0
        case 'routes':
          return gateway.attached_routes || 0
        case 'addresses':
          return gateway.addresses_count || 0
        case 'age':
          return parseAgeSeconds(gateway.created_at)
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
  }, [filteredGateways, sortDir, sortKey])

  const { containerRef: tableContainerRef, bodyRef: tableBodyRef, theadRef, firstRowRef, rowsPerPage } = useAdaptiveTable({
    recalculationKey: sortedGateways.length,
  })
  const totalPages = Math.max(1, Math.ceil(sortedGateways.length / rowsPerPage))

  useEffect(() => {
    setCurrentPage(1)
  }, [searchQuery, selectedNamespace])

  useEffect(() => {
    if (currentPage > totalPages) setCurrentPage(totalPages)
  }, [currentPage, totalPages])

  const pagedGateways = useMemo(() => {
    const start = (currentPage - 1) * rowsPerPage
    return sortedGateways.slice(start, start + rowsPerPage)
  }, [sortedGateways, currentPage, rowsPerPage])

  // 플로팅 AI 위젯용 스냅샷
  const aiSnapshot = useMemo(() => {
    if (!Array.isArray(gateways) || gateways.length === 0) return null
    const nsLabel = selectedNamespace === 'all' ? '전체 네임스페이스' : selectedNamespace
    const total = gateways.length
    const notProgrammed = gateways.filter((g) => g.programmed === false).length
    const prefix = notProgrammed > 0 ? '⚠️ ' : ''
    return {
      source: 'base' as const,
      summary: `${prefix}${nsLabel} Gateway ${total}개${notProgrammed ? ` (Not Programmed ${notProgrammed})` : ''}`,
      data: {
        filters: { namespace: selectedNamespace, search: searchQuery || undefined },
        stats: { total, not_programmed: notProgrammed },
        ...summarizeList(pagedGateways as unknown as Record<string, unknown>[], {
          total: sortedGateways.length,
          currentPage,
          pageSize: rowsPerPage,
          topN: rowsPerPage,
          pickFields: ['name', 'namespace', 'gateway_class_name', 'listeners_count', 'attached_routes', 'addresses_count', 'programmed', 'accepted', 'status'],
          filterProblematic: (g) => (g as unknown as GatewayInfo).programmed === false,
          linkBuilder: (g) => {
            const gw = g as unknown as GatewayInfo
            return buildResourceLink('Gateway', gw.namespace, gw.name)
          },
        }),
      },
    }
  }, [gateways, pagedGateways, sortedGateways.length, currentPage, rowsPerPage, selectedNamespace, searchQuery])

  useAIContext(aiSnapshot, [aiSnapshot])

  const handleRefresh = async () => {
    if (isRefreshing) return
    setIsRefreshing(true)
    try {
      const data = selectedNamespace === 'all'
        ? await api.getAllGateways(true)
        : await api.getGateways(selectedNamespace, true)
      queryClient.removeQueries({ queryKey: ['gateway', 'gateways', selectedNamespace] })
      queryClient.setQueryData(['gateway', 'gateways', selectedNamespace], data)
    } catch (error) {
      console.error('Gateways refresh failed:', error)
    }
    setTimeout(() => setIsRefreshing(false), 500)
  }

  const createGatewayYamlTemplate = useMemo(() => {
    const ns = selectedNamespace !== 'all' ? selectedNamespace : 'default'
    return `apiVersion: gateway.networking.k8s.io/v1
kind: Gateway
metadata:
  name: sample-gateway
  namespace: ${ns}
spec:
  gatewayClassName: example
  listeners:
    - name: http
      protocol: HTTP
      port: 80
`
  }, [selectedNamespace])

  const showNamespaceColumn = selectedNamespace === 'all'

  return (
    <div className="flex flex-col h-[calc(100vh-4rem)] gap-4">
      <div className="flex items-center justify-between shrink-0">
        <div>
          <h1 className="text-3xl font-bold text-white">{tr('gatewaysPage.title', 'Gateways')}</h1>
          <p className="mt-2 text-slate-400">{tr('gatewaysPage.subtitle', 'Inspect and manage Gateway API Gateways across namespaces.')}</p>
        </div>
        <div className="flex items-center gap-2">
          {canCreate && (
            <button
              type="button"
              onClick={() => setCreateDialogOpen(true)}
              className="btn btn-primary flex items-center gap-2"
            >
              <Plus className="w-4 h-4" />
              {tr('gatewaysPage.create', 'Create Gateway')}
            </button>
          )}
          <button
            type="button"
            onClick={handleRefresh}
            disabled={isRefreshing}
            title={tr('gatewaysPage.refreshTitle', 'Force refresh')}
            className="btn btn-primary flex items-center gap-2 disabled:opacity-50 disabled:cursor-not-allowed"
          >
            <RefreshCw className={`w-4 h-4 ${isRefreshing ? 'animate-spin' : ''}`} />
            {tr('gatewaysPage.refresh', 'Refresh')}
          </button>
        </div>
      </div>

      <GatewayFilters
        searchQuery={searchQuery}
        setSearchQuery={setSearchQuery}
        selectedNamespace={selectedNamespace}
        setSelectedNamespace={setSelectedNamespace}
        namespaces={namespaces}
        searchPlaceholder={tr('gatewaysPage.searchPlaceholder', 'Search gateways by name...')}
        allNamespacesLabel={tr('gatewaysPage.allNamespaces', 'All namespaces')}
      />

      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3 shrink-0">
        <div className="rounded-lg border border-slate-700 bg-slate-900/50 px-4 py-3">
          <p className="text-[11px] sm:text-xs leading-4 whitespace-nowrap text-slate-400">{tr('gatewaysPage.stats.total', 'Total')}</p>
          <p className="text-lg text-white font-semibold mt-1">{summary.total}</p>
        </div>
        <div className="rounded-lg border border-emerald-700/40 bg-emerald-900/10 px-4 py-3">
          <p className="text-[11px] sm:text-xs leading-4 whitespace-nowrap text-emerald-300">{tr('gatewaysPage.stats.programmed', 'Programmed')}</p>
          <p className="text-lg text-white font-semibold mt-1">{summary.programmed}</p>
        </div>
        <div className="rounded-lg border border-cyan-700/40 bg-cyan-900/10 px-4 py-3">
          <p className="text-[11px] sm:text-xs leading-4 whitespace-nowrap text-cyan-300">{tr('gatewaysPage.stats.accepted', 'Accepted')}</p>
          <p className="text-lg text-white font-semibold mt-1">{summary.accepted}</p>
        </div>
        <div className="rounded-lg border border-amber-700/40 bg-amber-900/10 px-4 py-3">
          <p className="text-[11px] sm:text-xs leading-4 whitespace-nowrap text-amber-300">{tr('gatewaysPage.stats.withAddress', 'With Address')}</p>
          <p className="text-lg text-white font-semibold mt-1">{summary.withAddress}</p>
        </div>
      </div>

      {searchQuery && (
        <p className="text-sm text-slate-400 shrink-0">
          {tr('gatewaysPage.matchCount', '{{count}} gateway{{suffix}} match.', {
            count: filteredGateways.length,
            suffix: filteredGateways.length === 1 ? '' : 's',
          })}
        </p>
      )}

      <GatewayTable
        pagedGateways={pagedGateways}
        sortedGatewaysLength={sortedGateways.length}
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
          title={tr('gatewaysPage.createTitle', 'Create Gateway from YAML')}
          initialYaml={createGatewayYamlTemplate}
          namespace={selectedNamespace !== 'all' ? selectedNamespace : undefined}
          onClose={() => setCreateDialogOpen(false)}
          onCreated={() => {
            queryClient.invalidateQueries({ queryKey: ['gateway', 'gateways'] })
          }}
        />
      )}
    </div>
  )
}
