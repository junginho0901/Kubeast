import { useEffect, useMemo, useRef, useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { useTranslation } from 'react-i18next'
import { api, type EndpointInfo } from '@/services/api'
import { useKubeWatchList } from '@/services/useKubeWatchList'
import { useResourceDetail } from '@/components/ResourceDetailContext'
import ResourceYamlCreateDialog from '@/components/ResourceYamlCreateDialog'
import { useAdaptiveRowsPerPage } from '@/hooks/useAdaptiveRowsPerPage'
import { CheckCircle, ChevronDown, ChevronUp, Plus, RefreshCw, Search } from 'lucide-react'

type SortKey = null | 'name' | 'namespace' | 'ready' | 'notReady' | 'addresses' | 'ports' | 'age'
type SummaryCard = [label: string, value: number, boxClass: string, labelClass: string]

function parseAgeSeconds(createdAt?: string | null): number {
  if (!createdAt) return 0
  const ms = new Date(createdAt).getTime()
  if (!Number.isFinite(ms)) return 0
  return Math.max(0, Math.floor((Date.now() - ms) / 1000))
}

function formatAge(createdAt?: string | null): string {
  const sec = parseAgeSeconds(createdAt)
  const d = Math.floor(sec / 86400)
  const h = Math.floor((sec % 86400) / 3600)
  const m = Math.floor((sec % 3600) / 60)
  if (d > 0) return `${d}d ${h}h`
  if (h > 0) return `${h}h ${m}m`
  return `${m}m`
}

function formatPorts(ports: EndpointInfo['ports']): string {
  if (!Array.isArray(ports) || ports.length === 0) return '-'
  return ports
    .map((p) => `${p.name || '-'}:${p.port ?? '-'}${p.protocol ? `/${p.protocol}` : ''}`)
    .join(', ')
}

function formatAddresses(row: EndpointInfo): string {
  const ready = row.ready_addresses || []
  const notReady = row.not_ready_addresses || []
  if (ready.length === 0 && notReady.length === 0) return '-'
  if (notReady.length === 0) return ready.join(', ')
  return `${ready.join(', ')} | not-ready: ${notReady.join(', ')}`
}

function getEndpointAddressCount(row: EndpointInfo): number {
  return (row.ready_count || 0) + (row.not_ready_count || 0)
}

function normalizeWatchEndpointObject(obj: any): EndpointInfo {
  if (
    typeof obj?.name === 'string' &&
    typeof obj?.namespace === 'string' &&
    typeof obj?.ready_count === 'number' &&
    typeof obj?.not_ready_count === 'number' &&
    Array.isArray(obj?.ports)
  ) {
    return obj as EndpointInfo
  }

  const metadata = obj?.metadata ?? {}
  const subsets = Array.isArray(obj?.subsets) ? obj.subsets : []

  const readyAddresses: string[] = []
  const notReadyAddresses: string[] = []
  const readyTargets: EndpointInfo['ready_targets'] = []
  const notReadyTargets: EndpointInfo['not_ready_targets'] = []
  const ports: EndpointInfo['ports'] = []

  for (const subset of subsets) {
    for (const addr of subset?.addresses || []) {
      const ip = addr?.ip
      if (ip) readyAddresses.push(ip)
      readyTargets.push({
        ip,
        node_name: addr?.nodeName || addr?.node_name,
        target_ref: addr?.targetRef || addr?.target_ref || null,
      })
    }
    for (const addr of subset?.notReadyAddresses || subset?.not_ready_addresses || []) {
      const ip = addr?.ip
      if (ip) notReadyAddresses.push(ip)
      notReadyTargets.push({
        ip,
        node_name: addr?.nodeName || addr?.node_name,
        target_ref: addr?.targetRef || addr?.target_ref || null,
      })
    }
    for (const p of subset?.ports || []) {
      ports.push({
        name: p?.name,
        port: p?.port,
        protocol: p?.protocol,
      })
    }
  }

  const seen = new Set<string>()
  const dedupPorts = ports.filter((p) => {
    const key = `${p.name || ''}|${p.port || ''}|${p.protocol || ''}`
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })

  return {
    name: metadata?.name ?? obj?.name ?? '',
    namespace: metadata?.namespace ?? obj?.namespace ?? '',
    ready_count: readyAddresses.length,
    not_ready_count: notReadyAddresses.length,
    ready_addresses: readyAddresses,
    not_ready_addresses: notReadyAddresses,
    ready_targets: readyTargets,
    not_ready_targets: notReadyTargets,
    ports: dedupPorts,
    created_at: metadata?.creationTimestamp ?? obj?.created_at ?? '',
  }
}

function applyEndpointWatchEvent(prev: EndpointInfo[] | undefined, event: { type?: string; object?: any }): EndpointInfo[] {
  const items = Array.isArray(prev) ? [...prev] : []
  const obj = event?.object
  if (!obj) return items

  const normalized = normalizeWatchEndpointObject(obj)
  const name = normalized?.name
  const namespace = normalized?.namespace
  if (!name || !namespace) return items

  const key = `${namespace}/${name}`
  const index = items.findIndex((item) => `${item.namespace}/${item.name}` === key)

  if (event.type === 'DELETED') {
    if (index >= 0) items.splice(index, 1)
    return items
  }

  if (index >= 0) items[index] = normalized
  else items.push(normalized)

  return items
}

function endpointToRawJson(endpoint: EndpointInfo): Record<string, unknown> {
  const toAddress = (target: NonNullable<EndpointInfo['ready_targets']>[number]) => ({
    ip: target?.ip,
    nodeName: target?.node_name,
    targetRef: target?.target_ref || undefined,
  })

  const addressesFromTargets = (endpoint.ready_targets || []).map(toAddress)
  const notReadyFromTargets = (endpoint.not_ready_targets || []).map(toAddress)

  const addresses = addressesFromTargets.length > 0
    ? addressesFromTargets
    : (endpoint.ready_addresses || []).map((ip) => ({ ip }))

  const notReadyAddresses = notReadyFromTargets.length > 0
    ? notReadyFromTargets
    : (endpoint.not_ready_addresses || []).map((ip) => ({ ip }))

  const subsets = (addresses.length > 0 || notReadyAddresses.length > 0 || (endpoint.ports || []).length > 0)
    ? [{
        addresses,
        notReadyAddresses,
        ports: (endpoint.ports || []).map((p) => ({
          name: p.name,
          port: p.port,
          protocol: p.protocol,
        })),
      }]
    : []

  return {
    apiVersion: 'v1',
    kind: 'Endpoints',
    metadata: {
      name: endpoint.name,
      namespace: endpoint.namespace,
      creationTimestamp: endpoint.created_at,
    },
    ready_count: endpoint.ready_count,
    not_ready_count: endpoint.not_ready_count,
    ready_addresses: endpoint.ready_addresses || [],
    not_ready_addresses: endpoint.not_ready_addresses || [],
    ready_targets: endpoint.ready_targets || [],
    not_ready_targets: endpoint.not_ready_targets || [],
    ports: endpoint.ports || [],
    subsets,
  }
}

export default function Endpoints() {
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
  const tableContainerRef = useRef<HTMLDivElement>(null)

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

  const { data: me } = useQuery({
    queryKey: ['me'],
    queryFn: api.me,
    staleTime: 30000,
  })
  const canCreate = me?.role === 'admin' || me?.role === 'write'

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

  const rowsPerPage = useAdaptiveRowsPerPage(tableContainerRef, {
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

      <div className="grid grid-cols-1 xl:grid-cols-3 gap-3 shrink-0">
        <div className="xl:col-span-2">
          <div className="relative">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-5 h-5 text-slate-400" />
            <input
              type="text"
              placeholder={tr('endpointsPage.searchPlaceholder', 'Search endpoints by name...')}
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
              {selectedNamespace === 'all' ? tr('endpointsPage.allNamespaces', 'All namespaces') : selectedNamespace}
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
                <span className={selectedNamespace === 'all' ? 'font-medium' : ''}>{tr('endpointsPage.allNamespaces', 'All namespaces')}</span>
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

      <div ref={tableContainerRef} className="card flex-1 min-h-0 flex flex-col">
        <div className="overflow-x-auto flex-1 min-h-0">
          <table className="w-full text-sm min-w-[1220px] table-fixed">
            <thead className="text-slate-400">
              <tr>
                {showNamespaceColumn && (
                  <th className="text-left py-3 px-4 w-[160px] cursor-pointer" onClick={() => handleSort('namespace')}>
                    <span className="inline-flex items-center gap-1">{tr('endpointsPage.table.namespace', 'Namespace')}{renderSortIcon('namespace')}</span>
                  </th>
                )}
                <th className="text-left py-3 px-4 w-[220px] cursor-pointer" onClick={() => handleSort('name')}>
                  <span className="inline-flex items-center gap-1">{tr('endpointsPage.table.name', 'Name')}{renderSortIcon('name')}</span>
                </th>
                <th className="text-left py-3 px-4 w-[320px] cursor-pointer" onClick={() => handleSort('addresses')}>
                  <span className="inline-flex items-center gap-1">{tr('endpointsPage.table.addresses', 'Addresses')}{renderSortIcon('addresses')}</span>
                </th>
                <th className="text-left py-3 px-4 w-[220px] cursor-pointer" onClick={() => handleSort('ports')}>
                  <span className="inline-flex items-center gap-1">{tr('endpointsPage.table.ports', 'Ports')}{renderSortIcon('ports')}</span>
                </th>
                <th className="text-left py-3 px-4 w-[90px] cursor-pointer" onClick={() => handleSort('ready')}>
                  <span className="inline-flex items-center gap-1">{tr('endpointsPage.table.ready', 'Ready')}{renderSortIcon('ready')}</span>
                </th>
                <th className="text-left py-3 px-4 w-[110px] cursor-pointer" onClick={() => handleSort('notReady')}>
                  <span className="inline-flex items-center gap-1">{tr('endpointsPage.table.notReady', 'Not Ready')}{renderSortIcon('notReady')}</span>
                </th>
                <th className="text-left py-3 px-4 w-[90px] cursor-pointer" onClick={() => handleSort('age')}>
                  <span className="inline-flex items-center gap-1">{tr('endpointsPage.table.age', 'Age')}{renderSortIcon('age')}</span>
                </th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-700">
              {pagedEndpoints.map((ep) => (
                <tr
                  key={`${ep.namespace}/${ep.name}`}
                  className="text-slate-200 hover:bg-slate-800/60 cursor-pointer"
                  onClick={() => openDetail({
                    kind: 'Endpoints',
                    name: ep.name,
                    namespace: ep.namespace,
                    rawJson: endpointToRawJson(ep),
                  })}
                >
                  {showNamespaceColumn && <td className="py-3 px-4 text-xs font-mono">{ep.namespace}</td>}
                  <td className="py-3 px-4 font-medium text-white"><span className="block truncate">{ep.name}</span></td>
                  <td className="py-3 px-4 text-xs font-mono"><span className="block truncate">{formatAddresses(ep)}</span></td>
                  <td className="py-3 px-4 text-xs font-mono"><span className="block truncate">{formatPorts(ep.ports)}</span></td>
                  <td className="py-3 px-4 text-xs font-mono">{ep.ready_count || 0}</td>
                  <td className="py-3 px-4 text-xs font-mono">{ep.not_ready_count || 0}</td>
                  <td className="py-3 px-4 text-xs font-mono">{formatAge(ep.created_at)}</td>
                </tr>
              ))}
              {sortedEndpoints.length === 0 && !isLoading && (
                <tr>
                  <td colSpan={showNamespaceColumn ? 8 : 7} className="py-6 px-4 text-center text-slate-400">
                    {tr('endpointsPage.noResults', 'No endpoints found.')}
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>

        {sortedEndpoints.length > 0 && (
          <div className="flex items-center justify-between px-4 py-3 border-t border-slate-700 shrink-0">
            <div className="text-xs text-slate-400">
              {tr('common.paginationRange', 'Showing {{start}}-{{end}} of {{total}}', {
                start: (currentPage - 1) * rowsPerPage + 1,
                end: Math.min(currentPage * rowsPerPage, sortedEndpoints.length),
                total: sortedEndpoints.length,
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
