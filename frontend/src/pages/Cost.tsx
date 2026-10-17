import { useEffect, useMemo, useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { useTranslation, Trans } from 'react-i18next'
import { api } from '@/services/api'
import type { CostAggregate, CostRow, CostWindow } from '@/services/api/types'
import { useAdaptiveTable } from '@/hooks/useAdaptiveTable'
import { AdaptiveTableFillerRows } from '@/components/AdaptiveTableFillerRows'
import { ListPager } from '@/components/ListPager'
import { TableEmptyRow } from '@/components/TableEmptyRow'
import CustomDropdown from '@/components/CustomDropdown'
import { useAIContext } from '@/hooks/useAIContext'
import { summarizeList } from '@/utils/aiContext/summarizeList'
import { formatMoney, formatPercent } from '@/utils/money'
import { formatTime } from '@/utils/time'
import { Loader2, ChevronDown, ChevronUp, RefreshCw, Search } from 'lucide-react'

// Cost: what each namespace or workload cost over a window, from the OpenCost in
// the selected cluster (k8s-service /cluster/cost, features.cost). A cluster
// without OpenCost says so instead of showing an empty table.

const WINDOWS: CostWindow[] = ['1h', '6h', '24h', '7d', '30d']
type SortKey = null | 'name' | 'cpu' | 'ram' | 'pv' | 'network' | 'total' | 'efficiency'

export default function Cost() {
  const { t } = useTranslation()
  const tr = (key: string, fallback: string, options?: Record<string, any>) =>
    t(key, { defaultValue: fallback, ...options })
  const queryClient = useQueryClient()
  const [win, setWin] = useState<CostWindow>('24h')
  const [aggregate, setAggregate] = useState<CostAggregate>('namespace')
  const [searchQuery, setSearchQuery] = useState('')
  const [isRefreshing, setIsRefreshing] = useState(false)
  const [sortKey, setSortKey] = useState<SortKey>(null)
  const [sortDir, setSortDir] = useState<'asc' | 'desc'>('asc')
  const [currentPage, setCurrentPage] = useState(1)

  const status = useQuery({
    queryKey: ['cluster', 'cost-status'],
    queryFn: () => api.getCostStatus(),
    staleTime: 60_000,
    retry: false,
  })
  const available = status.data?.available === true
  const notInstalled = status.isError || (status.isSuccess && !available)
  const cost = useQuery({
    queryKey: ['cluster', 'cost', win, aggregate],
    queryFn: () => api.getCost(win, aggregate),
    enabled: available,
    retry: false,
  })
  const rows = cost.data?.rows
  const totals = cost.data?.totals
  const currency = cost.data?.currency || 'USD'
  const byWorkload = aggregate === 'controller'

  const filtered = useMemo(() => {
    if (!Array.isArray(rows)) return [] as CostRow[]
    if (!searchQuery.trim()) return rows
    const q = searchQuery.toLowerCase()
    return rows.filter((r) => r.name.toLowerCase().includes(q) || r.namespace.toLowerCase().includes(q) || (r.kind || '').toLowerCase().includes(q))
  }, [rows, searchQuery])

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
    const getValue = (r: CostRow): string | number => {
      switch (sortKey) {
        case 'name': return r.name
        case 'cpu': return r.cpu_cost
        case 'ram': return r.ram_cost
        case 'pv': return r.pv_cost
        case 'network': return r.network_cost
        case 'total': return r.total_cost
        case 'efficiency': return r.total_efficiency
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
  }, [searchQuery, win, aggregate])

  useEffect(() => {
    if (currentPage > totalPages) setCurrentPage(totalPages)
  }, [currentPage, totalPages])

  const paged = useMemo(() => {
    const start = (currentPage - 1) * rowsPerPage
    return sorted.slice(start, start + rowsPerPage)
  }, [sorted, currentPage, rowsPerPage])

  const aiSnapshot = useMemo(() => {
    if (!cost.data) return null
    return {
      source: 'base' as const,
      summary: `Cost by ${aggregate}, window ${win}: ${cost.data.rows.length} rows, total ${formatMoney(cost.data.totals.total_cost, currency)}`,
      data: {
        filters: { window: win, aggregate, search: searchQuery || undefined, scoped: cost.data.scoped },
        stats: { ...cost.data.totals, currency, source: cost.data.source },
        ...summarizeList(paged as unknown as Record<string, unknown>[], {
          total: sorted.length,
          currentPage,
          pageSize: rowsPerPage,
          topN: rowsPerPage,
          pickFields: ['name', 'namespace', 'kind', 'total_cost', 'cpu_cost', 'ram_cost', 'pv_cost', 'network_cost', 'total_efficiency'],
        }),
      },
    }
  }, [cost.data, paged, sorted.length, currentPage, rowsPerPage, searchQuery, aggregate, win, currency])

  useAIContext(aiSnapshot, [aiSnapshot])

  const handleRefresh = async () => {
    if (isRefreshing) return
    setIsRefreshing(true)
    try {
      await queryClient.invalidateQueries({ queryKey: ['cluster', 'cost-status'] })
      await queryClient.invalidateQueries({ queryKey: ['cluster', 'cost'] })
    } catch (error) {
      console.error('cost refresh failed:', error)
    }
    setTimeout(() => setIsRefreshing(false), 500)
  }

  const rowName = (r: CostRow) => (r.name === '__unallocated__' ? tr('cost.noController', 'No controller') : r.name)
  // The server's reason (a cluster that refused the proxy for this user, OpenCost not answering): shown under the error row.
  const errorDetail = (cost.error as { response?: { data?: { detail?: string } } } | null)?.response?.data?.detail
  const money = (v: number | undefined) => formatMoney(v, currency)
  const columnCount = byWorkload ? 8 : 7
  const windowOptions = WINDOWS.map((w) => ({ value: w, label: tr(`cost.windows.${w}`, w), testId: `cost-window-opt-${w}` }))
  const tab = (value: CostAggregate, label: string) => (
    <button
      type="button"
      role="tab"
      aria-selected={aggregate === value}
      data-testid={`cost-aggregate-${value}`}
      onClick={() => setAggregate(value)}
      className={`h-8 px-3 text-sm rounded-md transition-colors ${aggregate === value ? 'bg-slate-700 text-white' : 'text-slate-400 hover:text-white hover:bg-slate-800'}`}
    >
      {label}
    </button>
  )

  return (
    <div className="flex flex-col h-[calc(100vh-4rem)] gap-4">
      <div className="flex items-center justify-between shrink-0">
        <div>
          <h1 className="text-3xl font-bold text-white">{tr('cost.title', 'Cost')}</h1>
          <p className="mt-2 text-slate-400">
            {tr('cost.subtitle', "What each namespace or workload cost over the window, as OpenCost allocates it from the cluster's Prometheus. Prices come from the cloud provider's price list, or OpenCost's default on-prem prices.")}
          </p>
        </div>
        <button
          type="button"
          onClick={handleRefresh}
          disabled={isRefreshing}
          title={tr('cost.refreshTitle', 'Force refresh')}
          className="btn btn-primary flex items-center gap-2 disabled:opacity-50 disabled:cursor-not-allowed"
        >
          <RefreshCw className={`w-4 h-4 ${isRefreshing ? 'animate-spin' : ''}`} />
          {tr('cost.refresh', 'Refresh')}
        </button>
      </div>

      {notInstalled ? (
        <div className="card p-6" data-testid="cost-not-installed">
          <p className="text-slate-200">
            {tr('cost.notInstalled', "OpenCost is not installed on this cluster. Install it next to the cluster's Prometheus (opencost.io/docs/installation) and have that Prometheus scrape OpenCost itself; this page then fills in.")}
          </p>
          {status.data?.message && <p className="mt-2 text-xs text-slate-500">{status.data.message}</p>}
        </div>
      ) : status.isLoading ? (
        <div className="card p-6 text-slate-400">
          <span className="inline-flex items-center gap-2">
            <Loader2 className="w-4 h-4 animate-spin" />
            {tr('cost.checking', 'Looking for OpenCost in this cluster...')}
          </span>
        </div>
      ) : (
        <>
          <div className="flex flex-wrap items-center gap-3 shrink-0">
            <div className="flex items-center gap-1 rounded-lg bg-slate-800/60 p-1" role="tablist">
              {tab('namespace', tr('cost.aggregate.namespace', 'By namespace'))}
              {tab('controller', tr('cost.aggregate.controller', 'By workload'))}
            </div>
            <CustomDropdown
              size="sm"
              testId="cost-window"
              value={win}
              onChange={(v) => setWin(v as CostWindow)}
              options={windowOptions}
              className="w-44"
            />
            {cost.data && (
              <p className="text-xs text-slate-400" data-testid="cost-source">
                {tr('cost.source', 'OpenCost {{endpoint}} · {{currency}} · window {{start}} – {{end}}', {
                  endpoint: `${cost.data.source.namespace}/${cost.data.source.service}:${cost.data.source.port}`,
                  currency,
                  start: cost.data.start ? formatTime(cost.data.start) : '-',
                  end: cost.data.end ? formatTime(cost.data.end) : '-',
                })}
              </p>
            )}
          </div>

          <div className="shrink-0">
            <div className="relative">
              <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-5 h-5 text-slate-400" />
              <input
                type="text"
                placeholder={tr('cost.searchPlaceholder', 'Search by name...')}
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                data-testid="cost-search"
                className="h-12 w-full pl-10 pr-4 bg-slate-700 border border-slate-600 rounded-lg text-sm text-white placeholder-slate-400 focus:outline-hidden focus:ring-2 focus:ring-primary-500 focus:border-transparent"
              />
            </div>
          </div>

          <div className="grid grid-cols-2 md:grid-cols-5 gap-3 shrink-0">
            {([
              ['total', tr('cost.stats.total', 'Total cost'), totals?.total_cost],
              ['cpu', tr('cost.stats.cpu', 'CPU'), totals?.cpu_cost],
              ['ram', tr('cost.stats.ram', 'Memory'), totals?.ram_cost],
              ['pv', tr('cost.stats.pv', 'Storage (PV)'), totals?.pv_cost],
              ['network', tr('cost.stats.network', 'Network'), totals?.network_cost],
            ] as [string, string, number | undefined][]).map(([key, label, value]) => (
              <div key={key} className="rounded-lg border border-slate-700 bg-slate-900/50 px-4 py-3">
                <p className="text-[11px] sm:text-xs leading-4 whitespace-nowrap text-slate-400">{label}</p>
                <p className="text-lg text-white font-semibold mt-1 whitespace-nowrap" data-testid={`cost-${key}`}>{totals ? money(value) : '-'}</p>
              </div>
            ))}
          </div>

          {cost.data?.scoped && (
            <p className="text-sm text-amber-300 shrink-0" data-testid="cost-scoped">
              {tr('cost.scoped', 'Only the namespaces of your grant are shown; the totals add up those rows.')}
            </p>
          )}

          {searchQuery && (
            <p className="text-sm text-slate-400 shrink-0">
              {tr('cost.matchCount', '{{count}} rows match.', { count: filtered.length })}
            </p>
          )}

          <div ref={tableContainerRef} className="card flex-1 min-h-0 flex flex-col">
            <div ref={tableBodyRef} className="overflow-x-auto flex-1 min-h-0">
              <table className="w-full text-sm min-w-[760px] table-fixed" data-testid="cost-table">
                <thead ref={theadRef} className="text-slate-400">
                  <tr>
                    <th className="text-left py-3 px-4 w-[300px] cursor-pointer" onClick={() => handleSort('name')}>
                      <span className="inline-flex items-center gap-1">
                        {tr('cost.table.name', 'Name')}{renderSortIcon('name')}
                      </span>
                    </th>
                    {byWorkload && <th className="col-low text-left py-3 px-4 w-[160px]">{tr('cost.table.namespace', 'Namespace')}</th>}
                    <th className="text-right py-3 px-4 w-[110px] cursor-pointer" onClick={() => handleSort('cpu')}>
                      <span className="inline-flex items-center gap-1">
                        {tr('cost.table.cpu', 'CPU')}{renderSortIcon('cpu')}
                      </span>
                    </th>
                    <th className="text-right py-3 px-4 w-[110px] cursor-pointer" onClick={() => handleSort('ram')}>
                      <span className="inline-flex items-center gap-1">
                        {tr('cost.table.ram', 'Memory')}{renderSortIcon('ram')}
                      </span>
                    </th>
                    <th className="col-optional text-right py-3 px-4 w-[110px] cursor-pointer" onClick={() => handleSort('pv')}>
                      <span className="inline-flex items-center gap-1">
                        {tr('cost.table.pv', 'PV')}{renderSortIcon('pv')}
                      </span>
                    </th>
                    <th className="col-optional text-right py-3 px-4 w-[110px] cursor-pointer" onClick={() => handleSort('network')}>
                      <span className="inline-flex items-center gap-1">
                        {tr('cost.table.network', 'Network')}{renderSortIcon('network')}
                      </span>
                    </th>
                    <th className="text-right py-3 px-4 w-[120px] cursor-pointer" onClick={() => handleSort('total')}>
                      <span className="inline-flex items-center gap-1">
                        {tr('cost.table.total', 'Total')}{renderSortIcon('total')}
                      </span>
                    </th>
                    <th className="col-optional text-right py-3 px-4 w-[100px] cursor-pointer" onClick={() => handleSort('efficiency')}>
                      <span className="inline-flex items-center gap-1">
                        {tr('cost.table.efficiency', 'Efficiency')}{renderSortIcon('efficiency')}
                      </span>
                    </th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-700">
                  {paged.map((row, idx) => (
                    <tr
                      ref={idx === 0 ? firstRowRef : undefined}
                      key={`${row.namespace}/${row.kind || ''}/${row.name}`}
                      data-testid="cost-row"
                      className="text-slate-200 hover:bg-slate-800/60"
                    >
                      <td className="py-3 px-4 font-medium text-white">
                        <span className="block truncate" title={`${row.kind ? `${row.kind}/` : ''}${row.name}`}>
                          {row.kind && <span className="text-slate-400">{row.kind}/</span>}
                          {rowName(row)}
                        </span>
                      </td>
                      {byWorkload && <td className="col-low py-3 px-4 text-xs font-mono whitespace-nowrap" title={row.namespace}>{row.namespace}</td>}
                      <td className="py-3 px-4 text-right text-xs font-mono whitespace-nowrap">{money(row.cpu_cost)}</td>
                      <td className="py-3 px-4 text-right text-xs font-mono whitespace-nowrap">{money(row.ram_cost)}</td>
                      <td className="col-optional py-3 px-4 text-right text-xs font-mono whitespace-nowrap">{money(row.pv_cost)}</td>
                      <td className="col-optional py-3 px-4 text-right text-xs font-mono whitespace-nowrap">{money(row.network_cost)}</td>
                      <td className="py-3 px-4 text-right text-xs font-mono text-white whitespace-nowrap" data-testid="cost-row-total">{money(row.total_cost)}</td>
                      <td className="col-optional py-3 px-4 text-right text-xs font-mono whitespace-nowrap">{formatPercent(row.total_efficiency)}</td>
                    </tr>
                  ))}
                  {cost.isLoading && (
                    <tr>
                      <td colSpan={columnCount} className="py-10 px-4 text-center text-slate-400">
                        <div className="inline-flex items-center gap-2">
                          <Loader2 className="w-4 h-4 animate-spin" />
                          <Trans i18nKey="common.loading" />
                        </div>
                      </td>
                    </tr>
                  )}
                  {cost.isError && (
                    <TableEmptyRow colSpan={columnCount} resource="cost">
                      <span data-testid="cost-load-error">{tr('cost.loadError', 'Could not load the cost table')}</span>
                      {errorDetail && <span className="block mt-1 text-xs text-slate-500">{errorDetail}</span>}
                    </TableEmptyRow>
                  )}
                  {sorted.length === 0 && !cost.isLoading && !cost.isError && (
                    <TableEmptyRow colSpan={columnCount} resource="cost" searching={!!searchQuery.trim()} />
                  )}
                </tbody>
                <AdaptiveTableFillerRows count={rowsPerPage - paged.length} columnCount={columnCount} />
              </table>
            </div>
            <ListPager currentPage={currentPage} totalPages={totalPages} total={sorted.length} rowsPerPage={rowsPerPage} onPageChange={setCurrentPage} />
          </div>
        </>
      )}
    </div>
  )
}
