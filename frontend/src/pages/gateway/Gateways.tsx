import { useEffect, useMemo, useRef, useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { useTranslation } from 'react-i18next'
import { api, type GatewayInfo } from '@/services/api'
import { useKubeWatchList } from '@/services/useKubeWatchList'
import { useResourceDetail } from '@/components/ResourceDetailContext'
import ResourceYamlCreateDialog from '@/components/ResourceYamlCreateDialog'
import { useAdaptiveTable } from '@/hooks/useAdaptiveTable'
import { AdaptiveTableFillerRows } from '@/components/AdaptiveTableFillerRows'
import { useAIContext } from '@/hooks/useAIContext'
import { usePermission } from '@/hooks/usePermission'
import { summarizeList } from '@/utils/aiContext/summarizeList'
import { buildResourceLink } from '@/utils/resourceLink'
import { Loader2, CheckCircle, ChevronDown, ChevronUp, Plus, RefreshCw, Search } from 'lucide-react'
import {
  parseAgeSeconds,
  formatAge,
  gatewayToRawJson,
  type SortKey,
} from './gateways/gatewayHelpers'
import { applyGatewayWatchEvent } from './gateways/gatewayWatchNormalize'

export default function Gateways() {
  const queryClient = useQueryClient()
  const { t } = useTranslation()
  const tr = (key: string, fallback: string, options?: Record<string, any>) =>
    t(key, { defaultValue: fallback, ...options })
  const { open: openDetail } = useResourceDetail()

  const [searchQuery, setSearchQuery] = useState('')
  const [selectedNamespace, setSelectedNamespace] = useState<string>('all')
  const [isNamespaceDropdownOpen, setIsNamespaceDropdownOpen] = useState(false)
  const [isRefreshing, setIsRefreshing] = useState(false)
  const [sortKey, setSortKey] = useState<SortKey>(null)
  const [sortDir, setSortDir] = useState<'asc' | 'desc'>('asc')
  const [currentPage, setCurrentPage] = useState(1)
  const [createDialogOpen, setCreateDialogOpen] = useState(false)
  const namespaceDropdownRef = useRef<HTMLDivElement>(null)

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

  useEffect(() => {
    if (!isNamespaceDropdownOpen) return
    const handleClickOutside = (event: MouseEvent) => {
      if (namespaceDropdownRef.current && !namespaceDropdownRef.current.contains(event.target as Node)) {
        setIsNamespaceDropdownOpen(false)
      }
    }
    document.addEventListener('mousedown', handleClickOutside)
    return () => document.removeEventListener('mousedown', handleClickOutside)
  }, [isNamespaceDropdownOpen])

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

  const handleSort = (key: NonNullable<SortKey>) => {
    if (sortKey !== key) {
      setSortKey(key)
      setSortDir('asc')
      return
    }
    if (sortDir === 'asc') {
      setSortDir('desc')
      return
    }
    setSortKey(null)
  }

  const renderSortIcon = (key: NonNullable<SortKey>) => {
    if (sortKey !== key) return null
    return sortDir === 'asc'
      ? <ChevronUp className="w-3.5 h-3.5 text-slate-300" />
      : <ChevronDown className="w-3.5 h-3.5 text-slate-300" />
  }

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

      <div className="grid grid-cols-1 xl:grid-cols-3 gap-3 shrink-0">
        <div className="xl:col-span-2">
          <div className="relative">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-5 h-5 text-slate-400" />
            <input
              type="text"
              placeholder={tr('gatewaysPage.searchPlaceholder', 'Search gateways by name...')}
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              className="h-12 w-full pl-10 pr-4 bg-slate-700 border border-slate-600 rounded-lg text-sm text-white placeholder-slate-400 focus:outline-none focus:ring-2 focus:ring-primary-500 focus:border-transparent"
            />
          </div>
        </div>

        <div className="relative" ref={namespaceDropdownRef}>
          <button
            type="button"
            onClick={() => setIsNamespaceDropdownOpen((v) => !v)}
            className="h-12 w-full px-3 bg-slate-700 border border-slate-600 rounded-lg text-sm text-white focus:outline-none focus:ring-2 focus:ring-primary-500 focus:border-transparent flex items-center justify-between gap-2"
          >
            <span className="text-sm font-medium">
              {selectedNamespace === 'all' ? tr('gatewaysPage.allNamespaces', 'All namespaces') : selectedNamespace}
            </span>
            <ChevronDown className={`w-4 h-4 text-slate-400 transition-transform ${isNamespaceDropdownOpen ? 'rotate-180' : ''}`} />
          </button>
          {isNamespaceDropdownOpen && (
            <div className="absolute top-full left-0 mt-2 w-full bg-slate-700 border border-slate-600 rounded-lg shadow-xl z-[100] max-h-[240px] overflow-y-auto">
              <button
                type="button"
                onClick={() => {
                  setSelectedNamespace('all')
                  setIsNamespaceDropdownOpen(false)
                }}
                className="w-full px-4 py-2.5 text-left text-sm text-white hover:bg-slate-600 transition-colors flex items-center gap-2 first:rounded-t-lg"
              >
                {selectedNamespace === 'all' && <CheckCircle className="w-4 h-4 text-green-400 flex-shrink-0" />}
                <span className={selectedNamespace === 'all' ? 'font-medium' : ''}>{tr('gatewaysPage.allNamespaces', 'All namespaces')}</span>
              </button>
              {(namespaces || []).map((ns) => (
                <button
                  key={ns.name}
                  type="button"
                  onClick={() => {
                    setSelectedNamespace(ns.name)
                    setIsNamespaceDropdownOpen(false)
                  }}
                  className="w-full px-4 py-2.5 text-left text-sm text-white hover:bg-slate-600 transition-colors flex items-center gap-2 last:rounded-b-lg"
                >
                  {selectedNamespace === ns.name && <CheckCircle className="w-4 h-4 text-green-400 flex-shrink-0" />}
                  <span className={selectedNamespace === ns.name ? 'font-medium' : ''}>{ns.name}</span>
                </button>
              ))}
            </div>
          )}
        </div>
      </div>

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

      <div ref={tableContainerRef} className="card flex-1 min-h-0 flex flex-col">
        <div ref={tableBodyRef} className="overflow-x-auto flex-1 min-h-0">
          <table className="w-full text-sm min-w-[1120px] table-fixed">
            <thead ref={theadRef} className="text-slate-400">
              <tr>
                {showNamespaceColumn && (
                  <th className="text-left py-3 px-4 w-[170px] cursor-pointer" onClick={() => handleSort('namespace')}>
                    <span className="inline-flex items-center gap-1">{tr('gatewaysPage.table.namespace', 'Namespace')}{renderSortIcon('namespace')}</span>
                  </th>
                )}
                <th className="text-left py-3 px-4 w-[250px] cursor-pointer" onClick={() => handleSort('name')}>
                  <span className="inline-flex items-center gap-1">{tr('gatewaysPage.table.name', 'Name')}{renderSortIcon('name')}</span>
                </th>
                <th className="text-left py-3 px-4 w-[170px] cursor-pointer" onClick={() => handleSort('class')}>
                  <span className="inline-flex items-center gap-1">{tr('gatewaysPage.table.class', 'Class Name')}{renderSortIcon('class')}</span>
                </th>
                <th className="text-left py-3 px-4 w-[160px] cursor-pointer" onClick={() => handleSort('status')}>
                  <span className="inline-flex items-center gap-1">{tr('gatewaysPage.table.status', 'Conditions')}{renderSortIcon('status')}</span>
                </th>
                <th className="text-left py-3 px-4 w-[120px] cursor-pointer" onClick={() => handleSort('listeners')}>
                  <span className="inline-flex items-center gap-1">{tr('gatewaysPage.table.listeners', 'Listeners')}{renderSortIcon('listeners')}</span>
                </th>
                <th className="text-left py-3 px-4 w-[140px] cursor-pointer" onClick={() => handleSort('routes')}>
                  <span className="inline-flex items-center gap-1">{tr('gatewaysPage.table.attachedRoutes', 'Attached Routes')}{renderSortIcon('routes')}</span>
                </th>
                <th className="text-left py-3 px-4 w-[120px] cursor-pointer" onClick={() => handleSort('addresses')}>
                  <span className="inline-flex items-center gap-1">{tr('gatewaysPage.table.addresses', 'Addresses')}{renderSortIcon('addresses')}</span>
                </th>
                <th className="text-left py-3 px-4 w-[90px] cursor-pointer" onClick={() => handleSort('age')}>
                  <span className="inline-flex items-center gap-1">{tr('gatewaysPage.table.age', 'Age')}{renderSortIcon('age')}</span>
                </th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-700">
              {pagedGateways.map((gateway, idx) => (
                <tr
                      ref={idx === 0 ? firstRowRef : undefined}
                  key={`${gateway.namespace}/${gateway.name}`}
                  className="text-slate-200 hover:bg-slate-800/60 cursor-pointer"
                  onClick={() => openDetail({
                    kind: 'Gateway',
                    name: gateway.name,
                    namespace: gateway.namespace,
                    rawJson: gatewayToRawJson(gateway),
                  })}
                >
                  {showNamespaceColumn && <td className="py-3 px-4 text-xs font-mono"><span className="block truncate">{gateway.namespace}</span></td>}
                  <td className="py-3 px-4 font-medium text-white"><span className="block truncate">{gateway.name}</span></td>
                  <td className="py-3 px-4 text-xs"><span className="block truncate">{gateway.gateway_class_name || '-'}</span></td>
                  <td className="py-3 px-4 text-xs"><span className="block truncate">{gateway.status || '-'}</span></td>
                  <td className="py-3 px-4 text-xs font-mono">{gateway.listeners_count || 0}</td>
                  <td className="py-3 px-4 text-xs font-mono">{gateway.attached_routes || 0}</td>
                  <td className="py-3 px-4 text-xs font-mono">{gateway.addresses_count || 0}</td>
                  <td className="py-3 px-4 text-xs font-mono">{formatAge(gateway.created_at)}</td>
                </tr>
              ))}
              {isLoading && (
                <tr>
                  <td colSpan={showNamespaceColumn ? 9 : 8} className="py-10 px-4 text-center text-slate-400">
                    <div className="inline-flex items-center gap-2">
                      <Loader2 className="w-4 h-4 animate-spin" />
                      Loading...
                    </div>
                  </td>
                </tr>
              )}

              {sortedGateways.length === 0 && !isLoading && (
                <tr>
                  <td colSpan={showNamespaceColumn ? 9 : 8} className="py-6 px-4 text-center text-slate-400">
                    {tr('gatewaysPage.noResults', 'No gateways found.')}
                  </td>
                </tr>
              )}
            </tbody>
              <AdaptiveTableFillerRows count={rowsPerPage - pagedGateways.length} columnCount={7 + (showNamespaceColumn ? 1 : 0)} />
          </table>
        </div>

        {sortedGateways.length > 0 && (
          <div className="flex items-center justify-between px-4 py-3 border-t border-slate-700 shrink-0">
            <div className="text-xs text-slate-400">
              {tr('common.paginationRange', 'Showing {{start}}-{{end}} of {{total}}', {
                start: (currentPage - 1) * rowsPerPage + 1,
                end: Math.min(currentPage * rowsPerPage, sortedGateways.length),
                total: sortedGateways.length,
              })}
            </div>
            <div className="flex items-center gap-2">
              <button
                type="button"
                onClick={() => setCurrentPage((prev) => Math.max(1, prev - 1))}
                disabled={currentPage <= 1}
                className="px-3 py-1.5 text-xs rounded border border-slate-600 text-slate-300 disabled:opacity-40 disabled:cursor-not-allowed hover:text-white hover:border-slate-500"
              >
                {tr('common.prev', 'Prev')}
              </button>
              <span className="text-xs text-slate-300 min-w-[72px] text-center">{currentPage} / {totalPages}</span>
              <button
                type="button"
                onClick={() => setCurrentPage((prev) => Math.min(totalPages, prev + 1))}
                disabled={currentPage >= totalPages}
                className="px-3 py-1.5 text-xs rounded border border-slate-600 text-slate-300 disabled:opacity-40 disabled:cursor-not-allowed hover:text-white hover:border-slate-500"
              >
                {tr('common.next', 'Next')}
              </button>
            </div>
          </div>
        )}
      </div>

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
