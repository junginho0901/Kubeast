import { useEffect, useMemo, useRef, useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { useTranslation } from 'react-i18next'
import { api, type ResourceClaimTemplateItem } from '@/services/api'
import { useKubeWatchList } from '@/services/useKubeWatchList'
import { useResourceDetail } from '@/components/ResourceDetailContext'
import ResourceYamlCreateDialog from '@/components/ResourceYamlCreateDialog'
import { useAdaptiveRowsPerPage } from '@/hooks/useAdaptiveRowsPerPage'
import { useAIContext } from '@/hooks/useAIContext'
import { usePermission } from '@/hooks/usePermission'
import { summarizeList } from '@/utils/aiContext/summarizeList'
import { buildResourceLink } from '@/utils/resourceLink'
import { Loader2, CheckCircle, ChevronDown, ChevronUp, Plus, RefreshCw, Search } from 'lucide-react'

type SortKey = null | 'name' | 'namespace' | 'requests' | 'age'

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

function normalizeWatchResourceClaimTemplateObject(obj: any): ResourceClaimTemplateItem {
  if (
    typeof obj?.name === 'string'
    && typeof obj?.namespace === 'string'
    && Object.prototype.hasOwnProperty.call(obj, 'request_count')
  ) {
    return {
      ...obj,
      labels: obj.labels || {},
    } as ResourceClaimTemplateItem
  }

  const metadata = obj?.metadata ?? {}
  const spec = obj?.spec?.spec ?? {}

  const requests = Array.isArray(spec?.devices?.requests) ? spec.devices.requests : []

  return {
    name: metadata?.name ?? obj?.name ?? '',
    namespace: metadata?.namespace ?? obj?.namespace ?? '',
    labels: metadata?.labels ?? obj?.labels ?? {},
    created_at: metadata?.creationTimestamp ?? obj?.created_at ?? null,
    request_count: requests.length,
  }
}

function applyResourceClaimTemplateWatchEvent(
  prev: ResourceClaimTemplateItem[] | undefined,
  event: { type?: string; object?: any },
): ResourceClaimTemplateItem[] {
  const items = Array.isArray(prev) ? [...prev] : []
  const obj = event?.object
  if (!obj) return items

  const normalized = normalizeWatchResourceClaimTemplateObject(obj)
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

export default function ResourceClaimTemplates() {
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

  const { data: resourceClaimTemplates, isLoading } = useQuery({
    queryKey: ['gpu', 'resourceclaimtemplates', selectedNamespace],
    queryFn: () => (
      selectedNamespace === 'all'
        ? api.getAllResourceClaimTemplates(false)
        : api.getResourceClaimTemplates(selectedNamespace, false)
    ),
  })
  const { has } = usePermission()
  const canCreate = has('resource.resourceclaimtemplate.create')

  useKubeWatchList({
    enabled: true,
    queryKey: ['gpu', 'resourceclaimtemplates', selectedNamespace],
    path: selectedNamespace === 'all'
      ? '/api/v1/resourceclaimtemplates'
      : `/api/v1/namespaces/${selectedNamespace}/resourceclaimtemplates`,
    query: 'watch=1',
    applyEvent: (prev, event) => applyResourceClaimTemplateWatchEvent(prev as ResourceClaimTemplateItem[] | undefined, event),
    onEvent: (event) => {
      if (event?.type === 'DELETED') return
      const name = event?.object?.name || event?.object?.metadata?.name
      const ns = event?.object?.namespace || event?.object?.metadata?.namespace
      if (name && ns) {
        queryClient.invalidateQueries({ queryKey: ['resourceclaimtemplate-describe', ns, name] })
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

  const filteredResourceClaimTemplates = useMemo(() => {
    if (!Array.isArray(resourceClaimTemplates)) return [] as ResourceClaimTemplateItem[]
    if (!searchQuery.trim()) return resourceClaimTemplates
    const q = searchQuery.toLowerCase()
    return resourceClaimTemplates.filter((item) => (
      item.name.toLowerCase().includes(q)
      || item.namespace.toLowerCase().includes(q)
    ))
  }, [resourceClaimTemplates, searchQuery])

  const summary = useMemo(() => {
    return { total: filteredResourceClaimTemplates.length }
  }, [filteredResourceClaimTemplates])

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

  const sortedResourceClaimTemplates = useMemo(() => {
    if (!sortKey) return filteredResourceClaimTemplates
    const list = [...filteredResourceClaimTemplates]

    const getValue = (item: ResourceClaimTemplateItem): string | number => {
      switch (sortKey) {
        case 'name':
          return item.name
        case 'namespace':
          return item.namespace
        case 'requests':
          return item.request_count || 0
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
  }, [filteredResourceClaimTemplates, sortDir, sortKey])

  const rowsPerPage = useAdaptiveRowsPerPage(tableContainerRef, {
    recalculationKey: sortedResourceClaimTemplates.length,
  })
  const totalPages = Math.max(1, Math.ceil(sortedResourceClaimTemplates.length / rowsPerPage))

  useEffect(() => {
    setCurrentPage(1)
  }, [searchQuery, selectedNamespace])

  useEffect(() => {
    if (currentPage > totalPages) setCurrentPage(totalPages)
  }, [currentPage, totalPages])

  const pagedResourceClaimTemplates = useMemo(() => {
    const start = (currentPage - 1) * rowsPerPage
    return sortedResourceClaimTemplates.slice(start, start + rowsPerPage)
  }, [sortedResourceClaimTemplates, currentPage, rowsPerPage])

  // 플로팅 AI 위젯용 스냅샷 (DRA)
  const aiSnapshot = useMemo(() => {
    if (!Array.isArray(resourceClaimTemplates) || resourceClaimTemplates.length === 0) return null
    const nsLabel = selectedNamespace === 'all' ? '전체 네임스페이스' : selectedNamespace
    const total = resourceClaimTemplates.length
    return {
      source: 'base' as const,
      summary: `${nsLabel} ResourceClaimTemplate ${total}개 (DRA)`,
      data: {
        filters: { namespace: selectedNamespace, search: searchQuery || undefined },
        stats: { total },
        ...summarizeList(pagedResourceClaimTemplates as unknown as Record<string, unknown>[], {
          total: sortedResourceClaimTemplates.length,
          currentPage,
          pageSize: rowsPerPage,
          topN: rowsPerPage,
          pickFields: ['name', 'namespace'],
          linkBuilder: (r) => {
            const rct = r as unknown as ResourceClaimTemplateItem
            return buildResourceLink('ResourceClaimTemplate', rct.namespace, rct.name)
          },
        }),
      },
    }
  }, [resourceClaimTemplates, pagedResourceClaimTemplates, sortedResourceClaimTemplates.length, currentPage, rowsPerPage, selectedNamespace, searchQuery])

  useAIContext(aiSnapshot, [aiSnapshot])

  const handleRefresh = async () => {
    if (isRefreshing) return
    setIsRefreshing(true)
    try {
      const data = selectedNamespace === 'all'
        ? await api.getAllResourceClaimTemplates(true)
        : await api.getResourceClaimTemplates(selectedNamespace, true)
      queryClient.removeQueries({ queryKey: ['gpu', 'resourceclaimtemplates', selectedNamespace] })
      queryClient.setQueryData(['gpu', 'resourceclaimtemplates', selectedNamespace], data)
    } catch (error) {
      console.error('ResourceClaimTemplates refresh failed:', error)
    }
    setTimeout(() => setIsRefreshing(false), 500)
  }

  const createResourceClaimTemplateYamlTemplate = useMemo(() => {
    const ns = selectedNamespace !== 'all' ? selectedNamespace : 'default'
    return `apiVersion: resource.k8s.io/v1beta1
kind: ResourceClaimTemplate
metadata:
  name: example-gpu-claim-template
  namespace: ${ns}
spec:
  spec:
    devices:
      requests:
        - name: gpu
          deviceClassName: example-gpu-class
`
  }, [selectedNamespace])

  const showNamespaceColumn = selectedNamespace === 'all'

  return (
    <div className="flex flex-col h-[calc(100vh-4rem)] gap-4">
      <div className="flex items-center justify-between shrink-0">
        <div>
          <h1 className="text-3xl font-bold text-white">{tr('resourceClaimTemplatesPage.title', 'Resource Claim Templates')}</h1>
          <p className="mt-2 text-slate-400">{tr('resourceClaimTemplatesPage.subtitle', 'Manage DRA ResourceClaimTemplate resources.')}</p>
        </div>
        <div className="flex items-center gap-2">
          {canCreate && (
            <button
              type="button"
              onClick={() => setCreateDialogOpen(true)}
              className="btn btn-primary flex items-center gap-2"
            >
              <Plus className="w-4 h-4" />
              {tr('resourceClaimTemplatesPage.create', 'Create ResourceClaimTemplate')}
            </button>
          )}
          <button
            type="button"
            onClick={handleRefresh}
            disabled={isRefreshing}
            title={tr('resourceClaimTemplatesPage.refreshTitle', 'Force refresh')}
            className="btn btn-primary flex items-center gap-2 disabled:opacity-50 disabled:cursor-not-allowed"
          >
            <RefreshCw className={`w-4 h-4 ${isRefreshing ? 'animate-spin' : ''}`} />
            {tr('resourceClaimTemplatesPage.refresh', 'Refresh')}
          </button>
        </div>
      </div>

      <div className="grid grid-cols-1 xl:grid-cols-3 gap-3 shrink-0">
        <div className="xl:col-span-2">
          <div className="relative">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-5 h-5 text-slate-400" />
            <input
              type="text"
              placeholder={tr('resourceClaimTemplatesPage.searchPlaceholder', 'Search ResourceClaimTemplates by name...')}
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
              {selectedNamespace === 'all' ? tr('resourceClaimTemplatesPage.allNamespaces', 'All namespaces') : selectedNamespace}
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
                <span className={selectedNamespace === 'all' ? 'font-medium' : ''}>{tr('resourceClaimTemplatesPage.allNamespaces', 'All namespaces')}</span>
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

      <div className="grid grid-cols-1 gap-3 shrink-0">
        <div className="rounded-lg border border-slate-700 bg-slate-900/50 px-4 py-3">
          <p className="text-[11px] sm:text-xs leading-4 whitespace-nowrap text-slate-400">{tr('resourceClaimTemplatesPage.stats.total', 'Total')}</p>
          <p className="text-lg text-white font-semibold mt-1">{summary.total}</p>
        </div>
      </div>

      {searchQuery && (
        <p className="text-sm text-slate-400 shrink-0">
          {tr('resourceClaimTemplatesPage.matchCount', '{{count}} ResourceClaimTemplate{{suffix}} match.', {
            count: filteredResourceClaimTemplates.length,
            suffix: filteredResourceClaimTemplates.length === 1 ? '' : 's',
          })}
        </p>
      )}

      <div ref={tableContainerRef} className="card flex-1 min-h-0 flex flex-col">
        <div className="overflow-x-auto flex-1 min-h-0">
          <table className="w-full text-sm min-w-[800px] table-fixed">
            <thead className="text-slate-400">
              <tr>
                {showNamespaceColumn && (
                  <th className="text-left py-3 px-4 w-[200px] cursor-pointer" onClick={() => handleSort('namespace')}>
                    <span className="inline-flex items-center gap-1">{tr('resourceClaimTemplatesPage.table.namespace', 'Namespace')}{renderSortIcon('namespace')}</span>
                  </th>
                )}
                <th className="text-left py-3 px-4 w-[280px] cursor-pointer" onClick={() => handleSort('name')}>
                  <span className="inline-flex items-center gap-1">{tr('resourceClaimTemplatesPage.table.name', 'Name')}{renderSortIcon('name')}</span>
                </th>
                <th className="text-left py-3 px-4 w-[120px] cursor-pointer" onClick={() => handleSort('requests')}>
                  <span className="inline-flex items-center gap-1">{tr('resourceClaimTemplatesPage.table.requests', 'Requests')}{renderSortIcon('requests')}</span>
                </th>
                <th className="text-left py-3 px-4 w-[100px] cursor-pointer" onClick={() => handleSort('age')}>
                  <span className="inline-flex items-center gap-1">{tr('resourceClaimTemplatesPage.table.age', 'Age')}{renderSortIcon('age')}</span>
                </th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-700">
              {pagedResourceClaimTemplates.map((item) => (
                <tr
                  key={`${item.namespace}/${item.name}`}
                  className="text-slate-200 hover:bg-slate-800/60 cursor-pointer"
                  onClick={() => openDetail({
                    kind: 'ResourceClaimTemplate',
                    name: item.name,
                    namespace: item.namespace,
                  })}
                >
                  {showNamespaceColumn && <td className="py-3 px-4 text-xs font-mono"><span className="block truncate">{item.namespace}</span></td>}
                  <td className="py-3 px-4 font-medium text-white"><span className="block truncate">{item.name}</span></td>
                  <td className="py-3 px-4 text-xs font-mono">{item.request_count || 0}</td>
                  <td className="py-3 px-4 text-xs font-mono">{formatAge(item.created_at)}</td>
                </tr>
              ))}
              {isLoading && (
                <tr>
                  <td colSpan={showNamespaceColumn ? 4 : 3} className="py-10 px-4 text-center text-slate-400">
                    <div className="inline-flex items-center gap-2">
                      <Loader2 className="w-4 h-4 animate-spin" />
                      Loading...
                    </div>
                  </td>
                </tr>
              )}

              {sortedResourceClaimTemplates.length === 0 && !isLoading && (
                <tr>
                  <td colSpan={showNamespaceColumn ? 4 : 3} className="py-6 px-4 text-center text-slate-400">
                    {tr('resourceClaimTemplatesPage.noResults', 'No ResourceClaimTemplates found.')}
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>

        {sortedResourceClaimTemplates.length > 0 && (
          <div className="flex items-center justify-between px-4 py-3 border-t border-slate-700 shrink-0">
            <div className="text-xs text-slate-400">
              {tr('common.paginationRange', 'Showing {{start}}-{{end}} of {{total}}', {
                start: (currentPage - 1) * rowsPerPage + 1,
                end: Math.min(currentPage * rowsPerPage, sortedResourceClaimTemplates.length),
                total: sortedResourceClaimTemplates.length,
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
          title={tr('resourceClaimTemplatesPage.createTitle', 'Create ResourceClaimTemplate from YAML')}
          initialYaml={createResourceClaimTemplateYamlTemplate}
          namespace={selectedNamespace !== 'all' ? selectedNamespace : undefined}
          onClose={() => setCreateDialogOpen(false)}
          onCreated={() => {
            queryClient.invalidateQueries({ queryKey: ['gpu', 'resourceclaimtemplates'] })
          }}
        />
      )}
    </div>
  )
}
