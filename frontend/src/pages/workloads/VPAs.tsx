import { useEffect, useMemo, useRef, useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { useTranslation } from 'react-i18next'
import { api, type VPAInfo } from '@/services/api'
import { useKubeWatchList } from '@/services/useKubeWatchList'
import { useResourceDetail } from '@/components/ResourceDetailContext'
import ResourceYamlCreateDialog from '@/components/ResourceYamlCreateDialog'
import { useAdaptiveRowsPerPage } from '@/hooks/useAdaptiveRowsPerPage'
import { Loader2, CheckCircle, ChevronDown, ChevronUp, Plus, RefreshCw, Search } from 'lucide-react'

type SortKey = null | 'name' | 'target' | 'updateMode' | 'cpu' | 'memory' | 'provided' | 'age'

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

function normalizeWatchVPAObject(obj: any): VPAInfo {
  if (typeof obj?.name === 'string' && typeof obj?.namespace === 'string' && 'update_mode' in obj) {
    return obj as VPAInfo
  }
  const metadata = obj?.metadata ?? {}
  const spec = obj?.spec ?? {}
  const status = obj?.status ?? {}
  const targetRef = spec?.targetRef ?? {}
  const updatePolicy = spec?.updatePolicy ?? {}

  let cpuTarget = ''
  let memoryTarget = ''
  let provided = ''

  if (status?.conditions?.[0]?.status) {
    provided = status.conditions[0].status
  }
  const recs = status?.recommendation?.containerRecommendations
  if (Array.isArray(recs) && recs.length > 0) {
    cpuTarget = recs[0]?.target?.cpu ?? ''
    memoryTarget = recs[0]?.target?.memory ?? ''
  }

  return {
    name: metadata?.name ?? obj?.name ?? '',
    namespace: metadata?.namespace ?? obj?.namespace ?? '',
    target_ref: `${targetRef?.kind ?? ''}/${targetRef?.name ?? ''}`,
    target_ref_kind: targetRef?.kind ?? '',
    target_ref_name: targetRef?.name ?? '',
    update_mode: updatePolicy?.updateMode ?? '',
    cpu_target: cpuTarget,
    memory_target: memoryTarget,
    provided,
    labels: metadata?.labels ?? obj?.labels,
    created_at: metadata?.creationTimestamp ?? obj?.created_at ?? '',
  }
}

function applyVPAWatchEvent(
  prev: VPAInfo[] | undefined,
  event: { type?: string; object?: any },
): VPAInfo[] {
  const items = Array.isArray(prev) ? [...prev] : []
  const obj = event?.object
  if (!obj) return items

  const normalized = normalizeWatchVPAObject(obj)
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

function vpaToRawJson(vpa: VPAInfo): Record<string, unknown> {
  return {
    apiVersion: 'autoscaling.k8s.io/v1',
    kind: 'VerticalPodAutoscaler',
    metadata: {
      name: vpa.name,
      namespace: vpa.namespace,
      labels: vpa.labels || {},
      creationTimestamp: vpa.created_at,
    },
    spec: {
      targetRef: {
        kind: vpa.target_ref_kind,
        name: vpa.target_ref_name,
      },
      updatePolicy: {
        updateMode: vpa.update_mode,
      },
    },
  }
}

export default function VPAs() {
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

  const { data: vpas, isLoading } = useQuery({
    queryKey: ['workloads', 'vpas', selectedNamespace],
    queryFn: () => (
      selectedNamespace === 'all'
        ? api.getAllVPAs(false)
        : api.getVPAs(selectedNamespace, false)
    ),
  })

  const { data: me } = useQuery({
    queryKey: ['me'],
    queryFn: api.me,
    staleTime: 30000,
  })
  const canCreate = me?.role === 'admin' || me?.role === 'write'

  useKubeWatchList({
    enabled: true,
    queryKey: ['workloads', 'vpas', selectedNamespace],
    path: selectedNamespace === 'all'
      ? '/apis/autoscaling.k8s.io/v1/verticalpodautoscalers'
      : `/apis/autoscaling.k8s.io/v1/namespaces/${selectedNamespace}/verticalpodautoscalers`,
    query: 'watch=1',
    applyEvent: (prev, event) => applyVPAWatchEvent(prev as VPAInfo[] | undefined, event),
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

  const filteredVPAs = useMemo(() => {
    if (!Array.isArray(vpas)) return [] as VPAInfo[]
    if (!searchQuery.trim()) return vpas
    const q = searchQuery.toLowerCase()
    return vpas.filter((v) =>
      v.name.toLowerCase().includes(q) ||
      v.namespace.toLowerCase().includes(q) ||
      (v.target_ref || '').toLowerCase().includes(q),
    )
  }, [vpas, searchQuery])

  const summary = useMemo(() => {
    const total = filteredVPAs.length
    let provided = 0
    let notProvided = 0

    for (const v of filteredVPAs) {
      if (v.provided === 'True') provided += 1
      else notProvided += 1
    }

    return { total, provided, notProvided }
  }, [filteredVPAs])

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

  const sortedVPAs = useMemo(() => {
    if (!sortKey) return filteredVPAs
    const list = [...filteredVPAs]

    const getValue = (v: VPAInfo): string | number => {
      switch (sortKey) {
        case 'name': return v.name
        case 'target': return v.target_ref || ''
        case 'updateMode': return v.update_mode || ''
        case 'cpu': return v.cpu_target || ''
        case 'memory': return v.memory_target || ''
        case 'provided': return v.provided || ''
        case 'age': return parseAgeSeconds(v.created_at)
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
  }, [filteredVPAs, sortDir, sortKey])

  const rowsPerPage = useAdaptiveRowsPerPage(tableContainerRef, {
    recalculationKey: sortedVPAs.length,
  })
  const totalPages = Math.max(1, Math.ceil(sortedVPAs.length / rowsPerPage))

  useEffect(() => {
    setCurrentPage(1)
  }, [searchQuery, selectedNamespace])

  useEffect(() => {
    if (currentPage > totalPages) {
      setCurrentPage(totalPages)
    }
  }, [currentPage, totalPages])

  const pagedVPAs = useMemo(() => {
    const start = (currentPage - 1) * rowsPerPage
    return sortedVPAs.slice(start, start + rowsPerPage)
  }, [sortedVPAs, currentPage, rowsPerPage])

  const handleRefresh = async () => {
    if (isRefreshing) return
    setIsRefreshing(true)
    try {
      const data = selectedNamespace === 'all'
        ? await api.getAllVPAs(true)
        : await api.getVPAs(selectedNamespace, true)
      queryClient.removeQueries({ queryKey: ['workloads', 'vpas', selectedNamespace] })
      queryClient.setQueryData(['workloads', 'vpas', selectedNamespace], data)
    } catch (error) {
      console.error('VPAs refresh failed:', error)
    }
    setTimeout(() => setIsRefreshing(false), 500)
  }

  const createVPAYamlTemplate = useMemo(() => {
    const ns = selectedNamespace !== 'all' ? selectedNamespace : 'default'
    return `apiVersion: autoscaling.k8s.io/v1
kind: VerticalPodAutoscaler
metadata:
  name: sample-vpa
  namespace: ${ns}
spec:
  targetRef:
    apiVersion: apps/v1
    kind: Deployment
    name: sample-deployment
  updatePolicy:
    updateMode: "Auto"
  resourcePolicy:
    containerPolicies:
      - containerName: "*"
        controlledResources:
          - cpu
          - memory
`
  }, [selectedNamespace])

  const showNamespaceColumn = selectedNamespace === 'all'

  return (
    <div className="flex flex-col h-[calc(100vh-4rem)] gap-4">
      <div className="flex items-center justify-between shrink-0">
        <div>
          <h1 className="text-3xl font-bold text-white">{tr('vpas.title', 'Vertical Pod Autoscalers')}</h1>
          <p className="mt-2 text-slate-400">
            {tr('vpas.subtitle', 'Manage vertical pod autoscaling recommendations across namespaces.')}
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
              {tr('vpas.create', 'Create VPA')}
            </button>
          )}
          <button
            type="button"
            onClick={handleRefresh}
            disabled={isRefreshing}
            title={tr('vpas.refreshTitle', 'Force refresh')}
            className="btn btn-primary flex items-center gap-2 disabled:opacity-50 disabled:cursor-not-allowed"
          >
            <RefreshCw className={`w-4 h-4 ${isRefreshing ? 'animate-spin' : ''}`} />
            {tr('vpas.refresh', 'Refresh')}
          </button>
        </div>
      </div>

      <div className="grid grid-cols-1 xl:grid-cols-3 gap-3 shrink-0">
        <div className="xl:col-span-2">
          <div className="relative">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-5 h-5 text-slate-400" />
            <input
              type="text"
              placeholder={tr('vpas.searchPlaceholder', 'Search VPAs by name...')}
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              className="h-12 w-full pl-10 pr-4 bg-slate-700 border border-slate-600 rounded-lg text-sm text-white placeholder-slate-400 focus:outline-none focus:ring-2 focus:ring-primary-500 focus:border-transparent"
            />
          </div>
        </div>

        <div className="relative" ref={namespaceDropdownRef}>
          <button
            type="button"
            onClick={() => setIsNamespaceDropdownOpen(!isNamespaceDropdownOpen)}
            className="h-12 w-full px-3 bg-slate-700 border border-slate-600 rounded-lg text-sm text-white focus:outline-none focus:ring-2 focus:ring-primary-500 focus:border-transparent flex items-center justify-between gap-2"
          >
            <span className="text-sm font-medium">
              {selectedNamespace === 'all' ? tr('vpas.allNamespaces', 'All namespaces') : selectedNamespace}
            </span>
            <ChevronDown
              className={`w-4 h-4 text-slate-400 transition-transform ${isNamespaceDropdownOpen ? 'rotate-180' : ''}`}
            />
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
                <span className={selectedNamespace === 'all' ? 'font-medium' : ''}>
                  {tr('vpas.allNamespaces', 'All namespaces')}
                </span>
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

      <div className="grid grid-cols-2 lg:grid-cols-3 gap-3 shrink-0">
        <div className="rounded-lg border border-slate-700 bg-slate-900/50 px-4 py-3">
          <p className="text-[11px] sm:text-xs leading-4 whitespace-nowrap text-slate-400">{tr('vpas.stats.total', 'Total')}</p>
          <p className="text-lg text-white font-semibold mt-1">{summary.total}</p>
        </div>
        <div className="rounded-lg border border-emerald-700/40 bg-emerald-900/10 px-4 py-3">
          <p className="text-[11px] sm:text-xs leading-4 whitespace-nowrap text-emerald-300">{tr('vpas.stats.provided', 'Provided')}</p>
          <p className="text-lg text-white font-semibold mt-1">{summary.provided}</p>
        </div>
        <div className="rounded-lg border border-amber-700/40 bg-amber-900/10 px-4 py-3">
          <p className="text-[11px] sm:text-xs leading-4 whitespace-nowrap text-amber-300">{tr('vpas.stats.notProvided', 'Not Provided')}</p>
          <p className="text-lg text-white font-semibold mt-1">{summary.notProvided}</p>
        </div>
      </div>

      {searchQuery && (
        <p className="text-sm text-slate-400 shrink-0">
          {tr('vpas.matchCount', '{{count}} VPA{{suffix}} match.', {
            count: filteredVPAs.length,
            suffix: filteredVPAs.length === 1 ? '' : 's',
          })}
        </p>
      )}

      <div ref={tableContainerRef} className="card flex-1 min-h-0 flex flex-col">
        <div className="overflow-x-auto flex-1 min-h-0">
          <table className="w-full text-sm min-w-[1040px] table-fixed">
            <thead className="text-slate-400">
              <tr>
                {showNamespaceColumn && (
                  <th className="text-left py-3 px-4 w-[150px]">{tr('vpas.table.namespace', 'Namespace')}</th>
                )}
                <th className="text-left py-3 px-4 w-[220px] cursor-pointer" onClick={() => handleSort('name')}>
                  <span className="inline-flex items-center gap-1">
                    {tr('vpas.table.name', 'Name')}{renderSortIcon('name')}
                  </span>
                </th>
                <th className="text-left py-3 px-4 w-[200px] cursor-pointer" onClick={() => handleSort('target')}>
                  <span className="inline-flex items-center gap-1">
                    {tr('vpas.table.reference', 'Reference')}{renderSortIcon('target')}
                  </span>
                </th>
                <th className="text-left py-3 px-4 w-[120px] cursor-pointer" onClick={() => handleSort('updateMode')}>
                  <span className="inline-flex items-center gap-1">
                    {tr('vpas.table.mode', 'Mode')}{renderSortIcon('updateMode')}
                  </span>
                </th>
                <th className="text-left py-3 px-4 w-[120px] cursor-pointer" onClick={() => handleSort('cpu')}>
                  <span className="inline-flex items-center gap-1">
                    {tr('vpas.table.cpu', 'CPU')}{renderSortIcon('cpu')}
                  </span>
                </th>
                <th className="text-left py-3 px-4 w-[120px] cursor-pointer" onClick={() => handleSort('memory')}>
                  <span className="inline-flex items-center gap-1">
                    {tr('vpas.table.memory', 'Memory')}{renderSortIcon('memory')}
                  </span>
                </th>
                <th className="text-left py-3 px-4 w-[130px] cursor-pointer" onClick={() => handleSort('provided')}>
                  <span className="inline-flex items-center gap-1">
                    {tr('vpas.table.provided', 'Provided')}{renderSortIcon('provided')}
                  </span>
                </th>
                <th className="text-left py-3 px-4 w-[130px] cursor-pointer" onClick={() => handleSort('age')}>
                  <span className="inline-flex items-center gap-1">
                    {tr('vpas.table.age', 'Age')}{renderSortIcon('age')}
                  </span>
                </th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-700">
              {pagedVPAs.map((v) => (
                <tr
                  key={`${v.namespace}/${v.name}`}
                  className="text-slate-200 hover:bg-slate-800/60 cursor-pointer"
                  onClick={() => openDetail({
                    kind: 'VerticalPodAutoscaler',
                    name: v.name,
                    namespace: v.namespace,
                    rawJson: vpaToRawJson(v),
                  })}
                >
                  {showNamespaceColumn && <td className="py-3 px-4 text-xs font-mono">{v.namespace}</td>}
                  <td className="py-3 px-4 font-medium text-white"><span className="block truncate">{v.name}</span></td>
                  <td className="py-3 px-4 text-xs font-mono"><span className="block truncate">{v.target_ref || '-'}</span></td>
                  <td className="py-3 px-4 text-xs">{v.update_mode || '-'}</td>
                  <td className="py-3 px-4 text-xs font-mono">{v.cpu_target || '-'}</td>
                  <td className="py-3 px-4 text-xs font-mono">{v.memory_target || '-'}</td>
                  <td className="py-3 px-4">
                    <span className={`badge ${v.provided === 'True' ? 'badge-success' : 'badge-warning'}`}>
                      {v.provided || '-'}
                    </span>
                  </td>
                  <td className="py-3 px-4 text-xs font-mono">{formatAge(v.created_at)}</td>
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

              {sortedVPAs.length === 0 && !isLoading && (
                <tr>
                  <td colSpan={showNamespaceColumn ? 9 : 8} className="py-6 px-4 text-center text-slate-400">
                    {tr('vpas.noResults', 'No VPAs found.')}
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
        {sortedVPAs.length > 0 && (
          <div className="flex items-center justify-between px-4 py-3 border-t border-slate-700 shrink-0">
            <div className="text-xs text-slate-400">
              {tr('common.paginationRange', 'Showing {{start}}-{{end}} of {{total}}', {
                start: (currentPage - 1) * rowsPerPage + 1,
                end: Math.min(currentPage * rowsPerPage, sortedVPAs.length),
                total: sortedVPAs.length,
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
          title={tr('vpas.createTitle', 'Create VPA from YAML')}
          initialYaml={createVPAYamlTemplate}
          namespace={selectedNamespace !== 'all' ? selectedNamespace : undefined}
          onClose={() => setCreateDialogOpen(false)}
          onCreated={() => {
            queryClient.invalidateQueries({ queryKey: ['workloads', 'vpas'] })
          }}
        />
      )}
    </div>
  )
}
