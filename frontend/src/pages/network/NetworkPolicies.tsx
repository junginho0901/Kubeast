import { useEffect, useMemo, useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { useTranslation } from 'react-i18next'
import { api, type NetworkPolicyInfo } from '@/services/api'
import { useKubeWatchList } from '@/services/useKubeWatchList'
import { useResourceDetail } from '@/components/ResourceDetailContext'
import ResourceYamlCreateDialog from '@/components/ResourceYamlCreateDialog'
import { useAdaptiveTable } from '@/hooks/useAdaptiveTable'
import { useAIContext } from '@/hooks/useAIContext'
import { usePermission } from '@/hooks/usePermission'
import { summarizeList } from '@/utils/aiContext/summarizeList'
import { buildResourceLink } from '@/utils/resourceLink'
import { Plus, RefreshCw } from 'lucide-react'
import {
  formatDefaultDeny,
  formatPolicyTypes,
  formatSelector,
  parseAgeSeconds,
  type SortKey,
} from './networkpolicies/networkPolicyHelpers'
import { applyNetworkPolicyWatchEvent } from './networkpolicies/networkPolicyWatchNormalize'
import { NetworkPolicyFilters } from './networkpolicies/NetworkPolicyFilters'
import { NetworkPolicyTable } from './networkpolicies/NetworkPolicyTable'

type SummaryCard = [label: string, value: number, boxClass: string, labelClass: string]

export default function NetworkPolicies() {
  const queryClient = useQueryClient()
  const { t } = useTranslation()
  const tr = (key: string, fallback: string, options?: Record<string, any>) =>
    t(key, { defaultValue: fallback, ...options })
  const { open: openDetail } = useResourceDetail()

  const [searchQuery, setSearchQuery] = useState('')
  const [selectedNamespace, setSelectedNamespace] = useState<string>('all')
  const [isRefreshing, setIsRefreshing] = useState(false)
  const [sortKey, setSortKey] = useState<SortKey>(null)
  const [sortDir, setSortDir] = useState<'asc' | 'desc'>('asc')
  const [currentPage, setCurrentPage] = useState(1)
  const [createDialogOpen, setCreateDialogOpen] = useState(false)

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

      <NetworkPolicyFilters
        searchQuery={searchQuery}
        setSearchQuery={setSearchQuery}
        selectedNamespace={selectedNamespace}
        setSelectedNamespace={setSelectedNamespace}
        namespaces={namespaces}
        searchPlaceholder={tr('networkPoliciesPage.searchPlaceholder', 'Search network policies by name...')}
        allNamespacesLabel={tr('networkPoliciesPage.allNamespaces', 'All namespaces')}
      />

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

      <NetworkPolicyTable
        pagedPolicies={pagedPolicies}
        sortedPoliciesLength={sortedPolicies.length}
        isLoading={isLoading}
        showNamespaceColumn={showNamespaceColumn}
        sortKey={sortKey}
        setSortKey={setSortKey}
        sortDir={sortDir}
        setSortDir={setSortDir}
        currentPage={currentPage}
        setCurrentPage={setCurrentPage}
        totalPages={totalPages}
        rowsPerPage={rowsPerPage}
        tableContainerRef={tableContainerRef}
        tableBodyRef={tableBodyRef}
        theadRef={theadRef}
        firstRowRef={firstRowRef}
        openDetail={openDetail}
        tr={tr}
      />

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
