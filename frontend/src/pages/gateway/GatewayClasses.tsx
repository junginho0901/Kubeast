import { useEffect, useMemo, useRef, useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { useTranslation } from 'react-i18next'
import { api, type GatewayClassInfo } from '@/services/api'
import { useKubeWatchList } from '@/services/useKubeWatchList'
import { useResourceDetail } from '@/components/ResourceDetailContext'
import ResourceYamlCreateDialog from '@/components/ResourceYamlCreateDialog'
import { useAdaptiveRowsPerPage } from '@/hooks/useAdaptiveRowsPerPage'
import { Loader2, ChevronDown, ChevronUp, Plus, RefreshCw, Search } from 'lucide-react'

type SortKey = null | 'name' | 'controller' | 'status' | 'parameters' | 'age'

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

function formatParametersRef(item: GatewayClassInfo): string {
  const ref = item.parameters_ref
  if (!ref || typeof ref !== 'object') return '-'
  const group = String(ref.group || '')
  const kind = String(ref.kind || '')
  const name = String(ref.name || '')
  const namespace = String(ref.namespace || '')
  const pieces = [
    kind || '-',
    group ? `.${group}` : '',
    name ? `/${name}` : '',
    namespace ? ` (ns: ${namespace})` : '',
  ]
  return pieces.join('') || '-'
}

function normalizeWatchGatewayClassObject(obj: any): GatewayClassInfo {
  if (
    typeof obj?.name === 'string'
    && Object.prototype.hasOwnProperty.call(obj, 'controller_name')
  ) {
    return {
      ...obj,
      parameters_ref: obj.parameters_ref || null,
      conditions: Array.isArray(obj.conditions) ? obj.conditions : [],
      labels: obj.labels || {},
      annotations: obj.annotations || {},
      finalizers: Array.isArray(obj.finalizers) ? obj.finalizers : [],
    } as GatewayClassInfo
  }

  const metadata = obj?.metadata ?? {}
  const spec = obj?.spec ?? {}
  const status = obj?.status ?? {}
  const conditions = Array.isArray(status?.conditions) ? status.conditions : []

  const accepted = conditions.some(
    (c: any) => String(c?.type) === 'Accepted' && String(c?.status).toLowerCase() === 'true',
  )

  const trueCondition = conditions.find((c: any) => String(c?.status).toLowerCase() === 'true')
  const falseCondition = conditions.find((c: any) => String(c?.status).toLowerCase() === 'false')
  const statusText = accepted
    ? 'Accepted'
    : trueCondition?.type
      ? String(trueCondition.type)
      : falseCondition?.type
        ? `${String(falseCondition.type)}(False)`
        : 'Unknown'

  return {
    name: metadata?.name ?? obj?.name ?? '',
    controller_name: spec?.controllerName ?? obj?.controller_name ?? null,
    description: metadata?.annotations?.['gateway.networking.k8s.io/description'] ?? obj?.description ?? null,
    accepted,
    status: statusText,
    parameters_ref: spec?.parametersRef ?? obj?.parameters_ref ?? null,
    conditions,
    labels: metadata?.labels ?? obj?.labels ?? {},
    annotations: metadata?.annotations ?? obj?.annotations ?? {},
    finalizers: Array.isArray(metadata?.finalizers) ? metadata.finalizers : (obj?.finalizers || []),
    created_at: metadata?.creationTimestamp ?? obj?.created_at ?? null,
    api_version: obj?.apiVersion ?? obj?.api_version ?? null,
  }
}

function applyGatewayClassWatchEvent(
  prev: GatewayClassInfo[] | undefined,
  event: { type?: string; object?: any },
): GatewayClassInfo[] {
  const items = Array.isArray(prev) ? [...prev] : []
  const obj = event?.object
  if (!obj) return items

  const normalized = normalizeWatchGatewayClassObject(obj)
  const name = normalized?.name
  if (!name) return items

  const index = items.findIndex((item) => item.name === name)

  if (event.type === 'DELETED') {
    if (index >= 0) items.splice(index, 1)
    return items
  }

  if (index >= 0) items[index] = normalized
  else items.push(normalized)

  return items
}

function gatewayClassToRawJson(item: GatewayClassInfo): Record<string, unknown> {
  return {
    apiVersion: item.api_version || 'gateway.networking.k8s.io/v1',
    kind: 'GatewayClass',
    metadata: {
      name: item.name,
      labels: item.labels || {},
      annotations: item.annotations || {},
      finalizers: item.finalizers || [],
      creationTimestamp: item.created_at,
    },
    spec: {
      controllerName: item.controller_name || undefined,
      parametersRef: item.parameters_ref || undefined,
    },
    status: {
      conditions: item.conditions || [],
    },
    accepted: item.accepted,
    status_text: item.status,
  }
}

export default function GatewayClasses() {
  const queryClient = useQueryClient()
  const { t } = useTranslation()
  const tr = (key: string, fallback: string, options?: Record<string, any>) =>
    t(key, { defaultValue: fallback, ...options })
  const { open: openDetail } = useResourceDetail()

  const [searchQuery, setSearchQuery] = useState('')
  const [isRefreshing, setIsRefreshing] = useState(false)
  const [sortKey, setSortKey] = useState<SortKey>(null)
  const [sortDir, setSortDir] = useState<'asc' | 'desc'>('asc')
  const [currentPage, setCurrentPage] = useState(1)
  const [createDialogOpen, setCreateDialogOpen] = useState(false)
  const tableContainerRef = useRef<HTMLDivElement>(null)

  const { data: gatewayClasses, isLoading } = useQuery({
    queryKey: ['gateway', 'gatewayclasses'],
    queryFn: () => api.getGatewayClasses(false),
  })

  const { data: me } = useQuery({
    queryKey: ['me'],
    queryFn: api.me,
    staleTime: 30000,
  })
  const canCreate = me?.role === 'admin' || me?.role === 'write'

  useKubeWatchList({
    enabled: true,
    queryKey: ['gateway', 'gatewayclasses'],
    path: '/api/v1/gatewayclasses',
    query: 'watch=1',
    applyEvent: (prev, event) => applyGatewayClassWatchEvent(prev as GatewayClassInfo[] | undefined, event),
    onEvent: (event) => {
      if (event?.type === 'DELETED') return
      const name = event?.object?.name || event?.object?.metadata?.name
      if (name) {
        queryClient.invalidateQueries({ queryKey: ['gatewayclass-describe', name] })
      }
    },
  })

  const filteredGatewayClasses = useMemo(() => {
    if (!Array.isArray(gatewayClasses)) return [] as GatewayClassInfo[]
    if (!searchQuery.trim()) return gatewayClasses
    const q = searchQuery.toLowerCase()
    return gatewayClasses.filter((item) => (
      item.name.toLowerCase().includes(q)
      || String(item.controller_name || '').toLowerCase().includes(q)
      || String(item.status || '').toLowerCase().includes(q)
      || formatParametersRef(item).toLowerCase().includes(q)
    ))
  }, [gatewayClasses, searchQuery])

  const summary = useMemo(() => {
    const total = filteredGatewayClasses.length
    let accepted = 0
    let withParameters = 0
    let withAnnotations = 0

    for (const item of filteredGatewayClasses) {
      if (item.accepted) accepted += 1
      if (item.parameters_ref) withParameters += 1
      if (Object.keys(item.annotations || {}).length > 0) withAnnotations += 1
    }

    return { total, accepted, withParameters, withAnnotations }
  }, [filteredGatewayClasses])

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

  const sortedGatewayClasses = useMemo(() => {
    if (!sortKey) return filteredGatewayClasses
    const list = [...filteredGatewayClasses]

    const getValue = (item: GatewayClassInfo): string | number => {
      switch (sortKey) {
        case 'name':
          return item.name
        case 'controller':
          return item.controller_name || ''
        case 'status':
          return item.status || ''
        case 'parameters':
          return formatParametersRef(item)
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
  }, [filteredGatewayClasses, sortDir, sortKey])

  const rowsPerPage = useAdaptiveRowsPerPage(tableContainerRef, {
    recalculationKey: sortedGatewayClasses.length,
  })
  const totalPages = Math.max(1, Math.ceil(sortedGatewayClasses.length / rowsPerPage))

  useEffect(() => {
    setCurrentPage(1)
  }, [searchQuery])

  useEffect(() => {
    if (currentPage > totalPages) setCurrentPage(totalPages)
  }, [currentPage, totalPages])

  const pagedGatewayClasses = useMemo(() => {
    const start = (currentPage - 1) * rowsPerPage
    return sortedGatewayClasses.slice(start, start + rowsPerPage)
  }, [sortedGatewayClasses, currentPage, rowsPerPage])

  const handleRefresh = async () => {
    if (isRefreshing) return
    setIsRefreshing(true)
    try {
      const data = await api.getGatewayClasses(true)
      queryClient.removeQueries({ queryKey: ['gateway', 'gatewayclasses'] })
      queryClient.setQueryData(['gateway', 'gatewayclasses'], data)
    } catch (error) {
      console.error('GatewayClasses refresh failed:', error)
    }
    setTimeout(() => setIsRefreshing(false), 500)
  }

  const createGatewayClassYamlTemplate = useMemo(() => {
    return `apiVersion: gateway.networking.k8s.io/v1
kind: GatewayClass
metadata:
  name: sample-gatewayclass
spec:
  controllerName: example.com/gateway-controller
`
  }, [])

  return (
    <div className="flex flex-col h-[calc(100vh-4rem)] gap-4">
      <div className="flex items-center justify-between shrink-0">
        <div>
          <h1 className="text-3xl font-bold text-white">{tr('gatewayClassesPage.title', 'Gateway Classes')}</h1>
          <p className="mt-2 text-slate-400">{tr('gatewayClassesPage.subtitle', 'Inspect and manage cluster-scoped GatewayClass resources.')}</p>
        </div>
        <div className="flex items-center gap-2">
          {canCreate && (
            <button
              type="button"
              onClick={() => setCreateDialogOpen(true)}
              className="btn btn-primary flex items-center gap-2"
            >
              <Plus className="w-4 h-4" />
              {tr('gatewayClassesPage.create', 'Create GatewayClass')}
            </button>
          )}
          <button
            type="button"
            onClick={handleRefresh}
            disabled={isRefreshing}
            title={tr('gatewayClassesPage.refreshTitle', 'Force refresh')}
            className="btn btn-primary flex items-center gap-2 disabled:opacity-50 disabled:cursor-not-allowed"
          >
            <RefreshCw className={`w-4 h-4 ${isRefreshing ? 'animate-spin' : ''}`} />
            {tr('gatewayClassesPage.refresh', 'Refresh')}
          </button>
        </div>
      </div>

      <div className="relative shrink-0">
        <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-5 h-5 text-slate-400" />
        <input
          type="text"
          placeholder={tr('gatewayClassesPage.searchPlaceholder', 'Search gateway classes by name...')}
          value={searchQuery}
          onChange={(e) => setSearchQuery(e.target.value)}
          className="h-12 w-full pl-10 pr-4 bg-slate-700 border border-slate-600 rounded-lg text-sm text-white placeholder-slate-400 focus:outline-none focus:ring-2 focus:ring-primary-500 focus:border-transparent"
        />
      </div>

      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3 shrink-0">
        <div className="rounded-lg border border-slate-700 bg-slate-900/50 px-4 py-3">
          <p className="text-[11px] sm:text-xs leading-4 whitespace-nowrap text-slate-400">{tr('gatewayClassesPage.stats.total', 'Total')}</p>
          <p className="text-lg text-white font-semibold mt-1">{summary.total}</p>
        </div>
        <div className="rounded-lg border border-emerald-700/40 bg-emerald-900/10 px-4 py-3">
          <p className="text-[11px] sm:text-xs leading-4 whitespace-nowrap text-emerald-300">{tr('gatewayClassesPage.stats.accepted', 'Accepted')}</p>
          <p className="text-lg text-white font-semibold mt-1">{summary.accepted}</p>
        </div>
        <div className="rounded-lg border border-cyan-700/40 bg-cyan-900/10 px-4 py-3">
          <p className="text-[11px] sm:text-xs leading-4 whitespace-nowrap text-cyan-300">{tr('gatewayClassesPage.stats.withParameters', 'With Parameters')}</p>
          <p className="text-lg text-white font-semibold mt-1">{summary.withParameters}</p>
        </div>
        <div className="rounded-lg border border-amber-700/40 bg-amber-900/10 px-4 py-3">
          <p className="text-[11px] sm:text-xs leading-4 whitespace-nowrap text-amber-300">{tr('gatewayClassesPage.stats.withAnnotations', 'With Annotations')}</p>
          <p className="text-lg text-white font-semibold mt-1">{summary.withAnnotations}</p>
        </div>
      </div>

      {searchQuery && (
        <p className="text-sm text-slate-400 shrink-0">
          {tr('gatewayClassesPage.matchCount', '{{count}} gateway class{{suffix}} match.', {
            count: filteredGatewayClasses.length,
            suffix: filteredGatewayClasses.length === 1 ? '' : 'es',
          })}
        </p>
      )}

      <div ref={tableContainerRef} className="card flex-1 min-h-0 flex flex-col">
        <div className="overflow-x-auto flex-1 min-h-0">
          <table className="w-full text-sm min-w-[940px] table-fixed">
            <thead className="text-slate-400">
              <tr>
                <th className="text-left py-3 px-4 w-[220px] cursor-pointer" onClick={() => handleSort('name')}>
                  <span className="inline-flex items-center gap-1">{tr('gatewayClassesPage.table.name', 'Name')}{renderSortIcon('name')}</span>
                </th>
                <th className="text-left py-3 px-4 w-[270px] cursor-pointer" onClick={() => handleSort('controller')}>
                  <span className="inline-flex items-center gap-1">{tr('gatewayClassesPage.table.controller', 'Controller')}{renderSortIcon('controller')}</span>
                </th>
                <th className="text-left py-3 px-4 w-[170px] cursor-pointer" onClick={() => handleSort('status')}>
                  <span className="inline-flex items-center gap-1">{tr('gatewayClassesPage.table.conditions', 'Conditions')}{renderSortIcon('status')}</span>
                </th>
                <th className="text-left py-3 px-4 w-[200px] cursor-pointer" onClick={() => handleSort('parameters')}>
                  <span className="inline-flex items-center gap-1">{tr('gatewayClassesPage.table.parametersRef', 'Parameters Ref')}{renderSortIcon('parameters')}</span>
                </th>
                <th className="text-left py-3 px-4 w-[90px] cursor-pointer" onClick={() => handleSort('age')}>
                  <span className="inline-flex items-center gap-1">{tr('gatewayClassesPage.table.age', 'Age')}{renderSortIcon('age')}</span>
                </th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-700">
              {pagedGatewayClasses.map((item) => (
                <tr
                  key={item.name}
                  className="text-slate-200 hover:bg-slate-800/60 cursor-pointer"
                  onClick={() => openDetail({
                    kind: 'GatewayClass',
                    name: item.name,
                    rawJson: gatewayClassToRawJson(item),
                  })}
                >
                  <td className="py-3 px-4 font-medium text-white"><span className="block truncate">{item.name}</span></td>
                  <td className="py-3 px-4 text-xs"><span className="block truncate">{item.controller_name || '-'}</span></td>
                  <td className="py-3 px-4 text-xs"><span className="block truncate">{item.status || '-'}</span></td>
                  <td className="py-3 px-4 text-xs"><span className="block truncate">{formatParametersRef(item)}</span></td>
                  <td className="py-3 px-4 text-xs font-mono">{formatAge(item.created_at)}</td>
                </tr>
              ))}
              {isLoading && (
                <tr>
                  <td colSpan={5} className="py-10 px-4 text-center text-slate-400">
                    <div className="inline-flex items-center gap-2">
                      <Loader2 className="w-4 h-4 animate-spin" />
                      Loading...
                    </div>
                  </td>
                </tr>
              )}

              {sortedGatewayClasses.length === 0 && !isLoading && (
                <tr>
                  <td colSpan={5} className="py-6 px-4 text-center text-slate-400">
                    {tr('gatewayClassesPage.noResults', 'No gateway classes found.')}
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>

        {sortedGatewayClasses.length > 0 && (
          <div className="flex items-center justify-between px-4 py-3 border-t border-slate-700 shrink-0">
            <div className="text-xs text-slate-400">
              {tr('common.paginationRange', 'Showing {{start}}-{{end}} of {{total}}', {
                start: (currentPage - 1) * rowsPerPage + 1,
                end: Math.min(currentPage * rowsPerPage, sortedGatewayClasses.length),
                total: sortedGatewayClasses.length,
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
          title={tr('gatewayClassesPage.createTitle', 'Create GatewayClass from YAML')}
          initialYaml={createGatewayClassYamlTemplate}
          onClose={() => setCreateDialogOpen(false)}
          onCreated={() => {
            queryClient.invalidateQueries({ queryKey: ['gateway', 'gatewayclasses'] })
          }}
        />
      )}
    </div>
  )
}
