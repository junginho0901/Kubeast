import { useEffect, useMemo, useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { useTranslation, Trans } from 'react-i18next'
import { api } from '@/services/api'
import type { AdmissionPolicyInfo } from '@/services/api/types'
import { useResourceDetail } from '@/components/ResourceDetailContext'
import { useAdaptiveTable } from '@/hooks/useAdaptiveTable'
import { ageSeconds as parseAgeSeconds, formatAge } from '@/utils/time'
import { AdaptiveTableFillerRows } from '@/components/AdaptiveTableFillerRows'
import { ListPager } from '@/components/ListPager'
import { TableEmptyRow } from '@/components/TableEmptyRow'
import { useAIContext } from '@/hooks/useAIContext'
import { useClusterFeatures } from '@/hooks/usePrometheusQuery'
import { summarizeList } from '@/utils/aiContext/summarizeList'
import { buildResourceLink } from '@/utils/resourceLink'
import { Loader2, ChevronDown, ChevronUp, RefreshCw, Search } from 'lucide-react'

// Cluster → Validating / Mutating Admission Policies: the admissionregistration.k8s.io/v1
// policies with their bindings, read-only (create and edit go through YAML).
// A cluster without the v1 API lists nothing and says "not installed".

export type AdmissionPolicyKind = 'ValidatingAdmissionPolicy' | 'MutatingAdmissionPolicy'
type SortKey = null | 'name' | 'rules' | 'bindings' | 'age'

const PLURAL: Record<AdmissionPolicyKind, string> = {
  ValidatingAdmissionPolicy: 'validatingadmissionpolicies',
  MutatingAdmissionPolicy: 'mutatingadmissionpolicies',
}

function rulesOf(item: AdmissionPolicyInfo): number {
  return item.validations_count ?? item.mutations_count ?? 0
}

function toRawJson(kind: AdmissionPolicyKind, item: AdmissionPolicyInfo): Record<string, unknown> {
  return {
    apiVersion: 'admissionregistration.k8s.io/v1',
    kind,
    metadata: { name: item.name, labels: item.labels || {}, creationTimestamp: item.created_at },
  }
}

export default function AdmissionPolicies({ kind }: { kind: AdmissionPolicyKind }) {
  const queryClient = useQueryClient()
  const { t } = useTranslation()
  const policiesReadOnly = !!useClusterFeatures().data?.admissionPolicies?.readOnly
  const tr = (key: string, fallback: string, options?: Record<string, any>) =>
    t(key, { defaultValue: fallback, ...options })
  const { open: openDetail } = useResourceDetail()
  const validating = kind === 'ValidatingAdmissionPolicy'
  const plural = PLURAL[kind]
  const ns = validating ? 'admissionPolicies.validating' : 'admissionPolicies.mutating'

  const [searchQuery, setSearchQuery] = useState('')
  const [isRefreshing, setIsRefreshing] = useState(false)
  const [sortKey, setSortKey] = useState<SortKey>(null)
  const [sortDir, setSortDir] = useState<'asc' | 'desc'>('asc')
  const [currentPage, setCurrentPage] = useState(1)

  const fetchList = (force: boolean) =>
    validating ? api.getValidatingAdmissionPolicies(force) : api.getMutatingAdmissionPolicies(force)
  const { data: items, isLoading } = useQuery({
    queryKey: ['cluster', plural],
    queryFn: () => fetchList(false),
  })

  const filtered = useMemo(() => {
    if (!Array.isArray(items)) return [] as AdmissionPolicyInfo[]
    if (!searchQuery.trim()) return items
    const q = searchQuery.toLowerCase()
    return items.filter((item) => item.name.toLowerCase().includes(q) || item.bindings.some((b) => b.toLowerCase().includes(q)))
  }, [items, searchQuery])

  const summary = useMemo(() => ({
    total: filtered.length,
    bindings: filtered.reduce((n, item) => n + item.bindings_count, 0),
  }), [filtered])

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

  const sorted = useMemo(() => {
    if (!sortKey) return filtered
    const list = [...filtered]
    const getValue = (item: AdmissionPolicyInfo): string | number => {
      switch (sortKey) {
        case 'name': return item.name
        case 'rules': return rulesOf(item)
        case 'bindings': return item.bindings_count
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
  }, [filtered, sortDir, sortKey])

  const { containerRef: tableContainerRef, bodyRef: tableBodyRef, theadRef, firstRowRef, rowsPerPage } = useAdaptiveTable({
    recalculationKey: sorted.length,
  })
  const totalPages = Math.max(1, Math.ceil(sorted.length / rowsPerPage))

  useEffect(() => {
    setCurrentPage(1)
  }, [searchQuery])

  useEffect(() => {
    if (currentPage > totalPages) setCurrentPage(totalPages)
  }, [currentPage, totalPages])

  const paged = useMemo(() => {
    const start = (currentPage - 1) * rowsPerPage
    return sorted.slice(start, start + rowsPerPage)
  }, [sorted, currentPage, rowsPerPage])

  const aiSnapshot = useMemo(() => {
    if (!Array.isArray(items)) return null
    return {
      source: 'base' as const,
      summary: `${kind} ${items.length}개`,
      data: {
        filters: { search: searchQuery || undefined },
        stats: { total: items.length, bindings: items.reduce((n, item) => n + item.bindings_count, 0) },
        ...summarizeList(paged as unknown as Record<string, unknown>[], {
          total: sorted.length,
          currentPage,
          pageSize: rowsPerPage,
          topN: rowsPerPage,
          pickFields: ['name', 'failure_policy', 'param_kind', 'bindings_count', validating ? 'validations_count' : 'mutations_count'],
          linkBuilder: (w) => buildResourceLink(kind, undefined, (w as unknown as AdmissionPolicyInfo).name),
        }),
      },
    }
  }, [items, paged, sorted.length, currentPage, rowsPerPage, searchQuery, kind, validating])

  useAIContext(aiSnapshot, [aiSnapshot])

  const handleRefresh = async () => {
    if (isRefreshing) return
    setIsRefreshing(true)
    try {
      const data = await fetchList(true)
      queryClient.removeQueries({ queryKey: ['cluster', plural] })
      queryClient.setQueryData(['cluster', plural], data)
    } catch (error) {
      console.error(`${kind} refresh failed:`, error)
    }
    setTimeout(() => setIsRefreshing(false), 500)
  }

  const columnCount = 6
  return (
    <div className="flex flex-col h-[calc(100vh-4rem)] gap-4">
      <div className="flex items-center justify-between shrink-0">
        <div>
          <h1 className="text-3xl font-bold text-white">
            {validating
              ? tr('admissionPolicies.validating.title', 'Validating Admission Policies')
              : tr('admissionPolicies.mutating.title', 'Mutating Admission Policies')}
          </h1>
          <p className="mt-2 text-slate-400">
            {validating
              ? tr('admissionPolicies.validating.subtitle', 'CEL policies that validate API requests in the API server, with their bindings. Read-only here; create or change them through YAML.')
              : tr('admissionPolicies.mutating.subtitle', 'CEL policies that mutate API requests in the API server, with their bindings. Read-only here; create or change them through YAML.')}
            {policiesReadOnly && <> {tr('admissionPolicies.readOnlyOn', 'In this installation YAML apply is off for policies too (features.admissionPolicies.readOnly): change them in Git.')}</>}
          </p>
        </div>
        <button
          type="button"
          onClick={handleRefresh}
          disabled={isRefreshing}
          title={tr('admissionPolicies.refreshTitle', 'Force refresh')}
          className="btn btn-primary flex items-center gap-2 disabled:opacity-50 disabled:cursor-not-allowed"
        >
          <RefreshCw className={`w-4 h-4 ${isRefreshing ? 'animate-spin' : ''}`} />
          {tr('admissionPolicies.refresh', 'Refresh')}
        </button>
      </div>

      <div className="shrink-0">
        <div className="relative">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-5 h-5 text-slate-400" />
          <input
            type="text"
            placeholder={tr('admissionPolicies.searchPlaceholder', 'Search by policy or binding name...')}
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            data-testid="admission-policies-search"
            className="h-12 w-full pl-10 pr-4 bg-slate-700 border border-slate-600 rounded-lg text-sm text-white placeholder-slate-400 focus:outline-hidden focus:ring-2 focus:ring-primary-500 focus:border-transparent"
          />
        </div>
      </div>

      <div className="grid grid-cols-2 gap-3 shrink-0">
        <div className="rounded-lg border border-slate-700 bg-slate-900/50 px-4 py-3">
          <p className="text-[11px] sm:text-xs leading-4 whitespace-nowrap text-slate-400">{tr('admissionPolicies.stats.total', 'Total Policies')}</p>
          <p className="text-lg text-white font-semibold mt-1" data-testid="admission-policies-total">{summary.total}</p>
        </div>
        <div className="rounded-lg border border-slate-700 bg-slate-900/50 px-4 py-3">
          <p className="text-[11px] sm:text-xs leading-4 whitespace-nowrap text-slate-400">{tr('admissionPolicies.stats.bindings', 'Total Bindings')}</p>
          <p className="text-lg text-white font-semibold mt-1">{summary.bindings}</p>
        </div>
      </div>

      {searchQuery && (
        <p className="text-sm text-slate-400 shrink-0">
          {tr('admissionPolicies.matchCount', '{{count}} polic{{suffix}} match.', {
            count: filtered.length,
            suffix: filtered.length === 1 ? 'y' : 'ies',
          })}
        </p>
      )}

      <div ref={tableContainerRef} className="card flex-1 min-h-0 flex flex-col">
        <div ref={tableBodyRef} className="overflow-x-auto flex-1 min-h-0">
          <table className="w-full text-sm min-w-[760px] table-fixed" data-testid="admission-policies-table">
            <thead ref={theadRef} className="text-slate-400">
              <tr>
                <th className="text-left py-3 px-4 w-[320px] cursor-pointer" onClick={() => handleSort('name')}>
                  <span className="inline-flex items-center gap-1">
                    {tr('admissionPolicies.table.name', 'Name')}{renderSortIcon('name')}
                  </span>
                </th>
                <th className="text-left py-3 px-4 w-[110px] cursor-pointer" onClick={() => handleSort('rules')}>
                  <span className="inline-flex items-center gap-1">
                    {validating ? tr('admissionPolicies.table.validations', 'Validations') : tr('admissionPolicies.table.mutations', 'Mutations')}{renderSortIcon('rules')}
                  </span>
                </th>
                <th className="col-optional text-left py-3 px-4 w-[220px]">{tr('admissionPolicies.table.paramKind', 'Param kind')}</th>
                <th className="text-left py-3 px-4 w-[100px] cursor-pointer" onClick={() => handleSort('bindings')}>
                  <span className="inline-flex items-center gap-1">
                    {tr('admissionPolicies.table.bindings', 'Bindings')}{renderSortIcon('bindings')}
                  </span>
                </th>
                <th className="text-left py-3 px-4 w-[120px]">{tr('admissionPolicies.table.failurePolicy', 'Failure policy')}</th>
                <th className="col-low text-left py-3 px-4 w-[100px] cursor-pointer" onClick={() => handleSort('age')}>
                  <span className="inline-flex items-center gap-1">
                    {tr('admissionPolicies.table.age', 'Age')}{renderSortIcon('age')}
                  </span>
                </th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-700">
              {paged.map((item, idx) => (
                <tr
                  ref={idx === 0 ? firstRowRef : undefined}
                  key={item.name}
                  data-testid="admission-policy-row"
                  className="text-slate-200 hover:bg-slate-800/60 cursor-pointer"
                  onClick={() => openDetail({ kind, name: item.name, rawJson: toRawJson(kind, item) })}
                >
                  <td className="py-3 px-4 font-medium text-white"><span className="block truncate">{item.name}</span></td>
                  <td className="py-3 px-4 text-xs font-mono">{rulesOf(item)}</td>
                  <td className="col-optional py-3 px-4 text-xs font-mono"><span className="block truncate" title={item.param_kind || undefined}>{item.param_kind || '-'}</span></td>
                  <td className="py-3 px-4 text-xs font-mono" title={item.bindings.join(', ') || undefined}>{item.bindings_count}</td>
                  <td className="py-3 px-4 text-xs">{item.failure_policy}</td>
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
              {sorted.length === 0 && !isLoading && (
                <TableEmptyRow colSpan={columnCount} resource={plural} searching={!!searchQuery.trim()} />
              )}
            </tbody>
            <AdaptiveTableFillerRows count={rowsPerPage - paged.length} columnCount={columnCount} />
          </table>
        </div>
        <ListPager currentPage={currentPage} totalPages={totalPages} total={sorted.length} rowsPerPage={rowsPerPage} onPageChange={setCurrentPage} />
      </div>
      <span className="hidden" data-testid="admission-policies-kind">{ns}</span>
    </div>
  )
}
