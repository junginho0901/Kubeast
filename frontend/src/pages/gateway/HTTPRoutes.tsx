import { useEffect, useMemo, useRef, useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { useTranslation } from 'react-i18next'
import { api, type HTTPRouteInfo } from '@/services/api'
import { useKubeWatchList } from '@/services/useKubeWatchList'
import { useResourceDetail } from '@/components/ResourceDetailContext'
import ResourceYamlCreateDialog from '@/components/ResourceYamlCreateDialog'
import { useAdaptiveRowsPerPage } from '@/hooks/useAdaptiveRowsPerPage'
import { Loader2, CheckCircle, ChevronDown, ChevronUp, Plus, RefreshCw, Search } from 'lucide-react'

type SortKey = null | 'name' | 'namespace' | 'hostnames' | 'parents' | 'rules' | 'backends' | 'status' | 'age'

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

function formatHostnames(item: HTTPRouteInfo): string {
  const list = Array.isArray(item.hostnames) ? item.hostnames : []
  if (list.length === 0) return '*'
  return list.map((h) => h || '*').join(', ')
}

function normalizeWatchHTTPRouteObject(obj: any): HTTPRouteInfo {
  if (
    typeof obj?.name === 'string'
    && typeof obj?.namespace === 'string'
    && Object.prototype.hasOwnProperty.call(obj, 'rule_count')
  ) {
    return {
      ...obj,
      hostnames: Array.isArray(obj.hostnames) ? obj.hostnames : [],
      parent_refs: Array.isArray(obj.parent_refs) ? obj.parent_refs : [],
      rules: Array.isArray(obj.rules) ? obj.rules : [],
      parents: Array.isArray(obj.parents) ? obj.parents : [],
      conditions: Array.isArray(obj.conditions) ? obj.conditions : [],
      labels: obj.labels || {},
      annotations: obj.annotations || {},
      finalizers: Array.isArray(obj.finalizers) ? obj.finalizers : [],
    } as HTTPRouteInfo
  }

  const metadata = obj?.metadata ?? {}
  const spec = obj?.spec ?? {}
  const status = obj?.status ?? {}

  const rules = Array.isArray(spec?.rules) ? spec.rules : []
  const parentRefs = Array.isArray(spec?.parentRefs) ? spec.parentRefs : []
  const parents = Array.isArray(status?.parents) ? status.parents : []

  let backendRefsCount = 0
  for (const rule of rules) {
    const refs = Array.isArray(rule?.backendRefs) ? rule.backendRefs : []
    backendRefsCount += refs.length
  }

  const conditions: Array<Record<string, any>> = []
  for (const parent of parents) {
    const parentConditions = Array.isArray(parent?.conditions) ? parent.conditions : []
    for (const condition of parentConditions) {
      if (condition && typeof condition === 'object') {
        conditions.push(condition)
      }
    }
  }

  const accepted = conditions.some((c) => String(c?.type) === 'Accepted' && String(c?.status).toLowerCase() === 'true')
  const resolvedRefs = conditions.some((c) => String(c?.type) === 'ResolvedRefs' && String(c?.status).toLowerCase() === 'true')

  const trueCondition = conditions.find((c) => String(c?.status).toLowerCase() === 'true')
  const falseCondition = conditions.find((c) => String(c?.status).toLowerCase() === 'false')
  const statusText = accepted
    ? 'Accepted'
    : resolvedRefs
      ? 'ResolvedRefs'
      : trueCondition?.type
        ? String(trueCondition.type)
        : falseCondition?.type
          ? `${String(falseCondition.type)}(False)`
          : 'Unknown'

  return {
    name: metadata?.name ?? obj?.name ?? '',
    namespace: metadata?.namespace ?? obj?.namespace ?? '',
    hostnames: Array.isArray(spec?.hostnames) ? spec.hostnames : [],
    parent_refs: parentRefs,
    rules,
    parents,
    rule_count: rules.length,
    parent_refs_count: parentRefs.length,
    backend_refs_count: backendRefsCount,
    status: statusText,
    accepted,
    resolved_refs: resolvedRefs,
    conditions,
    labels: metadata?.labels ?? obj?.labels ?? {},
    annotations: metadata?.annotations ?? obj?.annotations ?? {},
    finalizers: Array.isArray(metadata?.finalizers) ? metadata.finalizers : (obj?.finalizers || []),
    created_at: metadata?.creationTimestamp ?? obj?.created_at ?? null,
    api_version: obj?.apiVersion ?? obj?.api_version ?? null,
  }
}

function applyHTTPRouteWatchEvent(
  prev: HTTPRouteInfo[] | undefined,
  event: { type?: string; object?: any },
): HTTPRouteInfo[] {
  const items = Array.isArray(prev) ? [...prev] : []
  const obj = event?.object
  if (!obj) return items

  const normalized = normalizeWatchHTTPRouteObject(obj)
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

function httpRouteToRawJson(item: HTTPRouteInfo): Record<string, unknown> {
  return {
    apiVersion: item.api_version || 'gateway.networking.k8s.io/v1',
    kind: 'HTTPRoute',
    metadata: {
      name: item.name,
      namespace: item.namespace,
      labels: item.labels || {},
      annotations: item.annotations || {},
      finalizers: item.finalizers || [],
      creationTimestamp: item.created_at,
    },
    spec: {
      hostnames: item.hostnames || [],
      parentRefs: item.parent_refs || [],
      rules: item.rules || [],
    },
    status: {
      parents: item.parents || [],
    },
    rule_count: item.rule_count || 0,
    parent_refs_count: item.parent_refs_count || 0,
    backend_refs_count: item.backend_refs_count || 0,
    status_text: item.status,
    accepted: item.accepted,
    resolved_refs: item.resolved_refs,
    conditions: item.conditions || [],
  }
}

export default function HTTPRoutes() {
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

  const { data: httpRoutes, isLoading } = useQuery({
    queryKey: ['gateway', 'httproutes', selectedNamespace],
    queryFn: () => (
      selectedNamespace === 'all'
        ? api.getAllHTTPRoutes(false)
        : api.getHTTPRoutes(selectedNamespace, false)
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
    queryKey: ['gateway', 'httproutes', selectedNamespace],
    path: selectedNamespace === 'all'
      ? '/api/v1/httproutes'
      : `/api/v1/namespaces/${selectedNamespace}/httproutes`,
    query: 'watch=1',
    applyEvent: (prev, event) => applyHTTPRouteWatchEvent(prev as HTTPRouteInfo[] | undefined, event),
    onEvent: (event) => {
      if (event?.type === 'DELETED') return
      const name = event?.object?.name || event?.object?.metadata?.name
      const ns = event?.object?.namespace || event?.object?.metadata?.namespace
      if (name && ns) {
        queryClient.invalidateQueries({ queryKey: ['httproute-describe', ns, name] })
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

  const filteredHTTPRoutes = useMemo(() => {
    if (!Array.isArray(httpRoutes)) return [] as HTTPRouteInfo[]
    if (!searchQuery.trim()) return httpRoutes
    const q = searchQuery.toLowerCase()
    return httpRoutes.filter((item) => (
      item.name.toLowerCase().includes(q)
      || item.namespace.toLowerCase().includes(q)
      || formatHostnames(item).toLowerCase().includes(q)
      || String(item.status || '').toLowerCase().includes(q)
      || String(item.rule_count || 0).includes(q)
      || String(item.parent_refs_count || 0).includes(q)
      || String(item.backend_refs_count || 0).includes(q)
    ))
  }, [httpRoutes, searchQuery])

  const summary = useMemo(() => {
    const total = filteredHTTPRoutes.length
    let accepted = 0
    let resolvedRefs = 0
    let withHostnames = 0

    for (const item of filteredHTTPRoutes) {
      if (item.accepted) accepted += 1
      if (item.resolved_refs) resolvedRefs += 1
      if ((item.hostnames || []).length > 0) withHostnames += 1
    }

    return { total, accepted, resolvedRefs, withHostnames }
  }, [filteredHTTPRoutes])

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

  const sortedHTTPRoutes = useMemo(() => {
    if (!sortKey) return filteredHTTPRoutes
    const list = [...filteredHTTPRoutes]

    const getValue = (item: HTTPRouteInfo): string | number => {
      switch (sortKey) {
        case 'name':
          return item.name
        case 'namespace':
          return item.namespace
        case 'hostnames':
          return formatHostnames(item)
        case 'parents':
          return item.parent_refs_count || 0
        case 'rules':
          return item.rule_count || 0
        case 'backends':
          return item.backend_refs_count || 0
        case 'status':
          return item.status || ''
        case 'age':
          return parseAgeSeconds(item.created_at)
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
  }, [filteredHTTPRoutes, sortDir, sortKey])

  const rowsPerPage = useAdaptiveRowsPerPage(tableContainerRef, {
    recalculationKey: sortedHTTPRoutes.length,
  })
  const totalPages = Math.max(1, Math.ceil(sortedHTTPRoutes.length / rowsPerPage))

  useEffect(() => {
    setCurrentPage(1)
  }, [searchQuery, selectedNamespace])

  useEffect(() => {
    if (currentPage > totalPages) setCurrentPage(totalPages)
  }, [currentPage, totalPages])

  const pagedHTTPRoutes = useMemo(() => {
    const start = (currentPage - 1) * rowsPerPage
    return sortedHTTPRoutes.slice(start, start + rowsPerPage)
  }, [sortedHTTPRoutes, currentPage, rowsPerPage])

  const handleRefresh = async () => {
    if (isRefreshing) return
    setIsRefreshing(true)
    try {
      const data = selectedNamespace === 'all'
        ? await api.getAllHTTPRoutes(true)
        : await api.getHTTPRoutes(selectedNamespace, true)
      queryClient.removeQueries({ queryKey: ['gateway', 'httproutes', selectedNamespace] })
      queryClient.setQueryData(['gateway', 'httproutes', selectedNamespace], data)
    } catch (error) {
      console.error('HTTPRoutes refresh failed:', error)
    }
    setTimeout(() => setIsRefreshing(false), 500)
  }

  const createHTTPRouteYamlTemplate = useMemo(() => {
    const ns = selectedNamespace !== 'all' ? selectedNamespace : 'default'
    return `apiVersion: gateway.networking.k8s.io/v1
kind: HTTPRoute
metadata:
  name: sample-httproute
  namespace: ${ns}
spec:
  parentRefs:
    - name: sample-gateway
  hostnames:
    - example.com
  rules:
    - matches:
        - path:
            type: PathPrefix
            value: /
      backendRefs:
        - name: sample-service
          port: 80
`
  }, [selectedNamespace])

  const showNamespaceColumn = selectedNamespace === 'all'

  return (
    <div className="flex flex-col h-[calc(100vh-4rem)] gap-4">
      <div className="flex items-center justify-between shrink-0">
        <div>
          <h1 className="text-3xl font-bold text-white">{tr('httpRoutesPage.title', 'HTTP Routes')}</h1>
          <p className="mt-2 text-slate-400">{tr('httpRoutesPage.subtitle', 'Inspect and manage Gateway API HTTPRoute resources across namespaces.')}</p>
        </div>
        <div className="flex items-center gap-2">
          {canCreate && (
            <button
              type="button"
              onClick={() => setCreateDialogOpen(true)}
              className="btn btn-primary flex items-center gap-2"
            >
              <Plus className="w-4 h-4" />
              {tr('httpRoutesPage.create', 'Create HTTPRoute')}
            </button>
          )}
          <button
            type="button"
            onClick={handleRefresh}
            disabled={isRefreshing}
            title={tr('httpRoutesPage.refreshTitle', 'Force refresh')}
            className="btn btn-primary flex items-center gap-2 disabled:opacity-50 disabled:cursor-not-allowed"
          >
            <RefreshCw className={`w-4 h-4 ${isRefreshing ? 'animate-spin' : ''}`} />
            {tr('httpRoutesPage.refresh', 'Refresh')}
          </button>
        </div>
      </div>

      <div className="grid grid-cols-1 xl:grid-cols-3 gap-3 shrink-0">
        <div className="xl:col-span-2">
          <div className="relative">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-5 h-5 text-slate-400" />
            <input
              type="text"
              placeholder={tr('httpRoutesPage.searchPlaceholder', 'Search HTTPRoutes by name...')}
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
              {selectedNamespace === 'all' ? tr('httpRoutesPage.allNamespaces', 'All namespaces') : selectedNamespace}
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
                <span className={selectedNamespace === 'all' ? 'font-medium' : ''}>{tr('httpRoutesPage.allNamespaces', 'All namespaces')}</span>
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
          <p className="text-[11px] sm:text-xs leading-4 whitespace-nowrap text-slate-400">{tr('httpRoutesPage.stats.total', 'Total')}</p>
          <p className="text-lg text-white font-semibold mt-1">{summary.total}</p>
        </div>
        <div className="rounded-lg border border-emerald-700/40 bg-emerald-900/10 px-4 py-3">
          <p className="text-[11px] sm:text-xs leading-4 whitespace-nowrap text-emerald-300">{tr('httpRoutesPage.stats.accepted', 'Accepted')}</p>
          <p className="text-lg text-white font-semibold mt-1">{summary.accepted}</p>
        </div>
        <div className="rounded-lg border border-cyan-700/40 bg-cyan-900/10 px-4 py-3">
          <p className="text-[11px] sm:text-xs leading-4 whitespace-nowrap text-cyan-300">{tr('httpRoutesPage.stats.resolvedRefs', 'ResolvedRefs')}</p>
          <p className="text-lg text-white font-semibold mt-1">{summary.resolvedRefs}</p>
        </div>
        <div className="rounded-lg border border-amber-700/40 bg-amber-900/10 px-4 py-3">
          <p className="text-[11px] sm:text-xs leading-4 whitespace-nowrap text-amber-300">{tr('httpRoutesPage.stats.withHostnames', 'With Hostnames')}</p>
          <p className="text-lg text-white font-semibold mt-1">{summary.withHostnames}</p>
        </div>
      </div>

      {searchQuery && (
        <p className="text-sm text-slate-400 shrink-0">
          {tr('httpRoutesPage.matchCount', '{{count}} HTTPRoute{{suffix}} match.', {
            count: filteredHTTPRoutes.length,
            suffix: filteredHTTPRoutes.length === 1 ? '' : 's',
          })}
        </p>
      )}

      <div ref={tableContainerRef} className="card flex-1 min-h-0 flex flex-col">
        <div className="overflow-x-auto flex-1 min-h-0">
          <table className="w-full text-sm min-w-[1120px] table-fixed">
            <thead className="text-slate-400">
              <tr>
                {showNamespaceColumn && (
                  <th className="text-left py-3 px-4 w-[170px] cursor-pointer" onClick={() => handleSort('namespace')}>
                    <span className="inline-flex items-center gap-1">{tr('httpRoutesPage.table.namespace', 'Namespace')}{renderSortIcon('namespace')}</span>
                  </th>
                )}
                <th className="text-left py-3 px-4 w-[230px] cursor-pointer" onClick={() => handleSort('name')}>
                  <span className="inline-flex items-center gap-1">{tr('httpRoutesPage.table.name', 'Name')}{renderSortIcon('name')}</span>
                </th>
                <th className="text-left py-3 px-4 w-[260px] cursor-pointer" onClick={() => handleSort('hostnames')}>
                  <span className="inline-flex items-center gap-1">{tr('httpRoutesPage.table.hostnames', 'Hostnames')}{renderSortIcon('hostnames')}</span>
                </th>
                <th className="text-left py-3 px-4 w-[130px] cursor-pointer" onClick={() => handleSort('parents')}>
                  <span className="inline-flex items-center gap-1">{tr('httpRoutesPage.table.parentRefs', 'Parent Refs')}{renderSortIcon('parents')}</span>
                </th>
                <th className="text-left py-3 px-4 w-[110px] cursor-pointer" onClick={() => handleSort('rules')}>
                  <span className="inline-flex items-center gap-1">{tr('httpRoutesPage.table.rules', 'Rules')}{renderSortIcon('rules')}</span>
                </th>
                <th className="text-left py-3 px-4 w-[130px] cursor-pointer" onClick={() => handleSort('backends')}>
                  <span className="inline-flex items-center gap-1">{tr('httpRoutesPage.table.backendRefs', 'Backend Refs')}{renderSortIcon('backends')}</span>
                </th>
                <th className="text-left py-3 px-4 w-[150px] cursor-pointer" onClick={() => handleSort('status')}>
                  <span className="inline-flex items-center gap-1">{tr('httpRoutesPage.table.status', 'Status')}{renderSortIcon('status')}</span>
                </th>
                <th className="text-left py-3 px-4 w-[90px] cursor-pointer" onClick={() => handleSort('age')}>
                  <span className="inline-flex items-center gap-1">{tr('httpRoutesPage.table.age', 'Age')}{renderSortIcon('age')}</span>
                </th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-700">
              {pagedHTTPRoutes.map((item) => (
                <tr
                  key={`${item.namespace}/${item.name}`}
                  className="text-slate-200 hover:bg-slate-800/60 cursor-pointer"
                  onClick={() => openDetail({
                    kind: 'HTTPRoute',
                    name: item.name,
                    namespace: item.namespace,
                    rawJson: httpRouteToRawJson(item),
                  })}
                >
                  {showNamespaceColumn && <td className="py-3 px-4 text-xs font-mono"><span className="block truncate">{item.namespace}</span></td>}
                  <td className="py-3 px-4 font-medium text-white"><span className="block truncate">{item.name}</span></td>
                  <td className="py-3 px-4 text-xs"><span className="block truncate">{formatHostnames(item)}</span></td>
                  <td className="py-3 px-4 text-xs font-mono">{item.parent_refs_count || 0}</td>
                  <td className="py-3 px-4 text-xs font-mono">{item.rule_count || 0}</td>
                  <td className="py-3 px-4 text-xs font-mono">{item.backend_refs_count || 0}</td>
                  <td className="py-3 px-4 text-xs"><span className="block truncate">{item.status || '-'}</span></td>
                  <td className="py-3 px-4 text-xs font-mono">{formatAge(item.created_at)}</td>
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

              {sortedHTTPRoutes.length === 0 && !isLoading && (
                <tr>
                  <td colSpan={showNamespaceColumn ? 9 : 8} className="py-6 px-4 text-center text-slate-400">
                    {tr('httpRoutesPage.noResults', 'No HTTPRoutes found.')}
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>

        {sortedHTTPRoutes.length > 0 && (
          <div className="flex items-center justify-between px-4 py-3 border-t border-slate-700 shrink-0">
            <div className="text-xs text-slate-400">
              {tr('common.paginationRange', 'Showing {{start}}-{{end}} of {{total}}', {
                start: (currentPage - 1) * rowsPerPage + 1,
                end: Math.min(currentPage * rowsPerPage, sortedHTTPRoutes.length),
                total: sortedHTTPRoutes.length,
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
          title={tr('httpRoutesPage.createTitle', 'Create HTTPRoute from YAML')}
          initialYaml={createHTTPRouteYamlTemplate}
          namespace={selectedNamespace !== 'all' ? selectedNamespace : undefined}
          onClose={() => setCreateDialogOpen(false)}
          onCreated={() => {
            queryClient.invalidateQueries({ queryKey: ['gateway', 'httproutes'] })
          }}
        />
      )}
    </div>
  )
}
