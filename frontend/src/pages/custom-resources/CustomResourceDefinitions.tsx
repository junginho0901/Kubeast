import { useEffect, useMemo, useRef, useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { useTranslation } from 'react-i18next'
import { api, type CRDInfo } from '@/services/api'
import { useKubeWatchList } from '@/services/useKubeWatchList'
import { useResourceDetail } from '@/components/ResourceDetailContext'
import ResourceYamlCreateDialog from '@/components/ResourceYamlCreateDialog'
import { useAdaptiveRowsPerPage } from '@/hooks/useAdaptiveRowsPerPage'
import { Loader2, ChevronDown, ChevronUp, Plus, RefreshCw, Search } from 'lucide-react'

type SortKey = null | 'name' | 'group' | 'version' | 'scope' | 'kind' | 'age'
type SummaryCard = [label: string, value: number, boxClass: string, labelClass: string]

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

function normalizeWatchCRDObject(obj: any): CRDInfo {
  if (
    typeof obj?.name === 'string' &&
    typeof obj?.group === 'string'
  ) {
    return obj as CRDInfo
  }

  const metadata = obj?.metadata ?? {}
  const spec = obj?.spec ?? {}
  const names = spec?.names ?? {}

  let version = ''
  if (Array.isArray(spec?.versions)) {
    const storageVer = spec.versions.find((v: any) => v.storage)
    version = storageVer?.name ?? spec.versions[0]?.name ?? ''
  }

  return {
    name: metadata?.name ?? obj?.name ?? '',
    group: spec?.group ?? '',
    version,
    scope: spec?.scope ?? '',
    kind: names?.kind ?? '',
    created_at: metadata?.creationTimestamp ?? obj?.created_at ?? '',
    labels: metadata?.labels ?? obj?.labels ?? null,
    annotations: metadata?.annotations ?? obj?.annotations ?? null,
  }
}

function applyCRDWatchEvent(
  prev: CRDInfo[] | undefined,
  event: { type?: string; object?: any },
): CRDInfo[] {
  const items = Array.isArray(prev) ? [...prev] : []
  const obj = event?.object
  if (!obj) return items

  const normalized = normalizeWatchCRDObject(obj)
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

export default function CustomResourceDefinitions() {
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

  const { data: crds, isLoading } = useQuery({
    queryKey: ['custom-resources', 'crds'],
    queryFn: () => api.getCRDs(false),
  })

  const { data: me } = useQuery({
    queryKey: ['me'],
    queryFn: api.me,
    staleTime: 30000,
  })
  const canCreate = me?.role === 'admin'

  useKubeWatchList({
    enabled: true,
    queryKey: ['custom-resources', 'crds'],
    path: '/apis/apiextensions.k8s.io/v1/customresourcedefinitions',
    query: 'watch=1',
    applyEvent: (prev, event) => applyCRDWatchEvent(prev as CRDInfo[] | undefined, event),
    onEvent: (event) => {
      if (event?.type === 'DELETED') return
      const name = event?.object?.name || event?.object?.metadata?.name
      if (name) {
        queryClient.invalidateQueries({ queryKey: ['crd-describe', name] })
      }
    },
  })

  const filteredItems = useMemo(() => {
    if (!Array.isArray(crds)) return [] as CRDInfo[]
    if (!searchQuery.trim()) return crds
    const q = searchQuery.toLowerCase()
    return crds.filter(
      (crd) =>
        crd.name.toLowerCase().includes(q) ||
        crd.group.toLowerCase().includes(q) ||
        crd.kind.toLowerCase().includes(q),
    )
  }, [crds, searchQuery])

  const summary = useMemo(() => {
    const total = filteredItems.length
    let namespaced = 0
    let cluster = 0
    for (const crd of filteredItems) {
      if (crd.scope === 'Namespaced') namespaced++
      else cluster++
    }
    return { total, namespaced, cluster }
  }, [filteredItems])

  const summaryCards = useMemo<SummaryCard[]>(
    () => [
      [tr('crdPage.stats.total', 'Total'), summary.total, 'border-slate-700 bg-slate-900/50', 'text-slate-400'],
      [tr('crdPage.stats.namespaced', 'Namespaced'), summary.namespaced, 'border-cyan-700/40 bg-cyan-900/10', 'text-cyan-300'],
      [tr('crdPage.stats.cluster', 'Cluster-scoped'), summary.cluster, 'border-purple-700/40 bg-purple-900/10', 'text-purple-300'],
    ],
    [summary.total, summary.namespaced, summary.cluster, tr],
  )

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

  const sortedItems = useMemo(() => {
    if (!sortKey) return filteredItems
    const list = [...filteredItems]
    const getValue = (crd: CRDInfo): string | number => {
      switch (sortKey) {
        case 'name': return crd.name
        case 'group': return crd.group
        case 'version': return crd.version
        case 'scope': return crd.scope
        case 'kind': return crd.kind
        case 'age': return parseAgeSeconds(crd.created_at)
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
  }, [filteredItems, sortDir, sortKey])

  const rowsPerPage = useAdaptiveRowsPerPage(tableContainerRef, { recalculationKey: sortedItems.length })
  const totalPages = Math.max(1, Math.ceil(sortedItems.length / rowsPerPage))

  useEffect(() => { setCurrentPage(1) }, [searchQuery])
  useEffect(() => { if (currentPage > totalPages) setCurrentPage(totalPages) }, [currentPage, totalPages])

  const pagedItems = useMemo(() => {
    const start = (currentPage - 1) * rowsPerPage
    return sortedItems.slice(start, start + rowsPerPage)
  }, [sortedItems, currentPage, rowsPerPage])

  const handleRefresh = async () => {
    if (isRefreshing) return
    setIsRefreshing(true)
    try {
      const data = await api.getCRDs(true)
      queryClient.removeQueries({ queryKey: ['custom-resources', 'crds'] })
      queryClient.setQueryData(['custom-resources', 'crds'], data)
    } catch (error) {
      console.error('CRDs refresh failed:', error)
    }
    setTimeout(() => setIsRefreshing(false), 500)
  }

  const createYamlTemplate = `apiVersion: apiextensions.k8s.io/v1
kind: CustomResourceDefinition
metadata:
  name: samples.example.com
spec:
  group: example.com
  names:
    kind: Sample
    listKind: SampleList
    plural: samples
    singular: sample
  scope: Namespaced
  versions:
    - name: v1
      served: true
      storage: true
      schema:
        openAPIV3Schema:
          type: object
          properties:
            spec:
              type: object
              properties:
                replicas:
                  type: integer
`

  return (
    <div className="flex flex-col h-[calc(100vh-4rem)] gap-4">
      <div className="flex items-center justify-between shrink-0">
        <div>
          <h1 className="text-3xl font-bold text-white">{tr('crdPage.title', 'Custom Resource Definitions')}</h1>
          <p className="mt-2 text-slate-400">{tr('crdPage.subtitle', 'Manage Custom Resource Definitions registered in the cluster.')}</p>
        </div>
        <div className="flex items-center gap-2">
          {canCreate && (
            <button type="button" onClick={() => setCreateDialogOpen(true)} className="btn btn-primary flex items-center gap-2">
              <Plus className="w-4 h-4" />
              {tr('crdPage.create', 'Create CRD')}
            </button>
          )}
          <button type="button" onClick={handleRefresh} disabled={isRefreshing} title={tr('crdPage.refreshTitle', 'Force refresh')} className="btn btn-primary flex items-center gap-2 disabled:opacity-50 disabled:cursor-not-allowed">
            <RefreshCw className={`w-4 h-4 ${isRefreshing ? 'animate-spin' : ''}`} />
            {tr('crdPage.refresh', 'Refresh')}
          </button>
        </div>
      </div>

      <div className="shrink-0">
        <div className="relative">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-5 h-5 text-slate-400" />
          <input type="text" placeholder={tr('crdPage.searchPlaceholder', 'Search by name, group, or kind...')} value={searchQuery} onChange={(e) => setSearchQuery(e.target.value)} className="h-12 w-full pl-10 pr-4 bg-slate-700 border border-slate-600 rounded-lg text-sm text-white placeholder-slate-400 focus:outline-none focus:ring-2 focus:ring-primary-500 focus:border-transparent" />
        </div>
      </div>

      <div className="grid grid-cols-3 gap-3 shrink-0">
        {summaryCards.map(([label, value, boxClass, labelClass]) => (
          <div key={label} className={`rounded-lg border px-4 py-3 ${boxClass}`}>
            <p className={`text-[11px] sm:text-xs leading-4 whitespace-nowrap ${labelClass}`}>{label}</p>
            <p className="text-lg text-white font-semibold mt-1">{value}</p>
          </div>
        ))}
      </div>

      {searchQuery && (
        <p className="text-sm text-slate-400 shrink-0">
          {tr('crdPage.matchCount', '{{count}} result(s) match.', { count: filteredItems.length })}
        </p>
      )}

      <div ref={tableContainerRef} className="card flex-1 min-h-0 flex flex-col">
        <div className="overflow-x-auto flex-1 min-h-0">
          <table className="w-full text-sm min-w-[900px] table-fixed">
            <thead className="text-slate-400">
              <tr>
                <th className="text-left py-3 px-4 cursor-pointer" onClick={() => handleSort('name')}>
                  <span className="inline-flex items-center gap-1">{tr('crdPage.table.name', 'Name')}{renderSortIcon('name')}</span>
                </th>
                <th className="text-left py-3 px-4 w-[180px] cursor-pointer" onClick={() => handleSort('group')}>
                  <span className="inline-flex items-center gap-1">{tr('crdPage.table.group', 'Group')}{renderSortIcon('group')}</span>
                </th>
                <th className="text-left py-3 px-4 w-[100px] cursor-pointer" onClick={() => handleSort('version')}>
                  <span className="inline-flex items-center gap-1">{tr('crdPage.table.version', 'Version')}{renderSortIcon('version')}</span>
                </th>
                <th className="text-left py-3 px-4 w-[120px] cursor-pointer" onClick={() => handleSort('scope')}>
                  <span className="inline-flex items-center gap-1">{tr('crdPage.table.scope', 'Scope')}{renderSortIcon('scope')}</span>
                </th>
                <th className="text-left py-3 px-4 w-[150px] cursor-pointer" onClick={() => handleSort('kind')}>
                  <span className="inline-flex items-center gap-1">{tr('crdPage.table.kind', 'Kind')}{renderSortIcon('kind')}</span>
                </th>
                <th className="text-left py-3 px-4 w-[100px] cursor-pointer" onClick={() => handleSort('age')}>
                  <span className="inline-flex items-center gap-1">{tr('crdPage.table.age', 'Age')}{renderSortIcon('age')}</span>
                </th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-700">
              {pagedItems.map((crd) => (
                <tr key={crd.name} className="text-slate-200 hover:bg-slate-800/60 cursor-pointer" onClick={() => openDetail({ kind: 'CustomResourceDefinition', name: crd.name })}>
                  <td className="py-3 px-4 font-medium text-white"><span className="block truncate">{crd.name}</span></td>
                  <td className="py-3 px-4 text-xs font-mono"><span className="block truncate">{crd.group}</span></td>
                  <td className="py-3 px-4 text-xs font-mono">{crd.version}</td>
                  <td className="py-3 px-4 text-xs">
                    <span className={`inline-flex px-2 py-0.5 rounded text-[11px] font-medium ${crd.scope === 'Namespaced' ? 'bg-cyan-900/40 text-cyan-300' : 'bg-purple-900/40 text-purple-300'}`}>
                      {crd.scope}
                    </span>
                  </td>
                  <td className="py-3 px-4 text-xs font-mono"><span className="block truncate">{crd.kind}</span></td>
                  <td className="py-3 px-4 text-xs font-mono">{formatAge(crd.created_at)}</td>
                </tr>
              ))}
              {isLoading && (
                <tr>
                  <td colSpan={6} className="py-10 px-4 text-center text-slate-400">
                    <div className="inline-flex items-center gap-2">
                      <Loader2 className="w-4 h-4 animate-spin" />
                      Loading...
                    </div>
                  </td>
                </tr>
              )}

              {sortedItems.length === 0 && !isLoading && (
                <tr>
                  <td colSpan={6} className="py-6 px-4 text-center text-slate-400">
                    {tr('crdPage.noResults', 'No custom resource definitions found.')}
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>

        {sortedItems.length > 0 && (
          <div className="flex items-center justify-between px-4 py-3 border-t border-slate-700 shrink-0">
            <div className="text-xs text-slate-400">
              {tr('common.paginationRange', 'Showing {{start}}-{{end}} of {{total}}', {
                start: (currentPage - 1) * rowsPerPage + 1,
                end: Math.min(currentPage * rowsPerPage, sortedItems.length),
                total: sortedItems.length,
              })}
            </div>
            <div className="flex items-center gap-2">
              <button type="button" onClick={() => setCurrentPage((prev) => Math.max(1, prev - 1))} disabled={currentPage <= 1} className="px-3 py-1.5 text-xs rounded border border-slate-600 text-slate-300 disabled:opacity-40 disabled:cursor-not-allowed hover:text-white hover:border-slate-500">
                {tr('common.prev', 'Prev')}
              </button>
              <span className="text-xs text-slate-300 min-w-[72px] text-center">{currentPage} / {totalPages}</span>
              <button type="button" onClick={() => setCurrentPage((prev) => Math.min(totalPages, prev + 1))} disabled={currentPage >= totalPages} className="px-3 py-1.5 text-xs rounded border border-slate-600 text-slate-300 disabled:opacity-40 disabled:cursor-not-allowed hover:text-white hover:border-slate-500">
                {tr('common.next', 'Next')}
              </button>
            </div>
          </div>
        )}
      </div>

      {createDialogOpen && (
        <ResourceYamlCreateDialog
          title={tr('crdPage.createTitle', 'Create CRD from YAML')}
          initialYaml={createYamlTemplate}
          onClose={() => setCreateDialogOpen(false)}
          onCreated={() => {
            queryClient.invalidateQueries({ queryKey: ['custom-resources', 'crds'] })
          }}
        />
      )}
    </div>
  )
}
