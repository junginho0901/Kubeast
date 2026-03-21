import { useEffect, useMemo, useRef, useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { useTranslation } from 'react-i18next'
import { api, type DeviceClassItem } from '@/services/api'
import { useKubeWatchList } from '@/services/useKubeWatchList'
import { useResourceDetail } from '@/components/ResourceDetailContext'
import ResourceYamlCreateDialog from '@/components/ResourceYamlCreateDialog'
import { useAdaptiveRowsPerPage } from '@/hooks/useAdaptiveRowsPerPage'
import { ChevronDown, ChevronUp, Plus, RefreshCw, Search } from 'lucide-react'

type SortKey = null | 'name' | 'selectors' | 'conditions' | 'age'

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

function formatConditions(conditions?: Array<Record<string, any>>): string {
  if (!Array.isArray(conditions) || conditions.length === 0) return '-'
  return conditions
    .map((c) => {
      const type = String(c?.type || 'Unknown')
      const status = String(c?.status || '').toLowerCase()
      return status === 'true' ? type : `${type}(${String(c?.status || 'Unknown')})`
    })
    .join(', ')
}

function normalizeWatchDeviceClassObject(obj: any): DeviceClassItem {
  if (
    typeof obj?.name === 'string'
    && Object.prototype.hasOwnProperty.call(obj, 'selector_count')
  ) {
    return {
      ...obj,
      labels: obj.labels || {},
      conditions: Array.isArray(obj.conditions) ? obj.conditions : [],
    } as DeviceClassItem
  }

  const metadata = obj?.metadata ?? {}
  const spec = obj?.spec ?? {}
  const status = obj?.status ?? {}
  const conditions = Array.isArray(status?.conditions) ? status.conditions : []
  const selectors = Array.isArray(spec?.selectors) ? spec.selectors : []

  return {
    name: metadata?.name ?? obj?.name ?? '',
    labels: metadata?.labels ?? obj?.labels ?? {},
    created_at: metadata?.creationTimestamp ?? obj?.created_at ?? null,
    selector_count: selectors.length ?? obj?.selector_count ?? 0,
    conditions,
  }
}

function applyDeviceClassWatchEvent(
  prev: DeviceClassItem[] | undefined,
  event: { type?: string; object?: any },
): DeviceClassItem[] {
  const items = Array.isArray(prev) ? [...prev] : []
  const obj = event?.object
  if (!obj) return items

  const normalized = normalizeWatchDeviceClassObject(obj)
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

function deviceClassToRawJson(item: DeviceClassItem): Record<string, unknown> {
  return {
    apiVersion: 'resource.k8s.io/v1beta1',
    kind: 'DeviceClass',
    metadata: {
      name: item.name,
      labels: item.labels || {},
      creationTimestamp: item.created_at,
    },
    spec: {
      selectors: item.selector_count != null ? `(${item.selector_count} selectors)` : undefined,
    },
    status: {
      conditions: item.conditions || [],
    },
  }
}

export default function DeviceClasses() {
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

  const { data: deviceClasses, isLoading } = useQuery({
    queryKey: ['gpu', 'deviceclasses'],
    queryFn: () => api.getDeviceClasses(false),
  })

  const { data: me } = useQuery({
    queryKey: ['me'],
    queryFn: api.me,
    staleTime: 30000,
  })
  const canCreate = me?.role === 'admin' || me?.role === 'write'

  useKubeWatchList({
    enabled: true,
    queryKey: ['gpu', 'deviceclasses'],
    path: '/api/v1/deviceclasses',
    query: 'watch=1',
    applyEvent: (prev, event) => applyDeviceClassWatchEvent(prev as DeviceClassItem[] | undefined, event),
    onEvent: (event) => {
      if (event?.type === 'DELETED') return
      const name = event?.object?.name || event?.object?.metadata?.name
      if (name) {
        queryClient.invalidateQueries({ queryKey: ['deviceclass-describe', name] })
      }
    },
  })

  const filteredDeviceClasses = useMemo(() => {
    if (!Array.isArray(deviceClasses)) return [] as DeviceClassItem[]
    if (!searchQuery.trim()) return deviceClasses
    const q = searchQuery.toLowerCase()
    return deviceClasses.filter((item) => (
      item.name.toLowerCase().includes(q)
    ))
  }, [deviceClasses, searchQuery])

  const summary = useMemo(() => {
    const total = filteredDeviceClasses.length
    let withConditions = 0

    for (const item of filteredDeviceClasses) {
      if (Array.isArray(item.conditions) && item.conditions.length > 0) withConditions += 1
    }

    return { total, withConditions }
  }, [filteredDeviceClasses])

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

  const sortedDeviceClasses = useMemo(() => {
    if (!sortKey) return filteredDeviceClasses
    const list = [...filteredDeviceClasses]

    const getValue = (item: DeviceClassItem): string | number => {
      switch (sortKey) {
        case 'name':
          return item.name
        case 'selectors':
          return item.selector_count ?? 0
        case 'conditions':
          return formatConditions(item.conditions)
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
  }, [filteredDeviceClasses, sortDir, sortKey])

  const rowsPerPage = useAdaptiveRowsPerPage(tableContainerRef, {
    recalculationKey: sortedDeviceClasses.length,
  })
  const totalPages = Math.max(1, Math.ceil(sortedDeviceClasses.length / rowsPerPage))

  useEffect(() => {
    setCurrentPage(1)
  }, [searchQuery])

  useEffect(() => {
    if (currentPage > totalPages) setCurrentPage(totalPages)
  }, [currentPage, totalPages])

  const pagedDeviceClasses = useMemo(() => {
    const start = (currentPage - 1) * rowsPerPage
    return sortedDeviceClasses.slice(start, start + rowsPerPage)
  }, [sortedDeviceClasses, currentPage, rowsPerPage])

  const handleRefresh = async () => {
    if (isRefreshing) return
    setIsRefreshing(true)
    try {
      const data = await api.getDeviceClasses(true)
      queryClient.removeQueries({ queryKey: ['gpu', 'deviceclasses'] })
      queryClient.setQueryData(['gpu', 'deviceclasses'], data)
    } catch (error) {
      console.error('DeviceClasses refresh failed:', error)
    }
    setTimeout(() => setIsRefreshing(false), 500)
  }

  const createDeviceClassYamlTemplate = useMemo(() => {
    return `apiVersion: resource.k8s.io/v1beta1
kind: DeviceClass
metadata:
  name: example-gpu-class
spec:
  selectors:
    - cel:
        expression: "device.driver == 'gpu.nvidia.com'"
`
  }, [])

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-3xl font-bold text-white">{tr('deviceClassesPage.title', 'Device Classes')}</h1>
          <p className="mt-2 text-slate-400">{tr('deviceClassesPage.subtitle', 'Manage DRA DeviceClass resources for dynamic resource allocation.')}</p>
        </div>
        <div className="flex items-center gap-2">
          {canCreate && (
            <button
              type="button"
              onClick={() => setCreateDialogOpen(true)}
              className="btn btn-primary flex items-center gap-2"
            >
              <Plus className="w-4 h-4" />
              {tr('deviceClassesPage.create', 'Create DeviceClass')}
            </button>
          )}
          <button
            type="button"
            onClick={handleRefresh}
            disabled={isRefreshing}
            title={tr('deviceClassesPage.refreshTitle', 'Force refresh')}
            className="btn btn-primary flex items-center gap-2 disabled:opacity-50 disabled:cursor-not-allowed"
          >
            <RefreshCw className={`w-4 h-4 ${isRefreshing ? 'animate-spin' : ''}`} />
            {tr('deviceClassesPage.refresh', 'Refresh')}
          </button>
        </div>
      </div>

      <div className="relative">
        <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-5 h-5 text-slate-400" />
        <input
          type="text"
          placeholder={tr('deviceClassesPage.searchPlaceholder', 'Search device classes by name...')}
          value={searchQuery}
          onChange={(e) => setSearchQuery(e.target.value)}
          className="h-12 w-full pl-10 pr-4 bg-slate-700 border border-slate-600 rounded-lg text-sm text-white placeholder-slate-400 focus:outline-none focus:ring-2 focus:ring-primary-500 focus:border-transparent"
        />
      </div>

      <div className="grid grid-cols-2 gap-3">
        <div className="rounded-lg border border-slate-700 bg-slate-900/50 px-4 py-3">
          <p className="text-[11px] sm:text-xs leading-4 whitespace-nowrap text-slate-400">{tr('deviceClassesPage.stats.total', 'Total')}</p>
          <p className="text-lg text-white font-semibold mt-1">{summary.total}</p>
        </div>
        <div className="rounded-lg border border-amber-700/40 bg-amber-900/10 px-4 py-3">
          <p className="text-[11px] sm:text-xs leading-4 whitespace-nowrap text-amber-300">{tr('deviceClassesPage.stats.withConditions', 'With Conditions')}</p>
          <p className="text-lg text-white font-semibold mt-1">{summary.withConditions}</p>
        </div>
      </div>

      {searchQuery && (
        <p className="text-sm text-slate-400">
          {tr('deviceClassesPage.matchCount', '{{count}} device class{{suffix}} match.', {
            count: filteredDeviceClasses.length,
            suffix: filteredDeviceClasses.length === 1 ? '' : 'es',
          })}
        </p>
      )}

      <div ref={tableContainerRef} className="card">
        <div className="overflow-x-auto">
          <table className="w-full text-sm min-w-[940px] table-fixed">
            <thead className="text-slate-400">
              <tr>
                <th className="text-left py-3 px-4 w-[280px] cursor-pointer" onClick={() => handleSort('name')}>
                  <span className="inline-flex items-center gap-1">{tr('deviceClassesPage.table.name', 'Name')}{renderSortIcon('name')}</span>
                </th>
                <th className="text-left py-3 px-4 w-[150px] cursor-pointer" onClick={() => handleSort('selectors')}>
                  <span className="inline-flex items-center gap-1">{tr('deviceClassesPage.table.selectors', 'Selectors')}{renderSortIcon('selectors')}</span>
                </th>
                <th className="text-left py-3 px-4 w-[320px] cursor-pointer" onClick={() => handleSort('conditions')}>
                  <span className="inline-flex items-center gap-1">{tr('deviceClassesPage.table.conditions', 'Conditions')}{renderSortIcon('conditions')}</span>
                </th>
                <th className="text-left py-3 px-4 w-[90px] cursor-pointer" onClick={() => handleSort('age')}>
                  <span className="inline-flex items-center gap-1">{tr('deviceClassesPage.table.age', 'Age')}{renderSortIcon('age')}</span>
                </th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-700">
              {pagedDeviceClasses.map((item) => (
                <tr
                  key={item.name}
                  className="text-slate-200 hover:bg-slate-800/60 cursor-pointer"
                  onClick={() => openDetail({
                    kind: 'DeviceClass',
                    name: item.name,
                    rawJson: deviceClassToRawJson(item),
                  })}
                >
                  <td className="py-3 px-4 font-medium text-white"><span className="block truncate">{item.name}</span></td>
                  <td className="py-3 px-4 text-xs">{item.selector_count ?? 0}</td>
                  <td className="py-3 px-4 text-xs">
                    <span className="block truncate">
                      {Array.isArray(item.conditions) && item.conditions.length > 0
                        ? item.conditions.map((c, i) => {
                            const type = String(c?.type || 'Unknown')
                            const status = String(c?.status || '').toLowerCase()
                            const isTrue = status === 'true'
                            return (
                              <span
                                key={i}
                                className={`inline-flex items-center px-1.5 py-0.5 rounded text-[11px] font-medium mr-1 ${
                                  isTrue
                                    ? 'bg-emerald-900/40 text-emerald-300 border border-emerald-700/40'
                                    : 'bg-red-900/40 text-red-300 border border-red-700/40'
                                }`}
                              >
                                {type}
                              </span>
                            )
                          })
                        : '-'}
                    </span>
                  </td>
                  <td className="py-3 px-4 text-xs font-mono">{formatAge(item.created_at)}</td>
                </tr>
              ))}
              {sortedDeviceClasses.length === 0 && !isLoading && (
                <tr>
                  <td colSpan={4} className="py-6 px-4 text-slate-400">
                    {tr('deviceClassesPage.noResults', 'No device classes found.')}
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>

        {sortedDeviceClasses.length > 0 && (
          <div className="flex items-center justify-between px-4 py-3 border-t border-slate-700">
            <div className="text-xs text-slate-400">
              {tr('common.paginationRange', 'Showing {{start}}-{{end}} of {{total}}', {
                start: (currentPage - 1) * rowsPerPage + 1,
                end: Math.min(currentPage * rowsPerPage, sortedDeviceClasses.length),
                total: sortedDeviceClasses.length,
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
          title={tr('deviceClassesPage.createTitle', 'Create DeviceClass from YAML')}
          initialYaml={createDeviceClassYamlTemplate}
          onClose={() => setCreateDialogOpen(false)}
          onCreated={() => {
            queryClient.invalidateQueries({ queryKey: ['gpu', 'deviceclasses'] })
          }}
        />
      )}
    </div>
  )
}
