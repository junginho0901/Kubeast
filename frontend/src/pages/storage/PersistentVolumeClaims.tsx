import { useEffect, useMemo, useRef, useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { useTranslation } from 'react-i18next'
import { api, type PVCInfo } from '@/services/api'
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
  | 'namespace'
  | 'name'
  | 'status'
  | 'storageClass'
  | 'volume'
  | 'requested'
  | 'capacity'
  | 'accessModes'
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

function parseQuantityToBytes(value?: string | null): number | null {
  if (!value) return null
  const s = String(value).trim()
  if (!s) return null
  const m = s.match(/^([0-9]+(?:\.[0-9]+)?)([a-zA-Z]+)?$/)
  if (!m) return null

  const num = Number(m[1])
  if (Number.isNaN(num)) return null
  const unit = (m[2] || '').trim()

  const bin: Record<string, number> = {
    Ki: 1024 ** 1,
    Mi: 1024 ** 2,
    Gi: 1024 ** 3,
    Ti: 1024 ** 4,
    Pi: 1024 ** 5,
    Ei: 1024 ** 6,
  }
  const dec: Record<string, number> = {
    K: 1000 ** 1,
    M: 1000 ** 2,
    G: 1000 ** 3,
    T: 1000 ** 4,
    P: 1000 ** 5,
    E: 1000 ** 6,
  }

  if (!unit) return num
  if (bin[unit] !== undefined) return num * bin[unit]
  if (dec[unit] !== undefined) return num * dec[unit]
  return null
}

function normalizeWatchPvcObject(obj: any): PVCInfo {
  if (typeof obj?.name === 'string' && typeof obj?.namespace === 'string' && typeof obj?.status === 'string') {
    return {
      ...obj,
      access_modes: Array.isArray(obj?.access_modes) ? obj.access_modes : [],
    } as PVCInfo
  }

  const metadata = obj?.metadata ?? {}
  const spec = obj?.spec ?? {}
  const status = obj?.status ?? {}
  const capacity = status?.capacity?.storage
  const requested = spec?.resources?.requests?.storage

  return {
    name: metadata?.name ?? obj?.name ?? '',
    namespace: metadata?.namespace ?? obj?.namespace ?? '',
    status: status?.phase ?? obj?.status ?? 'Unknown',
    volume_name: spec?.volumeName ?? obj?.volume_name ?? null,
    storage_class: spec?.storageClassName ?? obj?.storage_class ?? null,
    capacity: capacity != null ? String(capacity) : (obj?.capacity ?? null),
    requested: requested != null ? String(requested) : (obj?.requested ?? null),
    access_modes: Array.isArray(spec?.accessModes) ? spec.accessModes : (Array.isArray(obj?.access_modes) ? obj.access_modes : []),
    created_at: metadata?.creationTimestamp ?? obj?.created_at ?? null,
  }
}

function applyPvcWatchEvent(prev: PVCInfo[] | undefined, event: { type?: string; object?: any }): PVCInfo[] {
  const items = Array.isArray(prev) ? [...prev] : []
  const obj = event?.object
  if (!obj) return items

  const normalized = normalizeWatchPvcObject(obj)
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

function pvcToRawJson(pvc: PVCInfo): Record<string, unknown> {
  return {
    apiVersion: 'v1',
    kind: 'PersistentVolumeClaim',
    metadata: {
      name: pvc.name,
      namespace: pvc.namespace,
      creationTimestamp: pvc.created_at,
    },
    spec: {
      accessModes: pvc.access_modes || [],
      storageClassName: pvc.storage_class,
      volumeName: pvc.volume_name,
      resources: {
        requests: {
          storage: pvc.requested,
        },
      },
    },
    status: {
      phase: pvc.status,
      capacity: {
        storage: pvc.capacity,
      },
    },
  }
}

export default function PersistentVolumeClaims() {
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

  const { data: pvcs, isLoading } = useQuery({
    queryKey: ['storage', 'pvcs', selectedNamespace],
    queryFn: () => api.getPVCs(selectedNamespace === 'all' ? undefined : selectedNamespace, false),
  })
  const { has } = usePermission()
  const canCreate = has('resource.pvc.create')

  useKubeWatchList({
    enabled: true,
    queryKey: ['storage', 'pvcs', selectedNamespace],
    path: selectedNamespace === 'all'
      ? '/api/v1/pvcs'
      : `/api/v1/namespaces/${selectedNamespace}/pvcs`,
    query: 'watch=1',
    applyEvent: (prev, event) => applyPvcWatchEvent(prev as PVCInfo[] | undefined, event),
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

  const filteredPVCs = useMemo(() => {
    if (!Array.isArray(pvcs)) return [] as PVCInfo[]
    if (!searchQuery.trim()) return pvcs
    const q = searchQuery.toLowerCase()
    return pvcs.filter((pvc) => {
      return pvc.name.toLowerCase().includes(q)
        || pvc.namespace.toLowerCase().includes(q)
        || String(pvc.status || '').toLowerCase().includes(q)
        || String(pvc.storage_class || '').toLowerCase().includes(q)
        || String(pvc.volume_name || '').toLowerCase().includes(q)
        || String(pvc.requested || '').toLowerCase().includes(q)
        || String(pvc.capacity || '').toLowerCase().includes(q)
        || (pvc.access_modes || []).join(',').toLowerCase().includes(q)
    })
  }, [pvcs, searchQuery])

  const summary = useMemo(() => {
    const total = filteredPVCs.length
    let bound = 0
    let pending = 0
    let lost = 0

    for (const pvc of filteredPVCs) {
      const status = String(pvc.status || '').toLowerCase()
      if (status === 'bound') bound += 1
      else if (status === 'pending') pending += 1
      else if (status === 'lost') lost += 1
    }

    return { total, bound, pending, lost }
  }, [filteredPVCs])

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

  const sortedPVCs = useMemo(() => {
    if (!sortKey) return filteredPVCs
    const list = [...filteredPVCs]

    const getValue = (pvc: PVCInfo): string | number => {
      switch (sortKey) {
        case 'namespace':
          return pvc.namespace
        case 'name':
          return pvc.name
        case 'status':
          return pvc.status || ''
        case 'storageClass':
          return pvc.storage_class || ''
        case 'volume':
          return pvc.volume_name || ''
        case 'requested':
          return parseQuantityToBytes(pvc.requested) ?? -1
        case 'capacity':
          return parseQuantityToBytes(pvc.capacity) ?? -1
        case 'accessModes':
          return (pvc.access_modes || []).join(',')
        case 'age':
          return parseAgeSeconds(pvc.created_at)
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
  }, [filteredPVCs, sortDir, sortKey])

  const rowsPerPage = useAdaptiveRowsPerPage(tableContainerRef, {
    recalculationKey: sortedPVCs.length,
  })
  const totalPages = Math.max(1, Math.ceil(sortedPVCs.length / rowsPerPage))

  useEffect(() => {
    setCurrentPage(1)
  }, [searchQuery, selectedNamespace])

  useEffect(() => {
    if (currentPage > totalPages) {
      setCurrentPage(totalPages)
    }
  }, [currentPage, totalPages])

  const pagedPVCs = useMemo(() => {
    const start = (currentPage - 1) * rowsPerPage
    return sortedPVCs.slice(start, start + rowsPerPage)
  }, [sortedPVCs, currentPage, rowsPerPage])

  // 플로팅 AI 위젯용 스냅샷
  const aiSnapshot = useMemo(() => {
    if (!Array.isArray(pvcs) || pvcs.length === 0) return null
    const nsLabel = selectedNamespace === 'all' ? '전체 네임스페이스' : selectedNamespace
    const total = pvcs.length
    const pending = pvcs.filter((p) => /pending/i.test(p.status)).length
    const lost = pvcs.filter((p) => /lost/i.test(p.status)).length
    const prefix = pending > 0 || lost > 0 ? '⚠️ ' : ''
    return {
      source: 'base' as const,
      summary: `${prefix}${nsLabel} PVC ${total}개${pending ? `, Pending ${pending}` : ''}${lost ? `, Lost ${lost}` : ''}`,
      data: {
        filters: { namespace: selectedNamespace, search: searchQuery || undefined },
        stats: { total, pending, lost },
        ...summarizeList(pagedPVCs as unknown as Record<string, unknown>[], {
          total: sortedPVCs.length,
          currentPage,
          pageSize: rowsPerPage,
          topN: rowsPerPage,
          pickFields: ['name', 'namespace', 'status', 'volume', 'capacity', 'access_modes', 'storage_class'],
          filterProblematic: (p) => {
            const pvc = p as unknown as PVCInfo
            return /pending|lost/i.test(pvc.status)
          },
          linkBuilder: (p) => {
            const pvc = p as unknown as PVCInfo
            return buildResourceLink('PersistentVolumeClaim', pvc.namespace, pvc.name)
          },
        }),
      },
    }
  }, [pvcs, pagedPVCs, sortedPVCs.length, currentPage, rowsPerPage, selectedNamespace, searchQuery])

  useAIContext(aiSnapshot, [aiSnapshot])

  const handleRefresh = async () => {
    if (isRefreshing) return
    setIsRefreshing(true)
    try {
      const data = await api.getPVCs(selectedNamespace === 'all' ? undefined : selectedNamespace, true)
      queryClient.removeQueries({ queryKey: ['storage', 'pvcs', selectedNamespace] })
      queryClient.setQueryData(['storage', 'pvcs', selectedNamespace], data)
    } catch (error) {
      console.error('PVC refresh failed:', error)
    }
    setTimeout(() => setIsRefreshing(false), 500)
  }

  const createPvcYamlTemplate = useMemo(() => {
    const ns = selectedNamespace !== 'all' ? selectedNamespace : 'default'
    return `apiVersion: v1
kind: PersistentVolumeClaim
metadata:
  name: sample-pvc
  namespace: ${ns}
spec:
  accessModes:
    - ReadWriteOnce
  resources:
    requests:
      storage: 5Gi
`
  }, [selectedNamespace])

  const showNamespaceColumn = selectedNamespace === 'all'

  return (
    <div className="flex flex-col h-[calc(100vh-4rem)] gap-4">
      <div className="flex items-center justify-between shrink-0">
        <div>
          <h1 className="text-3xl font-bold text-white">{tr('pvcs.title', 'Persistent Volume Claims')}</h1>
          <p className="mt-2 text-slate-400">{tr('pvcs.subtitle', 'Inspect and manage PVCs across namespaces.')}</p>
        </div>
        <div className="flex items-center gap-2">
          {canCreate && (
            <button
              type="button"
              onClick={() => setCreateDialogOpen(true)}
              className="btn btn-primary flex items-center gap-2"
            >
              <Plus className="w-4 h-4" />
              {tr('pvcs.create', 'Create PVC')}
            </button>
          )}
          <button
            type="button"
            onClick={handleRefresh}
            disabled={isRefreshing}
            title={tr('pvcs.refreshTitle', 'Force refresh')}
            className="btn btn-primary flex items-center gap-2 disabled:opacity-50 disabled:cursor-not-allowed"
          >
            <RefreshCw className={`w-4 h-4 ${isRefreshing ? 'animate-spin' : ''}`} />
            {tr('pvcs.refresh', 'Refresh')}
          </button>
        </div>
      </div>

      <div className="grid grid-cols-1 xl:grid-cols-3 gap-3 shrink-0">
        <div className="xl:col-span-2">
          <div className="relative">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-5 h-5 text-slate-400" />
            <input
              type="text"
              placeholder={tr('pvcs.searchPlaceholder', 'Search PVCs by name...')}
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
              {selectedNamespace === 'all' ? tr('pvcs.allNamespaces', 'All namespaces') : selectedNamespace}
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
                <span className={selectedNamespace === 'all' ? 'font-medium' : ''}>{tr('pvcs.allNamespaces', 'All namespaces')}</span>
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
          <p className="text-[11px] sm:text-xs leading-4 whitespace-nowrap text-slate-400">{tr('pvcs.stats.total', 'Total')}</p>
          <p className="text-lg text-white font-semibold mt-1">{summary.total}</p>
        </div>
        <div className="rounded-lg border border-emerald-700/40 bg-emerald-900/10 px-4 py-3">
          <p className="text-[11px] sm:text-xs leading-4 whitespace-nowrap text-emerald-300">{tr('pvcs.stats.bound', 'Bound')}</p>
          <p className="text-lg text-white font-semibold mt-1">{summary.bound}</p>
        </div>
        <div className="rounded-lg border border-amber-700/40 bg-amber-900/10 px-4 py-3">
          <p className="text-[11px] sm:text-xs leading-4 whitespace-nowrap text-amber-300">{tr('pvcs.stats.pending', 'Pending')}</p>
          <p className="text-lg text-white font-semibold mt-1">{summary.pending}</p>
        </div>
        <div className="rounded-lg border border-red-700/40 bg-red-900/10 px-4 py-3">
          <p className="text-[11px] sm:text-xs leading-4 whitespace-nowrap text-red-300">{tr('pvcs.stats.lost', 'Lost')}</p>
          <p className="text-lg text-white font-semibold mt-1">{summary.lost}</p>
        </div>
      </div>

      {searchQuery && (
        <p className="text-sm text-slate-400 shrink-0">
          {tr('pvcs.matchCount', '{{count}} pvc{{suffix}} match.', {
            count: filteredPVCs.length,
            suffix: filteredPVCs.length === 1 ? '' : 's',
          })}
        </p>
      )}

      <div ref={tableContainerRef} className="card flex-1 min-h-0 flex flex-col">
        <div className="overflow-x-auto flex-1 min-h-0">
          <table className="w-full text-sm min-w-[1360px] table-fixed">
            <thead className="text-slate-400">
              <tr>
                {showNamespaceColumn && (
                  <th className="text-left py-3 px-4 w-[140px] cursor-pointer" onClick={() => handleSort('namespace')}>
                    <span className="inline-flex items-center gap-1">{tr('pvcs.table.namespace', 'Namespace')}{renderSortIcon('namespace')}</span>
                  </th>
                )}
                <th className="text-left py-3 px-4 w-[220px] cursor-pointer" onClick={() => handleSort('name')}>
                  <span className="inline-flex items-center gap-1">{tr('pvcs.table.name', 'Name')}{renderSortIcon('name')}</span>
                </th>
                <th className="text-left py-3 px-4 w-[120px] cursor-pointer" onClick={() => handleSort('status')}>
                  <span className="inline-flex items-center gap-1">{tr('pvcs.table.status', 'Status')}{renderSortIcon('status')}</span>
                </th>
                <th className="text-left py-3 px-4 w-[180px] cursor-pointer" onClick={() => handleSort('storageClass')}>
                  <span className="inline-flex items-center gap-1">{tr('pvcs.table.storageClass', 'StorageClass')}{renderSortIcon('storageClass')}</span>
                </th>
                <th className="text-left py-3 px-4 w-[220px] cursor-pointer" onClick={() => handleSort('volume')}>
                  <span className="inline-flex items-center gap-1">{tr('pvcs.table.volume', 'Volume')}{renderSortIcon('volume')}</span>
                </th>
                <th className="text-left py-3 px-4 w-[120px] cursor-pointer" onClick={() => handleSort('requested')}>
                  <span className="inline-flex items-center gap-1">{tr('pvcs.table.requested', 'Requested')}{renderSortIcon('requested')}</span>
                </th>
                <th className="text-left py-3 px-4 w-[120px] cursor-pointer" onClick={() => handleSort('capacity')}>
                  <span className="inline-flex items-center gap-1">{tr('pvcs.table.capacity', 'Capacity')}{renderSortIcon('capacity')}</span>
                </th>
                <th className="text-left py-3 px-4 w-[170px] cursor-pointer" onClick={() => handleSort('accessModes')}>
                  <span className="inline-flex items-center gap-1">{tr('pvcs.table.accessModes', 'Access Modes')}{renderSortIcon('accessModes')}</span>
                </th>
                <th className="text-left py-3 px-4 w-[90px] cursor-pointer" onClick={() => handleSort('age')}>
                  <span className="inline-flex items-center gap-1">{tr('pvcs.table.age', 'Age')}{renderSortIcon('age')}</span>
                </th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-700">
              {pagedPVCs.map((pvc) => (
                <tr
                  key={`${pvc.namespace}/${pvc.name}`}
                  className="text-slate-200 hover:bg-slate-800/60 cursor-pointer"
                  onClick={() => openDetail({
                    kind: 'PersistentVolumeClaim',
                    name: pvc.name,
                    namespace: pvc.namespace,
                    rawJson: pvcToRawJson(pvc),
                  })}
                >
                  {showNamespaceColumn && <td className="py-3 px-4 text-xs font-mono">{pvc.namespace}</td>}
                  <td className="py-3 px-4 font-medium text-white"><span className="block truncate">{pvc.name}</span></td>
                  <td className="py-3 px-4">
                    <span className={`badge ${String(pvc.status || '').toLowerCase() === 'bound' ? 'badge-success' : String(pvc.status || '').toLowerCase() === 'pending' ? 'badge-warning' : 'badge-error'}`}>
                      {pvc.status || '-'}
                    </span>
                  </td>
                  <td className="py-3 px-4 text-xs font-mono"><span className="block truncate">{pvc.storage_class || '-'}</span></td>
                  <td className="py-3 px-4 text-xs font-mono"><span className="block truncate">{pvc.volume_name || '-'}</span></td>
                  <td className="py-3 px-4 text-xs font-mono">{pvc.requested || '-'}</td>
                  <td className="py-3 px-4 text-xs font-mono">{pvc.capacity || '-'}</td>
                  <td className="py-3 px-4 text-xs"><span className="block truncate">{(pvc.access_modes || []).join(', ') || '-'}</span></td>
                  <td className="py-3 px-4 text-xs font-mono">{formatAge(pvc.created_at)}</td>
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

              {sortedPVCs.length === 0 && !isLoading && (
                <tr>
                  <td colSpan={showNamespaceColumn ? 9 : 8} className="py-6 px-4 text-center text-slate-400">
                    {tr('pvcs.noResults', 'No PVCs found.')}
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>

        {sortedPVCs.length > 0 && (
          <div className="flex items-center justify-between px-4 py-3 border-t border-slate-700 shrink-0">
            <div className="text-xs text-slate-400">
              {tr('common.paginationRange', 'Showing {{start}}-{{end}} of {{total}}', {
                start: (currentPage - 1) * rowsPerPage + 1,
                end: Math.min(currentPage * rowsPerPage, sortedPVCs.length),
                total: sortedPVCs.length,
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
          title={tr('pvcs.createTitle', 'Create PersistentVolumeClaim from YAML')}
          initialYaml={createPvcYamlTemplate}
          namespace={selectedNamespace !== 'all' ? selectedNamespace : undefined}
          onClose={() => setCreateDialogOpen(false)}
          onCreated={() => {
            queryClient.invalidateQueries({ queryKey: ['storage', 'pvcs'] })
          }}
        />
      )}
    </div>
  )
}
