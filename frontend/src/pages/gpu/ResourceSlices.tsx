import { useEffect, useMemo, useRef, useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { useTranslation } from 'react-i18next'
import { api, type ResourceSliceItem } from '@/services/api'
import { useKubeWatchList } from '@/services/useKubeWatchList'
import { useResourceDetail } from '@/components/ResourceDetailContext'
import { useAdaptiveRowsPerPage } from '@/hooks/useAdaptiveRowsPerPage'
import { Loader2, ChevronDown, ChevronUp, RefreshCw, Search } from 'lucide-react'

type SortKey = null | 'name' | 'node' | 'driver' | 'pool' | 'devices' | 'age'

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

function normalizeWatchResourceSliceObject(obj: any): ResourceSliceItem {
  if (
    typeof obj?.name === 'string'
    && Object.prototype.hasOwnProperty.call(obj, 'driver_name')
  ) {
    return {
      ...obj,
      labels: obj.labels || {},
    } as ResourceSliceItem
  }

  const metadata = obj?.metadata ?? {}
  const spec = obj?.spec ?? {}
  const devices = Array.isArray(spec?.devices) ? spec.devices : []

  return {
    name: metadata?.name ?? obj?.name ?? '',
    labels: metadata?.labels ?? obj?.labels ?? {},
    created_at: metadata?.creationTimestamp ?? obj?.created_at ?? null,
    node_name: spec?.nodeName ?? obj?.node_name ?? null,
    driver_name: spec?.driver ?? obj?.driver_name ?? null,
    pool_name: spec?.pool?.name ?? obj?.pool_name ?? null,
    device_count: devices.length || (obj?.device_count ?? 0),
  }
}

function applyResourceSliceWatchEvent(
  prev: ResourceSliceItem[] | undefined,
  event: { type?: string; object?: any },
): ResourceSliceItem[] {
  const items = Array.isArray(prev) ? [...prev] : []
  const obj = event?.object
  if (!obj) return items

  const normalized = normalizeWatchResourceSliceObject(obj)
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

export default function ResourceSlices() {
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
  const tableContainerRef = useRef<HTMLDivElement>(null)

  const { data: resourceSlices, isLoading } = useQuery({
    queryKey: ['gpu', 'resourceslices'],
    queryFn: () => api.getResourceSlices(false),
  })

  useKubeWatchList({
    enabled: true,
    queryKey: ['gpu', 'resourceslices'],
    path: '/api/v1/resourceslices',
    query: 'watch=1',
    applyEvent: (prev, event) => applyResourceSliceWatchEvent(prev as ResourceSliceItem[] | undefined, event),
    onEvent: (event) => {
      if (event?.type === 'DELETED') return
      const name = event?.object?.name || event?.object?.metadata?.name
      if (name) {
        queryClient.invalidateQueries({ queryKey: ['resourceslice-describe', name] })
      }
    },
  })

  const filteredResourceSlices = useMemo(() => {
    if (!Array.isArray(resourceSlices)) return [] as ResourceSliceItem[]
    if (!searchQuery.trim()) return resourceSlices
    const q = searchQuery.toLowerCase()
    return resourceSlices.filter((item) => (
      item.name.toLowerCase().includes(q)
      || (item.node_name && item.node_name.toLowerCase().includes(q))
      || (item.driver_name && item.driver_name.toLowerCase().includes(q))
      || (item.pool_name && item.pool_name.toLowerCase().includes(q))
    ))
  }, [resourceSlices, searchQuery])

  const summary = useMemo(() => {
    const total = filteredResourceSlices.length
    let totalDevices = 0

    for (const item of filteredResourceSlices) {
      totalDevices += item.device_count ?? 0
    }

    return { total, totalDevices }
  }, [filteredResourceSlices])

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

  const sortedResourceSlices = useMemo(() => {
    if (!sortKey) return filteredResourceSlices
    const list = [...filteredResourceSlices]

    const getValue = (item: ResourceSliceItem): string | number => {
      switch (sortKey) {
        case 'name':
          return item.name
        case 'node':
          return item.node_name ?? ''
        case 'driver':
          return item.driver_name ?? ''
        case 'pool':
          return item.pool_name ?? ''
        case 'devices':
          return item.device_count ?? 0
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
  }, [filteredResourceSlices, sortDir, sortKey])

  const rowsPerPage = useAdaptiveRowsPerPage(tableContainerRef, {
    recalculationKey: sortedResourceSlices.length,
  })
  const totalPages = Math.max(1, Math.ceil(sortedResourceSlices.length / rowsPerPage))

  useEffect(() => {
    setCurrentPage(1)
  }, [searchQuery])

  useEffect(() => {
    if (currentPage > totalPages) setCurrentPage(totalPages)
  }, [currentPage, totalPages])

  const pagedResourceSlices = useMemo(() => {
    const start = (currentPage - 1) * rowsPerPage
    return sortedResourceSlices.slice(start, start + rowsPerPage)
  }, [sortedResourceSlices, currentPage, rowsPerPage])

  const handleRefresh = async () => {
    if (isRefreshing) return
    setIsRefreshing(true)
    try {
      const data = await api.getResourceSlices(true)
      queryClient.removeQueries({ queryKey: ['gpu', 'resourceslices'] })
      queryClient.setQueryData(['gpu', 'resourceslices'], data)
    } catch (error) {
      console.error('ResourceSlices refresh failed:', error)
    }
    setTimeout(() => setIsRefreshing(false), 500)
  }

  return (
    <div className="flex flex-col h-[calc(100vh-4rem)] gap-4">
      <div className="flex items-center justify-between shrink-0">
        <div>
          <h1 className="text-3xl font-bold text-white">{tr('resourceSlicesPage.title', 'Resource Slices')}</h1>
          <p className="mt-2 text-slate-400">{tr('resourceSlicesPage.subtitle', 'View DRA ResourceSlice resources advertised by nodes.')}</p>
        </div>
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={handleRefresh}
            disabled={isRefreshing}
            title={tr('resourceSlicesPage.refreshTitle', 'Force refresh')}
            className="btn btn-primary flex items-center gap-2 disabled:opacity-50 disabled:cursor-not-allowed"
          >
            <RefreshCw className={`w-4 h-4 ${isRefreshing ? 'animate-spin' : ''}`} />
            {tr('resourceSlicesPage.refresh', 'Refresh')}
          </button>
        </div>
      </div>

      <div className="relative shrink-0">
        <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-5 h-5 text-slate-400" />
        <input
          type="text"
          placeholder={tr('resourceSlicesPage.searchPlaceholder', 'Search resource slices by name, node, driver, or pool...')}
          value={searchQuery}
          onChange={(e) => setSearchQuery(e.target.value)}
          className="h-12 w-full pl-10 pr-4 bg-slate-700 border border-slate-600 rounded-lg text-sm text-white placeholder-slate-400 focus:outline-none focus:ring-2 focus:ring-primary-500 focus:border-transparent"
        />
      </div>

      <div className="grid grid-cols-2 gap-3 shrink-0">
        <div className="rounded-lg border border-slate-700 bg-slate-900/50 px-4 py-3">
          <p className="text-[11px] sm:text-xs leading-4 whitespace-nowrap text-slate-400">{tr('resourceSlicesPage.stats.total', 'Total')}</p>
          <p className="text-lg text-white font-semibold mt-1">{summary.total}</p>
        </div>
        <div className="rounded-lg border border-slate-700 bg-slate-900/50 px-4 py-3">
          <p className="text-[11px] sm:text-xs leading-4 whitespace-nowrap text-slate-400">{tr('resourceSlicesPage.stats.totalDevices', 'Total Devices')}</p>
          <p className="text-lg text-white font-semibold mt-1">{summary.totalDevices}</p>
        </div>
      </div>

      {searchQuery && (
        <p className="text-sm text-slate-400 shrink-0">
          {tr('resourceSlicesPage.matchCount', '{{count}} resource slice{{suffix}} match.', {
            count: filteredResourceSlices.length,
            suffix: filteredResourceSlices.length === 1 ? '' : 's',
          })}
        </p>
      )}

      <div ref={tableContainerRef} className="card flex-1 min-h-0 flex flex-col">
        <div className="overflow-x-auto flex-1 min-h-0">
          <table className="w-full text-sm min-w-[940px] table-fixed">
            <thead className="text-slate-400">
              <tr>
                <th className="text-left py-3 px-4 w-[240px] cursor-pointer" onClick={() => handleSort('name')}>
                  <span className="inline-flex items-center gap-1">{tr('resourceSlicesPage.table.name', 'Name')}{renderSortIcon('name')}</span>
                </th>
                <th className="text-left py-3 px-4 w-[180px] cursor-pointer" onClick={() => handleSort('node')}>
                  <span className="inline-flex items-center gap-1">{tr('resourceSlicesPage.table.node', 'Node')}{renderSortIcon('node')}</span>
                </th>
                <th className="text-left py-3 px-4 w-[180px] cursor-pointer" onClick={() => handleSort('driver')}>
                  <span className="inline-flex items-center gap-1">{tr('resourceSlicesPage.table.driver', 'Driver')}{renderSortIcon('driver')}</span>
                </th>
                <th className="text-left py-3 px-4 w-[150px] cursor-pointer" onClick={() => handleSort('pool')}>
                  <span className="inline-flex items-center gap-1">{tr('resourceSlicesPage.table.pool', 'Pool')}{renderSortIcon('pool')}</span>
                </th>
                <th className="text-left py-3 px-4 w-[100px] cursor-pointer" onClick={() => handleSort('devices')}>
                  <span className="inline-flex items-center gap-1">{tr('resourceSlicesPage.table.devices', 'Devices')}{renderSortIcon('devices')}</span>
                </th>
                <th className="text-left py-3 px-4 w-[90px] cursor-pointer" onClick={() => handleSort('age')}>
                  <span className="inline-flex items-center gap-1">{tr('resourceSlicesPage.table.age', 'Age')}{renderSortIcon('age')}</span>
                </th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-700">
              {pagedResourceSlices.map((item) => (
                <tr
                  key={item.name}
                  className="text-slate-200 hover:bg-slate-800/60 cursor-pointer"
                  onClick={() => openDetail({
                    kind: 'ResourceSlice',
                    name: item.name,
                  })}
                >
                  <td className="py-3 px-4 font-medium text-white"><span className="block truncate">{item.name}</span></td>
                  <td className="py-3 px-4 text-xs"><span className="block truncate">{item.node_name ?? '-'}</span></td>
                  <td className="py-3 px-4 text-xs"><span className="block truncate">{item.driver_name ?? '-'}</span></td>
                  <td className="py-3 px-4 text-xs"><span className="block truncate">{item.pool_name ?? '-'}</span></td>
                  <td className="py-3 px-4 text-xs">{item.device_count ?? 0}</td>
                  <td className="py-3 px-4 text-xs font-mono">{formatAge(item.created_at)}</td>
                </tr>
              ))}
              {isLoading && (
                <tr>
                  <td colSpan={6} className="py-10 px-4 text-center text-slate-400">
                    <div className="inline-flex items-center gap-2">
                      <Loader2 className="w-4 h-4 animate-spin" />
                      Loading...
                    </div>
                  </td>
                </tr>
              )}

              {sortedResourceSlices.length === 0 && !isLoading && (
                <tr>
                  <td colSpan={6} className="py-6 px-4 text-center text-slate-400">
                    {tr('resourceSlicesPage.noResults', 'No resource slices found.')}
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>

        {sortedResourceSlices.length > 0 && (
          <div className="flex items-center justify-between px-4 py-3 border-t border-slate-700 shrink-0">
            <div className="text-xs text-slate-400">
              {tr('common.paginationRange', 'Showing {{start}}-{{end}} of {{total}}', {
                start: (currentPage - 1) * rowsPerPage + 1,
                end: Math.min(currentPage * rowsPerPage, sortedResourceSlices.length),
                total: sortedResourceSlices.length,
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
    </div>
  )
}
