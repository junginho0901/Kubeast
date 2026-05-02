import { useEffect, useMemo, useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { useTranslation } from 'react-i18next'
import { api, type PVInfo } from '@/services/api'
import { useKubeWatchList } from '@/services/useKubeWatchList'
import { useResourceDetail } from '@/components/ResourceDetailContext'
import ResourceYamlCreateDialog from '@/components/ResourceYamlCreateDialog'
import { useAdaptiveTable } from '@/hooks/useAdaptiveTable'
import { AdaptiveTableFillerRows } from '@/components/AdaptiveTableFillerRows'
import { useAIContext } from '@/hooks/useAIContext'
import { usePermission } from '@/hooks/usePermission'
import { summarizeList } from '@/utils/aiContext/summarizeList'
import { buildResourceLink } from '@/utils/resourceLink'
import { Loader2, ChevronDown, ChevronUp, Plus, RefreshCw, Search } from 'lucide-react'

type SortKey =
  | null
  | 'name'
  | 'status'
  | 'storageClass'
  | 'capacity'
  | 'accessModes'
  | 'reclaimPolicy'
  | 'claim'
  | 'volumeMode'
  | 'source'
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

function normalizeWatchPvObject(obj: any): PVInfo {
  if (typeof obj?.name === 'string' && typeof obj?.status === 'string') {
    return {
      ...obj,
      access_modes: Array.isArray(obj?.access_modes) ? obj.access_modes : [],
    } as PVInfo
  }

  const metadata = obj?.metadata ?? {}
  const spec = obj?.spec ?? {}
  const status = obj?.status ?? {}

  return {
    name: metadata?.name ?? obj?.name ?? '',
    status: status?.phase ?? obj?.status ?? 'Unknown',
    capacity: String(spec?.capacity?.storage ?? obj?.capacity ?? ''),
    access_modes: Array.isArray(spec?.accessModes) ? spec.accessModes : (Array.isArray(obj?.access_modes) ? obj.access_modes : []),
    storage_class: spec?.storageClassName ?? obj?.storage_class ?? null,
    reclaim_policy: spec?.persistentVolumeReclaimPolicy ?? obj?.reclaim_policy ?? 'Delete',
    claim_ref: spec?.claimRef
      ? {
          namespace: spec.claimRef.namespace,
          name: spec.claimRef.name,
        }
      : (obj?.claim_ref ?? null),
    volume_mode: spec?.volumeMode ?? obj?.volume_mode ?? null,
    source: obj?.source ?? null,
    driver: obj?.driver ?? null,
    volume_handle: obj?.volume_handle ?? null,
    node_affinity: obj?.node_affinity ?? null,
    created_at: metadata?.creationTimestamp ?? obj?.created_at ?? null,
  }
}

function applyPvWatchEvent(prev: PVInfo[] | undefined, event: { type?: string; object?: any }): PVInfo[] {
  const items = Array.isArray(prev) ? [...prev] : []
  const obj = event?.object
  if (!obj) return items

  const normalized = normalizeWatchPvObject(obj)
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

function claimToText(claimRef?: { namespace?: string; name?: string } | null): string {
  if (!claimRef?.name) return '-'
  return claimRef.namespace ? `${claimRef.namespace}/${claimRef.name}` : claimRef.name
}

function pvToRawJson(pv: PVInfo): Record<string, unknown> {
  const claimRef = pv.claim_ref?.name
    ? {
        namespace: pv.claim_ref.namespace,
        name: pv.claim_ref.name,
      }
    : undefined

  return {
    apiVersion: 'v1',
    kind: 'PersistentVolume',
    metadata: {
      name: pv.name,
      creationTimestamp: pv.created_at,
    },
    spec: {
      capacity: { storage: pv.capacity },
      accessModes: pv.access_modes || [],
      storageClassName: pv.storage_class,
      persistentVolumeReclaimPolicy: pv.reclaim_policy,
      volumeMode: pv.volume_mode,
      claimRef,
      csi: pv.driver
        ? {
            driver: pv.driver,
            volumeHandle: pv.volume_handle,
          }
        : undefined,
    },
    status: {
      phase: pv.status,
    },
  }
}

function statusBadgeClass(status?: string | null): string {
  const lower = String(status || '').toLowerCase()
  if (lower === 'bound' || lower === 'available') return 'badge-success'
  if (lower === 'released' || lower === 'pending') return 'badge-warning'
  if (lower === 'failed') return 'badge-error'
  return 'badge-info'
}

export default function PersistentVolumes() {
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

  const { data: pvs, isLoading } = useQuery({
    queryKey: ['storage', 'pvs'],
    queryFn: () => api.getPVs(),
  })
  const { has } = usePermission()
  const canCreate = has('resource.pv.create')

  useKubeWatchList({
    enabled: true,
    queryKey: ['storage', 'pvs'],
    path: '/api/v1/pvs',
    query: 'watch=1',
    applyEvent: (prev, event) => applyPvWatchEvent(prev as PVInfo[] | undefined, event),
    onEvent: (event) => {
      if (event?.type === 'DELETED') return
      const name = event?.object?.name || event?.object?.metadata?.name
      if (name) {
        queryClient.invalidateQueries({ queryKey: ['pv-describe', name] })
      }
    },
  })

  const filteredPVs = useMemo(() => {
    if (!Array.isArray(pvs)) return [] as PVInfo[]
    if (!searchQuery.trim()) return pvs
    const q = searchQuery.toLowerCase()
    return pvs.filter((pv) => {
      return pv.name.toLowerCase().includes(q)
        || String(pv.status || '').toLowerCase().includes(q)
        || String(pv.storage_class || '').toLowerCase().includes(q)
        || String(pv.reclaim_policy || '').toLowerCase().includes(q)
        || String(pv.capacity || '').toLowerCase().includes(q)
        || String(pv.volume_mode || '').toLowerCase().includes(q)
        || String(pv.source || '').toLowerCase().includes(q)
        || String(pv.driver || '').toLowerCase().includes(q)
        || String(pv.node_affinity || '').toLowerCase().includes(q)
        || claimToText(pv.claim_ref).toLowerCase().includes(q)
        || (pv.access_modes || []).join(',').toLowerCase().includes(q)
    })
  }, [pvs, searchQuery])

  const summary = useMemo(() => {
    const total = filteredPVs.length
    let bound = 0
    let available = 0
    let released = 0
    let failed = 0

    for (const pv of filteredPVs) {
      const status = String(pv.status || '').toLowerCase()
      if (status === 'bound') bound += 1
      else if (status === 'available') available += 1
      else if (status === 'released') released += 1
      else if (status === 'failed') failed += 1
    }

    return { total, bound, available, released, failed }
  }, [filteredPVs])

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

  const sortedPVs = useMemo(() => {
    if (!sortKey) return filteredPVs
    const list = [...filteredPVs]

    const getValue = (pv: PVInfo): string | number => {
      switch (sortKey) {
        case 'name':
          return pv.name
        case 'status':
          return pv.status || ''
        case 'storageClass':
          return pv.storage_class || ''
        case 'capacity':
          return parseQuantityToBytes(pv.capacity) ?? -1
        case 'accessModes':
          return (pv.access_modes || []).join(',')
        case 'reclaimPolicy':
          return pv.reclaim_policy || ''
        case 'claim':
          return claimToText(pv.claim_ref)
        case 'volumeMode':
          return pv.volume_mode || ''
        case 'source':
          return pv.source || pv.driver || ''
        case 'age':
          return parseAgeSeconds(pv.created_at)
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
  }, [filteredPVs, sortDir, sortKey])

  const { containerRef: tableContainerRef, bodyRef: tableBodyRef, theadRef, firstRowRef, rowsPerPage } = useAdaptiveTable({
    recalculationKey: sortedPVs.length,
  })
  const totalPages = Math.max(1, Math.ceil(sortedPVs.length / rowsPerPage))

  useEffect(() => {
    setCurrentPage(1)
  }, [searchQuery])

  useEffect(() => {
    if (currentPage > totalPages) setCurrentPage(totalPages)
  }, [currentPage, totalPages])

  const pagedPVs = useMemo(() => {
    const start = (currentPage - 1) * rowsPerPage
    return sortedPVs.slice(start, start + rowsPerPage)
  }, [sortedPVs, currentPage, rowsPerPage])

  // 플로팅 AI 위젯용 스냅샷 (cluster-scoped)
  const aiSnapshot = useMemo(() => {
    if (!Array.isArray(pvs) || pvs.length === 0) return null
    const total = pvs.length
    const released = pvs.filter((p) => /released/i.test(p.status)).length
    const failed = pvs.filter((p) => /fail/i.test(p.status)).length
    const prefix = released > 0 || failed > 0 ? '⚠️ ' : ''
    return {
      source: 'base' as const,
      summary: `${prefix}PV ${total}개${released ? `, Released ${released}` : ''}${failed ? `, Failed ${failed}` : ''}`,
      data: {
        filters: { search: searchQuery || undefined },
        stats: { total, released, failed },
        ...summarizeList(pagedPVs as unknown as Record<string, unknown>[], {
          total: sortedPVs.length,
          currentPage,
          pageSize: rowsPerPage,
          topN: rowsPerPage,
          pickFields: ['name', 'capacity', 'access_modes', 'reclaim_policy', 'status', 'claim', 'storage_class'],
          filterProblematic: (p) => {
            const pv = p as unknown as PVInfo
            return /released|fail/i.test(pv.status)
          },
          linkBuilder: (p) => {
            const pv = p as unknown as PVInfo
            return buildResourceLink('PersistentVolume', undefined, pv.name)
          },
        }),
      },
    }
  }, [pvs, pagedPVs, sortedPVs.length, currentPage, rowsPerPage, searchQuery])

  useAIContext(aiSnapshot, [aiSnapshot])

  const handleRefresh = async () => {
    if (isRefreshing) return
    setIsRefreshing(true)
    try {
      const data = await api.getPVs()
      queryClient.removeQueries({ queryKey: ['storage', 'pvs'] })
      queryClient.setQueryData(['storage', 'pvs'], data)
    } catch (error) {
      console.error('PV refresh failed:', error)
    }
    setTimeout(() => setIsRefreshing(false), 500)
  }

  const createPvYamlTemplate = useMemo(() => {
    return `apiVersion: v1
kind: PersistentVolume
metadata:
  name: sample-pv
spec:
  capacity:
    storage: 10Gi
  accessModes:
    - ReadWriteOnce
  persistentVolumeReclaimPolicy: Retain
  storageClassName: manual
  hostPath:
    path: /tmp/sample-pv
`
  }, [])

  return (
    <div className="flex flex-col h-[calc(100vh-4rem)] gap-4">
      <div className="flex items-center justify-between shrink-0">
        <div>
          <h1 className="text-3xl font-bold text-white">{tr('pvs.title', 'Persistent Volumes')}</h1>
          <p className="mt-2 text-slate-400">{tr('pvs.subtitle', 'Inspect and manage persistent volumes across the cluster.')}</p>
        </div>
        <div className="flex items-center gap-2">
          {canCreate && (
            <button
              type="button"
              onClick={() => setCreateDialogOpen(true)}
              className="btn btn-primary flex items-center gap-2"
            >
              <Plus className="w-4 h-4" />
              {tr('pvs.create', 'Create PV')}
            </button>
          )}
          <button
            type="button"
            onClick={handleRefresh}
            disabled={isRefreshing}
            title={tr('pvs.refreshTitle', 'Force refresh')}
            className="btn btn-primary flex items-center gap-2 disabled:opacity-50 disabled:cursor-not-allowed"
          >
            <RefreshCw className={`w-4 h-4 ${isRefreshing ? 'animate-spin' : ''}`} />
            {tr('pvs.refresh', 'Refresh')}
          </button>
        </div>
      </div>

      <div className="grid grid-cols-1 gap-3 shrink-0">
        <div>
          <div className="relative">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-5 h-5 text-slate-400" />
            <input
              type="text"
              placeholder={tr('pvs.searchPlaceholder', 'Search PVs by name...')}
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              className="h-12 w-full pl-10 pr-4 bg-slate-700 border border-slate-600 rounded-lg text-sm text-white placeholder-slate-400 focus:outline-none focus:ring-2 focus:ring-primary-500 focus:border-transparent"
            />
          </div>
        </div>
      </div>

      <div className="grid grid-cols-2 xl:grid-cols-5 gap-3 shrink-0">
        <div className="rounded-lg border border-slate-700 bg-slate-900/50 px-4 py-3">
          <p className="text-[11px] sm:text-xs leading-4 whitespace-nowrap text-slate-400">{tr('pvs.stats.total', 'Total')}</p>
          <p className="text-lg text-white font-semibold mt-1">{summary.total}</p>
        </div>
        <div className="rounded-lg border border-emerald-700/40 bg-emerald-900/10 px-4 py-3">
          <p className="text-[11px] sm:text-xs leading-4 whitespace-nowrap text-emerald-300">{tr('pvs.stats.bound', 'Bound')}</p>
          <p className="text-lg text-white font-semibold mt-1">{summary.bound}</p>
        </div>
        <div className="rounded-lg border border-cyan-700/40 bg-cyan-900/10 px-4 py-3">
          <p className="text-[11px] sm:text-xs leading-4 whitespace-nowrap text-cyan-300">{tr('pvs.stats.available', 'Available')}</p>
          <p className="text-lg text-white font-semibold mt-1">{summary.available}</p>
        </div>
        <div className="rounded-lg border border-amber-700/40 bg-amber-900/10 px-4 py-3">
          <p className="text-[11px] sm:text-xs leading-4 whitespace-nowrap text-amber-300">{tr('pvs.stats.released', 'Released')}</p>
          <p className="text-lg text-white font-semibold mt-1">{summary.released}</p>
        </div>
        <div className="rounded-lg border border-red-700/40 bg-red-900/10 px-4 py-3">
          <p className="text-[11px] sm:text-xs leading-4 whitespace-nowrap text-red-300">{tr('pvs.stats.failed', 'Failed')}</p>
          <p className="text-lg text-white font-semibold mt-1">{summary.failed}</p>
        </div>
      </div>

      {searchQuery && (
        <p className="text-sm text-slate-400 shrink-0">
          {tr('pvs.matchCount', '{{count}} pv{{suffix}} match.', {
            count: filteredPVs.length,
            suffix: filteredPVs.length === 1 ? '' : 's',
          })}
        </p>
      )}

      <div ref={tableContainerRef} className="card flex-1 min-h-0 flex flex-col">
        <div ref={tableBodyRef} className="overflow-x-auto flex-1 min-h-0">
          <table className="w-full text-sm min-w-[1400px] table-fixed">
            <thead ref={theadRef} className="text-slate-400">
              <tr>
                <th className="text-left py-3 px-4 w-[220px] cursor-pointer" onClick={() => handleSort('name')}>
                  <span className="inline-flex items-center gap-1">{tr('pvs.table.name', 'Name')}{renderSortIcon('name')}</span>
                </th>
                <th className="text-left py-3 px-4 w-[120px] cursor-pointer" onClick={() => handleSort('status')}>
                  <span className="inline-flex items-center gap-1">{tr('pvs.table.status', 'Status')}{renderSortIcon('status')}</span>
                </th>
                <th className="text-left py-3 px-4 w-[180px] cursor-pointer" onClick={() => handleSort('storageClass')}>
                  <span className="inline-flex items-center gap-1">{tr('pvs.table.storageClass', 'StorageClass')}{renderSortIcon('storageClass')}</span>
                </th>
                <th className="text-left py-3 px-4 w-[110px] cursor-pointer" onClick={() => handleSort('capacity')}>
                  <span className="inline-flex items-center gap-1">{tr('pvs.table.capacity', 'Capacity')}{renderSortIcon('capacity')}</span>
                </th>
                <th className="text-left py-3 px-4 w-[170px] cursor-pointer" onClick={() => handleSort('accessModes')}>
                  <span className="inline-flex items-center gap-1">{tr('pvs.table.accessModes', 'Access Modes')}{renderSortIcon('accessModes')}</span>
                </th>
                <th className="text-left py-3 px-4 w-[140px] cursor-pointer" onClick={() => handleSort('reclaimPolicy')}>
                  <span className="inline-flex items-center gap-1">{tr('pvs.table.reclaimPolicy', 'Reclaim Policy')}{renderSortIcon('reclaimPolicy')}</span>
                </th>
                <th className="text-left py-3 px-4 w-[180px] cursor-pointer" onClick={() => handleSort('claim')}>
                  <span className="inline-flex items-center gap-1">{tr('pvs.table.claim', 'Claim')}{renderSortIcon('claim')}</span>
                </th>
                <th className="text-left py-3 px-4 w-[120px] cursor-pointer" onClick={() => handleSort('volumeMode')}>
                  <span className="inline-flex items-center gap-1">{tr('pvs.table.volumeMode', 'Volume Mode')}{renderSortIcon('volumeMode')}</span>
                </th>
                <th className="text-left py-3 px-4 w-[190px] cursor-pointer" onClick={() => handleSort('source')}>
                  <span className="inline-flex items-center gap-1">{tr('pvs.table.source', 'Source')}{renderSortIcon('source')}</span>
                </th>
                <th className="text-left py-3 px-4 w-[90px] cursor-pointer" onClick={() => handleSort('age')}>
                  <span className="inline-flex items-center gap-1">{tr('pvs.table.age', 'Age')}{renderSortIcon('age')}</span>
                </th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-700">
              {pagedPVs.map((pv, idx) => (
                <tr
                      ref={idx === 0 ? firstRowRef : undefined}
                  key={pv.name}
                  className="text-slate-200 hover:bg-slate-800/60 cursor-pointer"
                  onClick={() => openDetail({
                    kind: 'PersistentVolume',
                    name: pv.name,
                    rawJson: pvToRawJson(pv),
                  })}
                >
                  <td className="py-3 px-4 font-medium text-white"><span className="block truncate">{pv.name}</span></td>
                  <td className="py-3 px-4">
                    <span className={`badge ${statusBadgeClass(pv.status)}`}>{pv.status || '-'}</span>
                  </td>
                  <td className="py-3 px-4 text-xs font-mono"><span className="block truncate">{pv.storage_class || '-'}</span></td>
                  <td className="py-3 px-4 text-xs font-mono">{pv.capacity || '-'}</td>
                  <td className="py-3 px-4 text-xs"><span className="block truncate">{(pv.access_modes || []).join(', ') || '-'}</span></td>
                  <td className="py-3 px-4 text-xs"><span className="block truncate">{pv.reclaim_policy || '-'}</span></td>
                  <td className="py-3 px-4 text-xs font-mono"><span className="block truncate">{claimToText(pv.claim_ref)}</span></td>
                  <td className="py-3 px-4 text-xs">{pv.volume_mode || '-'}</td>
                  <td className="py-3 px-4 text-xs"><span className="block truncate">{pv.source || pv.driver || '-'}</span></td>
                  <td className="py-3 px-4 text-xs font-mono">{formatAge(pv.created_at)}</td>
                </tr>
              ))}
              {isLoading && (
                <tr>
                  <td colSpan={10} className="py-10 px-4 text-center text-slate-400">
                    <div className="inline-flex items-center gap-2">
                      <Loader2 className="w-4 h-4 animate-spin" />
                      Loading...
                    </div>
                  </td>
                </tr>
              )}

              {sortedPVs.length === 0 && !isLoading && (
                <tr>
                  <td colSpan={10} className="py-6 px-4 text-center text-slate-400">
                    {tr('pvs.noResults', 'No PVs found.')}
                  </td>
                </tr>
              )}
            </tbody>
              <AdaptiveTableFillerRows count={rowsPerPage - pagedPVs.length} columnCount={10} />
          </table>
        </div>

        {sortedPVs.length > 0 && (
          <div className="flex items-center justify-between px-4 py-3 border-t border-slate-700 shrink-0">
            <div className="text-xs text-slate-400">
              {tr('common.paginationRange', 'Showing {{start}}-{{end}} of {{total}}', {
                start: (currentPage - 1) * rowsPerPage + 1,
                end: Math.min(currentPage * rowsPerPage, sortedPVs.length),
                total: sortedPVs.length,
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
          title={tr('pvs.createTitle', 'Create PersistentVolume from YAML')}
          initialYaml={createPvYamlTemplate}
          onClose={() => setCreateDialogOpen(false)}
          onCreated={() => {
            queryClient.invalidateQueries({ queryKey: ['storage', 'pvs'] })
          }}
        />
      )}
    </div>
  )
}
