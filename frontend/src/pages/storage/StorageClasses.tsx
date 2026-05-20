import { useEffect, useMemo, useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { useTranslation } from 'react-i18next'
import { api, type StorageClassInfo } from '@/services/api'
import { useKubeWatchList } from '@/services/useKubeWatchList'
import { useResourceDetail } from '@/components/ResourceDetailContext'
import ResourceYamlCreateDialog from '@/components/ResourceYamlCreateDialog'
import { useAdaptiveTable } from '@/hooks/useAdaptiveTable'
import { useAIContext } from '@/hooks/useAIContext'
import { usePermission } from '@/hooks/usePermission'
import { summarizeList } from '@/utils/aiContext/summarizeList'
import { buildResourceLink } from '@/utils/resourceLink'
import { Plus, RefreshCw } from 'lucide-react'
import {
  parseAgeSeconds,
  type SortKey,
} from './storageclasses/storageClassHelpers'
import { applyStorageClassWatchEvent } from './storageclasses/storageClassWatchNormalize'
import { StorageClassFilters } from './storageclasses/StorageClassFilters'
import { StorageClassTable } from './storageclasses/StorageClassTable'

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

  const { data: storageClasses, isLoading } = useQuery({
    queryKey: ['storage', 'storageclasses'],
    queryFn: () => api.getStorageClasses(false),
  })
  const { has } = usePermission()
  const canCreate = has('resource.storageclass.create')

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

  const { containerRef: tableContainerRef, bodyRef: tableBodyRef, theadRef, firstRowRef, rowsPerPage } = useAdaptiveTable({
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

  // 플로팅 AI 위젯용 스냅샷 (cluster-scoped)
  const aiSnapshot = useMemo(() => {
    if (!Array.isArray(storageClasses) || storageClasses.length === 0) return null
    const total = storageClasses.length
    return {
      source: 'base' as const,
      summary: `StorageClass ${total}개`,
      data: {
        filters: { search: searchQuery || undefined },
        stats: { total },
        ...summarizeList(pagedStorageClasses as unknown as Record<string, unknown>[], {
          total: sortedStorageClasses.length,
          currentPage,
          pageSize: rowsPerPage,
          topN: rowsPerPage,
          pickFields: ['name', 'provisioner', 'reclaim_policy', 'volume_binding_mode', 'allow_volume_expansion'],
          linkBuilder: (s) => {
            const sc = s as unknown as StorageClassInfo
            return buildResourceLink('StorageClass', undefined, sc.name)
          },
        }),
      },
    }
  }, [storageClasses, pagedStorageClasses, sortedStorageClasses.length, currentPage, rowsPerPage, searchQuery])

  useAIContext(aiSnapshot, [aiSnapshot])

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
    <div className="flex flex-col h-[calc(100vh-4rem)] gap-4">
      <div className="flex items-center justify-between shrink-0">
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

      <StorageClassFilters
        searchQuery={searchQuery}
        setSearchQuery={setSearchQuery}
        searchPlaceholder={tr('storageclasses.searchPlaceholder', 'Search StorageClasses by name...')}
      />

      <div className="grid grid-cols-2 xl:grid-cols-4 gap-3 shrink-0">
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
        <p className="text-sm text-slate-400 shrink-0">
          {tr('storageclasses.matchCount', '{{count}} storage class{{suffix}} match.', {
            count: filteredStorageClasses.length,
            suffix: filteredStorageClasses.length === 1 ? '' : 'es',
          })}
        </p>
      )}

      <StorageClassTable
        pagedStorageClasses={pagedStorageClasses}
        sortedStorageClassesLength={sortedStorageClasses.length}
        isLoading={isLoading}
        sortKey={sortKey}
        setSortKey={setSortKey}
        sortDir={sortDir}
        setSortDir={setSortDir}
        currentPage={currentPage}
        setCurrentPage={setCurrentPage}
        totalPages={totalPages}
        rowsPerPage={rowsPerPage}
        tableContainerRef={tableContainerRef}
        tableBodyRef={tableBodyRef}
        theadRef={theadRef}
        firstRowRef={firstRowRef}
        openDetail={openDetail}
        tr={tr}
      />

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
