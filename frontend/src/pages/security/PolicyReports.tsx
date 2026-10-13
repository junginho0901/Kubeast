import { useEffect, useMemo, useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { useTranslation, Trans } from 'react-i18next'
import { api } from '@/services/api'
import type { PolicyReportNamespaceRow, PolicyReportPolicyRow, PolicyReportResult, PolicyReportResults, PolicyReportSummary } from '@/services/api/types'
import { useResourceDetail } from '@/components/ResourceDetailContext'
import { useAdaptiveTable } from '@/hooks/useAdaptiveTable'
import { AdaptiveTableFillerRows } from '@/components/AdaptiveTableFillerRows'
import { ListPager } from '@/components/ListPager'
import { TableEmptyRow } from '@/components/TableEmptyRow'
import CustomDropdown from '@/components/CustomDropdown'
import { useAIContext } from '@/hooks/useAIContext'
import { summarizeList } from '@/utils/aiContext/summarizeList'
import { formatTime, utcTitle } from '@/utils/time'
import { Loader2, ChevronDown, ChevronUp, RefreshCw, Search } from 'lucide-react'

// Security → Policy Reports: what the cluster's policy engine (Kyverno, Trivy Operator, …) wrote into
// wgpolicyk8s.io PolicyReports, aggregated by policy and by namespace, with the rows behind them.
// Read-only; a cluster without the CRD says so.

type Tab = 'policies' | 'namespaces' | 'results'
type ResultFilter = 'problems' | 'fail' | 'warn' | 'error' | 'pass' | 'skip' | 'all'
type SortKey = null | 'name' | 'fail' | 'warn' | 'pass' | 'result' | 'policy' | 'namespace'
const RESULT_PARAM: Record<ResultFilter, string> = { problems: '', fail: 'fail', warn: 'warn', error: 'error', pass: 'pass', skip: 'skip', all: 'pass,fail,warn,error,skip' }
const RESULT_BADGE: Record<string, string> = { fail: 'badge-error', error: 'badge-error', warn: 'badge-warning', pass: 'badge-success', skip: 'badge-neutral' }
const SEVERITIES = ['critical', 'high', 'medium', 'low', 'info']
const RESULTS_LIMIT = 500

export default function PolicyReports() {
  const { t } = useTranslation()
  const tr = (key: string, fallback: string, options?: Record<string, any>) =>
    t(key, { defaultValue: fallback, ...options })
  const queryClient = useQueryClient()
  const { open: openDetail } = useResourceDetail()
  const [tab, setTab] = useState<Tab>('policies')
  const [namespace, setNamespace] = useState('')
  const [resultFilter, setResultFilter] = useState<ResultFilter>('problems')
  const [severity, setSeverity] = useState('')
  const [policy, setPolicy] = useState('')
  const [searchQuery, setSearchQuery] = useState('')
  const [isRefreshing, setIsRefreshing] = useState(false)
  const [sortKey, setSortKey] = useState<SortKey>(null)
  const [sortDir, setSortDir] = useState<'asc' | 'desc'>('asc')
  const [currentPage, setCurrentPage] = useState(1)

  const status = useQuery({
    queryKey: ['cluster', 'policyreports', 'status'],
    queryFn: () => api.getPolicyReportStatus(),
    staleTime: 60_000,
    retry: false,
  })
  const installed = status.data?.installed === true
  const notInstalled = status.isError || (status.isSuccess && !installed)
  const summaryQuery = useQuery({
    queryKey: ['cluster', 'policyreports', 'summary', namespace],
    queryFn: () => api.getPolicyReportSummary(namespace),
    enabled: installed,
    retry: false,
  })
  const summary = useMemo<PolicyReportSummary | null>(
    () => (summaryQuery.data && !Array.isArray(summaryQuery.data) ? (summaryQuery.data as PolicyReportSummary) : null),
    [summaryQuery.data],
  )
  const resultsKey = ['cluster', 'policyreports', 'results', namespace, policy, resultFilter, severity, searchQuery]
  const resultsParams = { namespace, policy, result: RESULT_PARAM[resultFilter], severity, search: searchQuery, limit: RESULTS_LIMIT }
  const resultsQuery = useQuery({
    queryKey: resultsKey,
    queryFn: () => api.getPolicyReportResults(resultsParams),
    enabled: installed && tab === 'results',
    retry: false,
  })
  const results = useMemo<PolicyReportResults | null>(
    () => (resultsQuery.data && !Array.isArray(resultsQuery.data) ? (resultsQuery.data as PolicyReportResults) : null),
    [resultsQuery.data],
  )
  const { data: namespaceList } = useQuery({
    queryKey: ['namespaces'],
    queryFn: () => api.getNamespaces(),
    staleTime: 30_000,
    enabled: installed,
  })

  const search = searchQuery.trim().toLowerCase()
  const policyRows = useMemo<PolicyReportPolicyRow[]>(() => {
    const rows = summary?.policies ?? []
    return search ? rows.filter((r) => r.policy.toLowerCase().includes(search) || (r.category || '').toLowerCase().includes(search)) : rows
  }, [summary, search])
  const namespaceRows = useMemo<PolicyReportNamespaceRow[]>(() => {
    const rows = summary?.namespaces ?? []
    return search ? rows.filter((r) => r.namespace.toLowerCase().includes(search)) : rows
  }, [summary, search])
  const resultRows = useMemo<PolicyReportResult[]>(() => results?.rows ?? [], [results])

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
  const sortBy = <T,>(list: T[], value: (item: T) => string | number): T[] => {
    if (!sortKey) return list
    const copy = [...list]
    copy.sort((a, b) => {
      const av = value(a)
      const bv = value(b)
      if (typeof av === 'number' && typeof bv === 'number') return sortDir === 'asc' ? av - bv : bv - av
      return sortDir === 'asc' ? String(av).localeCompare(String(bv)) : String(bv).localeCompare(String(av))
    })
    return copy
  }
  const sortedPolicies = useMemo(() => sortBy(policyRows, (r) => {
    switch (sortKey) {
      case 'name': case 'policy': return r.policy
      case 'fail': return r.fail
      case 'warn': return r.warn
      case 'pass': return r.pass
      default: return ''
    }
  }), [policyRows, sortKey, sortDir]) // eslint-disable-line react-hooks/exhaustive-deps
  const sortedNamespaces = useMemo(() => sortBy(namespaceRows, (r) => {
    switch (sortKey) {
      case 'name': case 'namespace': return r.namespace
      case 'fail': return r.fail
      case 'warn': return r.warn
      case 'pass': return r.pass
      default: return ''
    }
  }), [namespaceRows, sortKey, sortDir]) // eslint-disable-line react-hooks/exhaustive-deps
  const sortedResults = useMemo(() => sortBy(resultRows, (r) => {
    switch (sortKey) {
      case 'result': return r.result
      case 'policy': return r.policy
      case 'namespace': return r.namespace
      case 'name': return `${r.kind}/${r.name}`
      default: return ''
    }
  }), [resultRows, sortKey, sortDir]) // eslint-disable-line react-hooks/exhaustive-deps

  const rowCount = tab === 'policies' ? sortedPolicies.length : tab === 'namespaces' ? sortedNamespaces.length : sortedResults.length
  const { containerRef: tableContainerRef, bodyRef: tableBodyRef, theadRef, firstRowRef, rowsPerPage } = useAdaptiveTable({
    recalculationKey: `${tab}:${rowCount}`,
  })
  const totalPages = Math.max(1, Math.ceil(rowCount / rowsPerPage))
  useEffect(() => {
    setCurrentPage(1)
    setSortKey(null)
  }, [tab, namespace, policy, resultFilter, severity, searchQuery])
  useEffect(() => {
    if (currentPage > totalPages) setCurrentPage(totalPages)
  }, [currentPage, totalPages])
  const pageSlice = <T,>(list: T[]): T[] => list.slice((currentPage - 1) * rowsPerPage, currentPage * rowsPerPage)
  const pagedPolicies = useMemo(() => pageSlice(sortedPolicies), [sortedPolicies, currentPage, rowsPerPage]) // eslint-disable-line react-hooks/exhaustive-deps
  const pagedNamespaces = useMemo(() => pageSlice(sortedNamespaces), [sortedNamespaces, currentPage, rowsPerPage]) // eslint-disable-line react-hooks/exhaustive-deps
  const pagedResults = useMemo(() => pageSlice(sortedResults), [sortedResults, currentPage, rowsPerPage]) // eslint-disable-line react-hooks/exhaustive-deps

  const aiSnapshot = useMemo(() => {
    if (!summary) return null
    const list = tab === 'policies' ? pagedPolicies : tab === 'namespaces' ? pagedNamespaces : pagedResults
    return {
      source: 'base' as const,
      summary: `Policy reports: ${summary.totals.fail} fail, ${summary.totals.warn} warn, ${summary.totals.error} error over ${summary.reports} reports (${tab})`,
      data: {
        filters: { tab, namespace: namespace || undefined, policy: policy || undefined, result: resultFilter, severity: severity || undefined, search: searchQuery || undefined, scoped: summary.scoped },
        stats: { ...summary.totals, reports: summary.reports, truncated: summary.truncated },
        ...summarizeList(list as unknown as Record<string, unknown>[], {
          total: rowCount,
          currentPage,
          pageSize: rowsPerPage,
          topN: rowsPerPage,
          pickFields: tab === 'results'
            ? ['result', 'severity', 'policy', 'rule', 'kind', 'name', 'namespace', 'message']
            : tab === 'policies' ? ['policy', 'category', 'severity', 'source', 'fail', 'warn', 'error', 'pass', 'skip'] : ['namespace', 'policies', 'fail', 'warn', 'error', 'pass', 'skip'],
        }),
      },
    }
  }, [summary, tab, pagedPolicies, pagedNamespaces, pagedResults, rowCount, currentPage, rowsPerPage, namespace, policy, resultFilter, severity, searchQuery])
  useAIContext(aiSnapshot, [aiSnapshot])

  // Force refresh: past the server's one-minute cache, so a fix shows up as soon as the engine reports it.
  const handleRefresh = async () => {
    if (isRefreshing) return
    setIsRefreshing(true)
    try {
      await queryClient.invalidateQueries({ queryKey: ['cluster', 'policyreports', 'status'] })
      if (installed) {
        queryClient.setQueryData(['cluster', 'policyreports', 'summary', namespace], await api.getPolicyReportSummary(namespace, true))
        if (tab === 'results') queryClient.setQueryData(resultsKey, await api.getPolicyReportResults(resultsParams, true))
      }
    } catch (error) {
      console.error('policy reports refresh failed:', error)
    }
    setTimeout(() => setIsRefreshing(false), 500)
  }

  const openRow = (r: PolicyReportResult) => {
    if (!r.kind || !r.name) return
    openDetail(r.namespace ? { kind: r.kind, namespace: r.namespace, name: r.name } : { kind: r.kind, name: r.name })
  }
  const showPolicy = (name: string) => {
    setPolicy(name)
    setTab('results')
  }
  const showNamespace = (ns: string) => {
    setNamespace(ns)
    setTab('results')
  }
  const resultLabel = (v: string) => tr(`policyReports.result.${v}`, v)
  const columnCount = tab === 'policies' ? 10 : tab === 'namespaces' ? 7 : 8
  const isLoading = tab === 'results' ? resultsQuery.isLoading : summaryQuery.isLoading
  const isError = tab === 'results' ? resultsQuery.isError : summaryQuery.isError
  const errorDetail = ((tab === 'results' ? resultsQuery.error : summaryQuery.error) as { response?: { data?: { detail?: string } } } | null)?.response?.data?.detail
  const sortHeader = (key: NonNullable<SortKey>, label: string, extra = '', align = 'text-left') => (
    <th className={`${extra} ${align} py-3 px-4 cursor-pointer`} onClick={() => handleSort(key)}>
      <span className="inline-flex items-center gap-1">{label}{renderSortIcon(key)}</span>
    </th>
  )
  const tabButton = (value: Tab, label: string) => (
    <button
      type="button"
      role="tab"
      aria-selected={tab === value}
      data-testid={`policy-reports-tab-${value}`}
      onClick={() => setTab(value)}
      className={`h-8 px-3 text-sm rounded-md transition-colors ${tab === value ? 'bg-slate-700 text-white' : 'text-slate-400 hover:text-white hover:bg-slate-800'}`}
    >
      {label}
    </button>
  )
  const countCells = (r: { fail: number; warn: number; error: number; pass: number; skip: number }) => (
    <>
      <td className="py-3 px-4 text-right text-xs font-mono text-red-300">{r.fail}</td>
      <td className="py-3 px-4 text-right text-xs font-mono text-amber-300">{r.warn}</td>
      <td className="col-optional py-3 px-4 text-right text-xs font-mono text-slate-300">{r.error}</td>
      <td className="py-3 px-4 text-right text-xs font-mono text-emerald-300">{r.pass}</td>
      <td className="col-optional py-3 px-4 text-right text-xs font-mono text-slate-400">{r.skip}</td>
    </>
  )
  const countHeaders = () => (
    <>
      {sortHeader('fail', tr('policyReports.table.fail', 'Fail'), 'w-[72px]', 'text-right')}
      {sortHeader('warn', tr('policyReports.table.warn', 'Warn'), 'w-[72px]', 'text-right')}
      <th className="col-optional text-right py-3 px-4 w-[72px]">{tr('policyReports.table.error', 'Error')}</th>
      {sortHeader('pass', tr('policyReports.table.pass', 'Pass'), 'w-[72px]', 'text-right')}
      <th className="col-optional text-right py-3 px-4 w-[72px]">{tr('policyReports.table.skip', 'Skip')}</th>
    </>
  )

  return (
    <div className="flex flex-col h-[calc(100vh-4rem)] gap-4">
      <div className="flex items-center justify-between shrink-0">
        <div>
          <h1 className="text-3xl font-bold text-white">{tr('policyReports.title', 'Policy Reports')}</h1>
          <p className="mt-2 text-slate-400">
            {tr('policyReports.subtitle', "What the cluster's policy engine (Kyverno, Trivy Operator, …) recorded in PolicyReports: results by policy and by namespace, and the rows behind them. Read-only.")}
          </p>
        </div>
        <button
          type="button"
          onClick={handleRefresh}
          disabled={isRefreshing}
          title={tr('policyReports.refreshTitle', 'Force refresh')}
          className="btn btn-primary flex items-center gap-2 disabled:opacity-50 disabled:cursor-not-allowed"
        >
          <RefreshCw className={`w-4 h-4 ${isRefreshing ? 'animate-spin' : ''}`} />
          {tr('policyReports.refresh', 'Refresh')}
        </button>
      </div>

      {notInstalled ? (
        <div className="card p-6" data-testid="policy-reports-not-installed">
          <p className="text-slate-200">
            {tr('policyReports.notInstalled', 'PolicyReport (wgpolicyk8s.io) is not installed on this cluster. Install a policy engine that writes policy reports, such as Kyverno with Audit policies, and this page fills in.')}
          </p>
        </div>
      ) : status.isLoading ? (
        <div className="card p-6 text-slate-400">
          <span className="inline-flex items-center gap-2">
            <Loader2 className="w-4 h-4 animate-spin" />
            {tr('policyReports.checking', 'Looking for policy reports in this cluster...')}
          </span>
        </div>
      ) : (
        <>
          <div className="flex flex-wrap items-center gap-3 shrink-0">
            <div className="flex items-center gap-1 rounded-lg bg-slate-800/60 p-1" role="tablist">
              {tabButton('policies', tr('policyReports.tabs.policies', 'By policy'))}
              {tabButton('namespaces', tr('policyReports.tabs.namespaces', 'By namespace'))}
              {tabButton('results', tr('policyReports.tabs.results', 'Results'))}
            </div>
            <CustomDropdown
              size="sm"
              testId="policy-reports-namespace"
              value={namespace}
              onChange={setNamespace}
              className="w-52"
              options={[{ value: '', label: tr('policyReports.allNamespaces', 'All namespaces') }, ...(namespaceList ?? []).map((n) => ({ value: n.name, label: n.name, testId: `policy-reports-namespace-opt-${n.name}` }))]}
            />
            {tab === 'results' && (
              <>
                <CustomDropdown
                  size="sm"
                  testId="policy-reports-result"
                  value={resultFilter}
                  onChange={(v) => setResultFilter(v as ResultFilter)}
                  className="w-44"
                  options={(['problems', 'fail', 'warn', 'error', 'pass', 'skip', 'all'] as ResultFilter[]).map((v) => ({ value: v, label: v === 'problems' ? tr('policyReports.resultFilter.problems', 'Fail · Warn · Error') : v === 'all' ? tr('policyReports.resultFilter.all', 'All results') : resultLabel(v), testId: `policy-reports-result-opt-${v}` }))}
                />
                <CustomDropdown
                  size="sm"
                  testId="policy-reports-severity"
                  value={severity}
                  onChange={setSeverity}
                  className="w-40"
                  options={[{ value: '', label: tr('policyReports.allSeverities', 'All severities') }, ...SEVERITIES.map((s) => ({ value: s, label: s, testId: `policy-reports-severity-opt-${s}` }))]}
                />
                <CustomDropdown
                  size="sm"
                  testId="policy-reports-policy"
                  value={policy}
                  onChange={setPolicy}
                  className="w-56"
                  options={[{ value: '', label: tr('policyReports.allPolicies', 'All policies') }, ...(summary?.policies ?? []).map((p) => ({ value: p.policy, label: p.policy, testId: `policy-reports-policy-opt-${p.policy}` }))]}
                />
              </>
            )}
            {summary && (
              <p className="text-xs text-slate-400" data-testid="policy-reports-source">
                {tr('policyReports.source', '{{reports}} reports · {{time}}', { reports: summary.reports, time: formatTime(summary.generated_at) })}
              </p>
            )}
          </div>

          <div className="shrink-0">
            <div className="relative">
              <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-5 h-5 text-slate-400" />
              <input
                type="text"
                placeholder={tab === 'results' ? tr('policyReports.searchResults', 'Search by policy, rule, resource or message...') : tr('policyReports.searchPlaceholder', 'Search by name...')}
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                data-testid="policy-reports-search"
                className="h-12 w-full pl-10 pr-4 bg-slate-700 border border-slate-600 rounded-lg text-sm text-white placeholder-slate-400 focus:outline-hidden focus:ring-2 focus:ring-primary-500 focus:border-transparent"
              />
            </div>
          </div>

          <div className="grid grid-cols-2 md:grid-cols-5 gap-3 shrink-0">
            {([
              ['fail', tr('policyReports.result.fail', 'Fail'), summary?.totals.fail, 'text-red-300'],
              ['warn', tr('policyReports.result.warn', 'Warn'), summary?.totals.warn, 'text-amber-300'],
              ['error', tr('policyReports.result.error', 'Error'), summary?.totals.error, 'text-slate-200'],
              ['pass', tr('policyReports.result.pass', 'Pass'), summary?.totals.pass, 'text-emerald-300'],
              ['skip', tr('policyReports.result.skip', 'Skip'), summary?.totals.skip, 'text-slate-400'],
            ] as [string, string, number | undefined, string][]).map(([key, label, value, color]) => (
              <div key={key} className="rounded-lg border border-slate-700 bg-slate-900/50 px-4 py-3">
                <p className="text-[11px] sm:text-xs leading-4 whitespace-nowrap text-slate-400">{label}</p>
                <p className={`text-lg font-semibold mt-1 ${color}`} data-testid={`policy-reports-stat-${key}`}>{summary ? value : '-'}</p>
              </div>
            ))}
          </div>

          {summary?.scoped && (
            <p className="text-sm text-amber-300 shrink-0" data-testid="policy-reports-scoped">
              {tr('policyReports.scoped', 'Only the namespaces of your grant are counted.')}
            </p>
          )}
          {(summary?.truncated || results?.truncated) && (
            <p className="text-sm text-amber-300 shrink-0" data-testid="policy-reports-truncated">
              {tr('policyReports.truncated', 'The cluster has more reports than this page reads at once; narrow by namespace or policy to see them all.')}
            </p>
          )}

          <div ref={tableContainerRef} className="card flex-1 min-h-0 flex flex-col">
            <div ref={tableBodyRef} className="overflow-x-auto flex-1 min-h-0">
              <table className="w-full text-sm min-w-[760px] table-fixed" data-testid="policy-reports-table" data-tab={tab}>
                <thead ref={theadRef} className="text-slate-400">
                  {tab === 'policies' && (
                    <tr>
                      {sortHeader('policy', tr('policyReports.table.policy', 'Policy'), 'w-[200px]')}
                      <th className="col-optional text-left py-3 px-4 w-[130px]">{tr('policyReports.table.category', 'Category')}</th>
                      <th className="text-left py-3 px-4 w-[90px]">{tr('policyReports.table.severity', 'Severity')}</th>
                      <th className="col-optional text-left py-3 px-4 w-[170px]">{tr('policyReports.table.source', 'Source')}</th>
                      {countHeaders()}
                      <th className="col-low text-right py-3 px-4 w-[110px]">{tr('policyReports.table.namespaces', 'Namespaces')}</th>
                    </tr>
                  )}
                  {tab === 'namespaces' && (
                    <tr>
                      {sortHeader('namespace', tr('policyReports.table.namespace', 'Namespace'), 'w-[260px]')}
                      <th className="text-right py-3 px-4 w-[100px]">{tr('policyReports.table.policies', 'Policies')}</th>
                      {countHeaders()}
                    </tr>
                  )}
                  {tab === 'results' && (
                    <tr>
                      {sortHeader('result', tr('policyReports.table.result', 'Result'), 'w-[80px]')}
                      {sortHeader('policy', tr('policyReports.table.policy', 'Policy'), 'w-[180px]')}
                      {sortHeader('name', tr('policyReports.table.resource', 'Resource'), 'w-[240px]')}
                      {sortHeader('namespace', tr('policyReports.table.namespace', 'Namespace'), 'col-low w-[140px]')}
                      <th className="text-left py-3 px-4 w-[250px]">{tr('policyReports.table.message', 'Message')}</th>
                      <th className="col-optional text-left py-3 px-4 w-[90px]">{tr('policyReports.table.severity', 'Severity')}</th>
                      <th className="col-optional text-left py-3 px-4 w-[140px]">{tr('policyReports.table.rule', 'Rule')}</th>
                      <th className="col-low text-left py-3 px-4 w-[180px]">{tr('policyReports.table.time', 'Time')}</th>
                    </tr>
                  )}
                </thead>
                <tbody className="divide-y divide-slate-700">
                  {tab === 'policies' && pagedPolicies.map((r, idx) => (
                    <tr ref={idx === 0 ? firstRowRef : undefined} key={r.policy} data-testid="policy-report-row" className="text-slate-200 hover:bg-slate-800/60 cursor-pointer" onClick={() => showPolicy(r.policy)}>
                      <td className="py-3 px-4 font-medium text-white"><span className="block truncate" title={r.policy}>{r.policy}</span></td>
                      <td className="col-optional py-3 px-4 text-xs"><span className="block truncate" title={r.category}>{r.category || '-'}</span></td>
                      <td className="py-3 px-4 text-xs">{r.severity || '-'}</td>
                      <td className="col-optional py-3 px-4 text-xs font-mono"><span className="block truncate" title={r.source}>{r.source || '-'}</span></td>
                      {countCells(r)}
                      <td className="col-low py-3 px-4 text-right text-xs font-mono" title={r.namespaces.join(', ') || undefined}>{r.namespaces.length}</td>
                    </tr>
                  ))}
                  {tab === 'namespaces' && pagedNamespaces.map((r, idx) => (
                    <tr ref={idx === 0 ? firstRowRef : undefined} key={r.namespace || '(cluster)'} data-testid="policy-report-row" className="text-slate-200 hover:bg-slate-800/60 cursor-pointer" onClick={() => r.namespace && showNamespace(r.namespace)}>
                      <td className="py-3 px-4 font-medium text-white"><span className="block truncate">{r.namespace || tr('policyReports.clusterScope', 'Cluster-scoped')}</span></td>
                      <td className="py-3 px-4 text-right text-xs font-mono">{r.policies}</td>
                      {countCells(r)}
                    </tr>
                  ))}
                  {tab === 'results' && pagedResults.map((r, idx) => (
                    <tr ref={idx === 0 ? firstRowRef : undefined} key={`${r.report}/${r.policy}/${r.rule}/${r.name}/${idx}`} data-testid="policy-report-row" className="text-slate-200 hover:bg-slate-800/60 cursor-pointer" onClick={() => openRow(r)}>
                      <td className="py-3 px-4"><span className={`badge ${RESULT_BADGE[r.result] || 'badge-neutral'}`} data-testid="policy-report-result">{resultLabel(r.result)}</span></td>
                      <td className="py-3 px-4 text-xs font-medium text-white"><span className="block truncate" title={r.policy}>{r.policy}</span></td>
                      <td className="py-3 px-4 text-xs font-mono">
                        <span className="block truncate" title={`${r.kind}/${r.name}`}>
                          {r.kind && <span className="text-slate-400">{r.kind}/</span>}
                          {r.name || '-'}
                        </span>
                      </td>
                      <td className="col-low py-3 px-4 text-xs font-mono whitespace-nowrap" title={r.namespace}>{r.namespace || '-'}</td>
                      <td className="py-3 px-4 text-xs text-slate-300"><span className="block truncate" title={r.message} data-testid="policy-report-message">{r.message || '-'}</span></td>
                      <td className="col-optional py-3 px-4 text-xs">{r.severity || '-'}</td>
                      <td className="col-optional py-3 px-4 text-xs font-mono"><span className="block truncate" title={r.rule}>{r.rule || '-'}</span></td>
                      <td className="col-low py-3 px-4 text-xs font-mono whitespace-nowrap" title={r.timestamp ? utcTitle(r.timestamp) : undefined}>{r.timestamp ? formatTime(r.timestamp) : '-'}</td>
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
                  {isError && (
                    <TableEmptyRow colSpan={columnCount} resource="policyreports">
                      <span data-testid="policy-reports-load-error">{tr('policyReports.loadError', 'Could not load the policy reports')}</span>
                      {errorDetail && <span className="block mt-1 text-xs text-slate-500">{errorDetail}</span>}
                    </TableEmptyRow>
                  )}
                  {rowCount === 0 && !isLoading && !isError && (
                    <TableEmptyRow colSpan={columnCount} resource="policyreports" searching={!!search} />
                  )}
                </tbody>
                <AdaptiveTableFillerRows count={rowsPerPage - Math.min(rowCount - (currentPage - 1) * rowsPerPage, rowsPerPage)} columnCount={columnCount} />
              </table>
            </div>
            <ListPager currentPage={currentPage} totalPages={totalPages} total={rowCount} rowsPerPage={rowsPerPage} onPageChange={setCurrentPage} />
          </div>
        </>
      )}
    </div>
  )
}
