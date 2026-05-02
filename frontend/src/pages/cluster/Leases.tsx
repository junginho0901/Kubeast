import { useEffect, useMemo, useRef, useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { useTranslation } from 'react-i18next'
import { api, type LeaseInfo } from '@/services/api'
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

type SortKey = null | 'name' | 'namespace' | 'holder' | 'duration' | 'age'

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

function normalizeWatchLeaseObject(obj: any): LeaseInfo {
  if (typeof obj?.name === 'string' && typeof obj?.namespace === 'string' && typeof obj?.created_at === 'string') {
    return obj as LeaseInfo
  }
  const metadata = obj?.metadata ?? {}
  const spec = obj?.spec ?? {}

  return {
    name: metadata?.name ?? obj?.name ?? '',
    namespace: metadata?.namespace ?? obj?.namespace ?? '',
    holder_identity: spec?.holderIdentity ?? obj?.holder_identity,
    lease_duration_seconds: spec?.leaseDurationSeconds ?? obj?.lease_duration_seconds,
    lease_transitions: spec?.leaseTransitions ?? obj?.lease_transitions,
    renew_time: spec?.renewTime ?? obj?.renew_time,
    acquire_time: spec?.acquireTime ?? obj?.acquire_time,
    labels: metadata?.labels ?? obj?.labels ?? {},
    created_at: metadata?.creationTimestamp ?? obj?.created_at ?? '',
  }
}

function applyLeaseWatchEvent(
  prev: LeaseInfo[] | undefined,
  event: { type?: string; object?: any },
): LeaseInfo[] {
  const items = Array.isArray(prev) ? [...prev] : []
  const obj = event?.object
  if (!obj) return items

  const normalized = normalizeWatchLeaseObject(obj)
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

function leaseToRawJson(lease: LeaseInfo): Record<string, unknown> {
  return {
    apiVersion: 'coordination.k8s.io/v1',
    kind: 'Lease',
    metadata: {
      name: lease.name,
      namespace: lease.namespace,
      labels: lease.labels || {},
      creationTimestamp: lease.created_at,
    },
    spec: {
      holderIdentity: lease.holder_identity,
      leaseDurationSeconds: lease.lease_duration_seconds,
      leaseTransitions: lease.lease_transitions,
      renewTime: lease.renew_time,
      acquireTime: lease.acquire_time,
    },
  }
}

export default function Leases() {
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

  const { data: namespaces } = useQuery({
    queryKey: ['namespaces'],
    queryFn: () => api.getNamespaces(),
    staleTime: 30000,
  })

  const { data: leases, isLoading } = useQuery({
    queryKey: ['cluster', 'leases', selectedNamespace],
    queryFn: () => (
      selectedNamespace === 'all'
        ? api.getAllLeases(false)
        : api.getLeases(selectedNamespace, false)
    ),
  })
  const { has } = usePermission()
  const canCreate = has('resource.lease.create')

  useKubeWatchList({
    enabled: true,
    queryKey: ['cluster', 'leases', selectedNamespace],
    path: selectedNamespace === 'all'
      ? '/apis/coordination.k8s.io/v1/leases'
      : `/apis/coordination.k8s.io/v1/namespaces/${selectedNamespace}/leases`,
    query: 'watch=1',
    applyEvent: (prev, event) => applyLeaseWatchEvent(prev as LeaseInfo[] | undefined, event),
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

  const filteredLeases = useMemo(() => {
    if (!Array.isArray(leases)) return [] as LeaseInfo[]
    if (!searchQuery.trim()) return leases
    const q = searchQuery.toLowerCase()
    return leases.filter((l) =>
      l.name.toLowerCase().includes(q) ||
      l.namespace.toLowerCase().includes(q) ||
      (l.holder_identity || '').toLowerCase().includes(q),
    )
  }, [leases, searchQuery])

  const summary = useMemo(() => {
    const total = filteredLeases.length
    let withHolder = 0
    for (const l of filteredLeases) {
      if (l.holder_identity) withHolder += 1
    }
    return { total, withHolder, withoutHolder: total - withHolder }
  }, [filteredLeases])

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

  const sortedLeases = useMemo(() => {
    if (!sortKey) return filteredLeases
    const list = [...filteredLeases]

    const getValue = (l: LeaseInfo): string | number => {
      switch (sortKey) {
        case 'name': return l.name
        case 'namespace': return l.namespace
        case 'holder': return l.holder_identity || ''
        case 'duration': return l.lease_duration_seconds ?? 0
        case 'age': return parseAgeSeconds(l.created_at)
        default: return ''
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
  }, [filteredLeases, sortDir, sortKey])

  const { containerRef: tableContainerRef, bodyRef: tableBodyRef, theadRef, firstRowRef, rowsPerPage } = useAdaptiveTable({
    recalculationKey: sortedLeases.length,
  })
  const totalPages = Math.max(1, Math.ceil(sortedLeases.length / rowsPerPage))

  useEffect(() => {
    setCurrentPage(1)
  }, [searchQuery, selectedNamespace])

  useEffect(() => {
    if (currentPage > totalPages) {
      setCurrentPage(totalPages)
    }
  }, [currentPage, totalPages])

  const pagedLeases = useMemo(() => {
    const start = (currentPage - 1) * rowsPerPage
    return sortedLeases.slice(start, start + rowsPerPage)
  }, [sortedLeases, currentPage, rowsPerPage])

  // 플로팅 AI 위젯용 스냅샷
  const aiSnapshot = useMemo(() => {
    if (!Array.isArray(leases) || leases.length === 0) return null
    const nsLabel = selectedNamespace === 'all' ? '전체 네임스페이스' : selectedNamespace
    const total = leases.length
    return {
      source: 'base' as const,
      summary: `${nsLabel} Lease ${total}개`,
      data: {
        filters: { namespace: selectedNamespace, search: searchQuery || undefined },
        stats: { total },
        ...summarizeList(pagedLeases as unknown as Record<string, unknown>[], {
          total: sortedLeases.length,
          currentPage,
          pageSize: rowsPerPage,
          topN: rowsPerPage,
          pickFields: ['name', 'namespace'],
          linkBuilder: (l) => {
            const li = l as unknown as LeaseInfo
            return buildResourceLink('Lease', li.namespace, li.name)
          },
        }),
      },
    }
  }, [leases, pagedLeases, sortedLeases.length, currentPage, rowsPerPage, selectedNamespace, searchQuery])

  useAIContext(aiSnapshot, [aiSnapshot])

  const handleRefresh = async () => {
    if (isRefreshing) return
    setIsRefreshing(true)
    try {
      const data = selectedNamespace === 'all'
        ? await api.getAllLeases(true)
        : await api.getLeases(selectedNamespace, true)
      queryClient.removeQueries({ queryKey: ['cluster', 'leases', selectedNamespace] })
      queryClient.setQueryData(['cluster', 'leases', selectedNamespace], data)
    } catch (error) {
      console.error('Leases refresh failed:', error)
    }
    setTimeout(() => setIsRefreshing(false), 500)
  }

  const createLeaseYamlTemplate = useMemo(() => {
    const ns = selectedNamespace !== 'all' ? selectedNamespace : 'default'
    return `apiVersion: coordination.k8s.io/v1
kind: Lease
metadata:
  name: sample-lease
  namespace: ${ns}
spec:
  holderIdentity: "sample-holder"
  leaseDurationSeconds: 40
`
  }, [selectedNamespace])

  const showNamespaceColumn = selectedNamespace === 'all'

  return (
    <div className="flex flex-col h-[calc(100vh-4rem)] gap-4">
      <div className="flex items-center justify-between shrink-0">
        <div>
          <h1 className="text-3xl font-bold text-white">{tr('leases.title', 'Leases')}</h1>
          <p className="mt-2 text-slate-400">
            {tr('leases.subtitle', 'Manage coordination leases across namespaces.')}
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
              {tr('leases.create', 'Create Lease')}
            </button>
          )}
          <button
            type="button"
            onClick={handleRefresh}
            disabled={isRefreshing}
            title={tr('leases.refreshTitle', 'Force refresh')}
            className="btn btn-primary flex items-center gap-2 disabled:opacity-50 disabled:cursor-not-allowed"
          >
            <RefreshCw className={`w-4 h-4 ${isRefreshing ? 'animate-spin' : ''}`} />
            {tr('leases.refresh', 'Refresh')}
          </button>
        </div>
      </div>

      <div className="grid grid-cols-1 xl:grid-cols-3 gap-3 shrink-0">
        <div className="xl:col-span-2">
          <div className="relative">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-5 h-5 text-slate-400" />
            <input
              type="text"
              placeholder={tr('leases.searchPlaceholder', 'Search leases by name or holder...')}
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              className="h-12 w-full pl-10 pr-4 bg-slate-700 border border-slate-600 rounded-lg text-sm text-white placeholder-slate-400 focus:outline-none focus:ring-2 focus:ring-primary-500 focus:border-transparent"
            />
          </div>
        </div>
        <div ref={namespaceDropdownRef} className="relative">
          <button
            type="button"
            onClick={() => setIsNamespaceDropdownOpen((prev) => !prev)}
            className="h-12 w-full flex items-center justify-between px-4 bg-slate-700 border border-slate-600 rounded-lg text-sm text-white"
          >
            <span className="truncate">
              {selectedNamespace === 'all'
                ? tr('leases.allNamespaces', 'All Namespaces')
                : selectedNamespace}
            </span>
            <ChevronDown className="w-4 h-4 text-slate-400 shrink-0" />
          </button>
          {isNamespaceDropdownOpen && (
            <div className="absolute z-20 mt-1 w-full max-h-64 overflow-y-auto rounded-lg bg-slate-800 border border-slate-600 shadow-xl">
              <button
                type="button"
                className={`w-full text-left px-4 py-2.5 text-sm hover:bg-slate-700 ${
                  selectedNamespace === 'all' ? 'text-primary-400 font-medium' : 'text-white'
                }`}
                onClick={() => { setSelectedNamespace('all'); setIsNamespaceDropdownOpen(false) }}
              >
                {tr('leases.allNamespaces', 'All Namespaces')}
              </button>
              {(namespaces || []).map((ns: any) => (
                <button
                  key={ns.name}
                  type="button"
                  className={`w-full text-left px-4 py-2.5 text-sm hover:bg-slate-700 ${
                    selectedNamespace === ns.name ? 'text-primary-400 font-medium' : 'text-white'
                  }`}
                  onClick={() => { setSelectedNamespace(ns.name); setIsNamespaceDropdownOpen(false) }}
                >
                  {ns.name}
                </button>
              ))}
            </div>
          )}
        </div>
      </div>

      <div className="grid grid-cols-2 lg:grid-cols-3 gap-3 shrink-0">
        <div className="rounded-lg border border-slate-700 bg-slate-900/50 px-4 py-3">
          <p className="text-[11px] sm:text-xs leading-4 whitespace-nowrap text-slate-400">{tr('leases.stats.total', 'Total')}</p>
          <p className="text-lg text-white font-semibold mt-1">{summary.total}</p>
        </div>
        <div className="rounded-lg border border-emerald-700/40 bg-emerald-900/10 px-4 py-3">
          <p className="text-[11px] sm:text-xs leading-4 whitespace-nowrap text-emerald-300">{tr('leases.stats.withHolder', 'With Holder')}</p>
          <p className="text-lg text-white font-semibold mt-1">{summary.withHolder}</p>
        </div>
        <div className="rounded-lg border border-slate-700 bg-slate-900/50 px-4 py-3">
          <p className="text-[11px] sm:text-xs leading-4 whitespace-nowrap text-slate-400">{tr('leases.stats.withoutHolder', 'Without Holder')}</p>
          <p className="text-lg text-white font-semibold mt-1">{summary.withoutHolder}</p>
        </div>
      </div>

      {searchQuery && (
        <p className="text-sm text-slate-400 shrink-0">
          {tr('leases.matchCount', '{{count}} lease{{suffix}} match.', {
            count: filteredLeases.length,
            suffix: filteredLeases.length === 1 ? '' : 's',
          })}
        </p>
      )}

      <div ref={tableContainerRef} className="card flex-1 min-h-0 flex flex-col">
        <div ref={tableBodyRef} className="overflow-x-auto flex-1 min-h-0">
          <table className="w-full text-sm min-w-[700px] table-fixed">
            <thead ref={theadRef} className="text-slate-400">
              <tr>
                <th className="text-left py-3 px-4 w-[250px] cursor-pointer" onClick={() => handleSort('name')}>
                  <span className="inline-flex items-center gap-1">
                    {tr('leases.table.name', 'Name')}{renderSortIcon('name')}
                  </span>
                </th>
                {showNamespaceColumn && (
                  <th className="text-left py-3 px-4 w-[150px] cursor-pointer" onClick={() => handleSort('namespace')}>
                    <span className="inline-flex items-center gap-1">
                      {tr('leases.table.namespace', 'Namespace')}{renderSortIcon('namespace')}
                    </span>
                  </th>
                )}
                <th className="text-left py-3 px-4 w-[200px] cursor-pointer" onClick={() => handleSort('holder')}>
                  <span className="inline-flex items-center gap-1">
                    {tr('leases.table.holder', 'Holder')}{renderSortIcon('holder')}
                  </span>
                </th>
                <th className="text-left py-3 px-4 w-[120px] cursor-pointer" onClick={() => handleSort('duration')}>
                  <span className="inline-flex items-center gap-1">
                    {tr('leases.table.duration', 'Duration (s)')}{renderSortIcon('duration')}
                  </span>
                </th>
                <th className="text-left py-3 px-4 w-[100px] cursor-pointer" onClick={() => handleSort('age')}>
                  <span className="inline-flex items-center gap-1">
                    {tr('leases.table.age', 'Age')}{renderSortIcon('age')}
                  </span>
                </th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-700">
              {pagedLeases.map((l, idx) => (
                <tr
                      ref={idx === 0 ? firstRowRef : undefined}
                  key={`${l.namespace}/${l.name}`}
                  className="text-slate-200 hover:bg-slate-800/60 cursor-pointer"
                  onClick={() => openDetail({
                    kind: 'Lease',
                    name: l.name,
                    namespace: l.namespace,
                    rawJson: leaseToRawJson(l),
                  })}
                >
                  <td className="py-3 px-4 font-medium text-white"><span className="block truncate">{l.name}</span></td>
                  {showNamespaceColumn && (
                    <td className="py-3 px-4 text-xs font-mono text-slate-400">{l.namespace}</td>
                  )}
                  <td className="py-3 px-4 text-xs font-mono"><span className="block truncate">{l.holder_identity || '-'}</span></td>
                  <td className="py-3 px-4 text-xs font-mono">{l.lease_duration_seconds ?? '-'}</td>
                  <td className="py-3 px-4 text-xs font-mono">{formatAge(l.created_at)}</td>
                </tr>
              ))}
              {isLoading && (
                <tr>
                  <td colSpan={showNamespaceColumn ? 5 : 4} className="py-10 px-4 text-center text-slate-400">
                    <div className="inline-flex items-center gap-2">
                      <Loader2 className="w-4 h-4 animate-spin" />
                      Loading...
                    </div>
                  </td>
                </tr>
              )}

              {sortedLeases.length === 0 && !isLoading && (
                <tr>
                  <td colSpan={showNamespaceColumn ? 5 : 4} className="py-6 px-4 text-center text-slate-400">
                    {tr('leases.noResults', 'No leases found.')}
                  </td>
                </tr>
              )}
            </tbody>
              <AdaptiveTableFillerRows count={rowsPerPage - pagedLeases.length} columnCount={4 + (showNamespaceColumn ? 1 : 0)} />
          </table>
        </div>
        {sortedLeases.length > 0 && (
          <div className="flex items-center justify-between px-4 py-3 border-t border-slate-700 shrink-0">
            <div className="text-xs text-slate-400">
              {tr('common.paginationRange', 'Showing {{start}}-{{end}} of {{total}}', {
                start: (currentPage - 1) * rowsPerPage + 1,
                end: Math.min(currentPage * rowsPerPage, sortedLeases.length),
                total: sortedLeases.length,
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
          title={tr('leases.createTitle', 'Create Lease from YAML')}
          initialYaml={createLeaseYamlTemplate}
          onClose={() => setCreateDialogOpen(false)}
          onCreated={() => {
            queryClient.invalidateQueries({ queryKey: ['cluster', 'leases'] })
          }}
        />
      )}
    </div>
  )
}
