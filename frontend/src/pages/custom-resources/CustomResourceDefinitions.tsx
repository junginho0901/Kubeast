import { useEffect, useMemo, useState, useCallback } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { useTranslation, Trans } from 'react-i18next'
import { api, type CRDInfo } from '@/services/api'
import { useKubeWatchList } from '@/services/useKubeWatchList'
import { useResourceDetail } from '@/components/ResourceDetailContext'
import ResourceYamlCreateDialog from '@/components/ResourceYamlCreateDialog'
import { useAdaptiveTable } from '@/hooks/useAdaptiveTable'
import { ageSeconds as parseAgeSeconds, formatAge } from '@/utils/time'
import { AdaptiveTableFillerRows } from '@/components/AdaptiveTableFillerRows'
import { ListPager } from '@/components/ListPager'
import { TableEmptyRow } from '@/components/TableEmptyRow'
import { useAIContext } from '@/hooks/useAIContext'
import { useCanCreate } from '@/hooks/useCanCreate'
import { useRefresh } from '@/hooks/useRefresh'
import { RefreshFailure } from '@/components/RefreshFailure'
import { summarizeList } from '@/utils/aiContext/summarizeList'
import { buildResourceLink } from '@/utils/resourceLink'
import { Loader2, ChevronDown, ChevronUp, Plus, RefreshCw, Search } from 'lucide-react'
import { crdVersionsText } from './crdVersions'
import { applyCRDWatchEvent } from './crdWatchNormalize'
import { countsOf } from '@/utils/listCounts'

type SortKey = null | 'name' | 'group' | 'version' | 'scope' | 'kind' | 'age'
type SummaryCard = [label: string, value: number | string, boxClass: string, labelClass: string]

