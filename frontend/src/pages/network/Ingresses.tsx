import { useEffect, useMemo, useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { useTranslation } from 'react-i18next'
import { api, type IngressInfo } from '@/services/api'
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
  formatAddresses,
  formatBackends,
  formatHosts,
  formatRules,
  parseAgeSeconds,
  type SortKey,
} from './ingresses/ingressHelpers'
import { applyIngressWatchEvent } from './ingresses/ingressWatchNormalize'
import { IngressFilters } from './ingresses/IngressFilters'
import { IngressTable } from './ingresses/IngressTable'

export default function Ingresses() {
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

  const { data: ingresses, isLoading } = useQuery({
    queryKey: ['network', 'ingresses', selectedNamespace],
    queryFn: () => (
      selectedNamespace === 'all'
        ? api.getAllIngresses(false)
        : api.getIngresses(selectedNamespace, false)
    ),
  })
  const { has } = usePermission()
  const canCreate = has('resource.ingress.create')

  useKubeWatchList({
    enabled: true,
    queryKey: ['network', 'ingresses', selectedNamespace],
    path: selectedNamespace === 'all'
      ? '/api/v1/ingresses'
      : `/api/v1/namespaces/${selectedNamespace}/ingresses`,
    query: 'watch=1',
    applyEvent: (prev, event) => applyIngressWatchEvent(prev as IngressInfo[] | undefined, event),
    onEvent: (event) => {
      if (event?.type === 'DELETED') return
      const name = event?.object?.name || event?.object?.metadata?.name
      const ns = event?.object?.namespace || event?.object?.metadata?.namespace
      if (name && ns) {
        queryClient.invalidateQueries({ queryKey: ['ingress-detail', ns, name] })
      }
    },
  })

  const filteredIngresses = useMemo(() => {
    if (!Array.isArray(ingresses)) return [] as IngressInfo[]
    if (!searchQuery.trim()) return ingresses
    const q = searchQuery.toLowerCase()
    return ingresses.filter((ing) => (
      ing.name.toLowerCase().includes(q)
      || ing.namespace.toLowerCase().includes(q)
      || String(ing.class || '').toLowerCase().includes(q)
      || formatHosts(ing).toLowerCase().includes(q)
      || formatBackends(ing).toLowerCase().includes(q)
      || formatAddresses(ing).toLowerCase().includes(q)
      || formatRules(ing).toLowerCase().includes(q)
    ))
  }, [ingresses, searchQuery])

  const summary = useMemo(() => {
    const total = filteredIngresses.length
    let withClass = 0
    let withTls = 0
    let withAddress = 0

    for (const ing of filteredIngresses) {
      if (ing.class) withClass += 1
      if (Array.isArray(ing.tls) && ing.tls.length > 0) withTls += 1
      if (Array.isArray(ing.addresses) && ing.addresses.length > 0) withAddress += 1
    }

    return { total, withClass, withTls, withAddress }
  }, [filteredIngresses])

  const sortedIngresses = useMemo(() => {
    if (!sortKey) return filteredIngresses
    const list = [...filteredIngresses]

    const getValue = (ing: IngressInfo): string | number => {
      switch (sortKey) {
        case 'name':
          return ing.name
        case 'namespace':
          return ing.namespace
        case 'class':
          return ing.class || ''
        case 'hosts':
          return formatHosts(ing)
        case 'backends':
          return formatBackends(ing)
        case 'addresses':
          return formatAddresses(ing)
        case 'age':
          return parseAgeSeconds(ing.created_at)
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
  }, [filteredIngresses, sortDir, sortKey])

  const { containerRef: tableContainerRef, bodyRef: tableBodyRef, theadRef, firstRowRef, rowsPerPage } = useAdaptiveTable({
    recalculationKey: sortedIngresses.length,
  })
  const totalPages = Math.max(1, Math.ceil(sortedIngresses.length / rowsPerPage))

  useEffect(() => {
    setCurrentPage(1)
  }, [searchQuery, selectedNamespace])

  useEffect(() => {
    if (currentPage > totalPages) setCurrentPage(totalPages)
  }, [currentPage, totalPages])

  const pagedIngresses = useMemo(() => {
    const start = (currentPage - 1) * rowsPerPage
    return sortedIngresses.slice(start, start + rowsPerPage)
  }, [sortedIngresses, currentPage, rowsPerPage])

  // 플로팅 AI 위젯용 스냅샷
  const aiSnapshot = useMemo(() => {
    if (!Array.isArray(ingresses) || ingresses.length === 0) return null
    const nsLabel = selectedNamespace === 'all' ? '전체 네임스페이스' : selectedNamespace
    const total = ingresses.length
    const noAddress = ingresses.filter((i) => !i.addresses || i.addresses.length === 0).length
    const prefix = noAddress > 0 ? '⚠️ ' : ''
    return {
      source: 'base' as const,
      summary: `${prefix}${nsLabel} Ingress ${total}개${noAddress ? ` (주소 미할당 ${noAddress})` : ''}`,
      data: {
        filters: { namespace: selectedNamespace, search: searchQuery || undefined },
        stats: { total, no_address: noAddress },
        ...summarizeList(pagedIngresses as unknown as Record<string, unknown>[], {
          total: sortedIngresses.length,
          currentPage,
          pageSize: rowsPerPage,
          topN: rowsPerPage,
          pickFields: ['name', 'namespace', 'class', 'hosts', 'backends', 'addresses'],
          filterProblematic: (i) => {
            const ing = i as unknown as IngressInfo
            return !ing.addresses || ing.addresses.length === 0
          },
          linkBuilder: (i) => {
            const ing = i as unknown as IngressInfo
            return buildResourceLink('Ingress', ing.namespace, ing.name)
          },
        }),
      },
    }
  }, [ingresses, pagedIngresses, sortedIngresses.length, currentPage, rowsPerPage, selectedNamespace, searchQuery])

  useAIContext(aiSnapshot, [aiSnapshot])

  const handleRefresh = async () => {
    if (isRefreshing) return
    setIsRefreshing(true)
    try {
      const data = selectedNamespace === 'all'
        ? await api.getAllIngresses(true)
        : await api.getIngresses(selectedNamespace, true)
      queryClient.removeQueries({ queryKey: ['network', 'ingresses', selectedNamespace] })
      queryClient.setQueryData(['network', 'ingresses', selectedNamespace], data)
    } catch (error) {
      console.error('Ingresses refresh failed:', error)
    }
    setTimeout(() => setIsRefreshing(false), 500)
  }

  const createIngressYamlTemplate = useMemo(() => {
    const ns = selectedNamespace !== 'all' ? selectedNamespace : 'default'
    return `apiVersion: networking.k8s.io/v1
kind: Ingress
metadata:
  name: sample-ingress
  namespace: ${ns}
spec:
  ingressClassName: nginx
  rules:
    - host: app.example.com
      http:
        paths:
          - path: /
            pathType: Prefix
            backend:
              service:
                name: sample-service
                port:
                  number: 80
`
  }, [selectedNamespace])

  const showNamespaceColumn = selectedNamespace === 'all'

  return (
    <div className="flex flex-col h-[calc(100vh-4rem)] gap-4">
      <div className="flex items-center justify-between shrink-0">
        <div>
          <h1 className="text-3xl font-bold text-white">{tr('ingressesPage.title', 'Ingresses')}</h1>
          <p className="mt-2 text-slate-400">{tr('ingressesPage.subtitle', 'Inspect and manage Ingresses across namespaces.')}</p>
        </div>
        <div className="flex items-center gap-2">
          {canCreate && (
            <button
              type="button"
              onClick={() => setCreateDialogOpen(true)}
              className="btn btn-primary flex items-center gap-2"
            >
              <Plus className="w-4 h-4" />
              {tr('ingressesPage.create', 'Create Ingress')}
            </button>
          )}
          <button
            type="button"
            onClick={handleRefresh}
            disabled={isRefreshing}
            title={tr('ingressesPage.refreshTitle', 'Force refresh')}
            className="btn btn-primary flex items-center gap-2 disabled:opacity-50 disabled:cursor-not-allowed"
          >
            <RefreshCw className={`w-4 h-4 ${isRefreshing ? 'animate-spin' : ''}`} />
            {tr('ingressesPage.refresh', 'Refresh')}
          </button>
        </div>
      </div>

      <IngressFilters
        searchQuery={searchQuery}
        setSearchQuery={setSearchQuery}
        selectedNamespace={selectedNamespace}
        setSelectedNamespace={setSelectedNamespace}
        namespaces={namespaces}
        searchPlaceholder={tr('ingressesPage.searchPlaceholder', 'Search ingresses by name...')}
        allNamespacesLabel={tr('ingressesPage.allNamespaces', 'All namespaces')}
      />

      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3 shrink-0">
        <div className="rounded-lg border border-slate-700 bg-slate-900/50 px-4 py-3">
          <p className="text-[11px] sm:text-xs leading-4 whitespace-nowrap text-slate-400">{tr('ingressesPage.stats.total', 'Total')}</p>
          <p className="text-lg text-white font-semibold mt-1">{summary.total}</p>
        </div>
        <div className="rounded-lg border border-cyan-700/40 bg-cyan-900/10 px-4 py-3">
          <p className="text-[11px] sm:text-xs leading-4 whitespace-nowrap text-cyan-300">{tr('ingressesPage.stats.withClass', 'With Class')}</p>
          <p className="text-lg text-white font-semibold mt-1">{summary.withClass}</p>
        </div>
        <div className="rounded-lg border border-emerald-700/40 bg-emerald-900/10 px-4 py-3">
          <p className="text-[11px] sm:text-xs leading-4 whitespace-nowrap text-emerald-300">{tr('ingressesPage.stats.withTls', 'With TLS')}</p>
          <p className="text-lg text-white font-semibold mt-1">{summary.withTls}</p>
        </div>
        <div className="rounded-lg border border-amber-700/40 bg-amber-900/10 px-4 py-3">
          <p className="text-[11px] sm:text-xs leading-4 whitespace-nowrap text-amber-300">{tr('ingressesPage.stats.withAddress', 'With Address')}</p>
          <p className="text-lg text-white font-semibold mt-1">{summary.withAddress}</p>
        </div>
      </div>

      {searchQuery && (
        <p className="text-sm text-slate-400 shrink-0">
          {tr('ingressesPage.matchCount', '{{count}} ingress{{suffix}} match.', {
            count: filteredIngresses.length,
            suffix: filteredIngresses.length === 1 ? '' : 'es',
          })}
        </p>
      )}

      <IngressTable
        pagedIngresses={pagedIngresses}
        sortedIngressesLength={sortedIngresses.length}
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
          title={tr('ingressesPage.createTitle', 'Create Ingress from YAML')}
          initialYaml={createIngressYamlTemplate}
          namespace={selectedNamespace !== 'all' ? selectedNamespace : 'default'}
          onClose={() => setCreateDialogOpen(false)}
          onCreated={() => {
            queryClient.invalidateQueries({ queryKey: ['network', 'ingresses'] })
          }}
        />
      )}
    </div>
  )
}
