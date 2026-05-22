import { useEffect, useMemo, useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { useTranslation } from 'react-i18next'
import { api, type LeaseInfo } from '@/services/api'
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
  leaseToRawJson,
  type SortKey,
} from './leases/leaseHelpers'
import { applyLeaseWatchEvent } from './leases/leaseWatchNormalize'
import { LeaseFilters } from './leases/LeaseFilters'
import { LeaseTable } from './leases/LeaseTable'

export default function Leases() {
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

  const { data: leases, isLoading } = useQuery({
    queryKey: ['cluster', 'leases', selectedNamespace],
    queryFn: () => (
      selectedNamespace === 'all'
        ? api.getAllLeases(false)
        : api.getLeases(selectedNamespace, false)
    ),
  })
  const { has } = usePermission()
  const canCreate = has('resource.lease.create')

  useKubeWatchList({
    enabled: true,
    queryKey: ['cluster', 'leases', selectedNamespace],
    path: selectedNamespace === 'all'
      ? '/apis/coordination.k8s.io/v1/leases'
      : `/apis/coordination.k8s.io/v1/namespaces/${selectedNamespace}/leases`,
    query: 'watch=1',
    applyEvent: (prev, event) => applyLeaseWatchEvent(prev as LeaseInfo[] | undefined, event),
  })

  const filteredLeases = useMemo(() => {
    if (!Array.isArray(leases)) return [] as LeaseInfo[]
    if (!searchQuery.trim()) return leases
    const q = searchQuery.toLowerCase()
    return leases.filter((l) =>
      l.name.toLowerCase().includes(q) ||
      l.namespace.toLowerCase().includes(q) ||
      (l.holder_identity || '').toLowerCase().includes(q),
    )
  }, [leases, searchQuery])

  const summary = useMemo(() => {
    const total = filteredLeases.length
    let withHolder = 0
    for (const l of filteredLeases) {
      if (l.holder_identity) withHolder += 1
    }
    return { total, withHolder, withoutHolder: total - withHolder }
  }, [filteredLeases])

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

  const sortedLeases = useMemo(() => {
    if (!sortKey) return filteredLeases
    const list = [...filteredLeases]

    const getValue = (l: LeaseInfo): string | number => {
      switch (sortKey) {
        case 'name': return l.name
        case 'namespace': return l.namespace
        case 'holder': return l.holder_identity || ''
        case 'duration': return l.lease_duration_seconds ?? 0
        case 'age': return parseAgeSeconds(l.created_at)
        default: return ''
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
  }, [filteredLeases, sortDir, sortKey])

  const { containerRef: tableContainerRef, bodyRef: tableBodyRef, theadRef, firstRowRef, rowsPerPage } = useAdaptiveTable({
    recalculationKey: sortedLeases.length,
  })
  const totalPages = Math.max(1, Math.ceil(sortedLeases.length / rowsPerPage))

  useEffect(() => {
    setCurrentPage(1)
  }, [searchQuery, selectedNamespace])

  useEffect(() => {
    if (currentPage > totalPages) {
      setCurrentPage(totalPages)
    }
  }, [currentPage, totalPages])

  const pagedLeases = useMemo(() => {
    const start = (currentPage - 1) * rowsPerPage
    return sortedLeases.slice(start, start + rowsPerPage)
  }, [sortedLeases, currentPage, rowsPerPage])

  // 플로팅 AI 위젯용 스냅샷
  const aiSnapshot = useMemo(() => {
    if (!Array.isArray(leases) || leases.length === 0) return null
    const nsLabel = selectedNamespace === 'all' ? '전체 네임스페이스' : selectedNamespace
    const total = leases.length
    return {
      source: 'base' as const,
      summary: `${nsLabel} Lease ${total}개`,
      data: {
        filters: { namespace: selectedNamespace, search: searchQuery || undefined },
        stats: { total },
        ...summarizeList(pagedLeases as unknown as Record<string, unknown>[], {
          total: sortedLeases.length,
          currentPage,
          pageSize: rowsPerPage,
          topN: rowsPerPage,
          pickFields: ['name', 'namespace'],
          linkBuilder: (l) => {
            const li = l as unknown as LeaseInfo
            return buildResourceLink('Lease', li.namespace, li.name)
          },
        }),
      },
    }
  }, [leases, pagedLeases, sortedLeases.length, currentPage, rowsPerPage, selectedNamespace, searchQuery])

  useAIContext(aiSnapshot, [aiSnapshot])

  const handleRefresh = async () => {
    if (isRefreshing) return
    setIsRefreshing(true)
    try {
      const data = selectedNamespace === 'all'
        ? await api.getAllLeases(true)
        : await api.getLeases(selectedNamespace, true)
      queryClient.removeQueries({ queryKey: ['cluster', 'leases', selectedNamespace] })
      queryClient.setQueryData(['cluster', 'leases', selectedNamespace], data)
    } catch (error) {
      console.error('Leases refresh failed:', error)
    }
    setTimeout(() => setIsRefreshing(false), 500)
  }

  const createLeaseYamlTemplate = useMemo(() => {
    const ns = selectedNamespace !== 'all' ? selectedNamespace : 'default'
    return `apiVersion: coordination.k8s.io/v1
kind: Lease
metadata:
  name: sample-lease
  namespace: ${ns}
spec:
  holderIdentity: "sample-holder"
  leaseDurationSeconds: 40
`
  }, [selectedNamespace])

  const showNamespaceColumn = selectedNamespace === 'all'

  return (
    <div className="flex flex-col h-[calc(100vh-4rem)] gap-4">
      <div className="flex items-center justify-between shrink-0">
        <div>
          <h1 className="text-3xl font-bold text-white">{tr('leases.title', 'Leases')}</h1>
          <p className="mt-2 text-slate-400">
            {tr('leases.subtitle', 'Manage coordination leases across namespaces.')}
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
              {tr('leases.create', 'Create Lease')}
            </button>
          )}
          <button
            type="button"
            onClick={handleRefresh}
            disabled={isRefreshing}
            title={tr('leases.refreshTitle', 'Force refresh')}
            className="btn btn-primary flex items-center gap-2 disabled:opacity-50 disabled:cursor-not-allowed"
          >
            <RefreshCw className={`w-4 h-4 ${isRefreshing ? 'animate-spin' : ''}`} />
            {tr('leases.refresh', 'Refresh')}
          </button>
        </div>
      </div>

      <LeaseFilters
        searchQuery={searchQuery}
        onSearchChange={setSearchQuery}
        selectedNamespace={selectedNamespace}
        onNamespaceChange={setSelectedNamespace}
        namespaces={namespaces}
      />

      <div className="grid grid-cols-2 lg:grid-cols-3 gap-3 shrink-0">
        <div className="rounded-lg border border-slate-700 bg-slate-900/50 px-4 py-3">
          <p className="text-[11px] sm:text-xs leading-4 whitespace-nowrap text-slate-400">{tr('leases.stats.total', 'Total')}</p>
          <p className="text-lg text-white font-semibold mt-1">{summary.total}</p>
        </div>
        <div className="rounded-lg border border-emerald-700/40 bg-emerald-900/10 px-4 py-3">
          <p className="text-[11px] sm:text-xs leading-4 whitespace-nowrap text-emerald-300">{tr('leases.stats.withHolder', 'With Holder')}</p>
          <p className="text-lg text-white font-semibold mt-1">{summary.withHolder}</p>
        </div>
        <div className="rounded-lg border border-slate-700 bg-slate-900/50 px-4 py-3">
          <p className="text-[11px] sm:text-xs leading-4 whitespace-nowrap text-slate-400">{tr('leases.stats.withoutHolder', 'Without Holder')}</p>
          <p className="text-lg text-white font-semibold mt-1">{summary.withoutHolder}</p>
        </div>
      </div>

      {searchQuery && (
        <p className="text-sm text-slate-400 shrink-0">
          {tr('leases.matchCount', '{{count}} lease{{suffix}} match.', {
            count: filteredLeases.length,
            suffix: filteredLeases.length === 1 ? '' : 's',
          })}
        </p>
      )}

      <LeaseTable
        pagedLeases={pagedLeases}
        sortedLeasesLength={sortedLeases.length}
        isLoading={isLoading}
        showNamespaceColumn={showNamespaceColumn}
        sortKey={sortKey}
        sortDir={sortDir}
        onSort={handleSort}
        currentPage={currentPage}
        totalPages={totalPages}
        rowsPerPage={rowsPerPage}
        onPageChange={setCurrentPage}
        onOpenDetail={(l) => openDetail({
          kind: 'Lease',
          name: l.name,
          namespace: l.namespace,
          rawJson: leaseToRawJson(l),
        })}
        containerRef={tableContainerRef}
        bodyRef={tableBodyRef}
        theadRef={theadRef}
        firstRowRef={firstRowRef}
      />

      {createDialogOpen && (
        <ResourceYamlCreateDialog
          title={tr('leases.createTitle', 'Create Lease from YAML')}
          initialYaml={createLeaseYamlTemplate}
          onClose={() => setCreateDialogOpen(false)}
          onCreated={() => {
            queryClient.invalidateQueries({ queryKey: ['cluster', 'leases'] })
          }}
        />
      )}
    </div>
  )
}
