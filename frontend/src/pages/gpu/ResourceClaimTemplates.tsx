import { useEffect, useMemo, useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { useTranslation } from 'react-i18next'
import { api, type ResourceClaimTemplateItem } from '@/services/api'
import { useKubeWatchList } from '@/services/useKubeWatchList'
import { useResourceDetail } from '@/components/ResourceDetailContext'
import ResourceYamlCreateDialog from '@/components/ResourceYamlCreateDialog'
import { useAdaptiveTable } from '@/hooks/useAdaptiveTable'
import { useAIContext } from '@/hooks/useAIContext'
import { usePermission } from '@/hooks/usePermission'
import { summarizeList } from '@/utils/aiContext/summarizeList'
import { buildResourceLink } from '@/utils/resourceLink'
import { Plus, RefreshCw } from 'lucide-react'
import { parseAgeSeconds, type SortKey } from './resourceclaimtemplates/resourceClaimTemplatesHelpers'
import { applyResourceClaimTemplateWatchEvent } from './resourceclaimtemplates/resourceClaimTemplatesWatchNormalize'
import { ResourceClaimTemplatesFilters } from './resourceclaimtemplates/ResourceClaimTemplatesFilters'
import { ResourceClaimTemplatesTable } from './resourceclaimtemplates/ResourceClaimTemplatesTable'

export default function ResourceClaimTemplates() {
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

  const { data: resourceClaimTemplates, isLoading } = useQuery({
    queryKey: ['gpu', 'resourceclaimtemplates', selectedNamespace],
    queryFn: () => (
      selectedNamespace === 'all'
        ? api.getAllResourceClaimTemplates(false)
        : api.getResourceClaimTemplates(selectedNamespace, false)
    ),
  })
  const { has } = usePermission()
  const canCreate = has('resource.resourceclaimtemplate.create')

  useKubeWatchList({
    enabled: true,
    queryKey: ['gpu', 'resourceclaimtemplates', selectedNamespace],
    path: selectedNamespace === 'all'
      ? '/api/v1/resourceclaimtemplates'
      : `/api/v1/namespaces/${selectedNamespace}/resourceclaimtemplates`,
    query: 'watch=1',
    applyEvent: (prev, event) => applyResourceClaimTemplateWatchEvent(prev as ResourceClaimTemplateItem[] | undefined, event),
    onEvent: (event) => {
      if (event?.type === 'DELETED') return
      const name = event?.object?.name || event?.object?.metadata?.name
      const ns = event?.object?.namespace || event?.object?.metadata?.namespace
      if (name && ns) {
        queryClient.invalidateQueries({ queryKey: ['resourceclaimtemplate-describe', ns, name] })
      }
    },
  })

  const filteredResourceClaimTemplates = useMemo(() => {
    if (!Array.isArray(resourceClaimTemplates)) return [] as ResourceClaimTemplateItem[]
    if (!searchQuery.trim()) return resourceClaimTemplates
    const q = searchQuery.toLowerCase()
    return resourceClaimTemplates.filter((item) => (
      item.name.toLowerCase().includes(q)
      || item.namespace.toLowerCase().includes(q)
    ))
  }, [resourceClaimTemplates, searchQuery])

  const summary = useMemo(() => {
    return { total: filteredResourceClaimTemplates.length }
  }, [filteredResourceClaimTemplates])

  const sortedResourceClaimTemplates = useMemo(() => {
    if (!sortKey) return filteredResourceClaimTemplates
    const list = [...filteredResourceClaimTemplates]

    const getValue = (item: ResourceClaimTemplateItem): string | number => {
      switch (sortKey) {
        case 'name':
          return item.name
        case 'namespace':
          return item.namespace
        case 'requests':
          return item.request_count || 0
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
  }, [filteredResourceClaimTemplates, sortDir, sortKey])

  const { containerRef: tableContainerRef, bodyRef: tableBodyRef, theadRef, firstRowRef, rowsPerPage } = useAdaptiveTable({
    recalculationKey: sortedResourceClaimTemplates.length,
  })
  const totalPages = Math.max(1, Math.ceil(sortedResourceClaimTemplates.length / rowsPerPage))

  useEffect(() => {
    setCurrentPage(1)
  }, [searchQuery, selectedNamespace])

  useEffect(() => {
    if (currentPage > totalPages) setCurrentPage(totalPages)
  }, [currentPage, totalPages])

  const pagedResourceClaimTemplates = useMemo(() => {
    const start = (currentPage - 1) * rowsPerPage
    return sortedResourceClaimTemplates.slice(start, start + rowsPerPage)
  }, [sortedResourceClaimTemplates, currentPage, rowsPerPage])

  // 플로팅 AI 위젯용 스냅샷 (DRA)
  const aiSnapshot = useMemo(() => {
    if (!Array.isArray(resourceClaimTemplates) || resourceClaimTemplates.length === 0) return null
    const nsLabel = selectedNamespace === 'all' ? '전체 네임스페이스' : selectedNamespace
    const total = resourceClaimTemplates.length
    return {
      source: 'base' as const,
      summary: `${nsLabel} ResourceClaimTemplate ${total}개 (DRA)`,
      data: {
        filters: { namespace: selectedNamespace, search: searchQuery || undefined },
        stats: { total },
        ...summarizeList(pagedResourceClaimTemplates as unknown as Record<string, unknown>[], {
          total: sortedResourceClaimTemplates.length,
          currentPage,
          pageSize: rowsPerPage,
          topN: rowsPerPage,
          pickFields: ['name', 'namespace'],
          linkBuilder: (r) => {
            const rct = r as unknown as ResourceClaimTemplateItem
            return buildResourceLink('ResourceClaimTemplate', rct.namespace, rct.name)
          },
        }),
      },
    }
  }, [resourceClaimTemplates, pagedResourceClaimTemplates, sortedResourceClaimTemplates.length, currentPage, rowsPerPage, selectedNamespace, searchQuery])

  useAIContext(aiSnapshot, [aiSnapshot])

  const handleRefresh = async () => {
    if (isRefreshing) return
    setIsRefreshing(true)
    try {
      const data = selectedNamespace === 'all'
        ? await api.getAllResourceClaimTemplates(true)
        : await api.getResourceClaimTemplates(selectedNamespace, true)
      queryClient.removeQueries({ queryKey: ['gpu', 'resourceclaimtemplates', selectedNamespace] })
      queryClient.setQueryData(['gpu', 'resourceclaimtemplates', selectedNamespace], data)
    } catch (error) {
      console.error('ResourceClaimTemplates refresh failed:', error)
    }
    setTimeout(() => setIsRefreshing(false), 500)
  }

  const createResourceClaimTemplateYamlTemplate = useMemo(() => {
    const ns = selectedNamespace !== 'all' ? selectedNamespace : 'default'
    return `apiVersion: resource.k8s.io/v1beta1
kind: ResourceClaimTemplate
metadata:
  name: example-gpu-claim-template
  namespace: ${ns}
spec:
  spec:
    devices:
      requests:
        - name: gpu
          deviceClassName: example-gpu-class
`
  }, [selectedNamespace])

  const showNamespaceColumn = selectedNamespace === 'all'

  return (
    <div className="flex flex-col h-[calc(100vh-4rem)] gap-4">
      <div className="flex items-center justify-between shrink-0">
        <div>
          <h1 className="text-3xl font-bold text-white">{tr('resourceClaimTemplatesPage.title', 'Resource Claim Templates')}</h1>
          <p className="mt-2 text-slate-400">{tr('resourceClaimTemplatesPage.subtitle', 'Manage DRA ResourceClaimTemplate resources.')}</p>
        </div>
        <div className="flex items-center gap-2">
          {canCreate && (
            <button
              type="button"
              onClick={() => setCreateDialogOpen(true)}
              className="btn btn-primary flex items-center gap-2"
            >
              <Plus className="w-4 h-4" />
              {tr('resourceClaimTemplatesPage.create', 'Create ResourceClaimTemplate')}
            </button>
          )}
          <button
            type="button"
            onClick={handleRefresh}
            disabled={isRefreshing}
            title={tr('resourceClaimTemplatesPage.refreshTitle', 'Force refresh')}
            className="btn btn-primary flex items-center gap-2 disabled:opacity-50 disabled:cursor-not-allowed"
          >
            <RefreshCw className={`w-4 h-4 ${isRefreshing ? 'animate-spin' : ''}`} />
            {tr('resourceClaimTemplatesPage.refresh', 'Refresh')}
          </button>
        </div>
      </div>

      <ResourceClaimTemplatesFilters
        searchQuery={searchQuery}
        setSearchQuery={setSearchQuery}
        selectedNamespace={selectedNamespace}
        setSelectedNamespace={setSelectedNamespace}
        namespaces={namespaces}
        searchPlaceholder={tr('resourceClaimTemplatesPage.searchPlaceholder', 'Search ResourceClaimTemplates by name...')}
        allNamespacesLabel={tr('resourceClaimTemplatesPage.allNamespaces', 'All namespaces')}
      />

      <div className="grid grid-cols-1 gap-3 shrink-0">
        <div className="rounded-lg border border-slate-700 bg-slate-900/50 px-4 py-3">
          <p className="text-[11px] sm:text-xs leading-4 whitespace-nowrap text-slate-400">{tr('resourceClaimTemplatesPage.stats.total', 'Total')}</p>
          <p className="text-lg text-white font-semibold mt-1">{summary.total}</p>
        </div>
      </div>

      {searchQuery && (
        <p className="text-sm text-slate-400 shrink-0">
          {tr('resourceClaimTemplatesPage.matchCount', '{{count}} ResourceClaimTemplate{{suffix}} match.', {
            count: filteredResourceClaimTemplates.length,
            suffix: filteredResourceClaimTemplates.length === 1 ? '' : 's',
          })}
        </p>
      )}

      <ResourceClaimTemplatesTable
        pagedResourceClaimTemplates={pagedResourceClaimTemplates}
        sortedResourceClaimTemplatesLength={sortedResourceClaimTemplates.length}
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
          title={tr('resourceClaimTemplatesPage.createTitle', 'Create ResourceClaimTemplate from YAML')}
          initialYaml={createResourceClaimTemplateYamlTemplate}
          namespace={selectedNamespace !== 'all' ? selectedNamespace : undefined}
          onClose={() => setCreateDialogOpen(false)}
          onCreated={() => {
            queryClient.invalidateQueries({ queryKey: ['gpu', 'resourceclaimtemplates'] })
          }}
        />
      )}
    </div>
  )
}
