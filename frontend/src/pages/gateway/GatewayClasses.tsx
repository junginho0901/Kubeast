import { useEffect, useMemo, useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { useTranslation } from 'react-i18next'
import { api, type GatewayClassInfo } from '@/services/api'
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
  formatParametersRef,
  type SortKey,
} from './gatewayclasses/gatewayClassHelpers'
import { applyGatewayClassWatchEvent } from './gatewayclasses/gatewayClassWatchNormalize'
import { GatewayClassFilters } from './gatewayclasses/GatewayClassFilters'
import { GatewayClassTable } from './gatewayclasses/GatewayClassTable'

export default function GatewayClasses() {
  const queryClient = useQueryClient()
  const { t } = useTranslation()
  const tr = (key: string, fallback: string, options?: Record<string, any>) =>
    t(key, { defaultValue: fallback, ...options })
  const { open: openDetail } = useResourceDetail()

  const [searchQuery, setSearchQuery] = useState('')
  const [isRefreshing, setIsRefreshing] = useState(false)
  const [sortKey, setSortKey] = useState<SortKey>(null)
  const [sortDir, setSortDir] = useState<'asc' | 'desc'>('asc')
  const [currentPage, setCurrentPage] = useState(1)
  const [createDialogOpen, setCreateDialogOpen] = useState(false)

  const { data: gatewayClasses, isLoading } = useQuery({
    queryKey: ['gateway', 'gatewayclasses'],
    queryFn: () => api.getGatewayClasses(false),
  })
  const { has } = usePermission()
  const canCreate = has('resource.gatewayclass.create')

  useKubeWatchList({
    enabled: true,
    queryKey: ['gateway', 'gatewayclasses'],
    path: '/api/v1/gatewayclasses',
    query: 'watch=1',
    applyEvent: (prev, event) => applyGatewayClassWatchEvent(prev as GatewayClassInfo[] | undefined, event),
    onEvent: (event) => {
      if (event?.type === 'DELETED') return
      const name = event?.object?.name || event?.object?.metadata?.name
      if (name) {
        queryClient.invalidateQueries({ queryKey: ['gatewayclass-describe', name] })
      }
    },
  })

  const filteredGatewayClasses = useMemo(() => {
    if (!Array.isArray(gatewayClasses)) return [] as GatewayClassInfo[]
    if (!searchQuery.trim()) return gatewayClasses
    const q = searchQuery.toLowerCase()
    return gatewayClasses.filter((item) => (
      item.name.toLowerCase().includes(q)
      || String(item.controller_name || '').toLowerCase().includes(q)
      || String(item.status || '').toLowerCase().includes(q)
      || formatParametersRef(item).toLowerCase().includes(q)
    ))
  }, [gatewayClasses, searchQuery])

  const summary = useMemo(() => {
    const total = filteredGatewayClasses.length
    let accepted = 0
    let withParameters = 0
    let withAnnotations = 0

    for (const item of filteredGatewayClasses) {
      if (item.accepted) accepted += 1
      if (item.parameters_ref) withParameters += 1
      if (Object.keys(item.annotations || {}).length > 0) withAnnotations += 1
    }

    return { total, accepted, withParameters, withAnnotations }
  }, [filteredGatewayClasses])

  const sortedGatewayClasses = useMemo(() => {
    if (!sortKey) return filteredGatewayClasses
    const list = [...filteredGatewayClasses]

    const getValue = (item: GatewayClassInfo): string | number => {
      switch (sortKey) {
        case 'name':
          return item.name
        case 'controller':
          return item.controller_name || ''
        case 'status':
          return item.status || ''
        case 'parameters':
          return formatParametersRef(item)
        case 'age':
          return parseAgeSeconds(item.created_at)
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
  }, [filteredGatewayClasses, sortDir, sortKey])

  const { containerRef: tableContainerRef, bodyRef: tableBodyRef, theadRef, firstRowRef, rowsPerPage } = useAdaptiveTable({
    recalculationKey: sortedGatewayClasses.length,
  })
  const totalPages = Math.max(1, Math.ceil(sortedGatewayClasses.length / rowsPerPage))

  useEffect(() => {
    setCurrentPage(1)
  }, [searchQuery])

  useEffect(() => {
    if (currentPage > totalPages) setCurrentPage(totalPages)
  }, [currentPage, totalPages])

  const pagedGatewayClasses = useMemo(() => {
    const start = (currentPage - 1) * rowsPerPage
    return sortedGatewayClasses.slice(start, start + rowsPerPage)
  }, [sortedGatewayClasses, currentPage, rowsPerPage])

  // 플로팅 AI 위젯용 스냅샷 (cluster-scoped)
  const aiSnapshot = useMemo(() => {
    if (!Array.isArray(gatewayClasses) || gatewayClasses.length === 0) return null
    const total = gatewayClasses.length
    return {
      source: 'base' as const,
      summary: `GatewayClass ${total}개`,
      data: {
        filters: { search: searchQuery || undefined },
        stats: { total },
        ...summarizeList(pagedGatewayClasses as unknown as Record<string, unknown>[], {
          total: sortedGatewayClasses.length,
          currentPage,
          pageSize: rowsPerPage,
          topN: rowsPerPage,
          pickFields: ['name', 'controller_name', 'accepted', 'status'],
          linkBuilder: (c) => {
            const gc = c as unknown as GatewayClassInfo
            return buildResourceLink('GatewayClass', undefined, gc.name)
          },
        }),
      },
    }
  }, [gatewayClasses, pagedGatewayClasses, sortedGatewayClasses.length, currentPage, rowsPerPage, searchQuery])

  useAIContext(aiSnapshot, [aiSnapshot])

  const handleRefresh = async () => {
    if (isRefreshing) return
    setIsRefreshing(true)
    try {
      const data = await api.getGatewayClasses(true)
      queryClient.removeQueries({ queryKey: ['gateway', 'gatewayclasses'] })
      queryClient.setQueryData(['gateway', 'gatewayclasses'], data)
    } catch (error) {
      console.error('GatewayClasses refresh failed:', error)
    }
    setTimeout(() => setIsRefreshing(false), 500)
  }

  const createGatewayClassYamlTemplate = useMemo(() => {
    return `apiVersion: gateway.networking.k8s.io/v1
kind: GatewayClass
metadata:
  name: sample-gatewayclass
spec:
  controllerName: example.com/gateway-controller
`
  }, [])

  return (
    <div className="flex flex-col h-[calc(100vh-4rem)] gap-4">
      <div className="flex items-center justify-between shrink-0">
        <div>
          <h1 className="text-3xl font-bold text-white">{tr('gatewayClassesPage.title', 'Gateway Classes')}</h1>
          <p className="mt-2 text-slate-400">{tr('gatewayClassesPage.subtitle', 'Inspect and manage cluster-scoped GatewayClass resources.')}</p>
        </div>
        <div className="flex items-center gap-2">
          {canCreate && (
            <button
              type="button"
              onClick={() => setCreateDialogOpen(true)}
              className="btn btn-primary flex items-center gap-2"
            >
              <Plus className="w-4 h-4" />
              {tr('gatewayClassesPage.create', 'Create GatewayClass')}
            </button>
          )}
          <button
            type="button"
            onClick={handleRefresh}
            disabled={isRefreshing}
            title={tr('gatewayClassesPage.refreshTitle', 'Force refresh')}
            className="btn btn-primary flex items-center gap-2 disabled:opacity-50 disabled:cursor-not-allowed"
          >
            <RefreshCw className={`w-4 h-4 ${isRefreshing ? 'animate-spin' : ''}`} />
            {tr('gatewayClassesPage.refresh', 'Refresh')}
          </button>
        </div>
      </div>

      <GatewayClassFilters
        searchQuery={searchQuery}
        setSearchQuery={setSearchQuery}
        searchPlaceholder={tr('gatewayClassesPage.searchPlaceholder', 'Search gateway classes by name...')}
      />

      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3 shrink-0">
        <div className="rounded-lg border border-slate-700 bg-slate-900/50 px-4 py-3">
          <p className="text-[11px] sm:text-xs leading-4 whitespace-nowrap text-slate-400">{tr('gatewayClassesPage.stats.total', 'Total')}</p>
          <p className="text-lg text-white font-semibold mt-1">{summary.total}</p>
        </div>
        <div className="rounded-lg border border-emerald-700/40 bg-emerald-900/10 px-4 py-3">
          <p className="text-[11px] sm:text-xs leading-4 whitespace-nowrap text-emerald-300">{tr('gatewayClassesPage.stats.accepted', 'Accepted')}</p>
          <p className="text-lg text-white font-semibold mt-1">{summary.accepted}</p>
        </div>
        <div className="rounded-lg border border-cyan-700/40 bg-cyan-900/10 px-4 py-3">
          <p className="text-[11px] sm:text-xs leading-4 whitespace-nowrap text-cyan-300">{tr('gatewayClassesPage.stats.withParameters', 'With Parameters')}</p>
          <p className="text-lg text-white font-semibold mt-1">{summary.withParameters}</p>
        </div>
        <div className="rounded-lg border border-amber-700/40 bg-amber-900/10 px-4 py-3">
          <p className="text-[11px] sm:text-xs leading-4 whitespace-nowrap text-amber-300">{tr('gatewayClassesPage.stats.withAnnotations', 'With Annotations')}</p>
          <p className="text-lg text-white font-semibold mt-1">{summary.withAnnotations}</p>
        </div>
      </div>

      {searchQuery && (
        <p className="text-sm text-slate-400 shrink-0">
          {tr('gatewayClassesPage.matchCount', '{{count}} gateway class{{suffix}} match.', {
            count: filteredGatewayClasses.length,
            suffix: filteredGatewayClasses.length === 1 ? '' : 'es',
          })}
        </p>
      )}

      <GatewayClassTable
        pagedGatewayClasses={pagedGatewayClasses}
        sortedGatewayClassesLength={sortedGatewayClasses.length}
        isLoading={isLoading}
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
          title={tr('gatewayClassesPage.createTitle', 'Create GatewayClass from YAML')}
          initialYaml={createGatewayClassYamlTemplate}
          onClose={() => setCreateDialogOpen(false)}
          onCreated={() => {
            queryClient.invalidateQueries({ queryKey: ['gateway', 'gatewayclasses'] })
          }}
        />
      )}
    </div>
  )
}
