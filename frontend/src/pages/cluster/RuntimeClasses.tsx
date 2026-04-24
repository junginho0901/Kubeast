import { useEffect, useMemo, useRef, useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { useTranslation } from 'react-i18next'
import { api, type RuntimeClassInfo } from '@/services/api'
import { useKubeWatchList } from '@/services/useKubeWatchList'
import { useResourceDetail } from '@/components/ResourceDetailContext'
import ResourceYamlCreateDialog from '@/components/ResourceYamlCreateDialog'
import { useAdaptiveRowsPerPage } from '@/hooks/useAdaptiveRowsPerPage'
import { useAIContext } from '@/hooks/useAIContext'
import { usePermission } from '@/hooks/usePermission'
import { summarizeList } from '@/utils/aiContext/summarizeList'
import { buildResourceLink } from '@/utils/resourceLink'
import { Loader2, ChevronDown, ChevronUp, Plus, RefreshCw, Search } from 'lucide-react'

type SortKey = null | 'name' | 'handler' | 'age'

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

function normalizeWatchRuntimeClassObject(obj: any): RuntimeClassInfo {
  if (typeof obj?.name === 'string' && typeof obj?.handler === 'string' && typeof obj?.created_at === 'string') {
    return obj as RuntimeClassInfo
  }
  const metadata = obj?.metadata ?? {}

  return {
    name: metadata?.name ?? obj?.name ?? '',
    handler: obj?.handler ?? '',
    overhead: obj?.overhead ?? undefined,
    scheduling: obj?.scheduling ?? undefined,
    labels: metadata?.labels ?? obj?.labels ?? {},
    created_at: metadata?.creationTimestamp ?? obj?.created_at ?? '',
  }
}

function applyRuntimeClassWatchEvent(
  prev: RuntimeClassInfo[] | undefined,
  event: { type?: string; object?: any },
): RuntimeClassInfo[] {
  const items = Array.isArray(prev) ? [...prev] : []
  const obj = event?.object
  if (!obj) return items

  const normalized = normalizeWatchRuntimeClassObject(obj)
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

function runtimeClassToRawJson(rc: RuntimeClassInfo): Record<string, unknown> {
  return {
    apiVersion: 'node.k8s.io/v1',
    kind: 'RuntimeClass',
    metadata: {
      name: rc.name,
      labels: rc.labels || {},
      creationTimestamp: rc.created_at,
    },
    handler: rc.handler,
    overhead: rc.overhead,
    scheduling: rc.scheduling,
  }
}

export default function RuntimeClasses() {
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

  const { data: runtimeClasses, isLoading } = useQuery({
    queryKey: ['cluster', 'runtimeclasses'],
    queryFn: () => api.getRuntimeClasses(false),
  })
  const { has } = usePermission()
  const canCreate = has('resource.runtimeclass.create')

  useKubeWatchList({
    enabled: true,
    queryKey: ['cluster', 'runtimeclasses'],
    path: '/apis/node.k8s.io/v1/runtimeclasses',
    query: 'watch=1',
    applyEvent: (prev, event) => applyRuntimeClassWatchEvent(prev as RuntimeClassInfo[] | undefined, event),
  })

  const filteredRCs = useMemo(() => {
    if (!Array.isArray(runtimeClasses)) return [] as RuntimeClassInfo[]
    if (!searchQuery.trim()) return runtimeClasses
    const q = searchQuery.toLowerCase()
    return runtimeClasses.filter((rc) =>
      rc.name.toLowerCase().includes(q) ||
      (rc.handler || '').toLowerCase().includes(q),
    )
  }, [runtimeClasses, searchQuery])

  const summary = useMemo(() => {
    const total = filteredRCs.length
    const handlers = new Set(filteredRCs.map((rc) => rc.handler))
    return { total, uniqueHandlers: handlers.size }
  }, [filteredRCs])

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

  const sortedRCs = useMemo(() => {
    if (!sortKey) return filteredRCs
    const list = [...filteredRCs]

    const getValue = (rc: RuntimeClassInfo): string | number => {
      switch (sortKey) {
        case 'name': return rc.name
        case 'handler': return rc.handler
        case 'age': return parseAgeSeconds(rc.created_at)
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
  }, [filteredRCs, sortDir, sortKey])

  const rowsPerPage = useAdaptiveRowsPerPage(tableContainerRef, {
    recalculationKey: sortedRCs.length,
  })
  const totalPages = Math.max(1, Math.ceil(sortedRCs.length / rowsPerPage))

  useEffect(() => {
    setCurrentPage(1)
  }, [searchQuery])

  useEffect(() => {
    if (currentPage > totalPages) {
      setCurrentPage(totalPages)
    }
  }, [currentPage, totalPages])

  const pagedRCs = useMemo(() => {
    const start = (currentPage - 1) * rowsPerPage
    return sortedRCs.slice(start, start + rowsPerPage)
  }, [sortedRCs, currentPage, rowsPerPage])

  // 플로팅 AI 위젯용 스냅샷 (cluster-scoped)
  const aiSnapshot = useMemo(() => {
    if (!Array.isArray(runtimeClasses) || runtimeClasses.length === 0) return null
    const total = runtimeClasses.length
    return {
      source: 'base' as const,
      summary: `RuntimeClass ${total}개`,
      data: {
        filters: { search: searchQuery || undefined },
        stats: { total },
        ...summarizeList(pagedRCs as unknown as Record<string, unknown>[], {
          total: sortedRCs.length,
          currentPage,
          pageSize: rowsPerPage,
          topN: rowsPerPage,
          pickFields: ['name', 'handler'],
          linkBuilder: (r) => {
            const rc = r as unknown as RuntimeClassInfo
            return buildResourceLink('RuntimeClass', undefined, rc.name)
          },
        }),
      },
    }
  }, [runtimeClasses, pagedRCs, sortedRCs.length, currentPage, rowsPerPage, searchQuery])

  useAIContext(aiSnapshot, [aiSnapshot])

  const handleRefresh = async () => {
    if (isRefreshing) return
    setIsRefreshing(true)
    try {
      const data = await api.getRuntimeClasses(true)
      queryClient.removeQueries({ queryKey: ['cluster', 'runtimeclasses'] })
      queryClient.setQueryData(['cluster', 'runtimeclasses'], data)
    } catch (error) {
      console.error('RuntimeClasses refresh failed:', error)
    }
    setTimeout(() => setIsRefreshing(false), 500)
  }

  const createRCYamlTemplate = `apiVersion: node.k8s.io/v1
kind: RuntimeClass
metadata:
  name: sample-runtime-class
handler: runc
`

  return (
    <div className="flex flex-col h-[calc(100vh-4rem)] gap-4">
      <div className="flex items-center justify-between shrink-0">
        <div>
          <h1 className="text-3xl font-bold text-white">{tr('runtimeClasses.title', 'Runtime Classes')}</h1>
          <p className="mt-2 text-slate-400">
            {tr('runtimeClasses.subtitle', 'Manage container runtime configurations for the cluster.')}
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
              {tr('runtimeClasses.create', 'Create Runtime Class')}
            </button>
          )}
          <button
            type="button"
            onClick={handleRefresh}
            disabled={isRefreshing}
            title={tr('runtimeClasses.refreshTitle', 'Force refresh')}
            className="btn btn-primary flex items-center gap-2 disabled:opacity-50 disabled:cursor-not-allowed"
          >
            <RefreshCw className={`w-4 h-4 ${isRefreshing ? 'animate-spin' : ''}`} />
            {tr('runtimeClasses.refresh', 'Refresh')}
          </button>
        </div>
      </div>

      <div className="shrink-0">
        <div className="relative">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-5 h-5 text-slate-400" />
          <input
            type="text"
            placeholder={tr('runtimeClasses.searchPlaceholder', 'Search runtime classes by name or handler...')}
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            className="h-12 w-full pl-10 pr-4 bg-slate-700 border border-slate-600 rounded-lg text-sm text-white placeholder-slate-400 focus:outline-none focus:ring-2 focus:ring-primary-500 focus:border-transparent"
          />
        </div>
      </div>

      <div className="grid grid-cols-2 gap-3 shrink-0">
        <div className="rounded-lg border border-slate-700 bg-slate-900/50 px-4 py-3">
          <p className="text-[11px] sm:text-xs leading-4 whitespace-nowrap text-slate-400">{tr('runtimeClasses.stats.total', 'Total')}</p>
          <p className="text-lg text-white font-semibold mt-1">{summary.total}</p>
        </div>
        <div className="rounded-lg border border-slate-700 bg-slate-900/50 px-4 py-3">
          <p className="text-[11px] sm:text-xs leading-4 whitespace-nowrap text-slate-400">{tr('runtimeClasses.stats.uniqueHandlers', 'Unique Handlers')}</p>
          <p className="text-lg text-white font-semibold mt-1">{summary.uniqueHandlers}</p>
        </div>
      </div>

      {searchQuery && (
        <p className="text-sm text-slate-400 shrink-0">
          {tr('runtimeClasses.matchCount', '{{count}} runtime class{{suffix}} match.', {
            count: filteredRCs.length,
            suffix: filteredRCs.length === 1 ? '' : 'es',
          })}
        </p>
      )}

      <div ref={tableContainerRef} className="card flex-1 min-h-0 flex flex-col">
        <div className="overflow-x-auto flex-1 min-h-0">
          <table className="w-full text-sm min-w-[600px] table-fixed">
            <thead className="text-slate-400">
              <tr>
                <th className="text-left py-3 px-4 w-[300px] cursor-pointer" onClick={() => handleSort('name')}>
                  <span className="inline-flex items-center gap-1">
                    {tr('runtimeClasses.table.name', 'Name')}{renderSortIcon('name')}
                  </span>
                </th>
                <th className="text-left py-3 px-4 w-[250px] cursor-pointer" onClick={() => handleSort('handler')}>
                  <span className="inline-flex items-center gap-1">
                    {tr('runtimeClasses.table.handler', 'Handler')}{renderSortIcon('handler')}
                  </span>
                </th>
                <th className="text-left py-3 px-4 w-[100px] cursor-pointer" onClick={() => handleSort('age')}>
                  <span className="inline-flex items-center gap-1">
                    {tr('runtimeClasses.table.age', 'Age')}{renderSortIcon('age')}
                  </span>
                </th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-700">
              {pagedRCs.map((rc) => (
                <tr
                  key={rc.name}
                  className="text-slate-200 hover:bg-slate-800/60 cursor-pointer"
                  onClick={() => openDetail({
                    kind: 'RuntimeClass',
                    name: rc.name,
                    rawJson: runtimeClassToRawJson(rc),
                  })}
                >
                  <td className="py-3 px-4 font-medium text-white"><span className="block truncate">{rc.name}</span></td>
                  <td className="py-3 px-4 text-xs font-mono">{rc.handler}</td>
                  <td className="py-3 px-4 text-xs font-mono">{formatAge(rc.created_at)}</td>
                </tr>
              ))}
              {isLoading && (
                <tr>
                  <td colSpan={3} className="py-10 px-4 text-center text-slate-400">
                    <div className="inline-flex items-center gap-2">
                      <Loader2 className="w-4 h-4 animate-spin" />
                      Loading...
                    </div>
                  </td>
                </tr>
              )}

              {sortedRCs.length === 0 && !isLoading && (
                <tr>
                  <td colSpan={3} className="py-6 px-4 text-center text-slate-400">
                    {tr('runtimeClasses.noResults', 'No runtime classes found.')}
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
        {sortedRCs.length > 0 && (
          <div className="flex items-center justify-between px-4 py-3 border-t border-slate-700 shrink-0">
            <div className="text-xs text-slate-400">
              {tr('common.paginationRange', 'Showing {{start}}-{{end}} of {{total}}', {
                start: (currentPage - 1) * rowsPerPage + 1,
                end: Math.min(currentPage * rowsPerPage, sortedRCs.length),
                total: sortedRCs.length,
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
          title={tr('runtimeClasses.createTitle', 'Create Runtime Class from YAML')}
          initialYaml={createRCYamlTemplate}
          onClose={() => setCreateDialogOpen(false)}
          onCreated={() => {
            queryClient.invalidateQueries({ queryKey: ['cluster', 'runtimeclasses'] })
          }}
        />
      )}
    </div>
  )
}
