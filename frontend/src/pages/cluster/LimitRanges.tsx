import { useEffect, useMemo, useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { useTranslation } from 'react-i18next'
import { api, type LimitRangeInfo } from '@/services/api'
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
  getLimitTypes,
  limitRangeToRawJson,
  type SortKey,
} from './limitranges/limitRangeHelpers'
import { applyLimitRangeWatchEvent } from './limitranges/limitRangeWatchNormalize'
import { LimitRangeFilters } from './limitranges/LimitRangeFilters'
import { LimitRangeTable } from './limitranges/LimitRangeTable'

export default function LimitRanges() {
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

  const { data: limitRanges, isLoading } = useQuery({
    queryKey: ['cluster', 'limitranges', selectedNamespace],
    queryFn: () => (
      selectedNamespace === 'all'
        ? api.getAllLimitRanges()
        : api.getLimitRanges(selectedNamespace)
    ),
  })
  const { has } = usePermission()
  const canCreate = has('resource.limitrange.create')

  useKubeWatchList({
    enabled: true,
    queryKey: ['cluster', 'limitranges', selectedNamespace],
    path: selectedNamespace === 'all'
      ? '/api/v1/limitranges'
      : `/api/v1/namespaces/${selectedNamespace}/limitranges`,
    query: 'watch=1',
    applyEvent: (prev, event) => applyLimitRangeWatchEvent(prev as LimitRangeInfo[] | undefined, event),
  })

  const filteredLimitRanges = useMemo(() => {
    if (!Array.isArray(limitRanges)) return [] as LimitRangeInfo[]
    if (!searchQuery.trim()) return limitRanges
    const q = searchQuery.toLowerCase()
    return limitRanges.filter((lr) =>
      lr.name.toLowerCase().includes(q) ||
      lr.namespace.toLowerCase().includes(q),
    )
  }, [limitRanges, searchQuery])

  const summary = useMemo(() => {
    const total = filteredLimitRanges.length
    let containerLimits = 0
    let podLimits = 0
    for (const lr of filteredLimitRanges) {
      if (Array.isArray(lr.limits)) {
        if (lr.limits.some((l) => l.type === 'Container')) containerLimits += 1
        if (lr.limits.some((l) => l.type === 'Pod')) podLimits += 1
      }
    }
    return { total, containerLimits, podLimits }
  }, [filteredLimitRanges])

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

  const sortedLimitRanges = useMemo(() => {
    if (!sortKey) return filteredLimitRanges
    const list = [...filteredLimitRanges]

    const getValue = (lr: LimitRangeInfo): string | number => {
      switch (sortKey) {
        case 'name': return lr.name
        case 'namespace': return lr.namespace
        case 'types': return getLimitTypes(lr)
        case 'age': return parseAgeSeconds(lr.created_at)
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
  }, [filteredLimitRanges, sortDir, sortKey])

  const { containerRef: tableContainerRef, bodyRef: tableBodyRef, theadRef, firstRowRef, rowsPerPage } = useAdaptiveTable({
    recalculationKey: sortedLimitRanges.length,
  })
  const totalPages = Math.max(1, Math.ceil(sortedLimitRanges.length / rowsPerPage))

  useEffect(() => {
    setCurrentPage(1)
  }, [searchQuery, selectedNamespace])

  useEffect(() => {
    if (currentPage > totalPages) {
      setCurrentPage(totalPages)
    }
  }, [currentPage, totalPages])

  const pagedLimitRanges = useMemo(() => {
    const start = (currentPage - 1) * rowsPerPage
    return sortedLimitRanges.slice(start, start + rowsPerPage)
  }, [sortedLimitRanges, currentPage, rowsPerPage])

  // 플로팅 AI 위젯용 스냅샷
  const aiSnapshot = useMemo(() => {
    if (!Array.isArray(limitRanges) || limitRanges.length === 0) return null
    const nsLabel = selectedNamespace === 'all' ? '전체 네임스페이스' : selectedNamespace
    const total = limitRanges.length
    return {
      source: 'base' as const,
      summary: `${nsLabel} LimitRange ${total}개`,
      data: {
        filters: { namespace: selectedNamespace, search: searchQuery || undefined },
        stats: { total },
        ...summarizeList(pagedLimitRanges as unknown as Record<string, unknown>[], {
          total: sortedLimitRanges.length,
          currentPage,
          pageSize: rowsPerPage,
          topN: rowsPerPage,
          pickFields: ['name', 'namespace'],
          linkBuilder: (l) => {
            const lr = l as unknown as LimitRangeInfo
            return buildResourceLink('LimitRange', lr.namespace, lr.name)
          },
        }),
      },
    }
  }, [limitRanges, pagedLimitRanges, sortedLimitRanges.length, currentPage, rowsPerPage, selectedNamespace, searchQuery])

  useAIContext(aiSnapshot, [aiSnapshot])

  const handleRefresh = async () => {
    if (isRefreshing) return
    setIsRefreshing(true)
    try {
      const data = selectedNamespace === 'all'
        ? await api.getAllLimitRanges(true)
        : await api.getLimitRanges(selectedNamespace, true)
      queryClient.removeQueries({ queryKey: ['cluster', 'limitranges', selectedNamespace] })
      queryClient.setQueryData(['cluster', 'limitranges', selectedNamespace], data)
    } catch (error) {
      console.error('LimitRanges refresh failed:', error)
    }
    setTimeout(() => setIsRefreshing(false), 500)
  }

  const createLimitRangeYamlTemplate = useMemo(() => {
    const ns = selectedNamespace !== 'all' ? selectedNamespace : 'default'
    return `apiVersion: v1
kind: LimitRange
metadata:
  name: sample-limitrange
  namespace: ${ns}
spec:
  limits:
  - type: Container
    default:
      cpu: 500m
      memory: 512Mi
    defaultRequest:
      cpu: 100m
      memory: 128Mi
    max:
      cpu: "2"
      memory: 2Gi
    min:
      cpu: 50m
      memory: 64Mi
`
  }, [selectedNamespace])

  const showNamespaceColumn = selectedNamespace === 'all'

  return (
    <div className="flex flex-col h-[calc(100vh-4rem)] gap-4">
      <div className="flex items-center justify-between shrink-0">
        <div>
          <h1 className="text-3xl font-bold text-white">{tr('limitRanges.title', 'Limit Ranges')}</h1>
          <p className="mt-2 text-slate-400">
            {tr('limitRanges.subtitle', 'Manage limit ranges across namespaces.')}
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
              {tr('limitRanges.create', 'Create Limit Range')}
            </button>
          )}
          <button
            type="button"
            onClick={handleRefresh}
            disabled={isRefreshing}
            title={tr('limitRanges.refreshTitle', 'Force refresh')}
            className="btn btn-primary flex items-center gap-2 disabled:opacity-50 disabled:cursor-not-allowed"
          >
            <RefreshCw className={`w-4 h-4 ${isRefreshing ? 'animate-spin' : ''}`} />
            {tr('limitRanges.refresh', 'Refresh')}
          </button>
        </div>
      </div>

      <LimitRangeFilters
        searchQuery={searchQuery}
        onSearchChange={setSearchQuery}
        selectedNamespace={selectedNamespace}
        onNamespaceChange={setSelectedNamespace}
        namespaces={namespaces}
      />

      <div className="grid grid-cols-2 lg:grid-cols-3 gap-3 shrink-0">
        <div className="rounded-lg border border-slate-700 bg-slate-900/50 px-4 py-3">
          <p className="text-[11px] sm:text-xs leading-4 whitespace-nowrap text-slate-400">{tr('limitRanges.stats.total', 'Total')}</p>
          <p className="text-lg text-white font-semibold mt-1">{summary.total}</p>
        </div>
        <div className="rounded-lg border border-emerald-700/40 bg-emerald-900/10 px-4 py-3">
          <p className="text-[11px] sm:text-xs leading-4 whitespace-nowrap text-emerald-300">{tr('limitRanges.stats.containerLimits', 'Container Limits')}</p>
          <p className="text-lg text-white font-semibold mt-1">{summary.containerLimits}</p>
        </div>
        <div className="rounded-lg border border-slate-700 bg-slate-900/50 px-4 py-3">
          <p className="text-[11px] sm:text-xs leading-4 whitespace-nowrap text-slate-400">{tr('limitRanges.stats.podLimits', 'Pod Limits')}</p>
          <p className="text-lg text-white font-semibold mt-1">{summary.podLimits}</p>
        </div>
      </div>

      {searchQuery && (
        <p className="text-sm text-slate-400 shrink-0">
          {tr('limitRanges.matchCount', '{{count}} limit range{{suffix}} match.', {
            count: filteredLimitRanges.length,
            suffix: filteredLimitRanges.length === 1 ? '' : 's',
          })}
        </p>
      )}

      <LimitRangeTable
        pagedLimitRanges={pagedLimitRanges}
        sortedLimitRangesLength={sortedLimitRanges.length}
        isLoading={isLoading}
        showNamespaceColumn={showNamespaceColumn}
        sortKey={sortKey}
        sortDir={sortDir}
        onSort={handleSort}
        currentPage={currentPage}
        totalPages={totalPages}
        rowsPerPage={rowsPerPage}
        onPageChange={setCurrentPage}
        onOpenDetail={(lr) => openDetail({
          kind: 'LimitRange',
          name: lr.name,
          namespace: lr.namespace,
          rawJson: limitRangeToRawJson(lr),
        })}
        containerRef={tableContainerRef}
        bodyRef={tableBodyRef}
        theadRef={theadRef}
        firstRowRef={firstRowRef}
      />

      {createDialogOpen && (
        <ResourceYamlCreateDialog
          title={tr('limitRanges.createTitle', 'Create Limit Range from YAML')}
          initialYaml={createLimitRangeYamlTemplate}
          onClose={() => setCreateDialogOpen(false)}
          onCreated={() => {
            queryClient.invalidateQueries({ queryKey: ['cluster', 'limitranges'] })
          }}
        />
      )}
    </div>
  )
}
