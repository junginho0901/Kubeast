import { useEffect, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Loader2, CheckCircle, ChevronDown, ChevronUp, Plus, RefreshCw, Search } from 'lucide-react'
import { useResourceDetail } from '@/components/ResourceDetailContext'
import ResourceYamlCreateDialog from '@/components/ResourceYamlCreateDialog'
import { AdaptiveTableFillerRows } from '@/components/AdaptiveTableFillerRows'
import {
  formatAge,
  formatConditionStatus,
  formatTargetRefs,
  toRawJson,
  type BackendPolicyLike,
  type SortKey,
} from './helpers'
import { useBackendPoliciesData, type BackendPolicyConfig } from './useBackendPoliciesData'

interface PageStrings {
  title: string
  subtitle: string
  createButton: string
  refreshTitle: string
  searchPlaceholder: string
  allNamespaces: string
  statsTotal: string
  statsAccepted: string
  statsWithTargets: string
  matchCount: (count: number) => string
  tableNamespace: string
  tableName: string
  tableTargetRef: string
  tableStatus: string
  tableAge: string
  noResults: string
  createDialogTitle: string
  matchSuffixSingular: string
  matchSuffixPlural: string
}

interface Props<T extends BackendPolicyLike> {
  config: BackendPolicyConfig<T>
  apiVersion: string
  yamlBodyTemplate: string // YAML body after metadata (starts with 'spec:')
  strings: PageStrings
  i18nPrefix: string
}

