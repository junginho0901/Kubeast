import { useEffect, useMemo, useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { useTranslation } from 'react-i18next'
import { api, type IngressClassInfo } from '@/services/api'
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
  formatParameters,
  type SortKey,
} from './ingressclasses/ingressClassHelpers'
import { applyIngressClassWatchEvent } from './ingressclasses/ingressClassWatchNormalize'
import { IngressClassFilters } from './ingressclasses/IngressClassFilters'
import { IngressClassTable } from './ingressclasses/IngressClassTable'

export default function IngressClasses() {
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

  const { data: ingressClasses, isLoading } = useQuery({
    queryKey: ['network', 'ingressclasses'],
    queryFn: () => api.getIngressClasses(false),
  })
  const { has } = usePermission()
  const canCreate = has('resource.ingressclass.create')

  useKubeWatchList({
    enabled: true,
    queryKey: ['network', 'ingressclasses'],
    path: '/api/v1/ingressclasses',
    query: 'watch=1',
    applyEvent: (prev, event) => applyIngressClassWatchEvent(prev as IngressClassInfo[] | undefined, event),
    onEvent: (event) => {
      if (event?.type === 'DELETED') return
      const name = event?.object?.name || event?.object?.metadata?.name
      if (name) {
        queryClient.invalidateQueries({ queryKey: ['ingressclass-describe', name] })
      }
    },
  })

  const filteredIngressClasses = useMemo(() => {
    if (!Array.isArray(ingressClasses)) return [] as IngressClassInfo[]
    if (!searchQuery.trim()) return ingressClasses
    const q = searchQuery.toLowerCase()
    return ingressClasses.filter((item) => (
      item.name.toLowerCase().includes(q)
      || String(item.controller || '').toLowerCase().includes(q)
      || formatParameters(item).toLowerCase().includes(q)
      || String(item.is_default).toLowerCase().includes(q)
    ))
  }, [ingressClasses, searchQuery])

  const summary = useMemo(() => {
    const total = filteredIngressClasses.length
    let defaults = 0
    let withParameters = 0
    let withAnnotations = 0

    for (const item of filteredIngressClasses) {
      if (item.is_default) defaults += 1
      if (item.parameters) withParameters += 1
      if (Object.keys(item.annotations || {}).length > 0) withAnnotations += 1
    }

    return { total, defaults, withParameters, withAnnotations }
  }, [filteredIngressClasses])

  const sortedIngressClasses = useMemo(() => {
    if (!sortKey) return filteredIngressClasses
    const list = [...filteredIngressClasses]

    const getValue = (item: IngressClassInfo): string | number => {
      switch (sortKey) {
        case 'name':
          return item.name
        case 'controller':
          return item.controller || ''
        case 'default':
          return item.is_default ? 1 : 0
        case 'parameters':
          return formatParameters(item)
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
  }, [filteredIngressClasses, sortDir, sortKey])

  const { containerRef: tableContainerRef, bodyRef: tableBodyRef, theadRef, firstRowRef, rowsPerPage } = useAdaptiveTable({
    recalculationKey: sortedIngressClasses.length,
  })
  const totalPages = Math.max(1, Math.ceil(sortedIngressClasses.length / rowsPerPage))

  useEffect(() => {
    setCurrentPage(1)
  }, [searchQuery])

  useEffect(() => {
    if (currentPage > totalPages) setCurrentPage(totalPages)
  }, [currentPage, totalPages])

  const pagedIngressClasses = useMemo(() => {
    const start = (currentPage - 1) * rowsPerPage
    return sortedIngressClasses.slice(start, start + rowsPerPage)
  }, [sortedIngressClasses, currentPage, rowsPerPage])

  // 플로팅 AI 위젯용 스냅샷 (cluster-scoped)
  const aiSnapshot = useMemo(() => {
    if (!Array.isArray(ingressClasses) || ingressClasses.length === 0) return null
    const total = ingressClasses.length
    const defaults = ingressClasses.filter((c) => c.is_default).length
    return {
      source: 'base' as const,
      summary: `IngressClass ${total}개 (기본 ${defaults}개)`,
      data: {
        filters: { search: searchQuery || undefined },
        stats: { total, defaults },
        ...summarizeList(pagedIngressClasses as unknown as Record<string, unknown>[], {
          total: sortedIngressClasses.length,
          currentPage,
          pageSize: rowsPerPage,
          topN: rowsPerPage,
          pickFields: ['name', 'controller', 'is_default'],
          linkBuilder: (c) => {
            const ic = c as unknown as IngressClassInfo
            return buildResourceLink('IngressClass', undefined, ic.name)
          },
        }),
      },
    }
  }, [ingressClasses, pagedIngressClasses, sortedIngressClasses.length, currentPage, rowsPerPage, searchQuery])

  useAIContext(aiSnapshot, [aiSnapshot])

  const handleRefresh = async () => {
    if (isRefreshing) return
    setIsRefreshing(true)
    try {
      const data = await api.getIngressClasses(true)
      queryClient.removeQueries({ queryKey: ['network', 'ingressclasses'] })
      queryClient.setQueryData(['network', 'ingressclasses'], data)
    } catch (error) {
      console.error('IngressClasses refresh failed:', error)
    }
    setTimeout(() => setIsRefreshing(false), 500)
  }

  const createIngressClassYamlTemplate = useMemo(() => {
    return `apiVersion: networking.k8s.io/v1
kind: IngressClass
metadata:
  name: sample-ingressclass
spec:
  controller: k8s.io/ingress-nginx
`
  }, [])

  return (
    <div className="flex flex-col h-[calc(100vh-4rem)] gap-4">
      <div className="flex items-center justify-between shrink-0">
        <div>
          <h1 className="text-3xl font-bold text-white">{tr('ingressClassesPage.title', 'Ingress Classes')}</h1>
          <p className="mt-2 text-slate-400">{tr('ingressClassesPage.subtitle', 'Inspect and manage cluster-scoped IngressClass resources.')}</p>
        </div>
        <div className="flex items-center gap-2">
          {canCreate && (
            <button
              type="button"
              onClick={() => setCreateDialogOpen(true)}
              className="btn btn-primary flex items-center gap-2"
            >
              <Plus className="w-4 h-4" />
              {tr('ingressClassesPage.create', 'Create IngressClass')}
            </button>
          )}
          <button
            type="button"
            onClick={handleRefresh}
            disabled={isRefreshing}
            title={tr('ingressClassesPage.refreshTitle', 'Force refresh')}
            className="btn btn-primary flex items-center gap-2 disabled:opacity-50 disabled:cursor-not-allowed"
          >
            <RefreshCw className={`w-4 h-4 ${isRefreshing ? 'animate-spin' : ''}`} />
            {tr('ingressClassesPage.refresh', 'Refresh')}
          </button>
        </div>
      </div>

      <IngressClassFilters
        searchQuery={searchQuery}
        setSearchQuery={setSearchQuery}
        searchPlaceholder={tr('ingressClassesPage.searchPlaceholder', 'Search ingress classes by name...')}
      />

      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3 shrink-0">
        <div className="rounded-lg border border-slate-700 bg-slate-900/50 px-4 py-3">
          <p className="text-[11px] sm:text-xs leading-4 whitespace-nowrap text-slate-400">{tr('ingressClassesPage.stats.total', 'Total')}</p>
          <p className="text-lg text-white font-semibold mt-1">{summary.total}</p>
        </div>
        <div className="rounded-lg border border-cyan-700/40 bg-cyan-900/10 px-4 py-3">
          <p className="text-[11px] sm:text-xs leading-4 whitespace-nowrap text-cyan-300">{tr('ingressClassesPage.stats.default', 'Default')}</p>
          <p className="text-lg text-white font-semibold mt-1">{summary.defaults}</p>
        </div>
        <div className="rounded-lg border border-emerald-700/40 bg-emerald-900/10 px-4 py-3">
          <p className="text-[11px] sm:text-xs leading-4 whitespace-nowrap text-emerald-300">{tr('ingressClassesPage.stats.withParameters', 'With Parameters')}</p>
          <p className="text-lg text-white font-semibold mt-1">{summary.withParameters}</p>
        </div>
        <div className="rounded-lg border border-amber-700/40 bg-amber-900/10 px-4 py-3">
          <p className="text-[11px] sm:text-xs leading-4 whitespace-nowrap text-amber-300">{tr('ingressClassesPage.stats.withAnnotations', 'With Annotations')}</p>
          <p className="text-lg text-white font-semibold mt-1">{summary.withAnnotations}</p>
        </div>
      </div>

      {searchQuery && (
        <p className="text-sm text-slate-400 shrink-0">
          {tr('ingressClassesPage.matchCount', '{{count}} ingress class{{suffix}} match.', {
            count: filteredIngressClasses.length,
            suffix: filteredIngressClasses.length === 1 ? '' : 'es',
          })}
        </p>
      )}

      <IngressClassTable
        pagedIngressClasses={pagedIngressClasses}
        sortedIngressClassesLength={sortedIngressClasses.length}
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
          title={tr('ingressClassesPage.createTitle', 'Create IngressClass from YAML')}
          initialYaml={createIngressClassYamlTemplate}
          onClose={() => setCreateDialogOpen(false)}
          onCreated={() => {
            queryClient.invalidateQueries({ queryKey: ['network', 'ingressclasses'] })
          }}
        />
      )}
    </div>
  )
}
