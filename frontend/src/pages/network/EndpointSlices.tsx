import { useEffect, useMemo, useRef, useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { useTranslation } from 'react-i18next'
import { api, type EndpointSliceInfo } from '@/services/api'
import { useKubeWatchList } from '@/services/useKubeWatchList'
import { useResourceDetail } from '@/components/ResourceDetailContext'
import ResourceYamlCreateDialog from '@/components/ResourceYamlCreateDialog'
import { useAdaptiveRowsPerPage } from '@/hooks/useAdaptiveRowsPerPage'
import { useAIContext } from '@/hooks/useAIContext'
import { usePermission } from '@/hooks/usePermission'
import { summarizeList } from '@/utils/aiContext/summarizeList'
import { buildResourceLink } from '@/utils/resourceLink'
import { Loader2, CheckCircle, ChevronDown, ChevronUp, Plus, RefreshCw, Search } from 'lucide-react'

type SortKey =
  | null
  | 'name'
  | 'namespace'
  | 'service'
  | 'addressType'
  | 'endpoints'
  | 'ready'
  | 'notReady'
  | 'ports'
  | 'age'
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

function formatPorts(ports: EndpointSliceInfo['ports']): string {
  if (!Array.isArray(ports) || ports.length === 0) return '-'
  return ports
    .map((p) => {
      const app = p.app_protocol ? ` (${p.app_protocol})` : ''
      return `${p.name || '-'}:${p.port ?? '-'}${p.protocol ? `/${p.protocol}` : ''}${app}`
    })
    .join(', ')
}

function formatEndpointPreview(row: EndpointSliceInfo): string {
  const total = row.endpoints_total || 0
  const endpoints = Array.isArray(row.endpoints) ? row.endpoints : []
  if (total === 0 || endpoints.length === 0) return '-'
  const addresses = endpoints.flatMap((ep) => ep.addresses || []).filter(Boolean)
  if (addresses.length === 0) return `${total} endpoint${total === 1 ? '' : 's'}`
  const preview = addresses.slice(0, 3).join(', ')
  if (addresses.length <= 3) return preview
  return `${preview} +${addresses.length - 3}`
}

function resolveNotReadyCount(slice: EndpointSliceInfo): number {
  return slice.endpoints_not_ready ?? Math.max((slice.endpoints_total || 0) - (slice.endpoints_ready || 0), 0)
}

function normalizeWatchEndpointSliceObject(obj: any): EndpointSliceInfo {
  if (
    typeof obj?.name === 'string' &&
    typeof obj?.namespace === 'string' &&
    typeof obj?.endpoints_total === 'number' &&
    typeof obj?.endpoints_ready === 'number' &&
    Array.isArray(obj?.ports)
  ) {
    return {
      ...obj,
      endpoints_not_ready: typeof obj?.endpoints_not_ready === 'number'
        ? obj.endpoints_not_ready
        : Math.max((obj?.endpoints_total || 0) - (obj?.endpoints_ready || 0), 0),
    } as EndpointSliceInfo
  }

  const metadata = obj?.metadata ?? {}
  const labels = (metadata?.labels ?? {}) as Record<string, string>
  const annotations = (metadata?.annotations ?? {}) as Record<string, string>
  const rawEndpoints = Array.isArray(obj?.endpoints) ? obj.endpoints : []
  const rawPorts = Array.isArray(obj?.ports) ? obj.ports : []

  const endpoints = rawEndpoints.map((ep: any) => {
    const cond = ep?.conditions ?? {}
    const ref = ep?.targetRef ?? ep?.target_ref
    const topology = ep?.topology ?? {}
    return {
      addresses: Array.isArray(ep?.addresses) ? ep.addresses : [],
      hostname: ep?.hostname,
      node_name: ep?.nodeName || ep?.node_name,
      zone: ep?.zone || topology?.['topology.kubernetes.io/zone'] || topology?.['failure-domain.beta.kubernetes.io/zone'],
      conditions: {
        ready: cond?.ready,
        serving: cond?.serving,
        terminating: cond?.terminating,
      },
      target_ref: ref
        ? {
            kind: ref?.kind,
            name: ref?.name,
            namespace: ref?.namespace,
            uid: ref?.uid,
          }
        : null,
    }
  })

  let ready = 0
  for (const ep of endpoints) {
    const condReady = ep?.conditions?.ready
    if (condReady === true || condReady == null) ready += 1
  }

  const ports = rawPorts.map((p: any) => ({
    name: p?.name,
    port: p?.port,
    protocol: p?.protocol,
    app_protocol: p?.appProtocol || p?.app_protocol,
  }))

  const total = endpoints.length

  return {
    name: metadata?.name ?? obj?.name ?? '',
    namespace: metadata?.namespace ?? obj?.namespace ?? '',
    service_name: labels?.['kubernetes.io/service-name'] ?? obj?.service_name,
    managed_by: labels?.['endpointslice.kubernetes.io/managed-by'] ?? obj?.managed_by,
    address_type: obj?.addressType ?? obj?.address_type,
    endpoints_total: total,
    endpoints_ready: ready,
    endpoints_not_ready: Math.max(total - ready, 0),
    ports,
    endpoints,
    labels,
    annotations,
    created_at: metadata?.creationTimestamp ?? obj?.created_at ?? '',
  }
}

function applyEndpointSliceWatchEvent(prev: EndpointSliceInfo[] | undefined, event: { type?: string; object?: any }): EndpointSliceInfo[] {
  const items = Array.isArray(prev) ? [...prev] : []
  const obj = event?.object
  if (!obj) return items

  const normalized = normalizeWatchEndpointSliceObject(obj)
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

function endpointSliceToRawJson(slice: EndpointSliceInfo): Record<string, unknown> {
  return {
    apiVersion: 'discovery.k8s.io/v1',
    kind: 'EndpointSlice',
    metadata: {
      name: slice.name,
      namespace: slice.namespace,
      creationTimestamp: slice.created_at,
      labels: slice.labels || {},
      annotations: slice.annotations || {},
    },
    service_name: slice.service_name,
    managed_by: slice.managed_by,
    address_type: slice.address_type,
    endpoints_total: slice.endpoints_total,
    endpoints_ready: slice.endpoints_ready,
    endpoints_not_ready: slice.endpoints_not_ready ?? Math.max((slice.endpoints_total || 0) - (slice.endpoints_ready || 0), 0),
    addressType: slice.address_type,
    endpoints: (slice.endpoints || []).map((ep) => ({
      addresses: ep.addresses || [],
      hostname: ep.hostname,
      nodeName: ep.node_name,
      zone: ep.zone,
      conditions: {
        ready: ep.conditions?.ready,
        serving: ep.conditions?.serving,
        terminating: ep.conditions?.terminating,
      },
      targetRef: ep.target_ref || undefined,
    })),
    ports: (slice.ports || []).map((p) => ({
      name: p.name,
      port: p.port,
      protocol: p.protocol,
      appProtocol: p.app_protocol,
    })),
  }
}

export default function EndpointSlices() {
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

  const rowsPerPage = useAdaptiveRowsPerPage(tableContainerRef, {
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

      <div className="grid grid-cols-1 xl:grid-cols-3 gap-3 shrink-0">
        <div className="xl:col-span-2">
          <div className="relative">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-5 h-5 text-slate-400" />
            <input
              type="text"
              placeholder={tr('endpointSlicesPage.searchPlaceholder', 'Search endpoint slices by name...')}
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
              {selectedNamespace === 'all' ? tr('endpointSlicesPage.allNamespaces', 'All namespaces') : selectedNamespace}
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
                <span className={selectedNamespace === 'all' ? 'font-medium' : ''}>{tr('endpointSlicesPage.allNamespaces', 'All namespaces')}</span>
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
          {tr('endpointSlicesPage.matchCount', '{{count}} endpoint slice{{suffix}} match.', {
            count: filteredEndpointSlices.length,
            suffix: filteredEndpointSlices.length === 1 ? '' : 's',
          })}
        </p>
      )}

      <div ref={tableContainerRef} className="card flex-1 min-h-0 flex flex-col">
        <div className="overflow-x-auto flex-1 min-h-0">
          <table className="w-full text-sm min-w-[1320px] table-fixed">
            <thead className="text-slate-400">
              <tr>
                {showNamespaceColumn && (
                  <th className="text-left py-3 px-4 w-[160px] cursor-pointer" onClick={() => handleSort('namespace')}>
                    <span className="inline-flex items-center gap-1">{tr('endpointSlicesPage.table.namespace', 'Namespace')}{renderSortIcon('namespace')}</span>
                  </th>
                )}
                <th className="text-left py-3 px-4 w-[220px] cursor-pointer" onClick={() => handleSort('name')}>
                  <span className="inline-flex items-center gap-1">{tr('endpointSlicesPage.table.name', 'Name')}{renderSortIcon('name')}</span>
                </th>
                <th className="text-left py-3 px-4 w-[180px] cursor-pointer" onClick={() => handleSort('service')}>
                  <span className="inline-flex items-center gap-1">{tr('endpointSlicesPage.table.service', 'Service')}{renderSortIcon('service')}</span>
                </th>
                <th className="text-left py-3 px-4 w-[120px] cursor-pointer" onClick={() => handleSort('addressType')}>
                  <span className="inline-flex items-center gap-1">{tr('endpointSlicesPage.table.addressType', 'Address Type')}{renderSortIcon('addressType')}</span>
                </th>
                <th className="text-left py-3 px-4 w-[260px] cursor-pointer" onClick={() => handleSort('ports')}>
                  <span className="inline-flex items-center gap-1">{tr('endpointSlicesPage.table.ports', 'Ports')}{renderSortIcon('ports')}</span>
                </th>
                <th className="text-left py-3 px-4 w-[280px]">
                  {tr('endpointSlicesPage.table.endpoints', 'Endpoints')}
                </th>
                <th className="text-left py-3 px-4 w-[90px] cursor-pointer" onClick={() => handleSort('endpoints')}>
                  <span className="inline-flex items-center gap-1">{tr('endpointSlicesPage.table.total', 'Total')}{renderSortIcon('endpoints')}</span>
                </th>
                <th className="text-left py-3 px-4 w-[90px] cursor-pointer" onClick={() => handleSort('ready')}>
                  <span className="inline-flex items-center gap-1">{tr('endpointSlicesPage.table.ready', 'Ready')}{renderSortIcon('ready')}</span>
                </th>
                <th className="text-left py-3 px-4 w-[110px] cursor-pointer" onClick={() => handleSort('notReady')}>
                  <span className="inline-flex items-center gap-1">{tr('endpointSlicesPage.table.notReady', 'Not Ready')}{renderSortIcon('notReady')}</span>
                </th>
                <th className="text-left py-3 px-4 w-[90px] cursor-pointer" onClick={() => handleSort('age')}>
                  <span className="inline-flex items-center gap-1">{tr('endpointSlicesPage.table.age', 'Age')}{renderSortIcon('age')}</span>
                </th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-700">
              {pagedEndpointSlices.map((es) => {
                const notReady = resolveNotReadyCount(es)
                return (
                  <tr
                    key={`${es.namespace}/${es.name}`}
                    className="text-slate-200 hover:bg-slate-800/60 cursor-pointer"
                    onClick={() => openDetail({
                      kind: 'EndpointSlice',
                      name: es.name,
                      namespace: es.namespace,
                      rawJson: endpointSliceToRawJson(es),
                    })}
                  >
                    {showNamespaceColumn && <td className="py-3 px-4 text-xs font-mono">{es.namespace}</td>}
                    <td className="py-3 px-4 font-medium text-white"><span className="block truncate">{es.name}</span></td>
                    <td className="py-3 px-4 text-xs font-mono"><span className="block truncate">{es.service_name || '-'}</span></td>
                    <td className="py-3 px-4 text-xs font-mono">{es.address_type || '-'}</td>
                    <td className="py-3 px-4 text-xs font-mono"><span className="block truncate">{formatPorts(es.ports)}</span></td>
                    <td className="py-3 px-4 text-xs font-mono"><span className="block truncate">{formatEndpointPreview(es)}</span></td>
                    <td className="py-3 px-4 text-xs font-mono">{es.endpoints_total || 0}</td>
                    <td className="py-3 px-4 text-xs font-mono">{es.endpoints_ready || 0}</td>
                    <td className="py-3 px-4 text-xs font-mono">{notReady}</td>
                    <td className="py-3 px-4 text-xs font-mono">{formatAge(es.created_at)}</td>
                  </tr>
                )
              })}
              {isLoading && (
                <tr>
                  <td colSpan={showNamespaceColumn ? 11 : 10} className="py-10 px-4 text-center text-slate-400">
                    <div className="inline-flex items-center gap-2">
                      <Loader2 className="w-4 h-4 animate-spin" />
                      Loading...
                    </div>
                  </td>
                </tr>
              )}

              {sortedEndpointSlices.length === 0 && !isLoading && (
                <tr>
                  <td colSpan={showNamespaceColumn ? 11 : 10} className="py-6 px-4 text-center text-slate-400">
                    {tr('endpointSlicesPage.noResults', 'No endpoint slices found.')}
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>

        {sortedEndpointSlices.length > 0 && (
          <div className="flex items-center justify-between px-4 py-3 border-t border-slate-700 shrink-0">
            <div className="text-xs text-slate-400">
              {tr('common.paginationRange', 'Showing {{start}}-{{end}} of {{total}}', {
                start: (currentPage - 1) * rowsPerPage + 1,
                end: Math.min(currentPage * rowsPerPage, sortedEndpointSlices.length),
                total: sortedEndpointSlices.length,
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
