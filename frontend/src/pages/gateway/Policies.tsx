import { useCallback, useEffect, useMemo, useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { useTranslation, Trans } from 'react-i18next'
import { api, type GatewayPolicyItem, type GatewayPolicyKindInfo } from '@/services/api'
import { useResourceDetail } from '@/components/ResourceDetailContext'
import { useAdaptiveTable } from '@/hooks/useAdaptiveTable'
import { ageSeconds as parseAgeSeconds, formatAge } from '@/utils/time'
import { AdaptiveTableFillerRows } from '@/components/AdaptiveTableFillerRows'
import { ListPager } from '@/components/ListPager'
import { TableEmptyRow } from '@/components/TableEmptyRow'
import { useAIContext } from '@/hooks/useAIContext'
import { summarizeList } from '@/utils/aiContext/summarizeList'
import { buildResourceLink } from '@/utils/resourceLink'
import { Loader2, ChevronDown, ChevronUp, RefreshCw, Search } from 'lucide-react'
import CustomDropdown from '@/components/CustomDropdown'

// Gateway → Policies: one table of every policy object attached to Gateway
// API resources, whichever implementation owns the kind (label-discovered
// CRDs, the Envoy Gateway / Istio built-in table, configured extras). Rows
// open the generic custom-resource drawer (describe / YAML / delete); the
// upstream BackendTLSPolicy has its own drawer.

type SortKey = null | 'kind' | 'name' | 'namespace' | 'target' | 'age'
type SummaryCard = [label: string, value: number, boxClass: string, labelClass: string]

const QUERY_KEY = ['gateway', 'policies'] as const

function formatPolicyTargets(item: GatewayPolicyItem): string {
  const targets = item.targets || []
  if (targets.length === 0) return '-'
  return targets
    .map((t) => {
      const ns = t.namespace ? `${t.namespace}/` : ''
      const section = t.section ? `#${t.section}` : ''
      return `${t.kind || '?'} ${ns}${t.name || ''}${section}`
    })
    .join(', ')
}

export default function Policies() {
  const queryClient = useQueryClient()
  const { t } = useTranslation()
  const tr = useCallback((key: string, fallback: string, options?: Record<string, any>) => t(key, { defaultValue: fallback, ...options }), [t])
  const { open: openDetail } = useResourceDetail()

  const [searchQuery, setSearchQuery] = useState('')
  const [kindFilter, setKindFilter] = useState('')
  const [namespaceFilter, setNamespaceFilter] = useState('')
  const [isRefreshing, setIsRefreshing] = useState(false)
  const [sortKey, setSortKey] = useState<SortKey>(null)
  const [sortDir, setSortDir] = useState<'asc' | 'desc'>('asc')
  const [currentPage, setCurrentPage] = useState(1)

  const { data, isLoading } = useQuery({
    queryKey: QUERY_KEY,
    queryFn: () => api.getAllGatewayPolicies(),
  })
  const items = useMemo(() => (Array.isArray(data?.items) ? data.items : []), [data])
  const kinds = useMemo<GatewayPolicyKindInfo[]>(() => (Array.isArray(data?.kinds) ? data.kinds : []), [data])

  const uniqueKinds = useMemo(() => Array.from(new Set(items.map((i) => i.kind))).sort(), [items])
  const uniqueNamespaces = useMemo(() => Array.from(new Set(items.map((i) => i.namespace).filter(Boolean))).sort(), [items])

  const filteredItems = useMemo(() => {
    let result = items
    if (kindFilter) result = result.filter((i) => i.kind === kindFilter)
    if (namespaceFilter) result = result.filter((i) => i.namespace === namespaceFilter)
    if (searchQuery.trim()) {
      const q = searchQuery.toLowerCase()
      result = result.filter((i) => (
        i.name.toLowerCase().includes(q)
        || (i.namespace || '').toLowerCase().includes(q)
        || i.kind.toLowerCase().includes(q)
        || i.group.toLowerCase().includes(q)
        || formatPolicyTargets(i).toLowerCase().includes(q)
      ))
    }
    return result
  }, [items, kindFilter, namespaceFilter, searchQuery])

  const summary = useMemo(() => {
    const kindSet = new Set<string>()
    let accepted = 0
    for (const i of filteredItems) {
      kindSet.add(i.kind)
      if (i.accepted === true) accepted += 1
    }
    return { total: filteredItems.length, kinds: kindSet.size, accepted }
  }, [filteredItems])

  const summaryCards = useMemo<SummaryCard[]>(
    () => [
      [tr('policiesPage.stats.total', 'Total'), summary.total, 'border-slate-700 bg-slate-900/50', 'text-slate-400'],
      [tr('policiesPage.stats.kinds', 'Kinds'), summary.kinds, 'border-cyan-700/40 bg-cyan-900/10', 'text-cyan-300'],
      [tr('policiesPage.stats.accepted', 'Accepted'), summary.accepted, 'border-emerald-700/40 bg-emerald-900/10', 'text-emerald-300'],
    ],
    [summary.total, summary.kinds, summary.accepted, tr],
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
    const getValue = (i: GatewayPolicyItem): string | number => {
      switch (sortKey) {
        case 'kind': return i.kind
        case 'name': return i.name
        case 'namespace': return i.namespace || ''
        case 'target': return formatPolicyTargets(i)
        case 'age': return parseAgeSeconds(i.created_at)
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

  useEffect(() => { setCurrentPage(1) }, [searchQuery, kindFilter, namespaceFilter])
  useEffect(() => { if (currentPage > totalPages) setCurrentPage(totalPages) }, [currentPage, totalPages])

  const pagedItems = useMemo(() => {
    const start = (currentPage - 1) * rowsPerPage
    return sortedItems.slice(start, start + rowsPerPage)
  }, [sortedItems, currentPage, rowsPerPage])

  const aiSnapshot = useMemo(() => {
    if (items.length === 0) return null
    return {
      source: 'base' as const,
      summary: `Gateway 정책 ${items.length}개${kindFilter ? ` · ${kindFilter}` : ''}`,
      data: {
        filters: { kind: kindFilter || undefined, namespace: namespaceFilter || undefined, search: searchQuery || undefined },
        stats: { total: items.length, kinds: kinds.map((k) => `${k.kind} (${k.source}, ${k.count})`) },
        ...summarizeList(pagedItems as unknown as Record<string, unknown>[], {
          total: sortedItems.length,
          currentPage,
          pageSize: rowsPerPage,
          topN: rowsPerPage,
          pickFields: ['kind', 'name', 'namespace', 'targets', 'accepted'],
          linkBuilder: (i) => {
            const p = i as unknown as GatewayPolicyItem
            return buildResourceLink('CustomResource', p.namespace, p.name)
          },
        }),
      },
    }
  }, [items, kinds, pagedItems, sortedItems.length, currentPage, rowsPerPage, kindFilter, namespaceFilter, searchQuery])

  useAIContext(aiSnapshot, [aiSnapshot])

  const handleRefresh = async () => {
    if (isRefreshing) return
    setIsRefreshing(true)
    try {
      const fresh = await api.getAllGatewayPolicies()
      queryClient.setQueryData(QUERY_KEY, fresh)
    } catch (error) {
      console.error('gateway policies refresh failed:', error)
    }
    setTimeout(() => setIsRefreshing(false), 500)
  }

  const sourceLabel = (source: string) => {
    if (source === 'label') return tr('policiesPage.source.label', 'labelled CRD')
    if (source === 'configured') return tr('policiesPage.source.configured', 'configured')
    return tr('policiesPage.source.builtin', 'built-in')
  }

  const columnCount = 6

  return (
    <div className="flex flex-col h-[calc(100vh-4rem)] gap-4">
      <div className="flex items-center justify-between shrink-0">
        <div>
          <h1 className="text-3xl font-bold text-white">{tr('policiesPage.title', 'Policies')}</h1>
          <p className="mt-2 text-slate-400">{tr('policiesPage.subtitle', 'Policies attached to Gateway API objects, from every implementation installed on the cluster.')}</p>
        </div>
        <div className="flex items-center gap-2">
          <button type="button" onClick={handleRefresh} disabled={isRefreshing} title={tr('policiesPage.refreshTitle', 'Force refresh')} className="btn btn-primary flex items-center gap-2 disabled:opacity-50 disabled:cursor-not-allowed">
            <RefreshCw className={`w-4 h-4 ${isRefreshing ? 'animate-spin' : ''}`} />
            {tr('policiesPage.refresh', 'Refresh')}
          </button>
        </div>
      </div>

      <div className="flex gap-3 shrink-0">
        <div className="relative flex-1">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-5 h-5 text-slate-400" />
          <input type="text" placeholder={tr('policiesPage.searchPlaceholder', 'Search by name, namespace, kind, or target...')} value={searchQuery} onChange={(e) => setSearchQuery(e.target.value)} className="h-12 w-full pl-10 pr-4 bg-slate-700 border border-slate-600 rounded-lg text-sm text-white placeholder-slate-400 focus:outline-hidden focus:ring-2 focus:ring-primary-500 focus:border-transparent" />
        </div>
        <CustomDropdown
          size="lg"
          className="min-w-[180px]"
          testId="policies-kind"
          value={kindFilter}
          onChange={setKindFilter}
          options={[{ value: '', label: tr('policiesPage.allKinds', 'All kinds') }, ...uniqueKinds.map((k) => ({ value: k, label: k }))]}
        />
        <CustomDropdown
          size="lg"
          className="min-w-[180px]"
          testId="policies-namespace"
          value={namespaceFilter}
          onChange={setNamespaceFilter}
          options={[{ value: '', label: tr('policiesPage.allNamespaces', 'All namespaces') }, ...uniqueNamespaces.map((ns) => ({ value: ns, label: ns }))]}
        />
      </div>

      <div className="grid grid-cols-3 gap-3 shrink-0">
        {summaryCards.map(([label, value, boxClass, labelClass]) => (
          <div key={label} className={`rounded-lg border px-4 py-3 ${boxClass}`}>
            <p className={`text-[11px] sm:text-xs leading-4 whitespace-nowrap ${labelClass}`}>{label}</p>
            <p className="text-lg text-white font-semibold mt-1">{value}</p>
          </div>
        ))}
      </div>

      {/* Which kinds were scanned, where each came from, and any the caller may not list */}
      <div className="flex flex-wrap items-center gap-2 shrink-0 text-xs" data-testid="policy-kinds">
        <span className="text-slate-400">{tr('policiesPage.kinds.title', 'Scanned kinds')}:</span>
        {!isLoading && kinds.length === 0 && (
          <span className="text-slate-500">{tr('policiesPage.kinds.none', 'No policy kinds are installed on this cluster.')}</span>
        )}
        {kinds.map((k) => (
          <span
            key={`${k.group}/${k.plural}`}
            title={`${k.plural}.${k.group}/${k.version} · ${sourceLabel(k.source)}${k.error ? ` · ${k.error}` : ''}`}
            className={`inline-flex items-center gap-1 rounded-full border px-2 py-0.5 ${k.error ? 'border-amber-700/60 bg-amber-900/20 text-amber-300' : 'border-slate-700 bg-slate-800/60 text-slate-300'}`}
          >
            <span className="font-mono">{k.kind}</span>
            <span className="text-slate-500">{k.error ? (k.error === 'forbidden' ? tr('policiesPage.kinds.forbidden', 'no permission') : k.error) : k.count}</span>
          </span>
        ))}
      </div>

      {searchQuery && (
        <p className="text-sm text-slate-400 shrink-0">
          {tr('policiesPage.matchCount', '{{count}} result(s) match.', { count: filteredItems.length })}
        </p>
      )}

      <div ref={tableContainerRef} className="card flex-1 min-h-0 flex flex-col">
        <div ref={tableBodyRef} className="overflow-x-auto flex-1 min-h-0">
          <table className="w-full text-sm min-w-[900px] table-fixed">
            <thead ref={theadRef} className="text-slate-400">
              <tr>
                <th className="text-left py-3 px-4 w-[190px] cursor-pointer" onClick={() => handleSort('kind')}>
                  <span className="inline-flex items-center gap-1">{tr('policiesPage.table.kind', 'Kind')}{renderSortIcon('kind')}</span>
                </th>
                <th className="text-left py-3 px-4 cursor-pointer" onClick={() => handleSort('name')}>
                  <span className="inline-flex items-center gap-1">{tr('policiesPage.table.name', 'Name')}{renderSortIcon('name')}</span>
                </th>
                <th className="text-left py-3 px-4 w-[160px] cursor-pointer" onClick={() => handleSort('namespace')}>
                  <span className="inline-flex items-center gap-1">{tr('policiesPage.table.namespace', 'Namespace')}{renderSortIcon('namespace')}</span>
                </th>
                <th className="text-left py-3 px-4 cursor-pointer" onClick={() => handleSort('target')}>
                  <span className="inline-flex items-center gap-1">{tr('policiesPage.table.target', 'Target')}{renderSortIcon('target')}</span>
                </th>
                <th className="text-left py-3 px-4 w-[110px]">{tr('policiesPage.table.accepted', 'Accepted')}</th>
                <th className="col-low text-left py-3 px-4 w-[100px] cursor-pointer" onClick={() => handleSort('age')}>
                  <span className="inline-flex items-center gap-1">{tr('policiesPage.table.age', 'Age')}{renderSortIcon('age')}</span>
                </th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-700">
              {pagedItems.map((item, idx) => (
                <tr
                  ref={idx === 0 ? firstRowRef : undefined}
                  key={`${item.group}/${item.kind}/${item.namespace || '-'}/${item.name}`}
                  className="text-slate-200 hover:bg-slate-800/60 cursor-pointer"
                  onClick={() => openDetail(item.group === 'gateway.networking.k8s.io' && item.kind === 'BackendTLSPolicy'
                    ? { kind: 'BackendTLSPolicy', name: item.name, namespace: item.namespace }
                    : {
                        kind: 'CustomResourceInstance',
                        name: item.name,
                        namespace: item.namespace || undefined,
                        rawJson: { kind: item.kind, group: item.group, version: item.version, crd_name: `${item.plural}.${item.group}`, scope: item.scope },
                      })}
                >
                  <td className="py-3 px-4 text-xs font-mono" title={`${item.plural}.${item.group}/${item.version}`}><span className="block truncate">{item.kind}</span></td>
                  <td className="py-3 px-4 font-medium text-white"><span className="block truncate">{item.name}</span></td>
                  <td className="py-3 px-4 text-xs"><span className="block truncate">{item.namespace || '-'}</span></td>
                  <td className="py-3 px-4 text-xs font-mono"><span className="block truncate" title={formatPolicyTargets(item)}>{formatPolicyTargets(item)}</span></td>
                  <td className="py-3 px-4 text-xs">
                    {item.accepted === true && <span className="text-emerald-300">{tr('policiesPage.accepted.yes', 'Yes')}</span>}
                    {item.accepted === false && <span className="text-red-300">{tr('policiesPage.accepted.no', 'No')}</span>}
                    {item.accepted === undefined && <span className="text-slate-500">-</span>}
                  </td>
                  <td className="col-low py-3 px-4 text-xs font-mono">{formatAge(item.created_at)}</td>
                </tr>
              ))}
              {isLoading && (
                <tr>
                  <td colSpan={columnCount} className="py-10 px-4 text-center text-slate-400">
                    <div className="inline-flex items-center gap-2">
                      <Loader2 className="w-4 h-4 animate-spin" />
                      
                      <Trans i18nKey="common.loading" />
                    </div>
                  </td>
                </tr>
              )}
              {sortedItems.length === 0 && !isLoading && (
                <TableEmptyRow colSpan={columnCount} resource="gateway-policies" searching={!!searchQuery.trim()} />
              )}
            </tbody>
            <AdaptiveTableFillerRows count={rowsPerPage - pagedItems.length} columnCount={columnCount} />
          </table>
        </div>

        <ListPager currentPage={currentPage} totalPages={totalPages} total={sortedItems.length} rowsPerPage={rowsPerPage} onPageChange={setCurrentPage} />
      </div>
    </div>
  )
}
