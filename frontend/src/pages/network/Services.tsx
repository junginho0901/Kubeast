import { useEffect, useMemo, useRef, useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { useTranslation } from 'react-i18next'
import { api, type ServiceInfo } from '@/services/api'
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
  parseAgeSeconds,
  formatAge,
  formatPorts,
  formatSelector,
  serviceToRawJson,
  type SortKey,
} from './services/serviceHelpers'
import { applyServiceWatchEvent } from './services/serviceWatchNormalize'

export default function Services() {
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

      <div className="grid grid-cols-1 xl:grid-cols-3 gap-3 shrink-0">
        <div className="xl:col-span-2">
          <div className="relative">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-5 h-5 text-slate-400" />
            <input
              type="text"
              placeholder={tr('servicesPage.searchPlaceholder', 'Search services by name...')}
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
              {selectedNamespace === 'all' ? tr('servicesPage.allNamespaces', 'All namespaces') : selectedNamespace}
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
                <span className={selectedNamespace === 'all' ? 'font-medium' : ''}>{tr('servicesPage.allNamespaces', 'All namespaces')}</span>
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

      <div ref={tableContainerRef} className="card flex-1 min-h-0 flex flex-col">
        <div ref={tableBodyRef} className="overflow-x-auto flex-1 min-h-0">
          <table className="w-full text-sm min-w-[1320px] table-fixed">
            <thead ref={theadRef} className="text-slate-400">
              <tr>
                {showNamespaceColumn && <th className="text-left py-3 px-4 w-[150px]">{tr('servicesPage.table.namespace', 'Namespace')}</th>}
                <th className="text-left py-3 px-4 w-[240px] cursor-pointer" onClick={() => handleSort('name')}>
                  <span className="inline-flex items-center gap-1">{tr('servicesPage.table.name', 'Name')}{renderSortIcon('name')}</span>
                </th>
                <th className="text-left py-3 px-4 w-[120px] cursor-pointer" onClick={() => handleSort('type')}>
                  <span className="inline-flex items-center gap-1">{tr('servicesPage.table.type', 'Type')}{renderSortIcon('type')}</span>
                </th>
                <th className="text-left py-3 px-4 w-[150px] cursor-pointer" onClick={() => handleSort('clusterIp')}>
                  <span className="inline-flex items-center gap-1">{tr('servicesPage.table.clusterIp', 'Cluster IP')}{renderSortIcon('clusterIp')}</span>
                </th>
                <th className="text-left py-3 px-4 w-[150px] cursor-pointer" onClick={() => handleSort('externalIp')}>
                  <span className="inline-flex items-center gap-1">{tr('servicesPage.table.externalIp', 'External IP')}{renderSortIcon('externalIp')}</span>
                </th>
                <th className="text-left py-3 px-4 w-[300px] cursor-pointer" onClick={() => handleSort('ports')}>
                  <span className="inline-flex items-center gap-1">{tr('servicesPage.table.ports', 'Ports')}{renderSortIcon('ports')}</span>
                </th>
                <th className="text-left py-3 px-4 w-[220px] cursor-pointer" onClick={() => handleSort('selector')}>
                  <span className="inline-flex items-center gap-1">{tr('servicesPage.table.selector', 'Selector')}{renderSortIcon('selector')}</span>
                </th>
                <th className="text-left py-3 px-4 w-[90px] cursor-pointer" onClick={() => handleSort('age')}>
                  <span className="inline-flex items-center gap-1">{tr('servicesPage.table.age', 'Age')}{renderSortIcon('age')}</span>
                </th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-700">
              {pagedServices.map((svc, idx) => (
                <tr
                      ref={idx === 0 ? firstRowRef : undefined}
                  key={`${svc.namespace}/${svc.name}`}
                  className="text-slate-200 hover:bg-slate-800/60 cursor-pointer"
                  onClick={() => openDetail({
                    kind: 'Service',
                    name: svc.name,
                    namespace: svc.namespace,
                    rawJson: serviceToRawJson(svc),
                  })}
                >
                  {showNamespaceColumn && <td className="py-3 px-4 text-xs font-mono">{svc.namespace}</td>}
                  <td className="py-3 px-4 font-medium text-white"><span className="block truncate">{svc.name}</span></td>
                  <td className="py-3 px-4"><span className="badge badge-info">{svc.type || '-'}</span></td>
                  <td className="py-3 px-4 text-xs font-mono"><span className="block truncate">{svc.cluster_ip || '-'}</span></td>
                  <td className="py-3 px-4 text-xs font-mono"><span className="block truncate">{svc.external_ip || '-'}</span></td>
                  <td className="py-3 px-4 text-xs font-mono"><span className="block truncate">{formatPorts(svc.ports)}</span></td>
                  <td className="py-3 px-4 text-xs font-mono"><span className="block truncate">{formatSelector(svc.selector)}</span></td>
                  <td className="py-3 px-4 text-xs font-mono">{formatAge(svc.created_at)}</td>
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

              {sortedServices.length === 0 && !isLoading && (
                <tr>
                  <td colSpan={showNamespaceColumn ? 9 : 8} className="py-6 px-4 text-center text-slate-400">
                    {tr('servicesPage.noResults', 'No services found.')}
                  </td>
                </tr>
              )}
            </tbody>
              <AdaptiveTableFillerRows count={rowsPerPage - pagedServices.length} columnCount={7 + (showNamespaceColumn ? 1 : 0)} />
          </table>
        </div>

        {sortedServices.length > 0 && (
          <div className="flex items-center justify-between px-4 py-3 border-t border-slate-700 shrink-0">
            <div className="text-xs text-slate-400">
              {tr('common.paginationRange', 'Showing {{start}}-{{end}} of {{total}}', {
                start: (currentPage - 1) * rowsPerPage + 1,
                end: Math.min(currentPage * rowsPerPage, sortedServices.length),
                total: sortedServices.length,
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
