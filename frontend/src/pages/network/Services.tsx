import { useEffect, useMemo, useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { useTranslation } from 'react-i18next'
import { api, type ServiceInfo } from '@/services/api'
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
  formatPorts,
  formatSelector,
  type SortKey,
} from './services/serviceHelpers'
import { applyServiceWatchEvent } from './services/serviceWatchNormalize'
import { ServiceFilters } from './services/ServiceFilters'
import { ServiceTable } from './services/ServiceTable'

export default function Services() {
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

  const { data: services, isLoading } = useQuery({
    queryKey: ['network', 'services', selectedNamespace],
    queryFn: () => (
      selectedNamespace === 'all'
        ? api.getAllServices(false)
        : api.getServices(selectedNamespace, false)
    ),
  })
  const { has } = usePermission()
  const canCreate = has('resource.service.create')

  useKubeWatchList({
    enabled: true,
    queryKey: ['network', 'services', selectedNamespace],
    path: selectedNamespace === 'all'
      ? '/api/v1/services'
      : `/api/v1/namespaces/${selectedNamespace}/services`,
    query: 'watch=1',
    applyEvent: (prev, event) => applyServiceWatchEvent(prev as ServiceInfo[] | undefined, event),
    onEvent: (event) => {
      if (event?.type === 'DELETED') return
      const name = event?.object?.name || event?.object?.metadata?.name
      const ns = event?.object?.namespace || event?.object?.metadata?.namespace
      if (name && ns) {
        queryClient.invalidateQueries({ queryKey: ['service-describe', ns, name] })
      }
    },
  })

  const filteredServices = useMemo(() => {
    if (!Array.isArray(services)) return [] as ServiceInfo[]
    if (!searchQuery.trim()) return services
    const q = searchQuery.toLowerCase()
    return services.filter((svc) => {
      return svc.name.toLowerCase().includes(q)
        || svc.namespace.toLowerCase().includes(q)
        || String(svc.type || '').toLowerCase().includes(q)
        || String(svc.cluster_ip || '').toLowerCase().includes(q)
        || String(svc.external_ip || '').toLowerCase().includes(q)
        || formatPorts(svc.ports).toLowerCase().includes(q)
        || formatSelector(svc.selector).toLowerCase().includes(q)
    })
  }, [services, searchQuery])

  const summary = useMemo(() => {
    const total = filteredServices.length
    let clusterIP = 0
    let exposed = 0
    let headless = 0

    for (const svc of filteredServices) {
      const type = String(svc.type || '').toLowerCase()
      if (type === 'clusterip') clusterIP += 1
      if (type === 'nodeport' || type === 'loadbalancer') exposed += 1
      if (String(svc.cluster_ip || '').toLowerCase() === 'none') headless += 1
    }

    return { total, clusterIP, exposed, headless }
  }, [filteredServices])

  const sortedServices = useMemo(() => {
    if (!sortKey) return filteredServices
    const list = [...filteredServices]

    const getValue = (svc: ServiceInfo): string | number => {
      switch (sortKey) {
        case 'name':
          return svc.name
        case 'type':
          return svc.type || ''
        case 'clusterIp':
          return svc.cluster_ip || ''
        case 'externalIp':
          return svc.external_ip || ''
        case 'ports':
          return formatPorts(svc.ports)
        case 'selector':
          return formatSelector(svc.selector)
        case 'age':
          return parseAgeSeconds(svc.created_at)
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
  }, [filteredServices, sortDir, sortKey])

  const { containerRef: tableContainerRef, bodyRef: tableBodyRef, theadRef, firstRowRef, rowsPerPage } = useAdaptiveTable({
    recalculationKey: sortedServices.length,
  })
  const totalPages = Math.max(1, Math.ceil(sortedServices.length / rowsPerPage))

  useEffect(() => {
    setCurrentPage(1)
  }, [searchQuery, selectedNamespace])

  useEffect(() => {
    if (currentPage > totalPages) {
      setCurrentPage(totalPages)
    }
  }, [currentPage, totalPages])

  const pagedServices = useMemo(() => {
    const start = (currentPage - 1) * rowsPerPage
    return sortedServices.slice(start, start + rowsPerPage)
  }, [sortedServices, currentPage, rowsPerPage])

  // 플로팅 AI 위젯용 스냅샷
  const aiSnapshot = useMemo(() => {
    if (!Array.isArray(services) || services.length === 0) return null
    const nsLabel = selectedNamespace === 'all' ? '전체 네임스페이스' : selectedNamespace
    const total = services.length
    const byType: Record<string, number> = {}
    for (const s of services) {
      byType[s.type] = (byType[s.type] ?? 0) + 1
    }
    return {
      source: 'base' as const,
      summary: `${nsLabel} Service ${total}개`,
      data: {
        filters: { namespace: selectedNamespace, search: searchQuery || undefined },
        stats: { total, by_type: byType },
        ...summarizeList(pagedServices as unknown as Record<string, unknown>[], {
          total: sortedServices.length,
          currentPage,
          pageSize: rowsPerPage,
          topN: rowsPerPage,
          pickFields: ['name', 'namespace', 'type', 'cluster_ip', 'external_ip', 'ports'],
          linkBuilder: (s) => {
            const svc = s as unknown as ServiceInfo
            return buildResourceLink('Service', svc.namespace, svc.name)
          },
        }),
      },
    }
  }, [services, pagedServices, sortedServices.length, currentPage, rowsPerPage, selectedNamespace, searchQuery])

  useAIContext(aiSnapshot, [aiSnapshot])

  const handleRefresh = async () => {
    if (isRefreshing) return
    setIsRefreshing(true)
    try {
      const data = selectedNamespace === 'all'
        ? await api.getAllServices(true)
        : await api.getServices(selectedNamespace, true)
      queryClient.removeQueries({ queryKey: ['network', 'services', selectedNamespace] })
      queryClient.setQueryData(['network', 'services', selectedNamespace], data)
    } catch (error) {
      console.error('Services refresh failed:', error)
    }
    setTimeout(() => setIsRefreshing(false), 500)
  }

  const createServiceYamlTemplate = useMemo(() => {
    const ns = selectedNamespace !== 'all' ? selectedNamespace : 'default'
    return `apiVersion: v1
kind: Service
metadata:
  name: sample-service
  namespace: ${ns}
spec:
  type: ClusterIP
  selector:
    app: sample
  ports:
    - name: http
      protocol: TCP
      port: 80
      targetPort: 8080
`
  }, [selectedNamespace])

  const showNamespaceColumn = selectedNamespace === 'all'

  return (
    <div className="flex flex-col h-[calc(100vh-4rem)] gap-4">
      <div className="flex items-center justify-between shrink-0">
        <div>
          <h1 className="text-3xl font-bold text-white">{tr('servicesPage.title', 'Services')}</h1>
          <p className="mt-2 text-slate-400">{tr('servicesPage.subtitle', 'Inspect and manage Services across namespaces.')}</p>
        </div>
        <div className="flex items-center gap-2">
          {canCreate && (
            <button
              type="button"
              onClick={() => setCreateDialogOpen(true)}
              className="btn btn-primary flex items-center gap-2"
            >
              <Plus className="w-4 h-4" />
              {tr('servicesPage.create', 'Create Service')}
            </button>
          )}
          <button
            type="button"
            onClick={handleRefresh}
            disabled={isRefreshing}
            title={tr('servicesPage.refreshTitle', 'Force refresh')}
            className="btn btn-primary flex items-center gap-2 disabled:opacity-50 disabled:cursor-not-allowed"
          >
            <RefreshCw className={`w-4 h-4 ${isRefreshing ? 'animate-spin' : ''}`} />
            {tr('servicesPage.refresh', 'Refresh')}
          </button>
        </div>
      </div>

      <ServiceFilters
        searchQuery={searchQuery}
        setSearchQuery={setSearchQuery}
        selectedNamespace={selectedNamespace}
        setSelectedNamespace={setSelectedNamespace}
        namespaces={namespaces}
        searchPlaceholder={tr('servicesPage.searchPlaceholder', 'Search services by name...')}
        allNamespacesLabel={tr('servicesPage.allNamespaces', 'All namespaces')}
      />

      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3 shrink-0">
        <div className="rounded-lg border border-slate-700 bg-slate-900/50 px-4 py-3">
          <p className="text-[11px] sm:text-xs leading-4 whitespace-nowrap text-slate-400">{tr('servicesPage.stats.total', 'Total')}</p>
          <p className="text-lg text-white font-semibold mt-1">{summary.total}</p>
        </div>
        <div className="rounded-lg border border-emerald-700/40 bg-emerald-900/10 px-4 py-3">
          <p className="text-[11px] sm:text-xs leading-4 whitespace-nowrap text-emerald-300">{tr('servicesPage.stats.clusterIp', 'ClusterIP')}</p>
          <p className="text-lg text-white font-semibold mt-1">{summary.clusterIP}</p>
        </div>
        <div className="rounded-lg border border-cyan-700/40 bg-cyan-900/10 px-4 py-3">
          <p className="text-[11px] sm:text-xs leading-4 whitespace-nowrap text-cyan-300">{tr('servicesPage.stats.exposed', 'Exposed')}</p>
          <p className="text-lg text-white font-semibold mt-1">{summary.exposed}</p>
        </div>
        <div className="rounded-lg border border-amber-700/40 bg-amber-900/10 px-4 py-3">
          <p className="text-[11px] sm:text-xs leading-4 whitespace-nowrap text-amber-300">{tr('servicesPage.stats.headless', 'Headless')}</p>
          <p className="text-lg text-white font-semibold mt-1">{summary.headless}</p>
        </div>
      </div>

      {searchQuery && (
        <p className="text-sm text-slate-400 shrink-0">
          {tr('servicesPage.matchCount', '{{count}} service{{suffix}} match.', {
            count: filteredServices.length,
            suffix: filteredServices.length === 1 ? '' : 's',
          })}
        </p>
      )}

      <ServiceTable
        pagedServices={pagedServices}
        sortedServicesLength={sortedServices.length}
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
          title={tr('servicesPage.createTitle', 'Create Service from YAML')}
          initialYaml={createServiceYamlTemplate}
          namespace={selectedNamespace !== 'all' ? selectedNamespace : undefined}
          onClose={() => setCreateDialogOpen(false)}
          onCreated={() => {
            queryClient.invalidateQueries({ queryKey: ['network', 'services'] })
          }}
        />
      )}
    </div>
  )
}