export default function BackendPoliciesPage<T extends BackendPolicyLike>({
  config,
  apiVersion,
  yamlBodyTemplate,
  strings,
  i18nPrefix,
}: Props<T>) {
  const { t } = useTranslation()
  const tr = (key: string, fallback: string, options?: Record<string, any>) =>
    t(key, { defaultValue: fallback, ...options })
  const { open: openDetail } = useResourceDetail()

  const [searchQuery, setSearchQuery] = useState('')
  const [selectedNamespace, setSelectedNamespace] = useState<string>('all')
  const [sortKey, setSortKey] = useState<SortKey>(null)
  const [sortDir, setSortDir] = useState<'asc' | 'desc'>('asc')
  const [currentPage, setCurrentPage] = useState(1)
  const [createDialogOpen, setCreateDialogOpen] = useState(false)

  const {
    namespaces,
    namespaceDropdownRef,
    isNamespaceDropdownOpen,
    setIsNamespaceDropdownOpen,
    canCreate,
    isLoading,
    isRefreshing,
    handleRefresh,
    filteredPolicies,
    sortedPolicies,
    pagedPolicies,
    summary,
    rowsPerPage,
    totalPages,
    tableContainerRef,
    tableBodyRef,
    theadRef,
    firstRowRef,
    queryClient,
  } = useBackendPoliciesData<T>({
    config,
    searchQuery,
    selectedNamespace,
    sortKey,
    sortDir,
    currentPage,
  })

  useEffect(() => { setCurrentPage(1) }, [searchQuery, selectedNamespace])
  useEffect(() => { if (currentPage > totalPages) setCurrentPage(totalPages) }, [currentPage, totalPages])

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

  const createYamlTemplate = useMemo(() => {
    const ns = selectedNamespace !== 'all' ? selectedNamespace : 'default'
    return `apiVersion: ${apiVersion}
kind: ${config.kind}
metadata:
  name: sample-${config.kind.toLowerCase()}
  namespace: ${ns}
${yamlBodyTemplate}`
  }, [selectedNamespace, apiVersion, config.kind, yamlBodyTemplate])

  const showNamespaceColumn = selectedNamespace === 'all'

  return (
    <div className="flex flex-col h-[calc(100vh-4rem)] gap-4">
      <div className="flex items-center justify-between shrink-0">
        <div>
          <h1 className="text-3xl font-bold text-white">{strings.title}</h1>
          <p className="mt-2 text-slate-400">{strings.subtitle}</p>
        </div>
        <div className="flex items-center gap-2">
          {canCreate && (
            <button type="button" onClick={() => setCreateDialogOpen(true)} className="btn btn-primary flex items-center gap-2">
              <Plus className="w-4 h-4" />
              {strings.createButton}
            </button>
          )}
          <button
            type="button" onClick={handleRefresh} disabled={isRefreshing}
            title={strings.refreshTitle}
            className="btn btn-primary flex items-center gap-2 disabled:opacity-50 disabled:cursor-not-allowed"
          >
            <RefreshCw className={`w-4 h-4 ${isRefreshing ? 'animate-spin' : ''}`} />
            {tr(`${i18nPrefix}.refresh`, 'Refresh')}
          </button>
        </div>
      </div>

      <div className="grid grid-cols-1 xl:grid-cols-3 gap-3 shrink-0">
        <div className="xl:col-span-2">
          <div className="relative">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-5 h-5 text-slate-400" />
            <input
              type="text"
              placeholder={strings.searchPlaceholder}
              value={searchQuery} onChange={(e) => setSearchQuery(e.target.value)}
              className="h-12 w-full pl-10 pr-4 bg-slate-700 border border-slate-600 rounded-lg text-sm text-white placeholder-slate-400 focus:outline-none focus:ring-2 focus:ring-primary-500 focus:border-transparent"
            />
          </div>
        </div>

        <div className="relative" ref={namespaceDropdownRef}>
          <button type="button" onClick={() => setIsNamespaceDropdownOpen((v) => !v)}
            className="h-12 w-full px-3 bg-slate-700 border border-slate-600 rounded-lg text-sm text-white focus:outline-none focus:ring-2 focus:ring-primary-500 focus:border-transparent flex items-center justify-between gap-2">
            <span className="text-sm font-medium">
              {selectedNamespace === 'all' ? strings.allNamespaces : selectedNamespace}
            </span>
            <ChevronDown className={`w-4 h-4 text-slate-400 transition-transform ${isNamespaceDropdownOpen ? 'rotate-180' : ''}`} />
          </button>
          {isNamespaceDropdownOpen && (
            <div className="absolute top-full left-0 mt-2 w-full bg-slate-700 border border-slate-600 rounded-lg shadow-xl z-[100] max-h-[240px] overflow-y-auto">
              <button type="button" onClick={() => { setSelectedNamespace('all'); setIsNamespaceDropdownOpen(false) }}
                className="w-full px-4 py-2.5 text-left text-sm text-white hover:bg-slate-600 transition-colors flex items-center gap-2 first:rounded-t-lg">
                {selectedNamespace === 'all' && <CheckCircle className="w-4 h-4 text-green-400 flex-shrink-0" />}
                <span className={selectedNamespace === 'all' ? 'font-medium' : ''}>{strings.allNamespaces}</span>
              </button>
              {(namespaces || []).map((ns) => (
                <button key={ns.name} type="button" onClick={() => { setSelectedNamespace(ns.name); setIsNamespaceDropdownOpen(false) }}
                  className="w-full px-4 py-2.5 text-left text-sm text-white hover:bg-slate-600 transition-colors flex items-center gap-2 last:rounded-b-lg">
                  {selectedNamespace === ns.name && <CheckCircle className="w-4 h-4 text-green-400 flex-shrink-0" />}
                  <span className={selectedNamespace === ns.name ? 'font-medium' : ''}>{ns.name}</span>
                </button>
              ))}
            </div>
          )}
        </div>
      </div>

      <div className="grid grid-cols-2 lg:grid-cols-3 gap-3 shrink-0">
        <div className="rounded-lg border border-slate-700 bg-slate-900/50 px-4 py-3">
          <p className="text-[11px] sm:text-xs leading-4 whitespace-nowrap text-slate-400">{strings.statsTotal}</p>
          <p className="text-lg text-white font-semibold mt-1">{summary.total}</p>
        </div>
        <div className="rounded-lg border border-emerald-700/40 bg-emerald-900/10 px-4 py-3">
          <p className="text-[11px] sm:text-xs leading-4 whitespace-nowrap text-emerald-300">{strings.statsAccepted}</p>
          <p className="text-lg text-white font-semibold mt-1">{summary.accepted}</p>
        </div>
        <div className="rounded-lg border border-cyan-700/40 bg-cyan-900/10 px-4 py-3">
          <p className="text-[11px] sm:text-xs leading-4 whitespace-nowrap text-cyan-300">{strings.statsWithTargets}</p>
          <p className="text-lg text-white font-semibold mt-1">{summary.withTargetRefs}</p>
        </div>
      </div>

      {searchQuery && (
        <p className="text-sm text-slate-400 shrink-0">
          {strings.matchCount(filteredPolicies.length)}
        </p>
      )}

      <div ref={tableContainerRef} className="card flex-1 min-h-0 flex flex-col">
        <div ref={tableBodyRef} className="overflow-x-auto flex-1 min-h-0">
          <table className="w-full text-sm min-w-[700px] table-fixed">
            <thead ref={theadRef} className="text-slate-400">
              <tr>
                {showNamespaceColumn && (
                  <th className="text-left py-3 px-4 w-[170px] cursor-pointer" onClick={() => handleSort('namespace')}>
                    <span className="inline-flex items-center gap-1">{strings.tableNamespace}{renderSortIcon('namespace')}</span>
                  </th>
                )}
                <th className="text-left py-3 px-4 w-[220px] cursor-pointer" onClick={() => handleSort('name')}>
                  <span className="inline-flex items-center gap-1">{strings.tableName}{renderSortIcon('name')}</span>
                </th>
                <th className="text-left py-3 px-4 w-[280px] cursor-pointer" onClick={() => handleSort('targetRef')}>
                  <span className="inline-flex items-center gap-1">{strings.tableTargetRef}{renderSortIcon('targetRef')}</span>
                </th>
                <th className="text-left py-3 px-4 w-[140px]">
                  {strings.tableStatus}
                </th>
                <th className="text-left py-3 px-4 w-[90px] cursor-pointer" onClick={() => handleSort('age')}>
                  <span className="inline-flex items-center gap-1">{strings.tableAge}{renderSortIcon('age')}</span>
                </th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-700">
              {pagedPolicies.map((item, idx) => (
                <tr
                  ref={idx === 0 ? firstRowRef : undefined}
                  key={`${item.namespace}/${item.name}`}
                  className="text-slate-200 hover:bg-slate-800/60 cursor-pointer"
                  onClick={() => openDetail({
                    kind: config.kind,
                    name: item.name,
                    namespace: item.namespace,
                    rawJson: toRawJson(item, apiVersion, config.kind),
                  })}
                >
                  {showNamespaceColumn && <td className="py-3 px-4 text-xs font-mono"><span className="block truncate">{item.namespace}</span></td>}
                  <td className="py-3 px-4 font-medium text-white"><span className="block truncate">{item.name}</span></td>
                  <td className="py-3 px-4 text-xs"><span className="block truncate">{formatTargetRefs(item)}</span></td>
                  <td className="py-3 px-4 text-xs"><span className="block truncate">{formatConditionStatus(item)}</span></td>
                  <td className="py-3 px-4 text-xs font-mono">{formatAge(item.created_at)}</td>
                </tr>
              ))}
              {isLoading && (
                <tr>
                  <td colSpan={showNamespaceColumn ? 5 : 4} className="py-10 px-4 text-center text-slate-400">
                    <div className="inline-flex items-center gap-2">
                      <Loader2 className="w-4 h-4 animate-spin" />
                      Loading...
                    </div>
                  </td>
                </tr>
              )}

              {sortedPolicies.length === 0 && !isLoading && (
                <tr>
                  <td colSpan={showNamespaceColumn ? 5 : 4} className="py-6 px-4 text-center text-slate-400">
                    {strings.noResults}
                  </td>
                </tr>
              )}
            </tbody>
            <AdaptiveTableFillerRows count={rowsPerPage - pagedPolicies.length} columnCount={4 + (showNamespaceColumn ? 1 : 0)} />
          </table>
        </div>

        {sortedPolicies.length > 0 && (
          <div className="flex items-center justify-between px-4 py-3 border-t border-slate-700 shrink-0">
            <div className="text-xs text-slate-400">
              {tr('common.paginationRange', 'Showing {{start}}-{{end}} of {{total}}', {
                start: (currentPage - 1) * rowsPerPage + 1,
                end: Math.min(currentPage * rowsPerPage, sortedPolicies.length),
                total: sortedPolicies.length,
              })}
            </div>
            <div className="flex items-center gap-2">
              <button type="button" onClick={() => setCurrentPage((prev) => Math.max(1, prev - 1))} disabled={currentPage <= 1}
                className="px-3 py-1.5 text-xs rounded border border-slate-600 text-slate-300 disabled:opacity-40 disabled:cursor-not-allowed hover:text-white hover:border-slate-500">
                {tr('common.prev', 'Prev')}
              </button>
              <span className="text-xs text-slate-300 min-w-[72px] text-center">{currentPage} / {totalPages}</span>
              <button type="button" onClick={() => setCurrentPage((prev) => Math.min(totalPages, prev + 1))} disabled={currentPage >= totalPages}
                className="px-3 py-1.5 text-xs rounded border border-slate-600 text-slate-300 disabled:opacity-40 disabled:cursor-not-allowed hover:text-white hover:border-slate-500">
                {tr('common.next', 'Next')}
              </button>
            </div>
          </div>
        )}
      </div>

      {createDialogOpen && (
        <ResourceYamlCreateDialog
          title={strings.createDialogTitle}
          initialYaml={createYamlTemplate}
          namespace={selectedNamespace !== 'all' ? selectedNamespace : undefined}
          onClose={() => setCreateDialogOpen(false)}
          onCreated={() => { queryClient.invalidateQueries({ queryKey: [...config.queryKeyPrefix] }) }}
        />
      )}
    </div>
  )
}
