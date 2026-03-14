import { useEffect, useMemo, useRef, useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { useTranslation } from 'react-i18next'
import { api, type StorageClassInfo } from '@/services/api'
import { useKubeWatchList } from '@/services/useKubeWatchList'
import { useResourceDetail } from '@/components/ResourceDetailContext'
import ResourceYamlCreateDialog from '@/components/ResourceYamlCreateDialog'
import { useAdaptiveRowsPerPage } from '@/hooks/useAdaptiveRowsPerPage'
import { CheckCircle, ChevronDown, ChevronUp, Plus, RefreshCw, Search } from 'lucide-react'

type SortKey =
  | null
  | 'name'
  | 'provisioner'
  | 'default'
  | 'reclaimPolicy'
  | 'bindingMode'
  | 'allowExpansion'
  | 'age'

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

function normalizeWatchStorageClassObject(obj: any): StorageClassInfo {
  if (typeof obj?.name === 'string' && typeof obj?.provisioner === 'string') {
    return {
      ...obj,
      parameters: obj?.parameters ?? {},
      mount_options: Array.isArray(obj?.mount_options) ? obj.mount_options : [],
      allowed_topologies: Array.isArray(obj?.allowed_topologies) ? obj.allowed_topologies : [],
    } as StorageClassInfo
  }

  const metadata = obj?.metadata ?? {}
  const annotations = (metadata?.annotations ?? {}) as Record<string, string>
  const labels = (metadata?.labels ?? {}) as Record<string, string>
  const isDefault = annotations['storageclass.kubernetes.io/is-default-class'] === 'true'
    || annotations['storageclass.beta.kubernetes.io/is-default-class'] === 'true'

  return {
    name: metadata?.name ?? obj?.name ?? '',
    provisioner: obj?.provisioner ?? '',
    reclaim_policy: obj?.reclaimPolicy ?? obj?.reclaim_policy ?? null,
    volume_binding_mode: obj?.volumeBindingMode ?? obj?.volume_binding_mode ?? null,
    allow_volume_expansion: obj?.allowVolumeExpansion ?? obj?.allow_volume_expansion ?? null,
    is_default: isDefault || Boolean(obj?.is_default),
    parameters: (obj?.parameters ?? {}) as Record<string, any>,
    mount_options: Array.isArray(obj?.mountOptions)
      ? obj.mountOptions
      : (Array.isArray(obj?.mount_options) ? obj.mount_options : []),
    allowed_topologies: Array.isArray(obj?.allowed_topologies) ? obj.allowed_topologies : [],
    labels,
    annotations,
    finalizers: Array.isArray(metadata?.finalizers) ? metadata.finalizers : [],
    created_at: metadata?.creationTimestamp ?? obj?.created_at ?? null,
  }
}

function applyStorageClassWatchEvent(prev: StorageClassInfo[] | undefined, event: { type?: string; object?: any }): StorageClassInfo[] {
  const items = Array.isArray(prev) ? [...prev] : []
  const obj = event?.object
  if (!obj) return items

  const normalized = normalizeWatchStorageClassObject(obj)
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

function storageClassToRawJson(sc: StorageClassInfo): Record<string, unknown> {
  const annotations: Record<string, string> = { ...(sc.annotations || {}) }
  if (sc.is_default) {
    annotations['storageclass.kubernetes.io/is-default-class'] = 'true'
  }

  return {
    apiVersion: 'storage.k8s.io/v1',
    kind: 'StorageClass',
    metadata: {
      name: sc.name,
      labels: sc.labels || {},
      annotations,
      finalizers: sc.finalizers || [],
      creationTimestamp: sc.created_at,
    },
    provisioner: sc.provisioner,
    reclaimPolicy: sc.reclaim_policy || undefined,
    volumeBindingMode: sc.volume_binding_mode || undefined,
    allowVolumeExpansion: sc.allow_volume_expansion,
    parameters: sc.parameters || {},
    mountOptions: sc.mount_options || [],
  }
}

export default function StorageClasses() {
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

  const { data: storageClasses, isLoading } = useQuery({
    queryKey: ['storage', 'storageclasses'],
    queryFn: () => api.getStorageClasses(false),
  })

  const { data: me } = useQuery({
    queryKey: ['me'],
    queryFn: api.me,
    staleTime: 30000,
  })
  const canCreate = me?.role === 'admin' || me?.role === 'write'

  useKubeWatchList({
    enabled: true,
    queryKey: ['storage', 'storageclasses'],
    path: '/api/v1/storageclasses',
    query: 'watch=1',
    applyEvent: (prev, event) => applyStorageClassWatchEvent(prev as StorageClassInfo[] | undefined, event),
    onEvent: (event) => {
      if (event?.type === 'DELETED') return
      const name = event?.object?.name || event?.object?.metadata?.name
      if (name) {
        queryClient.invalidateQueries({ queryKey: ['storageclass-describe', name] })
      }
    },
  })

  const filteredStorageClasses = useMemo(() => {
    if (!Array.isArray(storageClasses)) return [] as StorageClassInfo[]
    if (!searchQuery.trim()) return storageClasses
    const q = searchQuery.toLowerCase()

    return storageClasses.filter((sc) => {
      return sc.name.toLowerCase().includes(q)
        || String(sc.provisioner || '').toLowerCase().includes(q)
        || String(sc.reclaim_policy || '').toLowerCase().includes(q)
        || String(sc.volume_binding_mode || '').toLowerCase().includes(q)
        || String(sc.allow_volume_expansion ?? '').toLowerCase().includes(q)
        || String(sc.is_default).toLowerCase().includes(q)
        || Object.keys(sc.parameters || {}).join(',').toLowerCase().includes(q)
        || (sc.mount_options || []).join(',').toLowerCase().includes(q)
    })
  }, [storageClasses, searchQuery])

  const summary = useMemo(() => {
    const total = filteredStorageClasses.length
    let defaults = 0
    let expandable = 0
    let waitForFirstConsumer = 0

    for (const sc of filteredStorageClasses) {
      if (sc.is_default) defaults += 1
      if (sc.allow_volume_expansion) expandable += 1
      if (String(sc.volume_binding_mode || '').toLowerCase() === 'waitforfirstconsumer') {
        waitForFirstConsumer += 1
      }
    }

    return { total, defaults, expandable, waitForFirstConsumer }
  }, [filteredStorageClasses])

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

  const sortedStorageClasses = useMemo(() => {
    if (!sortKey) return filteredStorageClasses
    const list = [...filteredStorageClasses]

    const getValue = (sc: StorageClassInfo): string | number => {
      switch (sortKey) {
        case 'name':
          return sc.name
        case 'provisioner':
          return sc.provisioner || ''
        case 'default':
          return sc.is_default ? 1 : 0
        case 'reclaimPolicy':
          return sc.reclaim_policy || ''
        case 'bindingMode':
          return sc.volume_binding_mode || ''
        case 'allowExpansion':
          return sc.allow_volume_expansion ? 1 : 0
        case 'age':
          return parseAgeSeconds(sc.created_at)
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
  }, [filteredStorageClasses, sortDir, sortKey])

  const rowsPerPage = useAdaptiveRowsPerPage(tableContainerRef, {
    recalculationKey: sortedStorageClasses.length,
  })
  const totalPages = Math.max(1, Math.ceil(sortedStorageClasses.length / rowsPerPage))

  useEffect(() => {
    setCurrentPage(1)
  }, [searchQuery])

  useEffect(() => {
    if (currentPage > totalPages) setCurrentPage(totalPages)
  }, [currentPage, totalPages])

  const pagedStorageClasses = useMemo(() => {
    const start = (currentPage - 1) * rowsPerPage
    return sortedStorageClasses.slice(start, start + rowsPerPage)
  }, [sortedStorageClasses, currentPage, rowsPerPage])

  const handleRefresh = async () => {
    if (isRefreshing) return
    setIsRefreshing(true)
    try {
      const data = await api.getStorageClasses(true)
      queryClient.removeQueries({ queryKey: ['storage', 'storageclasses'] })
      queryClient.setQueryData(['storage', 'storageclasses'], data)
    } catch (error) {
      console.error('StorageClass refresh failed:', error)
    }
    setTimeout(() => setIsRefreshing(false), 500)
  }

  const createStorageClassYamlTemplate = useMemo(() => {
    return `apiVersion: storage.k8s.io/v1
kind: StorageClass
metadata:
  name: sample-storageclass
provisioner: kubernetes.io/no-provisioner
reclaimPolicy: Delete
volumeBindingMode: WaitForFirstConsumer
allowVolumeExpansion: true
`
  }, [])

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-3xl font-bold text-white">{tr('storageclasses.title', 'Storage Classes')}</h1>
          <p className="mt-2 text-slate-400">{tr('storageclasses.subtitle', 'Inspect and manage StorageClasses across the cluster.')}</p>
        </div>
        <div className="flex items-center gap-2">
          {canCreate && (
            <button
              type="button"
              onClick={() => setCreateDialogOpen(true)}
              className="btn btn-primary flex items-center gap-2"
            >
              <Plus className="w-4 h-4" />
              {tr('storageclasses.create', 'Create StorageClass')}
            </button>
          )}
          <button
            type="button"
            onClick={handleRefresh}
            disabled={isRefreshing}
            title={tr('storageclasses.refreshTitle', 'Force refresh')}
            className="btn btn-primary flex items-center gap-2 disabled:opacity-50 disabled:cursor-not-allowed"
          >
            <RefreshCw className={`w-4 h-4 ${isRefreshing ? 'animate-spin' : ''}`} />
            {tr('storageclasses.refresh', 'Refresh')}
          </button>
        </div>
      </div>

      <div className="grid grid-cols-1 gap-3">
        <div>
          <div className="relative">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-5 h-5 text-slate-400" />
            <input
              type="text"
              placeholder={tr('storageclasses.searchPlaceholder', 'Search StorageClasses by name...')}
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              className="w-full pl-10 pr-4 py-3 bg-slate-700 border border-slate-600 rounded-lg text-white placeholder-slate-400 focus:outline-none focus:ring-2 focus:ring-primary-500 focus:border-transparent"
            />
          </div>
        </div>
      </div>

      <div className="grid grid-cols-2 xl:grid-cols-4 gap-3">
        <div className="rounded-lg border border-slate-700 bg-slate-900/50 px-4 py-3">
          <p className="text-[11px] sm:text-xs leading-4 whitespace-nowrap text-slate-400">{tr('storageclasses.stats.total', 'Total')}</p>
          <p className="text-lg text-white font-semibold mt-1">{summary.total}</p>
        </div>
        <div className="rounded-lg border border-cyan-700/40 bg-cyan-900/10 px-4 py-3">
          <p className="text-[11px] sm:text-xs leading-4 whitespace-nowrap text-cyan-300">{tr('storageclasses.stats.default', 'Default')}</p>
          <p className="text-lg text-white font-semibold mt-1">{summary.defaults}</p>
        </div>
        <div className="rounded-lg border border-emerald-700/40 bg-emerald-900/10 px-4 py-3">
          <p className="text-[11px] sm:text-xs leading-4 whitespace-nowrap text-emerald-300">{tr('storageclasses.stats.expandable', 'Expandable')}</p>
          <p className="text-lg text-white font-semibold mt-1">{summary.expandable}</p>
        </div>
        <div className="rounded-lg border border-amber-700/40 bg-amber-900/10 px-4 py-3">
          <p className="text-[11px] sm:text-xs leading-4 whitespace-nowrap text-amber-300">{tr('storageclasses.stats.waitForFirstConsumer', 'WaitForFirstConsumer')}</p>
          <p className="text-lg text-white font-semibold mt-1">{summary.waitForFirstConsumer}</p>
        </div>
      </div>

      {searchQuery && (
        <p className="text-sm text-slate-400">
          {tr('storageclasses.matchCount', '{{count}} storage class{{suffix}} match.', {
            count: filteredStorageClasses.length,
            suffix: filteredStorageClasses.length === 1 ? '' : 'es',
          })}
        </p>
      )}

      <div ref={tableContainerRef} className="card">
        <div className="overflow-x-auto">
          <table className="w-full text-sm min-w-[1300px] table-fixed">
            <thead className="text-slate-400">
              <tr>
                <th className="text-left py-3 px-4 w-[220px] cursor-pointer" onClick={() => handleSort('name')}>
                  <span className="inline-flex items-center gap-1">{tr('storageclasses.table.name', 'Name')}{renderSortIcon('name')}</span>
                </th>
                <th className="text-left py-3 px-4 w-[260px] cursor-pointer" onClick={() => handleSort('provisioner')}>
                  <span className="inline-flex items-center gap-1">{tr('storageclasses.table.provisioner', 'Provisioner')}{renderSortIcon('provisioner')}</span>
                </th>
                <th className="text-left py-3 px-4 w-[100px] cursor-pointer" onClick={() => handleSort('default')}>
                  <span className="inline-flex items-center gap-1">{tr('storageclasses.table.default', 'Default')}{renderSortIcon('default')}</span>
                </th>
                <th className="text-left py-3 px-4 w-[160px] cursor-pointer" onClick={() => handleSort('reclaimPolicy')}>
                  <span className="inline-flex items-center gap-1">{tr('storageclasses.table.reclaimPolicy', 'Reclaim Policy')}{renderSortIcon('reclaimPolicy')}</span>
                </th>
                <th className="text-left py-3 px-4 w-[190px] cursor-pointer" onClick={() => handleSort('bindingMode')}>
                  <span className="inline-flex items-center gap-1">{tr('storageclasses.table.volumeBindingMode', 'Volume Binding Mode')}{renderSortIcon('bindingMode')}</span>
                </th>
                <th className="text-left py-3 px-4 w-[170px] cursor-pointer" onClick={() => handleSort('allowExpansion')}>
                  <span className="inline-flex items-center gap-1">{tr('storageclasses.table.allowVolumeExpansion', 'Allow Volume Expansion')}{renderSortIcon('allowExpansion')}</span>
                </th>
                <th className="text-left py-3 px-4 w-[120px]">{tr('storageclasses.table.parameters', 'Parameters')}</th>
                <th className="text-left py-3 px-4 w-[90px] cursor-pointer" onClick={() => handleSort('age')}>
                  <span className="inline-flex items-center gap-1">{tr('storageclasses.table.age', 'Age')}{renderSortIcon('age')}</span>
                </th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-700">
              {pagedStorageClasses.map((sc) => (
                <tr
                  key={sc.name}
                  className="text-slate-200 hover:bg-slate-800/60 cursor-pointer"
                  onClick={() => openDetail({
                    kind: 'StorageClass',
                    name: sc.name,
                    rawJson: storageClassToRawJson(sc),
                  })}
                >
                  <td className="py-3 px-4 font-medium text-white"><span className="block truncate">{sc.name}</span></td>
                  <td className="py-3 px-4 text-xs font-mono"><span className="block truncate">{sc.provisioner || '-'}</span></td>
                  <td className="py-3 px-4 text-xs">
                    {sc.is_default ? (
                      <span className="inline-flex items-center gap-1 text-emerald-300">
                        <CheckCircle className="w-3.5 h-3.5" />
                        {tr('common.yes', 'Yes')}
                      </span>
                    ) : '-'}
                  </td>
                  <td className="py-3 px-4 text-xs"><span className="block truncate">{sc.reclaim_policy || '-'}</span></td>
                  <td className="py-3 px-4 text-xs"><span className="block truncate">{sc.volume_binding_mode || '-'}</span></td>
                  <td className="py-3 px-4 text-xs">{sc.allow_volume_expansion ? tr('common.yes', 'Yes') : tr('common.no', 'No')}</td>
                  <td className="py-3 px-4 text-xs">{Object.keys(sc.parameters || {}).length}</td>
                  <td className="py-3 px-4 text-xs font-mono">{formatAge(sc.created_at)}</td>
                </tr>
              ))}
              {sortedStorageClasses.length === 0 && !isLoading && (
                <tr>
                  <td colSpan={8} className="py-6 px-4 text-slate-400">
                    {tr('storageclasses.noResults', 'No StorageClasses found.')}
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>

        {sortedStorageClasses.length > 0 && (
          <div className="flex items-center justify-between px-4 py-3 border-t border-slate-700">
            <div className="text-xs text-slate-400">
              {tr('common.paginationRange', 'Showing {{start}}-{{end}} of {{total}}', {
                start: (currentPage - 1) * rowsPerPage + 1,
                end: Math.min(currentPage * rowsPerPage, sortedStorageClasses.length),
                total: sortedStorageClasses.length,
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
          title={tr('storageclasses.createTitle', 'Create StorageClass from YAML')}
          initialYaml={createStorageClassYamlTemplate}
          onClose={() => setCreateDialogOpen(false)}
          onCreated={() => {
            queryClient.invalidateQueries({ queryKey: ['storage', 'storageclasses'] })
          }}
        />
      )}
    </div>
  )
}
