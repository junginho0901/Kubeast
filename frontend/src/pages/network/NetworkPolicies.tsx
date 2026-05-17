import { useEffect, useMemo, useRef, useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { useTranslation } from 'react-i18next'
import { api, type NetworkPolicyInfo } from '@/services/api'
import { useKubeWatchList } from '@/services/useKubeWatchList'
import { useResourceDetail } from '@/components/ResourceDetailContext'
import ResourceYamlCreateDialog from '@/components/ResourceYamlCreateDialog'
import { useAdaptiveTable } from '@/hooks/useAdaptiveTable'
import { AdaptiveTableFillerRows } from '@/components/AdaptiveTableFillerRows'
import { useAIContext } from '@/hooks/useAIContext'
import { usePermission } from '@/hooks/usePermission'
import { summarizeList } from '@/utils/aiContext/summarizeList'
import { buildResourceLink } from '@/utils/resourceLink'
import { Loader2, CheckCircle, ChevronDown, ChevronUp, Plus, RefreshCw, Search } from 'lucide-react'
import {
  formatAge,
  formatDefaultDeny,
  formatPolicyTypes,
  formatSelector,
  networkPolicyToRawJson,
  parseAgeSeconds,
  type SortKey,
} from './networkpolicies/networkPolicyHelpers'
import { applyNetworkPolicyWatchEvent } from './networkpolicies/networkPolicyWatchNormalize'

type SummaryCard = [label: string, value: number, boxClass: string, labelClass: string]

export default function NetworkPolicies() {
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

  const { data: namespaces } = useQuery({
    queryKey: ['namespaces'],
    queryFn: () => api.getNamespaces(),
    staleTime: 30000,
  })

  const { data: policies, isLoading } = useQuery({
    queryKey: ['network', 'networkpolicies', selectedNamespace],
    queryFn: () => (
      selectedNamespace === 'all'
        ? api.getAllNetworkPolicies(false)
        : api.getNetworkPolicies(selectedNamespace, false)
    ),
  })
  const { has } = usePermission()
  const canCreate = has('resource.networkpolicy.create')

  useKubeWatchList({
    enabled: true,
    queryKey: ['network', 'networkpolicies', selectedNamespace],
    path: selectedNamespace === 'all'
      ? '/api/v1/networkpolicies'
      : `/api/v1/namespaces/${selectedNamespace}/networkpolicies`,
    query: 'watch=1',
    applyEvent: (prev, event) => applyNetworkPolicyWatchEvent(prev as NetworkPolicyInfo[] | undefined, event),
    onEvent: (event) => {
      if (event?.type === 'DELETED') return
      const name = event?.object?.name || event?.object?.metadata?.name
      const ns = event?.object?.namespace || event?.object?.metadata?.namespace
      if (name && ns) {
        queryClient.invalidateQueries({ queryKey: ['networkpolicy-describe', ns, name] })
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

  const filteredPolicies = useMemo(() => {
    if (!Array.isArray(policies)) return [] as NetworkPolicyInfo[]
    if (!searchQuery.trim()) return policies
    const q = searchQuery.toLowerCase()
    return policies.filter((policy) => (
      policy.name.toLowerCase().includes(q)
      || policy.namespace.toLowerCase().includes(q)
      || formatSelector(policy).toLowerCase().includes(q)
      || formatPolicyTypes(policy).toLowerCase().includes(q)
      || String(policy.ingress_rules || 0).includes(q)
      || String(policy.egress_rules || 0).includes(q)
      || formatDefaultDeny(policy).toLowerCase().includes(q)
    ))
  }, [policies, searchQuery])

  const summary = useMemo(() => {
    const total = filteredPolicies.length
    let defaultDenyIngress = 0
    let defaultDenyEgress = 0
    let selectsAllPods = 0

    for (const policy of filteredPolicies) {
      if (policy.default_deny_ingress) defaultDenyIngress += 1
      if (policy.default_deny_egress) defaultDenyEgress += 1
      if (policy.selects_all_pods) selectsAllPods += 1
    }

    return { total, defaultDenyIngress, defaultDenyEgress, selectsAllPods }
  }, [filteredPolicies])

  const summaryCards = useMemo<SummaryCard[]>(
    () => [
      [tr('networkPoliciesPage.stats.total', 'Total'), summary.total, 'border-slate-700 bg-slate-900/50', 'text-slate-400'],
      [tr('networkPoliciesPage.stats.defaultDenyIngress', 'Default Deny Ingress'), summary.defaultDenyIngress, 'border-amber-700/40 bg-amber-900/10', 'text-amber-300'],
      [tr('networkPoliciesPage.stats.defaultDenyEgress', 'Default Deny Egress'), summary.defaultDenyEgress, 'border-orange-700/40 bg-orange-900/10', 'text-orange-300'],
      [tr('networkPoliciesPage.stats.selectsAllPods', 'Selects All Pods'), summary.selectsAllPods, 'border-cyan-700/40 bg-cyan-900/10', 'text-cyan-300'],
    ],
    [summary.defaultDenyEgress, summary.defaultDenyIngress, summary.selectsAllPods, summary.total, tr],
  )

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

  const sortedPolicies = useMemo(() => {
    if (!sortKey) return filteredPolicies
    const list = [...filteredPolicies]

    const getValue = (policy: NetworkPolicyInfo): string | number => {
      switch (sortKey) {
        case 'name':
          return policy.name
        case 'namespace':
          return policy.namespace
        case 'podSelector':
          return formatSelector(policy)
        case 'types':
          return formatPolicyTypes(policy)
        case 'ingressRules':
          return policy.ingress_rules || 0
        case 'egressRules':
          return policy.egress_rules || 0
        case 'defaultDeny':
          return formatDefaultDeny(policy)
        case 'age':
          return parseAgeSeconds(policy.created_at)
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
  }, [filteredPolicies, sortDir, sortKey])

  const { containerRef: tableContainerRef, bodyRef: tableBodyRef, theadRef, firstRowRef, rowsPerPage } = useAdaptiveTable({
    recalculationKey: sortedPolicies.length,
  })
  const totalPages = Math.max(1, Math.ceil(sortedPolicies.length / rowsPerPage))

  useEffect(() => {
    setCurrentPage(1)
  }, [searchQuery, selectedNamespace])

  useEffect(() => {
    if (currentPage > totalPages) setCurrentPage(totalPages)
  }, [currentPage, totalPages])

  const pagedPolicies = useMemo(() => {
    const start = (currentPage - 1) * rowsPerPage
    return sortedPolicies.slice(start, start + rowsPerPage)
  }, [sortedPolicies, currentPage, rowsPerPage])

  // 플로팅 AI 위젯용 스냅샷
  const aiSnapshot = useMemo(() => {
    if (!Array.isArray(policies) || policies.length === 0) return null
    const nsLabel = selectedNamespace === 'all' ? '전체 네임스페이스' : selectedNamespace
    const total = policies.length
    const denyAll = policies.filter((p) => p.default_deny_ingress || p.default_deny_egress).length
    return {
      source: 'base' as const,
      summary: `${nsLabel} NetworkPolicy ${total}개${denyAll ? ` (default-deny ${denyAll})` : ''}`,
      data: {
        filters: { namespace: selectedNamespace, search: searchQuery || undefined },
        stats: { total, default_deny: denyAll },
        ...summarizeList(pagedPolicies as unknown as Record<string, unknown>[], {
          total: sortedPolicies.length,
          currentPage,
          pageSize: rowsPerPage,
          topN: rowsPerPage,
          pickFields: ['name', 'namespace', 'policy_types', 'ingress_rules', 'egress_rules', 'default_deny_ingress', 'default_deny_egress'],
          linkBuilder: (p) => {
            const pol = p as unknown as NetworkPolicyInfo
            return buildResourceLink('NetworkPolicy', pol.namespace, pol.name)
          },
        }),
      },
    }
  }, [policies, pagedPolicies, sortedPolicies.length, currentPage, rowsPerPage, selectedNamespace, searchQuery])

  useAIContext(aiSnapshot, [aiSnapshot])

  const handleRefresh = async () => {
    if (isRefreshing) return
    setIsRefreshing(true)
    try {
      const data = selectedNamespace === 'all'
        ? await api.getAllNetworkPolicies(true)
        : await api.getNetworkPolicies(selectedNamespace, true)
      queryClient.removeQueries({ queryKey: ['network', 'networkpolicies', selectedNamespace] })
      queryClient.setQueryData(['network', 'networkpolicies', selectedNamespace], data)
    } catch (error) {
      console.error('Network policies refresh failed:', error)
    }
    setTimeout(() => setIsRefreshing(false), 500)
  }

  const createNetworkPolicyYamlTemplate = useMemo(() => {
    const ns = selectedNamespace !== 'all' ? selectedNamespace : 'default'
    return `apiVersion: networking.k8s.io/v1
kind: NetworkPolicy
metadata:
  name: allow-sample
  namespace: ${ns}
spec:
  podSelector:
    matchLabels:
      app: sample
  policyTypes:
    - Ingress
  ingress:
    - from:
        - namespaceSelector: {}
`
  }, [selectedNamespace])

  const showNamespaceColumn = selectedNamespace === 'all'

  return (
    <div className="flex flex-col h-[calc(100vh-4rem)] gap-4">
      <div className="flex items-center justify-between shrink-0">
        <div>
          <h1 className="text-3xl font-bold text-white">{tr('networkPoliciesPage.title', 'Network Policies')}</h1>
          <p className="mt-2 text-slate-400">{tr('networkPoliciesPage.subtitle', 'Inspect and manage NetworkPolicy resources across namespaces.')}</p>
        </div>
        <div className="flex items-center gap-2">
          {canCreate && (
            <button
              type="button"
              onClick={() => setCreateDialogOpen(true)}
              className="btn btn-primary flex items-center gap-2"
            >
              <Plus className="w-4 h-4" />
              {tr('networkPoliciesPage.create', 'Create NetworkPolicy')}
            </button>
          )}
          <button
            type="button"
            onClick={handleRefresh}
            disabled={isRefreshing}
            title={tr('networkPoliciesPage.refreshTitle', 'Force refresh')}
            className="btn btn-primary flex items-center gap-2 disabled:opacity-50 disabled:cursor-not-allowed"
          >
            <RefreshCw className={`w-4 h-4 ${isRefreshing ? 'animate-spin' : ''}`} />
            {tr('networkPoliciesPage.refresh', 'Refresh')}
          </button>
        </div>
      </div>

      <div className="grid grid-cols-1 xl:grid-cols-3 gap-3 shrink-0">
        <div className="xl:col-span-2">
          <div className="relative">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-5 h-5 text-slate-400" />
            <input
              type="text"
              placeholder={tr('networkPoliciesPage.searchPlaceholder', 'Search network policies by name...')}
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
              {selectedNamespace === 'all' ? tr('networkPoliciesPage.allNamespaces', 'All namespaces') : selectedNamespace}
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
                <span className={selectedNamespace === 'all' ? 'font-medium' : ''}>{tr('networkPoliciesPage.allNamespaces', 'All namespaces')}</span>
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

      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3 shrink-0">
        {summaryCards.map(([label, value, boxClass, labelClass]) => (
          <div key={label} className={`rounded-lg border px-4 py-3 ${boxClass}`}>
            <p className={`text-[11px] sm:text-xs leading-4 whitespace-nowrap ${labelClass}`}>{label}</p>
            <p className="text-lg text-white font-semibold mt-1">{value}</p>
          </div>
        ))}
      </div>

      {searchQuery && (
        <p className="text-sm text-slate-400 shrink-0">
          {tr('networkPoliciesPage.matchCount', '{{count}} network polic{{suffix}} match.', {
            count: filteredPolicies.length,
            suffix: filteredPolicies.length === 1 ? 'y' : 'ies',
          })}
        </p>
      )}

      <div ref={tableContainerRef} className="card flex-1 min-h-0 flex flex-col">
        <div ref={tableBodyRef} className="overflow-x-auto flex-1 min-h-0">
          <table className="w-full text-sm min-w-[1140px] table-fixed">
            <thead ref={theadRef} className="text-slate-400">
              <tr>
                {showNamespaceColumn && (
                  <th className="text-left py-3 px-4 w-[180px] cursor-pointer" onClick={() => handleSort('namespace')}>
                    <span className="inline-flex items-center gap-1">{tr('networkPoliciesPage.table.namespace', 'Namespace')}{renderSortIcon('namespace')}</span>
                  </th>
                )}
                <th className="text-left py-3 px-4 w-[220px] cursor-pointer" onClick={() => handleSort('name')}>
                  <span className="inline-flex items-center gap-1">{tr('networkPoliciesPage.table.name', 'Name')}{renderSortIcon('name')}</span>
                </th>
                <th className="text-left py-3 px-4 w-[280px] cursor-pointer" onClick={() => handleSort('podSelector')}>
                  <span className="inline-flex items-center gap-1">{tr('networkPoliciesPage.table.podSelector', 'Pod Selector')}{renderSortIcon('podSelector')}</span>
                </th>
                <th className="text-left py-3 px-4 w-[170px] cursor-pointer" onClick={() => handleSort('types')}>
                  <span className="inline-flex items-center gap-1">{tr('networkPoliciesPage.table.types', 'Types')}{renderSortIcon('types')}</span>
                </th>
                <th className="text-left py-3 px-4 w-[120px] cursor-pointer" onClick={() => handleSort('ingressRules')}>
                  <span className="inline-flex items-center gap-1">{tr('networkPoliciesPage.table.ingressRules', 'Ingress')}{renderSortIcon('ingressRules')}</span>
                </th>
                <th className="text-left py-3 px-4 w-[120px] cursor-pointer" onClick={() => handleSort('egressRules')}>
                  <span className="inline-flex items-center gap-1">{tr('networkPoliciesPage.table.egressRules', 'Egress')}{renderSortIcon('egressRules')}</span>
                </th>
                <th className="text-left py-3 px-4 w-[150px] cursor-pointer" onClick={() => handleSort('defaultDeny')}>
                  <span className="inline-flex items-center gap-1">{tr('networkPoliciesPage.table.defaultDeny', 'Default Deny')}{renderSortIcon('defaultDeny')}</span>
                </th>
                <th className="text-left py-3 px-4 w-[90px] cursor-pointer" onClick={() => handleSort('age')}>
                  <span className="inline-flex items-center gap-1">{tr('networkPoliciesPage.table.age', 'Age')}{renderSortIcon('age')}</span>
                </th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-700">
              {pagedPolicies.map((policy, idx) => (
                <tr
                      ref={idx === 0 ? firstRowRef : undefined}
                  key={`${policy.namespace}/${policy.name}`}
                  className="text-slate-200 hover:bg-slate-800/60 cursor-pointer"
                  onClick={() => openDetail({
                    kind: 'NetworkPolicy',
                    name: policy.name,
                    namespace: policy.namespace,
                    rawJson: networkPolicyToRawJson(policy),
                  })}
                >
                  {showNamespaceColumn && <td className="py-3 px-4 text-xs font-mono"><span className="block truncate">{policy.namespace}</span></td>}
                  <td className="py-3 px-4 font-medium text-white"><span className="block truncate">{policy.name}</span></td>
                  <td className="py-3 px-4 text-xs font-mono"><span className="block truncate">{formatSelector(policy)}</span></td>
                  <td className="py-3 px-4 text-xs"><span className="block truncate">{formatPolicyTypes(policy)}</span></td>
                  <td className="py-3 px-4 text-xs font-mono">{policy.ingress_rules || 0}</td>
                  <td className="py-3 px-4 text-xs font-mono">{policy.egress_rules || 0}</td>
                  <td className="py-3 px-4 text-xs"><span className="block truncate">{formatDefaultDeny(policy)}</span></td>
                  <td className="py-3 px-4 text-xs font-mono">{formatAge(policy.created_at)}</td>
                </tr>
              ))}
              {isLoading && (
                <tr>
                  <td colSpan={showNamespaceColumn ? 9 : 8} className="py-10 px-4 text-center text-slate-400">
                    <div className="inline-flex items-center gap-2">
                      <Loader2 className="w-4 h-4 animate-spin" />
                      Loading...
                    </div>
                  </td>
                </tr>
              )}

              {sortedPolicies.length === 0 && !isLoading && (
                <tr>
                  <td colSpan={showNamespaceColumn ? 9 : 8} className="py-6 px-4 text-center text-slate-400">
                    {tr('networkPoliciesPage.noResults', 'No network policies found.')}
                  </td>
                </tr>
              )}
            </tbody>
              <AdaptiveTableFillerRows count={rowsPerPage - pagedPolicies.length} columnCount={7 + (showNamespaceColumn ? 1 : 0)} />
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
          title={tr('networkPoliciesPage.createTitle', 'Create NetworkPolicy from YAML')}
          initialYaml={createNetworkPolicyYamlTemplate}
          namespace={selectedNamespace !== 'all' ? selectedNamespace : undefined}
          onClose={() => setCreateDialogOpen(false)}
          onCreated={() => {
            queryClient.invalidateQueries({ queryKey: ['network', 'networkpolicies'] })
          }}
        />
      )}
    </div>
  )
}