export default function CustomResourceDefinitions() {
  const queryClient = useQueryClient()
  const { t } = useTranslation()
  const tr = useCallback((key: string, fallback: string, options?: Record<string, any>) => t(key, { defaultValue: fallback, ...options }), [t])
  const { open: openDetail } = useResourceDetail()

  const [searchQuery, setSearchQuery] = useState('')
  const [sortKey, setSortKey] = useState<SortKey>(null)
  const [sortDir, setSortDir] = useState<'asc' | 'desc'>('asc')
  const [currentPage, setCurrentPage] = useState(1)
  const [createDialogOpen, setCreateDialogOpen] = useState(false)

  const { data: crds, isLoading } = useQuery({
    queryKey: ['custom-resources', 'crds'],
    queryFn: () => api.getCRDs(false),
  })
  const canCreate = useCanCreate('resource.crd.create', { group: 'apiextensions.k8s.io', resource: 'customresourcedefinitions' })

  useKubeWatchList({
    enabled: true,
    queryKey: ['custom-resources', 'crds'],
    path: '/apis/apiextensions.k8s.io/v1/customresourcedefinitions',
    query: 'watch=1',
    applyEvent: (prev, event) => applyCRDWatchEvent(prev as CRDInfo[] | undefined, event),
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
  const cards = countsOf(crds, summary)

  const summaryCards = useMemo<SummaryCard[]>(
    () => [
      [tr('crdPage.stats.total', 'Total'), cards.total, 'border-slate-700 bg-slate-900/50', 'text-slate-400'],
      [tr('crdPage.stats.namespaced', 'Namespaced'), cards.namespaced, 'border-slate-700 bg-slate-900/50', 'text-slate-400'],
      [tr('crdPage.stats.cluster', 'Cluster-scoped'), cards.cluster, 'border-slate-700 bg-slate-900/50', 'text-slate-400'],
    ],
    [cards.total, cards.namespaced, cards.cluster, tr],
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
        case 'version': return crdVersionsText(crd)
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

  const { containerRef: tableContainerRef, bodyRef: tableBodyRef, theadRef, firstRowRef, rowsPerPage } = useAdaptiveTable({ recalculationKey: sortedItems.length })
  const totalPages = Math.max(1, Math.ceil(sortedItems.length / rowsPerPage))

  useEffect(() => { setCurrentPage(1) }, [searchQuery])
  useEffect(() => { if (currentPage > totalPages) setCurrentPage(totalPages) }, [currentPage, totalPages])

  const pagedItems = useMemo(() => {
    const start = (currentPage - 1) * rowsPerPage
    return sortedItems.slice(start, start + rowsPerPage)
  }, [sortedItems, currentPage, rowsPerPage])

  // 플로팅 AI 위젯용 스냅샷 (cluster-scoped)
  const aiSnapshot = useMemo(() => {
    if (!Array.isArray(crds)) return null
    const total = crds.length
    return {
      source: 'base' as const,
      summary: `CustomResourceDefinition ${total}개`,
      data: {
        filters: { search: searchQuery || undefined },
        stats: { total },
        ...summarizeList(pagedItems as unknown as Record<string, unknown>[], {
          total: sortedItems.length,
          currentPage,
          pageSize: rowsPerPage,
          topN: rowsPerPage,
          pickFields: ['name', 'group', 'kind', 'scope', 'version', 'served_versions'],
          linkBuilder: (c) => {
            const crd = c as unknown as CRDInfo
            return buildResourceLink('CustomResourceDefinition', undefined, crd.name)
          },
        }),
      },
    }
  }, [crds, pagedItems, sortedItems.length, currentPage, rowsPerPage, searchQuery])

  useAIContext(aiSnapshot, [aiSnapshot])

  const { refresh: handleRefresh, refreshing: isRefreshing, failure: refreshFailure } = useRefresh(async () => {
    const data = await api.getCRDs(true)
    queryClient.removeQueries({ queryKey: ['custom-resources', 'crds'] })
    queryClient.setQueryData(['custom-resources', 'crds'], data)
  })

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
      <div className="page-head items-center shrink-0">
        <div>
          <h1 className="text-3xl font-semibold text-ink">{tr('crdPage.title', 'Custom Resource Definitions')}</h1>
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

      <RefreshFailure failure={refreshFailure} />

      <div className="shrink-0">
        <div className="relative">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-5 h-5 text-slate-400" />
          <input type="text" placeholder={tr('crdPage.searchPlaceholder', 'Search by name, group, or kind...')} value={searchQuery} onChange={(e) => setSearchQuery(e.target.value)} className="h-12 w-full pl-10 pr-4 bg-slate-700 border border-slate-600 rounded-lg text-sm text-ink placeholder-slate-400 focus:outline-hidden focus:ring-2 focus:ring-primary-500 focus:border-transparent" />
        </div>
      </div>

      <div className="grid grid-cols-3 gap-3 shrink-0">
        {summaryCards.map(([label, value, boxClass, labelClass]) => (
          <div key={label} className={`rounded-lg border px-4 py-3 ${boxClass}`}>
            <p className={`text-[11px] sm:text-xs leading-4 whitespace-nowrap ${labelClass}`}>{label}</p>
            <p className="text-lg text-ink font-semibold mt-1">{value}</p>
          </div>
        ))}
      </div>

      {searchQuery && (
        <p className="text-sm text-slate-400 shrink-0">
          {tr('crdPage.matchCount', '{{count}} result(s) match.', { count: filteredItems.length })}
        </p>
      )}

      <div ref={tableContainerRef} className="card flex-1 min-h-0 flex flex-col">
        <div ref={tableBodyRef} className="overflow-x-auto flex-1 min-h-0">
          <table className="w-full text-sm min-w-[900px] table-fixed">
            <thead ref={theadRef} className="text-slate-400">
              <tr>
                <th className="text-left py-3 px-4 cursor-pointer" onClick={() => handleSort('name')}>
                  <span className="inline-flex items-center gap-1">{tr('crdPage.table.name', 'Name')}{renderSortIcon('name')}</span>
                </th>
                <th className="text-left py-3 px-4 w-[180px] cursor-pointer" onClick={() => handleSort('group')}>
                  <span className="inline-flex items-center gap-1">{tr('crdPage.table.group', 'Group')}{renderSortIcon('group')}</span>
                </th>
                <th className="col-optional text-left py-3 px-4 w-[160px] cursor-pointer" onClick={() => handleSort('version')}>
                  <span className="inline-flex items-center gap-1">{tr('crdPage.table.versions', 'Versions')}{renderSortIcon('version')}</span>
                </th>
                <th className="text-left py-3 px-4 w-[120px] cursor-pointer" onClick={() => handleSort('scope')}>
                  <span className="inline-flex items-center gap-1">{tr('crdPage.table.scope', 'Scope')}{renderSortIcon('scope')}</span>
                </th>
                <th className="text-left py-3 px-4 w-[150px] cursor-pointer" onClick={() => handleSort('kind')}>
                  <span className="inline-flex items-center gap-1">{tr('crdPage.table.kind', 'Kind')}{renderSortIcon('kind')}</span>
                </th>
                <th className="col-low text-left py-3 px-4 w-[100px] cursor-pointer" onClick={() => handleSort('age')}>
                  <span className="inline-flex items-center gap-1">{tr('crdPage.table.age', 'Age')}{renderSortIcon('age')}</span>
                </th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-700">
              {pagedItems.map((crd, idx) => (
                <tr
                      ref={idx === 0 ? firstRowRef : undefined} key={crd.name} className="text-slate-200 hover:bg-slate-800/60 cursor-pointer" onClick={() => openDetail({ kind: 'CustomResourceDefinition', name: crd.name })}>
                  <td className="py-3 px-4 font-medium text-ink"><span className="block truncate">{crd.name}</span></td>
                  <td className="py-3 px-4 text-xs font-mono"><span className="block truncate">{crd.group}</span></td>
                  <td className="col-optional py-3 px-4 text-xs font-mono"><span className="block truncate" title={crdVersionsText(crd)}>{crdVersionsText(crd)}</span></td>
                  <td className="py-3 px-4 text-xs">
                    <span className={`inline-flex px-2 py-0.5 rounded-sm text-[11px] font-medium bg-slate-700 text-slate-300`}>
                      {crd.scope}
                    </span>
                  </td>
                  <td className="py-3 px-4 text-xs font-mono"><span className="block truncate">{crd.kind}</span></td>
                  <td className="col-low py-3 px-4 text-xs font-mono">{formatAge(crd.created_at)}</td>
                </tr>
              ))}
              {isLoading && (
                <tr>
                  <td colSpan={6} className="py-10 px-4 text-center text-slate-400">
                    <div className="inline-flex items-center gap-2">
                      <Loader2 className="w-4 h-4 animate-spin" />
                      
                      <Trans i18nKey="common.loading" />
                    </div>
                  </td>
                </tr>
              )}

              {sortedItems.length === 0 && !isLoading && (
                <TableEmptyRow colSpan={6} resource="custom-resources" searching={!!searchQuery.trim()} />
              )}
            </tbody>
              <AdaptiveTableFillerRows count={rowsPerPage - pagedItems.length} columnCount={6} />
          </table>
        </div>

        <ListPager currentPage={currentPage} totalPages={totalPages} total={sortedItems.length} rowsPerPage={rowsPerPage} onPageChange={setCurrentPage} />
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
