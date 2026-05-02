import { useEffect, useMemo, useRef, useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { useTranslation } from 'react-i18next'
import { api, type PDBInfo } from '@/services/api'
import { useKubeWatchList } from '@/services/useKubeWatchList'
import { useResourceDetail } from '@/components/ResourceDetailContext'
import ResourceYamlCreateDialog from '@/components/ResourceYamlCreateDialog'
import { useAdaptiveTable } from '@/hooks/useAdaptiveTable'
import { AdaptiveTableFillerRows } from '@/components/AdaptiveTableFillerRows'
import { useAIContext } from '@/hooks/useAIContext'
import { usePermission } from '@/hooks/usePermission'
import { summarizeList } from '@/utils/aiContext/summarizeList'
import { buildResourceLink } from '@/utils/resourceLink'
import { Loader2, CheckCircle, ChevronDown, ChevronUp, Plus, RefreshCw, Search } from 'lucide-react'

type SortKey = null | 'name' | 'minAvailable' | 'maxUnavailable' | 'allowedDisruptions' | 'currentHealthy' | 'desiredHealthy' | 'age'

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

function normalizeWatchPDBObject(obj: any): PDBInfo {
  if (typeof obj?.name === 'string' && typeof obj?.namespace === 'string' && typeof obj?.current_healthy === 'number') {
    return obj as PDBInfo
  }
  const metadata = obj?.metadata ?? {}
  const spec = obj?.spec ?? {}
  const status = obj?.status ?? {}

  return {
    name: metadata?.name ?? obj?.name ?? '',
    namespace: metadata?.namespace ?? obj?.namespace ?? '',
    min_available: spec?.minAvailable != null ? String(spec.minAvailable) : null,
    max_unavailable: spec?.maxUnavailable != null ? String(spec.maxUnavailable) : null,
    current_healthy: status?.currentHealthy ?? 0,
    desired_healthy: status?.desiredHealthy ?? 0,
    disruptions_allowed: status?.disruptionsAllowed ?? 0,
    expected_pods: status?.expectedPods ?? 0,
    selector: spec?.selector?.matchLabels ?? {},
    created_at: metadata?.creationTimestamp ?? obj?.created_at ?? '',
  }
}

function applyPDBWatchEvent(
  prev: PDBInfo[] | undefined,
  event: { type?: string; object?: any },
): PDBInfo[] {
  const items = Array.isArray(prev) ? [...prev] : []
  const obj = event?.object
  if (!obj) return items

  const normalized = normalizeWatchPDBObject(obj)
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

function pdbToRawJson(pdb: PDBInfo): Record<string, unknown> {
  const spec: Record<string, unknown> = {}
  if (pdb.min_available != null) spec.minAvailable = pdb.min_available
  if (pdb.max_unavailable != null) spec.maxUnavailable = pdb.max_unavailable
  if (pdb.selector && Object.keys(pdb.selector).length > 0) {
    spec.selector = { matchLabels: pdb.selector }
  }

  return {
    apiVersion: 'policy/v1',
    kind: 'PodDisruptionBudget',
    metadata: {
      name: pdb.name,
      namespace: pdb.namespace,
      creationTimestamp: pdb.created_at,
    },
    spec,
    status: {
      currentHealthy: pdb.current_healthy,
      desiredHealthy: pdb.desired_healthy,
      disruptionsAllowed: pdb.disruptions_allowed,
      expectedPods: pdb.expected_pods,
    },
  }
}

export default function PDBs() {
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

  const { data: pdbs, isLoading } = useQuery({
    queryKey: ['workloads', 'pdbs', selectedNamespace],
    queryFn: () => (
      selectedNamespace === 'all'
        ? api.getAllPDBs(false)
        : api.getPDBs(selectedNamespace, false)
    ),
  })
  const { has } = usePermission()
  const canCreate = has('resource.pdb.create')

  useKubeWatchList({
    enabled: true,
    queryKey: ['workloads', 'pdbs', selectedNamespace],
    path: selectedNamespace === 'all'
      ? '/apis/policy/v1/poddisruptionbudgets'
      : `/apis/policy/v1/namespaces/${selectedNamespace}/poddisruptionbudgets`,
    query: 'watch=1',
    applyEvent: (prev, event) => applyPDBWatchEvent(prev as PDBInfo[] | undefined, event),
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

  const filteredPDBs = useMemo(() => {
    if (!Array.isArray(pdbs)) return [] as PDBInfo[]
    if (!searchQuery.trim()) return pdbs
    const q = searchQuery.toLowerCase()
    return pdbs.filter((p) =>
      p.name.toLowerCase().includes(q) ||
      p.namespace.toLowerCase().includes(q),
    )
  }, [pdbs, searchQuery])

  const summary = useMemo(() => {
    const total = filteredPDBs.length
    let healthy = 0
    let disrupted = 0

    for (const p of filteredPDBs) {
      if (p.disruptions_allowed > 0 || p.current_healthy >= p.desired_healthy) healthy += 1
      else disrupted += 1
    }

    return { total, healthy, disrupted }
  }, [filteredPDBs])

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

  const sortedPDBs = useMemo(() => {
    if (!sortKey) return filteredPDBs
    const list = [...filteredPDBs]

    const getValue = (p: PDBInfo): string | number => {
      switch (sortKey) {
        case 'name': return p.name
        case 'minAvailable': return p.min_available ?? ''
        case 'maxUnavailable': return p.max_unavailable ?? ''
        case 'allowedDisruptions': return p.disruptions_allowed
        case 'currentHealthy': return p.current_healthy
        case 'desiredHealthy': return p.desired_healthy
        case 'age': return parseAgeSeconds(p.created_at)
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
  }, [filteredPDBs, sortDir, sortKey])

  const { containerRef: tableContainerRef, bodyRef: tableBodyRef, theadRef, firstRowRef, rowsPerPage } = useAdaptiveTable({
    recalculationKey: sortedPDBs.length,
  })
  const totalPages = Math.max(1, Math.ceil(sortedPDBs.length / rowsPerPage))

  useEffect(() => {
    setCurrentPage(1)
  }, [searchQuery, selectedNamespace])

  useEffect(() => {
    if (currentPage > totalPages) {
      setCurrentPage(totalPages)
    }
  }, [currentPage, totalPages])

  const pagedPDBs = useMemo(() => {
    const start = (currentPage - 1) * rowsPerPage
    return sortedPDBs.slice(start, start + rowsPerPage)
  }, [sortedPDBs, currentPage, rowsPerPage])

  // 플로팅 AI 위젯용 스냅샷
  const aiSnapshot = useMemo(() => {
    if (!Array.isArray(pdbs) || pdbs.length === 0) return null
    const nsLabel = selectedNamespace === 'all' ? '전체 네임스페이스' : selectedNamespace
    const total = pdbs.length
    const unhealthy = pdbs.filter((p) => p.current_healthy < p.desired_healthy).length
    const prefix = unhealthy > 0 ? '⚠️ ' : ''
    return {
      source: 'base' as const,
      summary: `${prefix}${nsLabel} PDB ${total}개${unhealthy ? ` (미달 ${unhealthy})` : ''}`,
      data: {
        filters: { namespace: selectedNamespace, search: searchQuery || undefined },
        stats: { total, unhealthy },
        ...summarizeList(pagedPDBs as unknown as Record<string, unknown>[], {
          total: sortedPDBs.length,
          currentPage,
          pageSize: rowsPerPage,
          topN: rowsPerPage,
          pickFields: ['name', 'namespace', 'min_available', 'max_unavailable', 'current_healthy', 'desired_healthy', 'disruptions_allowed', 'expected_pods'],
          filterProblematic: (p) => {
            const pdb = p as unknown as PDBInfo
            return pdb.current_healthy < pdb.desired_healthy
          },
          linkBuilder: (p) => {
            const pdb = p as unknown as PDBInfo
            return buildResourceLink('PodDisruptionBudget', pdb.namespace, pdb.name)
          },
        }),
      },
    }
  }, [pdbs, pagedPDBs, sortedPDBs.length, currentPage, rowsPerPage, selectedNamespace, searchQuery])

  useAIContext(aiSnapshot, [aiSnapshot])

  const handleRefresh = async () => {
    if (isRefreshing) return
    setIsRefreshing(true)
    try {
      const data = selectedNamespace === 'all'
        ? await api.getAllPDBs(true)
        : await api.getPDBs(selectedNamespace, true)
      queryClient.removeQueries({ queryKey: ['workloads', 'pdbs', selectedNamespace] })
      queryClient.setQueryData(['workloads', 'pdbs', selectedNamespace], data)
    } catch (error) {
      console.error('PDBs refresh failed:', error)
    }
    setTimeout(() => setIsRefreshing(false), 500)
  }

  const createPDBYamlTemplate = useMemo(() => {
    const ns = selectedNamespace !== 'all' ? selectedNamespace : 'default'
    return `apiVersion: policy/v1
kind: PodDisruptionBudget
metadata:
  name: sample-pdb
  namespace: ${ns}
spec:
  minAvailable: 1
  selector:
    matchLabels:
      app: sample
`
  }, [selectedNamespace])

  const showNamespaceColumn = selectedNamespace === 'all'

  return (
    <div className="flex flex-col h-[calc(100vh-4rem)] gap-4">
      <div className="flex items-center justify-between shrink-0">
        <div>
          <h1 className="text-3xl font-bold text-white">{tr('pdbs.title', 'Pod Disruption Budgets')}</h1>
          <p className="mt-2 text-slate-400">
            {tr('pdbs.subtitle', 'Manage pod disruption budgets across namespaces.')}
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
              {tr('pdbs.create', 'Create PDB')}
            </button>
          )}
          <button
            type="button"
            onClick={handleRefresh}
            disabled={isRefreshing}
            title={tr('pdbs.refreshTitle', 'Force refresh')}
            className="btn btn-primary flex items-center gap-2 disabled:opacity-50 disabled:cursor-not-allowed"
          >
            <RefreshCw className={`w-4 h-4 ${isRefreshing ? 'animate-spin' : ''}`} />
            {tr('pdbs.refresh', 'Refresh')}
          </button>
        </div>
      </div>

      <div className="grid grid-cols-1 xl:grid-cols-3 gap-3 shrink-0">
        <div className="xl:col-span-2">
          <div className="relative">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-5 h-5 text-slate-400" />
            <input
              type="text"
              placeholder={tr('pdbs.searchPlaceholder', 'Search PDBs by name...')}
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
              {selectedNamespace === 'all' ? tr('pdbs.allNamespaces', 'All namespaces') : selectedNamespace}
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
                  {tr('pdbs.allNamespaces', 'All namespaces')}
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
          <p className="text-[11px] sm:text-xs leading-4 whitespace-nowrap text-slate-400">{tr('pdbs.stats.total', 'Total')}</p>
          <p className="text-lg text-white font-semibold mt-1">{summary.total}</p>
        </div>
        <div className="rounded-lg border border-emerald-700/40 bg-emerald-900/10 px-4 py-3">
          <p className="text-[11px] sm:text-xs leading-4 whitespace-nowrap text-emerald-300">{tr('pdbs.stats.healthy', 'Healthy')}</p>
          <p className="text-lg text-white font-semibold mt-1">{summary.healthy}</p>
        </div>
        <div className="rounded-lg border border-red-700/40 bg-red-900/10 px-4 py-3">
          <p className="text-[11px] sm:text-xs leading-4 whitespace-nowrap text-red-300">{tr('pdbs.stats.disrupted', 'Disrupted')}</p>
          <p className="text-lg text-white font-semibold mt-1">{summary.disrupted}</p>
        </div>
      </div>

      {searchQuery && (
        <p className="text-sm text-slate-400 shrink-0">
          {tr('pdbs.matchCount', '{{count}} PDB{{suffix}} match.', {
            count: filteredPDBs.length,
            suffix: filteredPDBs.length === 1 ? '' : 's',
          })}
        </p>
      )}

      <div ref={tableContainerRef} className="card flex-1 min-h-0 flex flex-col">
        <div ref={tableBodyRef} className="overflow-x-auto flex-1 min-h-0">
          <table className="w-full text-sm min-w-[900px] table-fixed">
            <thead ref={theadRef} className="text-slate-400">
              <tr>
                {showNamespaceColumn && (
                  <th className="text-left py-3 px-4 w-[140px]">{tr('pdbs.table.namespace', 'Namespace')}</th>
                )}
                <th className="text-left py-3 px-4 w-[200px] cursor-pointer" onClick={() => handleSort('name')}>
                  <span className="inline-flex items-center gap-1">
                    {tr('pdbs.table.name', 'Name')}{renderSortIcon('name')}
                  </span>
                </th>
                <th className="text-left py-3 px-4 w-[120px] cursor-pointer" onClick={() => handleSort('minAvailable')}>
                  <span className="inline-flex items-center gap-1">
                    {tr('pdbs.table.minAvailable', 'Min Available')}{renderSortIcon('minAvailable')}
                  </span>
                </th>
                <th className="text-left py-3 px-4 w-[130px] cursor-pointer" onClick={() => handleSort('maxUnavailable')}>
                  <span className="inline-flex items-center gap-1">
                    {tr('pdbs.table.maxUnavailable', 'Max Unavailable')}{renderSortIcon('maxUnavailable')}
                  </span>
                </th>
                <th className="text-left py-3 px-4 w-[140px] cursor-pointer" onClick={() => handleSort('allowedDisruptions')}>
                  <span className="inline-flex items-center gap-1">
                    {tr('pdbs.table.allowedDisruptions', 'Allowed Disruptions')}{renderSortIcon('allowedDisruptions')}
                  </span>
                </th>
                <th className="text-left py-3 px-4 w-[110px] cursor-pointer" onClick={() => handleSort('currentHealthy')}>
                  <span className="inline-flex items-center gap-1">
                    {tr('pdbs.table.currentHealthy', 'Current')}{renderSortIcon('currentHealthy')}
                  </span>
                </th>
                <th className="text-left py-3 px-4 w-[100px] cursor-pointer" onClick={() => handleSort('desiredHealthy')}>
                  <span className="inline-flex items-center gap-1">
                    {tr('pdbs.table.desiredHealthy', 'Desired')}{renderSortIcon('desiredHealthy')}
                  </span>
                </th>
                <th className="text-left py-3 px-4 w-[100px] cursor-pointer" onClick={() => handleSort('age')}>
                  <span className="inline-flex items-center gap-1">
                    {tr('pdbs.table.age', 'Age')}{renderSortIcon('age')}
                  </span>
                </th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-700">
              {pagedPDBs.map((p, idx) => (
                <tr
                      ref={idx === 0 ? firstRowRef : undefined}
                  key={`${p.namespace}/${p.name}`}
                  className="text-slate-200 hover:bg-slate-800/60 cursor-pointer"
                  onClick={() => openDetail({
                    kind: 'PodDisruptionBudget',
                    name: p.name,
                    namespace: p.namespace,
                    rawJson: pdbToRawJson(p),
                  })}
                >
                  {showNamespaceColumn && <td className="py-3 px-4 text-xs font-mono">{p.namespace}</td>}
                  <td className="py-3 px-4 font-medium text-white"><span className="block truncate">{p.name}</span></td>
                  <td className="py-3 px-4 text-xs font-mono">{p.min_available ?? '-'}</td>
                  <td className="py-3 px-4 text-xs font-mono">{p.max_unavailable ?? '-'}</td>
                  <td className="py-3 px-4 text-xs font-mono">{p.disruptions_allowed}</td>
                  <td className="py-3 px-4 text-xs font-mono">{p.current_healthy}/{p.desired_healthy}</td>
                  <td className="py-3 px-4 text-xs font-mono">{p.desired_healthy}</td>
                  <td className="py-3 px-4 text-xs font-mono">{formatAge(p.created_at)}</td>
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

              {sortedPDBs.length === 0 && !isLoading && (
                <tr>
                  <td colSpan={showNamespaceColumn ? 9 : 8} className="py-6 px-4 text-center text-slate-400">
                    {tr('pdbs.noResults', 'No PDBs found.')}
                  </td>
                </tr>
              )}
            </tbody>
              <AdaptiveTableFillerRows count={rowsPerPage - pagedPDBs.length} columnCount={7 + (showNamespaceColumn ? 1 : 0)} />
          </table>
        </div>
        {sortedPDBs.length > 0 && (
          <div className="flex items-center justify-between px-4 py-3 border-t border-slate-700 shrink-0">
            <div className="text-xs text-slate-400">
              {tr('common.paginationRange', 'Showing {{start}}-{{end}} of {{total}}', {
                start: (currentPage - 1) * rowsPerPage + 1,
                end: Math.min(currentPage * rowsPerPage, sortedPDBs.length),
                total: sortedPDBs.length,
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
          title={tr('pdbs.createTitle', 'Create PDB from YAML')}
          initialYaml={createPDBYamlTemplate}
          namespace={selectedNamespace !== 'all' ? selectedNamespace : undefined}
          onClose={() => setCreateDialogOpen(false)}
          onCreated={() => {
            queryClient.invalidateQueries({ queryKey: ['workloads', 'pdbs'] })
          }}
        />
      )}
    </div>
  )
}
