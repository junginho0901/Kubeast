import { useEffect, useMemo, useRef, useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { useTranslation } from 'react-i18next'
import { api, type IngressClassInfo } from '@/services/api'
import { useKubeWatchList } from '@/services/useKubeWatchList'
import { useResourceDetail } from '@/components/ResourceDetailContext'
import ResourceYamlCreateDialog from '@/components/ResourceYamlCreateDialog'
import { useAdaptiveRowsPerPage } from '@/hooks/useAdaptiveRowsPerPage'
import { ChevronDown, ChevronUp, Plus, RefreshCw, Search } from 'lucide-react'

type SortKey = null | 'name' | 'controller' | 'default' | 'parameters' | 'age'

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

function formatParameters(item: IngressClassInfo): string {
  const p = item.parameters
  if (!p) return '-'
  const parts: string[] = []
  if (p.kind) parts.push(p.kind)
  if (p.api_group) parts.push(`.${p.api_group}`)
  if (p.name) parts.push(`/${p.name}`)
  if (p.scope) parts.push(` (${p.scope})`)
  if (p.namespace) parts.push(` ns=${p.namespace}`)
  const text = parts.join('')
  return text || '-'
}

function normalizeWatchIngressClassObject(obj: any): IngressClassInfo {
  if (typeof obj?.name === 'string' && Object.prototype.hasOwnProperty.call(obj, 'is_default')) {
    return {
      ...obj,
      labels: obj?.labels || {},
      annotations: obj?.annotations || {},
      finalizers: Array.isArray(obj?.finalizers) ? obj.finalizers : [],
    } as IngressClassInfo
  }

  const metadata = obj?.metadata ?? {}
  const spec = obj?.spec ?? {}
  const annotations = metadata?.annotations ?? {}
  const labels = metadata?.labels ?? {}
  const paramObj = spec?.parameters
    ? {
        api_group: spec.parameters?.apiGroup ?? null,
        kind: spec.parameters?.kind ?? null,
        name: spec.parameters?.name ?? null,
        scope: spec.parameters?.scope ?? null,
        namespace: spec.parameters?.namespace ?? null,
      }
    : null

  return {
    name: metadata?.name ?? '',
    controller: spec?.controller ?? null,
    is_default: annotations?.['ingressclass.kubernetes.io/is-default-class'] === 'true',
    parameters: paramObj,
    labels,
    annotations,
    finalizers: Array.isArray(metadata?.finalizers) ? metadata.finalizers : [],
    created_at: metadata?.creationTimestamp ?? null,
  }
}

function applyIngressClassWatchEvent(
  prev: IngressClassInfo[] | undefined,
  event: { type?: string; object?: any },
): IngressClassInfo[] {
  const items = Array.isArray(prev) ? [...prev] : []
  const obj = event?.object
  if (!obj) return items

  const normalized = normalizeWatchIngressClassObject(obj)
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

function ingressClassToRawJson(item: IngressClassInfo): Record<string, unknown> {
  const isDefault = Boolean(item.is_default)
  const annotations = { ...(item.annotations || {}) }
  if (isDefault && !annotations['ingressclass.kubernetes.io/is-default-class']) {
    annotations['ingressclass.kubernetes.io/is-default-class'] = 'true'
  }

  return {
    apiVersion: 'networking.k8s.io/v1',
    kind: 'IngressClass',
    metadata: {
      name: item.name,
      labels: item.labels || {},
      annotations,
      finalizers: item.finalizers || [],
      creationTimestamp: item.created_at,
    },
    spec: {
      controller: item.controller,
      parameters: item.parameters
        ? {
            apiGroup: item.parameters.api_group,
            kind: item.parameters.kind,
            name: item.parameters.name,
            scope: item.parameters.scope,
            namespace: item.parameters.namespace,
          }
        : undefined,
    },
    is_default: item.is_default,
    parameters: item.parameters,
  }
}

export default function IngressClasses() {
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
  const tableContainerRef = useRef<HTMLDivElement>(null)

  const { data: ingressClasses, isLoading } = useQuery({
    queryKey: ['network', 'ingressclasses'],
    queryFn: () => api.getIngressClasses(false),
  })

  const { data: me } = useQuery({
    queryKey: ['me'],
    queryFn: api.me,
    staleTime: 30000,
  })
  const canCreate = me?.role === 'admin' || me?.role === 'write'

  useKubeWatchList({
    enabled: true,
    queryKey: ['network', 'ingressclasses'],
    path: '/api/v1/ingressclasses',
    query: 'watch=1',
    applyEvent: (prev, event) => applyIngressClassWatchEvent(prev as IngressClassInfo[] | undefined, event),
    onEvent: (event) => {
      if (event?.type === 'DELETED') return
      const name = event?.object?.name || event?.object?.metadata?.name
      if (name) {
        queryClient.invalidateQueries({ queryKey: ['ingressclass-describe', name] })
      }
    },
  })

  const filteredIngressClasses = useMemo(() => {
    if (!Array.isArray(ingressClasses)) return [] as IngressClassInfo[]
    if (!searchQuery.trim()) return ingressClasses
    const q = searchQuery.toLowerCase()
    return ingressClasses.filter((item) => (
      item.name.toLowerCase().includes(q)
      || String(item.controller || '').toLowerCase().includes(q)
      || formatParameters(item).toLowerCase().includes(q)
      || String(item.is_default).toLowerCase().includes(q)
    ))
  }, [ingressClasses, searchQuery])

  const summary = useMemo(() => {
    const total = filteredIngressClasses.length
    let defaults = 0
    let withParameters = 0
    let withAnnotations = 0

    for (const item of filteredIngressClasses) {
      if (item.is_default) defaults += 1
      if (item.parameters) withParameters += 1
      if (Object.keys(item.annotations || {}).length > 0) withAnnotations += 1
    }

    return { total, defaults, withParameters, withAnnotations }
  }, [filteredIngressClasses])

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

  const sortedIngressClasses = useMemo(() => {
    if (!sortKey) return filteredIngressClasses
    const list = [...filteredIngressClasses]

    const getValue = (item: IngressClassInfo): string | number => {
      switch (sortKey) {
        case 'name':
          return item.name
        case 'controller':
          return item.controller || ''
        case 'default':
          return item.is_default ? 1 : 0
        case 'parameters':
          return formatParameters(item)
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
  }, [filteredIngressClasses, sortDir, sortKey])

  const rowsPerPage = useAdaptiveRowsPerPage(tableContainerRef, {
    recalculationKey: sortedIngressClasses.length,
  })
  const totalPages = Math.max(1, Math.ceil(sortedIngressClasses.length / rowsPerPage))

  useEffect(() => {
    setCurrentPage(1)
  }, [searchQuery])

  useEffect(() => {
    if (currentPage > totalPages) setCurrentPage(totalPages)
  }, [currentPage, totalPages])

  const pagedIngressClasses = useMemo(() => {
    const start = (currentPage - 1) * rowsPerPage
    return sortedIngressClasses.slice(start, start + rowsPerPage)
  }, [sortedIngressClasses, currentPage, rowsPerPage])

  const handleRefresh = async () => {
    if (isRefreshing) return
    setIsRefreshing(true)
    try {
      const data = await api.getIngressClasses(true)
      queryClient.removeQueries({ queryKey: ['network', 'ingressclasses'] })
      queryClient.setQueryData(['network', 'ingressclasses'], data)
    } catch (error) {
      console.error('IngressClasses refresh failed:', error)
    }
    setTimeout(() => setIsRefreshing(false), 500)
  }

  const createIngressClassYamlTemplate = useMemo(() => {
    return `apiVersion: networking.k8s.io/v1
kind: IngressClass
metadata:
  name: sample-ingressclass
spec:
  controller: k8s.io/ingress-nginx
`
  }, [])

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-3xl font-bold text-white">{tr('ingressClassesPage.title', 'Ingress Classes')}</h1>
          <p className="mt-2 text-slate-400">{tr('ingressClassesPage.subtitle', 'Inspect and manage cluster-scoped IngressClass resources.')}</p>
        </div>
        <div className="flex items-center gap-2">
          {canCreate && (
            <button
              type="button"
              onClick={() => setCreateDialogOpen(true)}
              className="btn btn-primary flex items-center gap-2"
            >
              <Plus className="w-4 h-4" />
              {tr('ingressClassesPage.create', 'Create IngressClass')}
            </button>
          )}
          <button
            type="button"
            onClick={handleRefresh}
            disabled={isRefreshing}
            title={tr('ingressClassesPage.refreshTitle', 'Force refresh')}
            className="btn btn-primary flex items-center gap-2 disabled:opacity-50 disabled:cursor-not-allowed"
          >
            <RefreshCw className={`w-4 h-4 ${isRefreshing ? 'animate-spin' : ''}`} />
            {tr('ingressClassesPage.refresh', 'Refresh')}
          </button>
        </div>
      </div>

      <div className="relative">
        <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-5 h-5 text-slate-400" />
        <input
          type="text"
          placeholder={tr('ingressClassesPage.searchPlaceholder', 'Search ingress classes by name...')}
          value={searchQuery}
          onChange={(e) => setSearchQuery(e.target.value)}
          className="w-full pl-10 pr-4 py-3 bg-slate-700 border border-slate-600 rounded-lg text-white placeholder-slate-400 focus:outline-none focus:ring-2 focus:ring-primary-500 focus:border-transparent"
        />
      </div>

      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
        <div className="rounded-lg border border-slate-700 bg-slate-900/50 px-4 py-3">
          <p className="text-[11px] sm:text-xs leading-4 whitespace-nowrap text-slate-400">{tr('ingressClassesPage.stats.total', 'Total')}</p>
          <p className="text-lg text-white font-semibold mt-1">{summary.total}</p>
        </div>
        <div className="rounded-lg border border-cyan-700/40 bg-cyan-900/10 px-4 py-3">
          <p className="text-[11px] sm:text-xs leading-4 whitespace-nowrap text-cyan-300">{tr('ingressClassesPage.stats.default', 'Default')}</p>
          <p className="text-lg text-white font-semibold mt-1">{summary.defaults}</p>
        </div>
        <div className="rounded-lg border border-emerald-700/40 bg-emerald-900/10 px-4 py-3">
          <p className="text-[11px] sm:text-xs leading-4 whitespace-nowrap text-emerald-300">{tr('ingressClassesPage.stats.withParameters', 'With Parameters')}</p>
          <p className="text-lg text-white font-semibold mt-1">{summary.withParameters}</p>
        </div>
        <div className="rounded-lg border border-amber-700/40 bg-amber-900/10 px-4 py-3">
          <p className="text-[11px] sm:text-xs leading-4 whitespace-nowrap text-amber-300">{tr('ingressClassesPage.stats.withAnnotations', 'With Annotations')}</p>
          <p className="text-lg text-white font-semibold mt-1">{summary.withAnnotations}</p>
        </div>
      </div>

      {searchQuery && (
        <p className="text-sm text-slate-400">
          {tr('ingressClassesPage.matchCount', '{{count}} ingress class{{suffix}} match.', {
            count: filteredIngressClasses.length,
            suffix: filteredIngressClasses.length === 1 ? '' : 'es',
          })}
        </p>
      )}

      <div ref={tableContainerRef} className="card">
        <div className="overflow-x-auto">
          <table className="w-full text-sm min-w-[1060px] table-fixed">
            <thead className="text-slate-400">
              <tr>
                <th className="text-left py-3 px-4 w-[220px] cursor-pointer" onClick={() => handleSort('name')}>
                  <span className="inline-flex items-center gap-1">{tr('ingressClassesPage.table.name', 'Name')}{renderSortIcon('name')}</span>
                </th>
                <th className="text-left py-3 px-4 w-[260px] cursor-pointer" onClick={() => handleSort('controller')}>
                  <span className="inline-flex items-center gap-1">{tr('ingressClassesPage.table.controller', 'Controller')}{renderSortIcon('controller')}</span>
                </th>
                <th className="text-left py-3 px-4 w-[110px] cursor-pointer" onClick={() => handleSort('default')}>
                  <span className="inline-flex items-center gap-1">{tr('ingressClassesPage.table.default', 'Default')}{renderSortIcon('default')}</span>
                </th>
                <th className="text-left py-3 px-4 w-[310px] cursor-pointer" onClick={() => handleSort('parameters')}>
                  <span className="inline-flex items-center gap-1">{tr('ingressClassesPage.table.parameters', 'Parameters')}{renderSortIcon('parameters')}</span>
                </th>
                <th className="text-left py-3 px-4 w-[90px] cursor-pointer" onClick={() => handleSort('age')}>
                  <span className="inline-flex items-center gap-1">{tr('ingressClassesPage.table.age', 'Age')}{renderSortIcon('age')}</span>
                </th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-700">
              {pagedIngressClasses.map((item) => (
                <tr
                  key={item.name}
                  className="text-slate-200 hover:bg-slate-800/60 cursor-pointer"
                  onClick={() => openDetail({
                    kind: 'IngressClass',
                    name: item.name,
                    rawJson: ingressClassToRawJson(item),
                  })}
                >
                  <td className="py-3 px-4 font-medium text-white"><span className="block truncate">{item.name}</span></td>
                  <td className="py-3 px-4 text-xs font-mono"><span className="block truncate">{item.controller || '-'}</span></td>
                  <td className="py-3 px-4 text-xs">
                    {item.is_default
                      ? <span className="badge badge-success">{tr('common.yes', 'Yes')}</span>
                      : <span className="badge badge-info">{tr('common.no', 'No')}</span>}
                  </td>
                  <td className="py-3 px-4 text-xs font-mono"><span className="block truncate">{formatParameters(item)}</span></td>
                  <td className="py-3 px-4 text-xs font-mono">{formatAge(item.created_at)}</td>
                </tr>
              ))}
              {sortedIngressClasses.length === 0 && !isLoading && (
                <tr>
                  <td colSpan={5} className="py-6 px-4 text-slate-400">
                    {tr('ingressClassesPage.noResults', 'No ingress classes found.')}
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </div>

      {totalPages > 1 && (
        <div className="flex items-center justify-between text-xs text-slate-400">
          <span>
            {(() => {
              const total = sortedIngressClasses.length
              if (total === 0) return tr('common.pagination.empty', '0')
              const from = (currentPage - 1) * rowsPerPage + 1
              const to = Math.min(currentPage * rowsPerPage, total)
              return tr('common.pagination.range', '{{from}}-{{to}} / {{total}}', { from, to, total })
            })()}
          </span>
          <div className="flex items-center gap-2">
            <button
              type="button"
              className="btn btn-secondary px-2 py-1 disabled:opacity-50"
              disabled={currentPage === 1}
              onClick={() => setCurrentPage((p) => Math.max(1, p - 1))}
            >
              {tr('common.pagination.prev', 'Prev')}
            </button>
            <span>{currentPage} / {totalPages}</span>
            <button
              type="button"
              className="btn btn-secondary px-2 py-1 disabled:opacity-50"
              disabled={currentPage === totalPages}
              onClick={() => setCurrentPage((p) => Math.min(totalPages, p + 1))}
            >
              {tr('common.pagination.next', 'Next')}
            </button>
          </div>
        </div>
      )}

      {createDialogOpen && (
        <ResourceYamlCreateDialog
          title={tr('ingressClassesPage.createTitle', 'Create IngressClass from YAML')}
          initialYaml={createIngressClassYamlTemplate}
          onClose={() => setCreateDialogOpen(false)}
          onCreated={() => {
            queryClient.invalidateQueries({ queryKey: ['network', 'ingressclasses'] })
          }}
        />
      )}
    </div>
  )
}
