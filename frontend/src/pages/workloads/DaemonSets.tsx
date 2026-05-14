import { useEffect, useMemo, useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { useTranslation } from 'react-i18next'
import { api, type DaemonSetInfo } from '@/services/api'
import { useKubeWatchList } from '@/services/useKubeWatchList'
import { useResourceDetail } from '@/components/ResourceDetailContext'
import ResourceYamlCreateDialog from '@/components/ResourceYamlCreateDialog'
import { useAdaptiveTable } from '@/hooks/useAdaptiveTable'
import { AdaptiveTableFillerRows } from '@/components/AdaptiveTableFillerRows'
import { useAIContext } from '@/hooks/useAIContext'
import { usePermission } from '@/hooks/usePermission'
import { summarizeList } from '@/utils/aiContext/summarizeList'
import { buildResourceLink } from '@/utils/resourceLink'
import { Loader2, ChevronDown, ChevronUp, Plus, RefreshCw } from 'lucide-react'
import {
  parseAgeSeconds,
  formatAge,
  getDaemonSetStatusColor,
  type SortKey,
} from './daemonsets/daemonSetHelpers'
import { applyDaemonSetWatchEvent } from './daemonsets/daemonSetWatchNormalize'
import { DaemonSetFilters } from './daemonsets/DaemonSetFilters'

function daemonSetToWorkloadRawJson(daemonset: DaemonSetInfo): Record<string, unknown> {
  return {
    apiVersion: 'apps/v1',
    kind: 'DaemonSet',
    metadata: {
      name: daemonset.name,
      namespace: daemonset.namespace,
      creationTimestamp: daemonset.created_at,
    },
    spec: {
      selector: { matchLabels: { app: daemonset.name } },
      template: {
        metadata: { labels: { app: daemonset.name } },
        spec: {
          nodeSelector: daemonset.node_selector || {},
          containers: (daemonset.images || []).map((image, idx) => ({
            name: `container-${idx + 1}`,
            image,
          })),
        },
      },
      updateStrategy: {
        type: 'RollingUpdate',
      },
    },
    status: {
      desiredNumberScheduled: daemonset.desired,
      currentNumberScheduled: daemonset.current,
      numberReady: daemonset.ready,
      updatedNumberScheduled: daemonset.updated,
      numberAvailable: daemonset.available,
      numberMisscheduled: daemonset.misscheduled,
      numberUnavailable: daemonset.unavailable,
    },
  }
}

export default function DaemonSets() {
  const queryClient = useQueryClient()
  const { t } = useTranslation()
  const tr = (key: string, fallback: string, options?: Record<string, any>) =>
    t(key, { defaultValue: fallback, ...options })
  const { open: openDetail } = useResourceDetail()

  const [searchQuery, setSearchQuery] = useState('')
  const [selectedNamespace, setSelectedNamespace] = useState<string>('all')
  const [isRefreshing, setIsRefreshing] = useState(false)
  const [sortKey, setSortKey] = useState<SortKey>(null)
  const [sortDir, setSortDir] = useState<'asc' | 'desc'>('asc')
  const [currentPage, setCurrentPage] = useState(1)
  const [createDialogOpen, setCreateDialogOpen] = useState(false)

  const { data: namespaces } = useQuery({
    queryKey: ['namespaces'],
    queryFn: () => api.getNamespaces(),
    staleTime: 30000,
  })

  const { data: daemonsets, isLoading } = useQuery({
    queryKey: ['workloads', 'daemonsets', selectedNamespace],
    queryFn: () => (
      selectedNamespace === 'all'
        ? api.getAllDaemonSets(false)
        : api.getDaemonSets(selectedNamespace, false)
    ),
  })
  const { has } = usePermission()
  const canCreate = has('resource.daemonset.create')

  useKubeWatchList({
    enabled: true,
    queryKey: ['workloads', 'daemonsets', selectedNamespace],
    path: selectedNamespace === 'all'
      ? '/api/v1/daemonsets'
      : `/api/v1/namespaces/${selectedNamespace}/daemonsets`,
    query: 'watch=1',
    applyEvent: (prev, event) => applyDaemonSetWatchEvent(prev as DaemonSetInfo[] | undefined, event),
  })

  const filteredDaemonSets = useMemo(() => {
    if (!Array.isArray(daemonsets)) return [] as DaemonSetInfo[]
    if (!searchQuery.trim()) return daemonsets
    const q = searchQuery.toLowerCase()
    return daemonsets.filter((daemonset) => {
      const selectorText = Object.entries(daemonset.node_selector || {})
        .map(([key, value]) => `${key}=${value}`)
        .join(',')
      const imagesText = (daemonset.images || []).join(',')
      return daemonset.name.toLowerCase().includes(q)
        || daemonset.namespace.toLowerCase().includes(q)
        || String(daemonset.status || '').toLowerCase().includes(q)
        || selectorText.toLowerCase().includes(q)
        || imagesText.toLowerCase().includes(q)
    })
  }, [daemonsets, searchQuery])

  const summary = useMemo(() => {
    const total = filteredDaemonSets.length
    let healthy = 0
    let degraded = 0
    let unavailable = 0
    for (const daemonset of filteredDaemonSets) {
      const status = (daemonset.status || '').toLowerCase()
      if (status.includes('healthy')) healthy += 1
      else if (status.includes('unavailable')) unavailable += 1
      else degraded += 1
    }
    return { total, healthy, degraded, unavailable }
  }, [filteredDaemonSets])

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

  const sortedDaemonSets = useMemo(() => {
    if (!sortKey) return filteredDaemonSets
    const list = [...filteredDaemonSets]

    const getValue = (daemonset: DaemonSetInfo): string | number => {
      switch (sortKey) {
        case 'name':
          return daemonset.name
        case 'ready':
          return daemonset.desired === 0 ? 0 : (daemonset.ready || 0) / daemonset.desired
        case 'current':
          return daemonset.current || 0
        case 'desired':
          return daemonset.desired || 0
        case 'updated':
          return daemonset.updated || 0
        case 'available':
          return daemonset.available || 0
        case 'status':
          return daemonset.status || ''
        case 'images':
          return (daemonset.images || []).join(',')
        case 'age':
          return parseAgeSeconds(daemonset.created_at)
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
  }, [filteredDaemonSets, sortDir, sortKey])

  const { containerRef: tableContainerRef, bodyRef: tableBodyRef, theadRef, firstRowRef, rowsPerPage } = useAdaptiveTable({
    recalculationKey: sortedDaemonSets.length,
  })
  const totalPages = Math.max(1, Math.ceil(sortedDaemonSets.length / rowsPerPage))

  useEffect(() => {
    setCurrentPage(1)
  }, [searchQuery, selectedNamespace])

  useEffect(() => {
    if (currentPage > totalPages) {
      setCurrentPage(totalPages)
    }
  }, [currentPage, totalPages])

  const pagedDaemonSets = useMemo(() => {
    const start = (currentPage - 1) * rowsPerPage
    return sortedDaemonSets.slice(start, start + rowsPerPage)
  }, [sortedDaemonSets, currentPage, rowsPerPage])

  // 플로팅 AI 위젯용 스냅샷
  const aiSnapshot = useMemo(() => {
    if (!Array.isArray(daemonsets) || daemonsets.length === 0) return null
    const nsLabel = selectedNamespace === 'all' ? '전체 네임스페이스' : selectedNamespace
    const total = daemonsets.length
    const unavailable = daemonsets.filter((d) => d.unavailable > 0 || d.misscheduled > 0).length
    const prefix = unavailable > 0 ? '⚠️ ' : ''
    return {
      source: 'base' as const,
      summary: `${prefix}${nsLabel} DaemonSet ${total}개${unavailable ? ` (문제 ${unavailable})` : ''}`,
      data: {
        filters: { namespace: selectedNamespace, search: searchQuery || undefined },
        stats: { total, unavailable },
        ...summarizeList(pagedDaemonSets as unknown as Record<string, unknown>[], {
          total: sortedDaemonSets.length,
          currentPage,
          pageSize: rowsPerPage,
          topN: rowsPerPage,
          pickFields: ['name', 'namespace', 'desired', 'current', 'ready', 'updated', 'available', 'unavailable', 'status'],
          filterProblematic: (d) => {
            const ds = d as unknown as DaemonSetInfo
            return ds.unavailable > 0 || ds.misscheduled > 0 || ds.ready < ds.desired
          },
          linkBuilder: (d) => {
            const ds = d as unknown as DaemonSetInfo
            return buildResourceLink('DaemonSet', ds.namespace, ds.name)
          },
        }),
      },
    }
  }, [daemonsets, pagedDaemonSets, sortedDaemonSets.length, currentPage, rowsPerPage, selectedNamespace, searchQuery])

  useAIContext(aiSnapshot, [aiSnapshot])

  const handleRefresh = async () => {
    if (isRefreshing) return
    setIsRefreshing(true)
    try {
      const data = selectedNamespace === 'all'
        ? await api.getAllDaemonSets(true)
        : await api.getDaemonSets(selectedNamespace, true)
      queryClient.removeQueries({ queryKey: ['workloads', 'daemonsets', selectedNamespace] })
      queryClient.setQueryData(['workloads', 'daemonsets', selectedNamespace], data)
    } catch (error) {
      console.error('DaemonSets refresh failed:', error)
    }
    setTimeout(() => setIsRefreshing(false), 500)
  }

  const createDaemonSetYamlTemplate = useMemo(() => {
    const ns = selectedNamespace !== 'all' ? selectedNamespace : 'default'
    return `apiVersion: apps/v1
kind: DaemonSet
metadata:
  name: sample-daemonset
  namespace: ${ns}
  labels:
    app: sample-daemon
spec:
  selector:
    matchLabels:
      app: sample-daemon
  template:
    metadata:
      labels:
        app: sample-daemon
    spec:
      containers:
        - name: sample-daemon
          image: nginx:stable
          ports:
            - containerPort: 80
  updateStrategy:
    type: RollingUpdate
`
  }, [selectedNamespace])

  const showNamespaceColumn = selectedNamespace === 'all'

  return (
    <div className="flex flex-col h-[calc(100vh-4rem)] gap-4">
      <div className="flex items-center justify-between shrink-0">
        <div>
          <h1 className="text-3xl font-bold text-white">{tr('daemonsets.title', 'Daemon Sets')}</h1>
          <p className="mt-2 text-slate-400">
            {tr('daemonsets.subtitle', 'Inspect scheduling health for DaemonSets across namespaces.')}
          </p>
        </div>
        <div className="flex items-center gap-2">
          {canCreate && (
            <button
              type="button"
              onClick={() => setCreateDialogOpen(true)}
              className="btn btn-primary flex items-center gap-2"
            >
              <Plus className="w-4 h-4" />
              {tr('daemonsets.create', 'Create DaemonSet')}
            </button>
          )}
          <button
            type="button"
            onClick={handleRefresh}
            disabled={isRefreshing}
            title={tr('daemonsets.refreshTitle', 'Force refresh')}
            className="btn btn-primary flex items-center gap-2 disabled:opacity-50 disabled:cursor-not-allowed"
          >
            <RefreshCw className={`w-4 h-4 ${isRefreshing ? 'animate-spin' : ''}`} />
            {tr('daemonsets.refresh', 'Refresh')}
          </button>
        </div>
      </div>

      <DaemonSetFilters
        searchQuery={searchQuery}
        setSearchQuery={setSearchQuery}
        selectedNamespace={selectedNamespace}
        setSelectedNamespace={setSelectedNamespace}
        namespaces={namespaces}
        searchPlaceholder={tr('daemonsets.searchPlaceholder', 'Search daemonsets by name...')}
        allNamespacesLabel={tr('daemonsets.allNamespaces', 'All namespaces')}
      />

      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3 shrink-0">
        <div className="rounded-lg border border-slate-700 bg-slate-900/50 px-4 py-3">
          <p className="text-[11px] sm:text-xs leading-4 whitespace-nowrap text-slate-400">{tr('daemonsets.stats.total', 'Total')}</p>
          <p className="text-lg text-white font-semibold mt-1">{summary.total}</p>
        </div>
        <div className="rounded-lg border border-emerald-700/40 bg-emerald-900/10 px-4 py-3">
          <p className="text-[11px] sm:text-xs leading-4 whitespace-nowrap text-emerald-300">{tr('daemonsets.stats.healthy', 'Healthy')}</p>
          <p className="text-lg text-white font-semibold mt-1">{summary.healthy}</p>
        </div>
        <div className="rounded-lg border border-amber-700/40 bg-amber-900/10 px-4 py-3">
          <p className="text-[11px] sm:text-xs leading-4 whitespace-nowrap text-amber-300">{tr('daemonsets.stats.degraded', 'Degraded')}</p>
          <p className="text-lg text-white font-semibold mt-1">{summary.degraded}</p>
        </div>
        <div className="rounded-lg border border-red-700/40 bg-red-900/10 px-4 py-3">
          <p className="text-[11px] sm:text-xs leading-4 whitespace-nowrap text-red-300">{tr('daemonsets.stats.unavailable', 'Unavailable')}</p>
          <p className="text-lg text-white font-semibold mt-1">{summary.unavailable}</p>
        </div>
      </div>

      {searchQuery && (
        <p className="text-sm text-slate-400 shrink-0">
          {tr('daemonsets.matchCount', '{{count}} daemonset{{suffix}} match.', {
            count: filteredDaemonSets.length,
            suffix: filteredDaemonSets.length === 1 ? '' : 's',
          })}
        </p>
      )}

      <div ref={tableContainerRef} className="card flex-1 min-h-0 flex flex-col">
        <div ref={tableBodyRef} className="overflow-x-auto flex-1 min-h-0">
          <table className="w-full text-sm min-w-[1320px] table-fixed">
            <thead ref={theadRef} className="text-slate-400">
              <tr>
                {showNamespaceColumn && (
                  <th className="text-left py-3 px-4 w-[140px]">{tr('daemonsets.table.namespace', 'Namespace')}</th>
                )}
                <th className="text-left py-3 px-4 w-[220px] cursor-pointer" onClick={() => handleSort('name')}>
                  <span className="inline-flex items-center gap-1">
                    {tr('daemonsets.table.name', 'Name')}{renderSortIcon('name')}
                  </span>
                </th>
                <th className="text-left py-3 px-4 w-[90px] cursor-pointer" onClick={() => handleSort('ready')}>
                  <span className="inline-flex items-center gap-1">
                    {tr('daemonsets.table.ready', 'Ready')}{renderSortIcon('ready')}
                  </span>
                </th>
                <th className="text-left py-3 px-4 w-[90px] cursor-pointer" onClick={() => handleSort('current')}>
                  <span className="inline-flex items-center gap-1">
                    {tr('daemonsets.table.current', 'Current')}{renderSortIcon('current')}
                  </span>
                </th>
                <th className="text-left py-3 px-4 w-[90px] cursor-pointer" onClick={() => handleSort('desired')}>
                  <span className="inline-flex items-center gap-1">
                    {tr('daemonsets.table.desired', 'Desired')}{renderSortIcon('desired')}
                  </span>
                </th>
                <th className="text-left py-3 px-4 w-[95px] cursor-pointer" onClick={() => handleSort('updated')}>
                  <span className="inline-flex items-center gap-1">
                    {tr('daemonsets.table.updated', 'Updated')}{renderSortIcon('updated')}
                  </span>
                </th>
                <th className="text-left py-3 px-4 w-[100px] cursor-pointer" onClick={() => handleSort('available')}>
                  <span className="inline-flex items-center gap-1">
                    {tr('daemonsets.table.available', 'Available')}{renderSortIcon('available')}
                  </span>
                </th>
                <th className="text-left py-3 px-4 w-[130px] cursor-pointer" onClick={() => handleSort('status')}>
                  <span className="inline-flex items-center gap-1">
                    {tr('daemonsets.table.status', 'Status')}{renderSortIcon('status')}
                  </span>
                </th>
                <th className="text-left py-3 px-4 w-[200px]">{tr('daemonsets.table.nodeSelector', 'Node Selector')}</th>
                <th className="text-left py-3 px-4 w-[230px] cursor-pointer" onClick={() => handleSort('images')}>
                  <span className="inline-flex items-center gap-1">
                    {tr('daemonsets.table.images', 'Images')}{renderSortIcon('images')}
                  </span>
                </th>
                <th className="text-left py-3 px-4 w-[90px] cursor-pointer" onClick={() => handleSort('age')}>
                  <span className="inline-flex items-center gap-1">
                    {tr('daemonsets.table.age', 'Age')}{renderSortIcon('age')}
                  </span>
                </th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-700">
              {pagedDaemonSets.map((daemonset, idx) => (
                <tr
                      ref={idx === 0 ? firstRowRef : undefined}
                  key={`${daemonset.namespace}/${daemonset.name}`}
                  className="text-slate-200 hover:bg-slate-800/60 cursor-pointer"
                  onClick={() => openDetail({
                    kind: 'DaemonSet',
                    name: daemonset.name,
                    namespace: daemonset.namespace,
                    rawJson: daemonSetToWorkloadRawJson(daemonset),
                  })}
                >
                  {showNamespaceColumn && <td className="py-3 px-4 text-xs font-mono">{daemonset.namespace}</td>}
                  <td className="py-3 px-4 font-medium text-white"><span className="block truncate">{daemonset.name}</span></td>
                  <td className="py-3 px-4 text-xs font-mono">{daemonset.ready}/{daemonset.desired}</td>
                  <td className="py-3 px-4 text-xs font-mono">{daemonset.current}</td>
                  <td className="py-3 px-4 text-xs font-mono">{daemonset.desired}</td>
                  <td className="py-3 px-4 text-xs font-mono">{daemonset.updated}</td>
                  <td className="py-3 px-4 text-xs font-mono">{daemonset.available}</td>
                  <td className="py-3 px-4">
                    <span className={`badge ${getDaemonSetStatusColor(daemonset.status)}`}>{daemonset.status}</span>
                  </td>
                  <td className="py-3 px-4 text-xs font-mono">
                    <span className="block truncate">
                      {Object.entries(daemonset.node_selector || {}).map(([k, v]) => `${k}=${v}`).join(', ') || '-'}
                    </span>
                  </td>
                  <td className="py-3 px-4 text-xs font-mono"><span className="block truncate">{(daemonset.images || []).join(', ') || '-'}</span></td>
                  <td className="py-3 px-4 text-xs font-mono">{formatAge(daemonset.created_at)}</td>
                </tr>
              ))}
              {isLoading && (
                <tr>
                  <td colSpan={showNamespaceColumn ? 12 : 11} className="py-10 px-4 text-center text-slate-400">
                    <div className="inline-flex items-center gap-2">
                      <Loader2 className="w-4 h-4 animate-spin" />
                      Loading...
                    </div>
                  </td>
                </tr>
              )}

              {sortedDaemonSets.length === 0 && !isLoading && (
                <tr>
                  <td colSpan={showNamespaceColumn ? 12 : 11} className="py-6 px-4 text-center text-slate-400">
                    {tr('daemonsets.noResults', 'No daemonsets found.')}
                  </td>
                </tr>
              )}
            </tbody>
              <AdaptiveTableFillerRows count={rowsPerPage - pagedDaemonSets.length} columnCount={10 + (showNamespaceColumn ? 1 : 0)} />
          </table>
        </div>
        {sortedDaemonSets.length > 0 && (
          <div className="flex items-center justify-between px-4 py-3 border-t border-slate-700 shrink-0">
            <div className="text-xs text-slate-400">
              {tr('common.paginationRange', 'Showing {{start}}-{{end}} of {{total}}', {
                start: (currentPage - 1) * rowsPerPage + 1,
                end: Math.min(currentPage * rowsPerPage, sortedDaemonSets.length),
                total: sortedDaemonSets.length,
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
              <span className="text-xs text-slate-300 min-w-[72px] text-center">
                {currentPage} / {totalPages}
              </span>
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
          title={tr('daemonsets.createTitle', 'Create DaemonSet from YAML')}
          initialYaml={createDaemonSetYamlTemplate}
          namespace={selectedNamespace !== 'all' ? selectedNamespace : undefined}
          onClose={() => setCreateDialogOpen(false)}
          onCreated={() => {
            queryClient.invalidateQueries({ queryKey: ['workloads', 'daemonsets'] })
          }}
        />
      )}
    </div>
  )
}
