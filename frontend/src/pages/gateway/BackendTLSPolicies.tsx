import { useEffect, useMemo, useRef, useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { useTranslation } from 'react-i18next'
import { api, type BackendTLSPolicyInfo } from '@/services/api'
import { useKubeWatchList } from '@/services/useKubeWatchList'
import { useResourceDetail } from '@/components/ResourceDetailContext'
import ResourceYamlCreateDialog from '@/components/ResourceYamlCreateDialog'
import { useAdaptiveRowsPerPage } from '@/hooks/useAdaptiveRowsPerPage'
import { CheckCircle, ChevronDown, ChevronUp, Plus, RefreshCw, Search } from 'lucide-react'

type SortKey = null | 'name' | 'namespace' | 'targetRef' | 'age'

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

function formatTargetRefs(item: BackendTLSPolicyInfo): string {
  const refs = Array.isArray(item.target_refs) ? item.target_refs : []
  if (refs.length === 0) return '-'
  return refs.map((r) => `${r.kind || 'Service'}/${r.name || '-'}`).join(', ')
}

function formatConditionStatus(item: BackendTLSPolicyInfo): string {
  const conds = Array.isArray(item.conditions) ? item.conditions : []
  if (conds.length === 0) return '-'
  const accepted = conds.find((c) => c.type === 'Accepted')
  if (accepted) return accepted.status === 'True' ? 'Accepted' : accepted.reason || 'Not Accepted'
  return conds[0]?.type || '-'
}

function normalizeWatchObject(obj: any): BackendTLSPolicyInfo {
  if (typeof obj?.name === 'string' && typeof obj?.namespace === 'string') {
    return {
      ...obj,
      target_refs: Array.isArray(obj.target_refs) ? obj.target_refs : [],
      labels: obj.labels || {},
      annotations: obj.annotations || {},
    } as BackendTLSPolicyInfo
  }
  const metadata = obj?.metadata ?? {}
  const spec = obj?.spec ?? {}
  let targetRefs = Array.isArray(spec?.targetRefs) ? spec.targetRefs : []
  if (targetRefs.length === 0 && spec?.targetRef) targetRefs = [spec.targetRef]
  return {
    name: metadata?.name ?? obj?.name ?? '',
    namespace: metadata?.namespace ?? obj?.namespace ?? '',
    target_refs: targetRefs,
    labels: metadata?.labels ?? obj?.labels ?? {},
    annotations: metadata?.annotations ?? obj?.annotations ?? {},
    created_at: metadata?.creationTimestamp ?? obj?.created_at ?? null,
  }
}

function applyWatchEvent(
  prev: BackendTLSPolicyInfo[] | undefined,
  event: { type?: string; object?: any },
): BackendTLSPolicyInfo[] {
  const items = Array.isArray(prev) ? [...prev] : []
  const obj = event?.object
  if (!obj) return items
  const normalized = normalizeWatchObject(obj)
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

function toRawJson(item: BackendTLSPolicyInfo): Record<string, unknown> {
  return {
    apiVersion: 'gateway.networking.k8s.io/v1alpha3',
    kind: 'BackendTLSPolicy',
    metadata: {
      name: item.name,
      namespace: item.namespace,
      labels: item.labels || {},
      annotations: item.annotations || {},
      creationTimestamp: item.created_at,
    },
    spec: { targetRefs: item.target_refs || [] },
  }
}

export default function BackendTLSPolicies() {
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

  const { data: policies, isLoading } = useQuery({
    queryKey: ['gateway', 'backendtlspolicies', selectedNamespace],
    queryFn: () => (
      selectedNamespace === 'all'
        ? api.getAllBackendTLSPolicies(false)
        : api.getBackendTLSPolicies(selectedNamespace, false)
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
    queryKey: ['gateway', 'backendtlspolicies', selectedNamespace],
    path: selectedNamespace === 'all'
      ? '/api/v1/backendtlspolicies'
      : `/api/v1/namespaces/${selectedNamespace}/backendtlspolicies`,
    query: 'watch=1',
    applyEvent: (prev, event) => applyWatchEvent(prev as BackendTLSPolicyInfo[] | undefined, event),
    onEvent: (event) => {
      if (event?.type === 'DELETED') return
      const name = event?.object?.name || event?.object?.metadata?.name
      const ns = event?.object?.namespace || event?.object?.metadata?.namespace
      if (name && ns) {
        queryClient.invalidateQueries({ queryKey: ['backendtlspolicy-describe', ns, name] })
      }
    },
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

  const filteredPolicies = useMemo(() => {
    if (!Array.isArray(policies)) return [] as BackendTLSPolicyInfo[]
    if (!searchQuery.trim()) return policies
    const q = searchQuery.toLowerCase()
    return policies.filter((item) => (
      item.name.toLowerCase().includes(q)
      || item.namespace.toLowerCase().includes(q)
      || formatTargetRefs(item).toLowerCase().includes(q)
    ))
  }, [policies, searchQuery])

  const summary = useMemo(() => {
    const total = filteredPolicies.length
    let accepted = 0
    let withTargetRefs = 0
    for (const item of filteredPolicies) {
      if ((item.target_refs || []).length > 0) withTargetRefs += 1
      const conds = Array.isArray(item.conditions) ? item.conditions : []
      const acc = conds.find((c) => c.type === 'Accepted')
      if (acc && acc.status === 'True') accepted += 1
    }
    return { total, accepted, withTargetRefs }
  }, [filteredPolicies])

  const handleSort = (key: NonNullable<SortKey>) => {
    if (sortKey !== key) { setSortKey(key); setSortDir('asc'); return }
    if (sortDir === 'asc') { setSortDir('desc'); return }
    setSortKey(null)
  }

  const renderSortIcon = (key: NonNullable<SortKey>) => {
    if (sortKey !== key) return null
    return sortDir === 'asc'
      ? <ChevronUp className="w-3.5 h-3.5 text-slate-300" />
      : <ChevronDown className="w-3.5 h-3.5 text-slate-300" />
  }

  const sortedPolicies = useMemo(() => {
    if (!sortKey) return filteredPolicies
    const list = [...filteredPolicies]
    const getValue = (item: BackendTLSPolicyInfo): string | number => {
      switch (sortKey) {
        case 'name': return item.name
        case 'namespace': return item.namespace
        case 'targetRef': return formatTargetRefs(item)
        case 'age': return parseAgeSeconds(item.created_at)
        default: return ''
      }
    }
    list.sort((a, b) => {
      const av = getValue(a)
      const bv = getValue(b)
      if (typeof av === 'number' && typeof bv === 'number') return sortDir === 'asc' ? av - bv : bv - av
      return sortDir === 'asc' ? String(av).localeCompare(String(bv)) : String(bv).localeCompare(String(av))
    })
    return list
  }, [filteredPolicies, sortDir, sortKey])

  const rowsPerPage = useAdaptiveRowsPerPage(tableContainerRef, { recalculationKey: sortedPolicies.length })
  const totalPages = Math.max(1, Math.ceil(sortedPolicies.length / rowsPerPage))

  useEffect(() => { setCurrentPage(1) }, [searchQuery, selectedNamespace])
  useEffect(() => { if (currentPage > totalPages) setCurrentPage(totalPages) }, [currentPage, totalPages])

  const pagedPolicies = useMemo(() => {
    const start = (currentPage - 1) * rowsPerPage
    return sortedPolicies.slice(start, start + rowsPerPage)
  }, [sortedPolicies, currentPage, rowsPerPage])

  const handleRefresh = async () => {
    if (isRefreshing) return
    setIsRefreshing(true)
    try {
      const data = selectedNamespace === 'all'
        ? await api.getAllBackendTLSPolicies(true)
        : await api.getBackendTLSPolicies(selectedNamespace, true)
      queryClient.removeQueries({ queryKey: ['gateway', 'backendtlspolicies', selectedNamespace] })
      queryClient.setQueryData(['gateway', 'backendtlspolicies', selectedNamespace], data)
    } catch (error) {
      console.error('BackendTLSPolicies refresh failed:', error)
    }
    setTimeout(() => setIsRefreshing(false), 500)
  }

  const createYamlTemplate = useMemo(() => {
    const ns = selectedNamespace !== 'all' ? selectedNamespace : 'default'
    return `apiVersion: gateway.networking.k8s.io/v1alpha3
kind: BackendTLSPolicy
metadata:
  name: sample-backendtlspolicy
  namespace: ${ns}
spec:
  targetRefs:
    - group: ""
      kind: Service
      name: my-service
  validation:
    hostname: my-service.example.com
    wellKnownCACertificates: System
`
  }, [selectedNamespace])

  const showNamespaceColumn = selectedNamespace === 'all'

  return (
    <div className="flex flex-col h-[calc(100vh-4rem)] gap-4">
      <div className="flex items-center justify-between shrink-0">
        <div>
          <h1 className="text-3xl font-bold text-white">{tr('backendTLSPoliciesPage.title', 'Backend TLS Policies')}</h1>
          <p className="mt-2 text-slate-400">{tr('backendTLSPoliciesPage.subtitle', 'Inspect and manage Gateway API BackendTLSPolicy resources across namespaces.')}</p>
        </div>
        <div className="flex items-center gap-2">
          {canCreate && (
            <button type="button" onClick={() => setCreateDialogOpen(true)} className="btn btn-primary flex items-center gap-2">
              <Plus className="w-4 h-4" />
              {tr('backendTLSPoliciesPage.create', 'Create BackendTLSPolicy')}
            </button>
          )}
          <button
            type="button" onClick={handleRefresh} disabled={isRefreshing}
            title={tr('backendTLSPoliciesPage.refreshTitle', 'Force refresh')}
            className="btn btn-primary flex items-center gap-2 disabled:opacity-50 disabled:cursor-not-allowed"
          >
            <RefreshCw className={`w-4 h-4 ${isRefreshing ? 'animate-spin' : ''}`} />
            {tr('backendTLSPoliciesPage.refresh', 'Refresh')}
          </button>
        </div>
      </div>

      <div className="grid grid-cols-1 xl:grid-cols-3 gap-3 shrink-0">
        <div className="xl:col-span-2">
          <div className="relative">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-5 h-5 text-slate-400" />
            <input
              type="text"
              placeholder={tr('backendTLSPoliciesPage.searchPlaceholder', 'Search BackendTLSPolicies by name...')}
              value={searchQuery} onChange={(e) => setSearchQuery(e.target.value)}
              className="h-12 w-full pl-10 pr-4 bg-slate-700 border border-slate-600 rounded-lg text-sm text-white placeholder-slate-400 focus:outline-none focus:ring-2 focus:ring-primary-500 focus:border-transparent"
            />
          </div>
        </div>

        <div className="relative" ref={namespaceDropdownRef}>
          <button type="button" onClick={() => setIsNamespaceDropdownOpen((v) => !v)}
            className="h-12 w-full px-3 bg-slate-700 border border-slate-600 rounded-lg text-sm text-white focus:outline-none focus:ring-2 focus:ring-primary-500 focus:border-transparent flex items-center justify-between gap-2">
            <span className="text-sm font-medium">
              {selectedNamespace === 'all' ? tr('backendTLSPoliciesPage.allNamespaces', 'All namespaces') : selectedNamespace}
            </span>
            <ChevronDown className={`w-4 h-4 text-slate-400 transition-transform ${isNamespaceDropdownOpen ? 'rotate-180' : ''}`} />
          </button>
          {isNamespaceDropdownOpen && (
            <div className="absolute top-full left-0 mt-2 w-full bg-slate-700 border border-slate-600 rounded-lg shadow-xl z-[100] max-h-[240px] overflow-y-auto">
              <button type="button" onClick={() => { setSelectedNamespace('all'); setIsNamespaceDropdownOpen(false) }}
                className="w-full px-4 py-2.5 text-left text-sm text-white hover:bg-slate-600 transition-colors flex items-center gap-2 first:rounded-t-lg">
                {selectedNamespace === 'all' && <CheckCircle className="w-4 h-4 text-green-400 flex-shrink-0" />}
                <span className={selectedNamespace === 'all' ? 'font-medium' : ''}>{tr('backendTLSPoliciesPage.allNamespaces', 'All namespaces')}</span>
              </button>
              {(namespaces || []).map((ns) => (
                <button key={ns.name} type="button" onClick={() => { setSelectedNamespace(ns.name); setIsNamespaceDropdownOpen(false) }}
                  className="w-full px-4 py-2.5 text-left text-sm text-white hover:bg-slate-600 transition-colors flex items-center gap-2 last:rounded-b-lg">
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
          <p className="text-[11px] sm:text-xs leading-4 whitespace-nowrap text-slate-400">{tr('backendTLSPoliciesPage.stats.total', 'Total')}</p>
          <p className="text-lg text-white font-semibold mt-1">{summary.total}</p>
        </div>
        <div className="rounded-lg border border-emerald-700/40 bg-emerald-900/10 px-4 py-3">
          <p className="text-[11px] sm:text-xs leading-4 whitespace-nowrap text-emerald-300">{tr('backendTLSPoliciesPage.stats.accepted', 'Accepted')}</p>
          <p className="text-lg text-white font-semibold mt-1">{summary.accepted}</p>
        </div>
        <div className="rounded-lg border border-cyan-700/40 bg-cyan-900/10 px-4 py-3">
          <p className="text-[11px] sm:text-xs leading-4 whitespace-nowrap text-cyan-300">{tr('backendTLSPoliciesPage.stats.withTargets', 'With Targets')}</p>
          <p className="text-lg text-white font-semibold mt-1">{summary.withTargetRefs}</p>
        </div>
      </div>

      {searchQuery && (
        <p className="text-sm text-slate-400 shrink-0">
          {tr('backendTLSPoliciesPage.matchCount', '{{count}} BackendTLSPolic{{suffix}} match.', {
            count: filteredPolicies.length,
            suffix: filteredPolicies.length === 1 ? 'y' : 'ies',
          })}
        </p>
      )}

      <div ref={tableContainerRef} className="card flex-1 min-h-0 flex flex-col">
        <div className="overflow-x-auto flex-1 min-h-0">
          <table className="w-full text-sm min-w-[700px] table-fixed">
            <thead className="text-slate-400">
              <tr>
                {showNamespaceColumn && (
                  <th className="text-left py-3 px-4 w-[170px] cursor-pointer" onClick={() => handleSort('namespace')}>
                    <span className="inline-flex items-center gap-1">{tr('backendTLSPoliciesPage.table.namespace', 'Namespace')}{renderSortIcon('namespace')}</span>
                  </th>
                )}
                <th className="text-left py-3 px-4 w-[220px] cursor-pointer" onClick={() => handleSort('name')}>
                  <span className="inline-flex items-center gap-1">{tr('backendTLSPoliciesPage.table.name', 'Name')}{renderSortIcon('name')}</span>
                </th>
                <th className="text-left py-3 px-4 w-[280px] cursor-pointer" onClick={() => handleSort('targetRef')}>
                  <span className="inline-flex items-center gap-1">{tr('backendTLSPoliciesPage.table.targetRef', 'Target Ref')}{renderSortIcon('targetRef')}</span>
                </th>
                <th className="text-left py-3 px-4 w-[140px]">
                  {tr('backendTLSPoliciesPage.table.status', 'Status')}
                </th>
                <th className="text-left py-3 px-4 w-[90px] cursor-pointer" onClick={() => handleSort('age')}>
                  <span className="inline-flex items-center gap-1">{tr('backendTLSPoliciesPage.table.age', 'Age')}{renderSortIcon('age')}</span>
                </th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-700">
              {pagedPolicies.map((item) => (
                <tr
                  key={`${item.namespace}/${item.name}`}
                  className="text-slate-200 hover:bg-slate-800/60 cursor-pointer"
                  onClick={() => openDetail({
                    kind: 'BackendTLSPolicy',
                    name: item.name,
                    namespace: item.namespace,
                    rawJson: toRawJson(item),
                  })}
                >
                  {showNamespaceColumn && <td className="py-3 px-4 text-xs font-mono"><span className="block truncate">{item.namespace}</span></td>}
                  <td className="py-3 px-4 font-medium text-white"><span className="block truncate">{item.name}</span></td>
                  <td className="py-3 px-4 text-xs"><span className="block truncate">{formatTargetRefs(item)}</span></td>
                  <td className="py-3 px-4 text-xs"><span className="block truncate">{formatConditionStatus(item)}</span></td>
                  <td className="py-3 px-4 text-xs font-mono">{formatAge(item.created_at)}</td>
                </tr>
              ))}
              {sortedPolicies.length === 0 && !isLoading && (
                <tr>
                  <td colSpan={showNamespaceColumn ? 5 : 4} className="py-6 px-4 text-center text-slate-400">
                    {tr('backendTLSPoliciesPage.noResults', 'No BackendTLSPolicies found.')}
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>

        {sortedPolicies.length > 0 && (
          <div className="flex items-center justify-between px-4 py-3 border-t border-slate-700 shrink-0">
            <div className="text-xs text-slate-400">
              {tr('common.paginationRange', 'Showing {{start}}-{{end}} of {{total}}', {
                start: (currentPage - 1) * rowsPerPage + 1,
                end: Math.min(currentPage * rowsPerPage, sortedPolicies.length),
                total: sortedPolicies.length,
              })}
            </div>
            <div className="flex items-center gap-2">
              <button type="button" onClick={() => setCurrentPage((prev) => Math.max(1, prev - 1))} disabled={currentPage <= 1}
                className="px-3 py-1.5 text-xs rounded border border-slate-600 text-slate-300 disabled:opacity-40 disabled:cursor-not-allowed hover:text-white hover:border-slate-500">
                {tr('common.prev', 'Prev')}
              </button>
              <span className="text-xs text-slate-300 min-w-[72px] text-center">{currentPage} / {totalPages}</span>
              <button type="button" onClick={() => setCurrentPage((prev) => Math.min(totalPages, prev + 1))} disabled={currentPage >= totalPages}
                className="px-3 py-1.5 text-xs rounded border border-slate-600 text-slate-300 disabled:opacity-40 disabled:cursor-not-allowed hover:text-white hover:border-slate-500">
                {tr('common.next', 'Next')}
              </button>
            </div>
          </div>
        )}
      </div>

      {createDialogOpen && (
        <ResourceYamlCreateDialog
          title={tr('backendTLSPoliciesPage.createTitle', 'Create BackendTLSPolicy from YAML')}
          initialYaml={createYamlTemplate}
          namespace={selectedNamespace !== 'all' ? selectedNamespace : undefined}
          onClose={() => setCreateDialogOpen(false)}
          onCreated={() => { queryClient.invalidateQueries({ queryKey: ['gateway', 'backendtlspolicies'] }) }}
        />
      )}
    </div>
  )
}
