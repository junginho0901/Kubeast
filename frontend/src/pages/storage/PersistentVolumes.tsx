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
import {
  parseAgeSeconds,
  formatAge,
  parseQuantityToBytes,
  claimToText,
  statusBadgeClass,
  pvToRawJson,
  type SortKey,
} from './pvs/pvHelpers'
import { applyPvWatchEvent } from './pvs/pvWatchNormalize'

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
