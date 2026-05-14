import { useEffect, useMemo, useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { useTranslation } from 'react-i18next'
import { api, type DeploymentInfo } from '@/services/api'
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
  parseAgeSeconds,
  computeDeploymentStatus,
  type SortKey,
} from './deployments/deploymentHelpers'
import { applyDeploymentWatchEvent } from './deployments/deploymentWatchNormalize'
import { DeploymentFilters } from './deployments/DeploymentFilters'
import { DeploymentTable } from './deployments/DeploymentTable'

export default function Deployments() {
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

  const { data: deployments, isLoading } = useQuery({
    queryKey: ['workloads', 'deployments', selectedNamespace],
    queryFn: () => (
      selectedNamespace === 'all'
        ? api.getAllDeployments(false)
        : api.getDeployments(selectedNamespace, false)
    ),
  })
  const { has } = usePermission()
  const canCreate = has('resource.deployment.create')

  useKubeWatchList({
    enabled: true,
    queryKey: ['workloads', 'deployments', selectedNamespace],
    path: selectedNamespace === 'all'
      ? '/apis/apps/v1/deployments'
      : `/apis/apps/v1/namespaces/${selectedNamespace}/deployments`,
    query: 'watch=1',
    applyEvent: (prev, event) => applyDeploymentWatchEvent(prev as DeploymentInfo[] | undefined, event),
  })

  const filteredDeployments = useMemo(() => {
    if (!Array.isArray(deployments)) return [] as DeploymentInfo[]
    if (!searchQuery.trim()) return deployments
    const q = searchQuery.toLowerCase()
    return deployments.filter((dep) =>
      dep.name.toLowerCase().includes(q) ||
      dep.namespace.toLowerCase().includes(q) ||
      (dep.image || '').toLowerCase().includes(q) ||
      (dep.status || '').toLowerCase().includes(q),
    )
  }, [deployments, searchQuery])

  const summary = useMemo(() => {
    const total = filteredDeployments.length
    let healthy = 0
    let degraded = 0
    let unavailable = 0

    for (const dep of filteredDeployments) {
      const status = String(
        dep.status || computeDeploymentStatus(dep.replicas || 0, dep.ready_replicas || 0),
      ).toLowerCase()

      if (status.includes('healthy')) healthy += 1
      else if (status.includes('unavailable')) unavailable += 1
      else degraded += 1
    }

    return { total, healthy, degraded, unavailable }
  }, [filteredDeployments])

  const sortedDeployments = useMemo(() => {
    if (!sortKey) return filteredDeployments
    const list = [...filteredDeployments]

    const getValue = (dep: DeploymentInfo): string | number => {
      switch (sortKey) {
        case 'name':
          return dep.name
        case 'ready':
          return dep.replicas === 0 ? 0 : (dep.ready_replicas || 0) / dep.replicas
        case 'updated':
          return dep.updated_replicas || 0
        case 'available':
          return dep.available_replicas || 0
        case 'status':
          return dep.status || ''
        case 'image':
          return dep.image || ''
        case 'age':
          return parseAgeSeconds(dep.created_at)
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
  }, [filteredDeployments, sortDir, sortKey])

  const { containerRef: tableContainerRef, bodyRef: tableBodyRef, theadRef, firstRowRef, rowsPerPage } = useAdaptiveTable({
    recalculationKey: sortedDeployments.length,
  })
  const totalPages = Math.max(1, Math.ceil(sortedDeployments.length / rowsPerPage))

  useEffect(() => {
    setCurrentPage(1)
  }, [searchQuery, selectedNamespace])

  useEffect(() => {
    if (currentPage > totalPages) {
      setCurrentPage(totalPages)
    }
  }, [currentPage, totalPages])

  const pagedDeployments = useMemo(() => {
    const start = (currentPage - 1) * rowsPerPage
    return sortedDeployments.slice(start, start + rowsPerPage)
  }, [sortedDeployments, currentPage, rowsPerPage])

  // 플로팅 AI 위젯용 스냅샷
  const aiSnapshot = useMemo(() => {
    if (!Array.isArray(deployments) || deployments.length === 0) return null
    const nsLabel = selectedNamespace === 'all' ? '전체 네임스페이스' : selectedNamespace
    const unhealthy = summary.degraded + summary.unavailable
    const prefix = summary.unavailable > 0 ? '⚠️ ' : ''
    const summaryText = `${prefix}${nsLabel} Deployment ${summary.total}개 (Healthy ${summary.healthy}${unhealthy ? `, 문제 ${unhealthy}` : ''})`

    const problematic = (d: DeploymentInfo) => {
      const status = String(
        d.status || computeDeploymentStatus(d.replicas || 0, d.ready_replicas || 0),
      ).toLowerCase()
      return !status.includes('healthy')
    }

    return {
      source: 'base' as const,
      summary: summaryText,
      data: {
        filters: {
          namespace: selectedNamespace,
          search: searchQuery || undefined,
        },
        stats: {
          total: summary.total,
          healthy: summary.healthy,
          degraded: summary.degraded,
          unavailable: summary.unavailable,
        },
        ...summarizeList(pagedDeployments as unknown as Record<string, unknown>[], {
          total: sortedDeployments.length,
          currentPage,
          pageSize: rowsPerPage,
          topN: rowsPerPage,
          pickFields: ['name', 'namespace', 'replicas', 'ready_replicas', 'updated_replicas', 'available_replicas', 'status', 'image'],
          filterProblematic: (d) => problematic(d as unknown as DeploymentInfo),
          interpret: (items) => {
            const out: string[] = []
            const arr = items as unknown as DeploymentInfo[]
            const unavail = arr.filter((d) => {
              const s = String(d.status || '').toLowerCase()
              return s.includes('unavailable')
            }).length
            if (unavail > 0) out.push(`⚠️ ${unavail}개 Deployment 가 Unavailable`)
            const partial = arr.filter((d) => {
              const ready = d.ready_replicas ?? 0
              const total = d.replicas ?? 0
              return total > 0 && ready < total
            }).length
            if (partial > 0) out.push(`⚠️ ${partial}개 Deployment 가 replica 일부만 ready`)
            return out
          },
          linkBuilder: (d) => {
            const dep = d as unknown as DeploymentInfo
            return buildResourceLink('Deployment', dep.namespace, dep.name)
          },
        }),
      },
    }
  }, [deployments, pagedDeployments, sortedDeployments.length, currentPage, rowsPerPage, selectedNamespace, searchQuery, summary])

  useAIContext(aiSnapshot, [aiSnapshot])

  const handleRefresh = async () => {
    if (isRefreshing) return
    setIsRefreshing(true)
    try {
      const data = selectedNamespace === 'all'
        ? await api.getAllDeployments(true)
        : await api.getDeployments(selectedNamespace, true)
      queryClient.removeQueries({ queryKey: ['workloads', 'deployments', selectedNamespace] })
      queryClient.setQueryData(['workloads', 'deployments', selectedNamespace], data)
    } catch (error) {
      console.error('Deployments refresh failed:', error)
    }
    setTimeout(() => setIsRefreshing(false), 500)
  }

  const createDeploymentYamlTemplate = useMemo(() => {
    const ns = selectedNamespace !== 'all' ? selectedNamespace : 'default'
    return `apiVersion: apps/v1
kind: Deployment
metadata:
  name: sample-deployment
  namespace: ${ns}
  labels:
    app: sample
spec:
  replicas: 1
  selector:
    matchLabels:
      app: sample
  template:
    metadata:
      labels:
        app: sample
    spec:
      containers:
        - name: sample
          image: nginx:stable
          ports:
            - containerPort: 80
`
  }, [selectedNamespace])

  const showNamespaceColumn = selectedNamespace === 'all'

  return (
    <div className="flex flex-col h-[calc(100vh-4rem)] gap-4">
      <div className="flex items-center justify-between shrink-0">
        <div>
          <h1 className="text-3xl font-bold text-white">{tr('deployments.title', 'Deployments')}</h1>
          <p className="mt-2 text-slate-400">
            {tr('deployments.subtitle', 'Inspect rollout health across namespaces.')}
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
              {tr('deployments.create', 'Create Deployment')}
            </button>
          )}
          <button
            type="button"
            onClick={handleRefresh}
            disabled={isRefreshing}
            title={tr('deployments.refreshTitle', 'Force refresh')}
            className="btn btn-primary flex items-center gap-2 disabled:opacity-50 disabled:cursor-not-allowed"
          >
            <RefreshCw className={`w-4 h-4 ${isRefreshing ? 'animate-spin' : ''}`} />
            {tr('deployments.refresh', 'Refresh')}
          </button>
        </div>
      </div>

      <DeploymentFilters
        searchQuery={searchQuery}
        setSearchQuery={setSearchQuery}
        selectedNamespace={selectedNamespace}
        setSelectedNamespace={setSelectedNamespace}
        namespaces={namespaces}
        searchPlaceholder={tr('deployments.searchPlaceholder', 'Search deployments by name...')}
        allNamespacesLabel={tr('deployments.allNamespaces', 'All namespaces')}
      />

      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3 shrink-0">
        <div className="rounded-lg border border-slate-700 bg-slate-900/50 px-4 py-3">
          <p className="text-[11px] sm:text-xs leading-4 whitespace-nowrap text-slate-400">{tr('deployments.stats.total', 'Total')}</p>
          <p className="text-lg text-white font-semibold mt-1">{summary.total}</p>
        </div>
        <div className="rounded-lg border border-emerald-700/40 bg-emerald-900/10 px-4 py-3">
          <p className="text-[11px] sm:text-xs leading-4 whitespace-nowrap text-emerald-300">{tr('deployments.stats.healthy', 'Healthy')}</p>
          <p className="text-lg text-white font-semibold mt-1">{summary.healthy}</p>
        </div>
        <div className="rounded-lg border border-amber-700/40 bg-amber-900/10 px-4 py-3">
          <p className="text-[11px] sm:text-xs leading-4 whitespace-nowrap text-amber-300">{tr('deployments.stats.degraded', 'Degraded')}</p>
          <p className="text-lg text-white font-semibold mt-1">{summary.degraded}</p>
        </div>
        <div className="rounded-lg border border-red-700/40 bg-red-900/10 px-4 py-3">
          <p className="text-[11px] sm:text-xs leading-4 whitespace-nowrap text-red-300">{tr('deployments.stats.unavailable', 'Unavailable')}</p>
          <p className="text-lg text-white font-semibold mt-1">{summary.unavailable}</p>
        </div>
      </div>

      {searchQuery && (
        <p className="text-sm text-slate-400 shrink-0">
          {tr('deployments.matchCount', '{{count}} deployment{{suffix}} match.', {
            count: filteredDeployments.length,
            suffix: filteredDeployments.length === 1 ? '' : 's',
          })}
        </p>
      )}

      <DeploymentTable
        pagedDeployments={pagedDeployments}
        sortedDeploymentsLength={sortedDeployments.length}
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
          title={tr('deployments.createTitle', 'Create Deployment from YAML')}
          initialYaml={createDeploymentYamlTemplate}
          namespace={selectedNamespace !== 'all' ? selectedNamespace : undefined}
          onClose={() => setCreateDialogOpen(false)}
          onCreated={() => {
            queryClient.invalidateQueries({ queryKey: ['workloads', 'deployments'] })
          }}
        />
      )}
    </div>
  )
}
