import { useEffect, useMemo, useRef, useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { useTranslation } from 'react-i18next'
import { api, type IngressInfo } from '@/services/api'
import { useKubeWatchList } from '@/services/useKubeWatchList'
import { useResourceDetail } from '@/components/ResourceDetailContext'
import ResourceYamlCreateDialog from '@/components/ResourceYamlCreateDialog'
import { useAdaptiveRowsPerPage } from '@/hooks/useAdaptiveRowsPerPage'
import { useAIContext } from '@/hooks/useAIContext'
import { usePermission } from '@/hooks/usePermission'
import { summarizeList } from '@/utils/aiContext/summarizeList'
import { buildResourceLink } from '@/utils/resourceLink'
import { Loader2, CheckCircle, ChevronDown, ChevronUp, Plus, RefreshCw, Search } from 'lucide-react'

type SortKey = null | 'name' | 'namespace' | 'class' | 'hosts' | 'backends' | 'addresses' | 'age'

function parseAgeSeconds(createdAt?: string | null): number {
  if (!createdAt) return 0
  const ms = new Date(createdAt).getTime()
  if (!Number.isFinite(ms)) return 0
  return Math.max(0, Math.floor((Date.now() - ms) / 1000))
}

function formatAge(createdAt?: string | null): string {
  const sec = parseAgeSeconds(createdAt)
  const d = Math.floor(sec / 86400)
  const h = Math.floor((sec % 86400) / 3600)
  const m = Math.floor((sec % 3600) / 60)
  if (d > 0) return `${d}d ${h}h`
  if (h > 0) return `${h}h ${m}m`
  return `${m}m`
}

function formatHosts(ing: IngressInfo): string {
  if (!Array.isArray(ing.hosts) || ing.hosts.length === 0) return '-'
  return ing.hosts.join(', ')
}

function formatBackends(ing: IngressInfo): string {
  if (!Array.isArray(ing.backends) || ing.backends.length === 0) return '-'
  return ing.backends.join(', ')
}

function formatAddresses(ing: IngressInfo): string {
  const addresses = Array.isArray(ing.addresses) ? ing.addresses : []
  if (addresses.length === 0) return '-'
  return addresses
    .map((a) => a?.ip || a?.hostname || '-')
    .filter(Boolean)
    .join(', ')
}

function formatRules(ing: IngressInfo): string {
  const rules = Array.isArray(ing.rules) ? ing.rules : []
  if (rules.length === 0) return '-'

  const items: string[] = []
  for (const rule of rules) {
    const host = rule?.host || '*'
    const paths = Array.isArray(rule?.paths) ? rule.paths : []
    if (paths.length === 0) {
      items.push(`${host}:/*`)
      continue
    }
    for (const p of paths) {
      const path = p?.path || '/'
      items.push(`${host}:${path}`)
    }
  }
  if (items.length === 0) return '-'
  if (items.length <= 2) return items.join(', ')
  return `${items.slice(0, 2).join(', ')} +${items.length - 2}`
}

function normalizeBackend(backend: any): any {
  if (!backend || typeof backend !== 'object') return {}
  const service = backend?.service
  if (service) {
    const portObj = service?.port
    const port = portObj?.number ?? portObj?.name ?? null
    return {
      type: 'service',
      service: {
        name: service?.name ?? null,
        port,
      },
    }
  }
  const resource = backend?.resource
  if (resource) {
    return {
      type: 'resource',
      resource,
    }
  }
  return {}
}

function normalizeWatchIngressObject(obj: any): IngressInfo {
  if (typeof obj?.name === 'string' && typeof obj?.namespace === 'string' && Array.isArray(obj?.hosts)) {
    return {
      ...obj,
      backends: Array.isArray(obj?.backends) ? obj.backends : [],
      hosts: Array.isArray(obj?.hosts) ? obj.hosts : [],
      rules: Array.isArray(obj?.rules) ? obj.rules : [],
      tls: Array.isArray(obj?.tls) ? obj.tls : [],
      addresses: Array.isArray(obj?.addresses) ? obj.addresses : [],
      annotations: obj?.annotations || {},
      labels: obj?.labels || {},
    } as IngressInfo
  }

  const metadata = obj?.metadata ?? {}
  const spec = obj?.spec ?? {}
  const status = obj?.status ?? {}
  const annotations = metadata?.annotations ?? {}
  const labels = metadata?.labels ?? {}
  const specClass = spec?.ingressClassName ?? null
  const annoClass = annotations?.['kubernetes.io/ingress.class'] ?? null
  const ingressClass = specClass || annoClass || null
  const classSource = specClass ? 'spec' : annoClass ? 'annotation' : null

  const addresses = (status?.loadBalancer?.ingress || []).map((item: any) => ({
    ip: item?.ip ?? null,
    hostname: item?.hostname ?? null,
  }))

  const tls = (spec?.tls || []).map((item: any) => ({
    secret_name: item?.secretName ?? null,
    hosts: Array.isArray(item?.hosts) ? item.hosts : [],
  }))

  const defaultBackend = normalizeBackend(spec?.defaultBackend)
  const backends = new Set<string>()
  if (defaultBackend?.type === 'service' && defaultBackend?.service?.name) {
    backends.add(defaultBackend.service.name)
  } else if (defaultBackend?.type === 'resource') {
    const kind = defaultBackend?.resource?.kind
    const name = defaultBackend?.resource?.name
    if (kind && name) backends.add(`${kind}:${name}`)
  }

  const rules = (spec?.rules || []).map((rule: any) => {
    const paths = (rule?.http?.paths || []).map((p: any) => {
      const backend = normalizeBackend(p?.backend)
      if (backend?.type === 'service' && backend?.service?.name) {
        backends.add(backend.service.name)
      } else if (backend?.type === 'resource') {
        const kind = backend?.resource?.kind
        const name = backend?.resource?.name
        if (kind && name) backends.add(`${kind}:${name}`)
      }
      return {
        path: p?.path ?? null,
        path_type: p?.pathType ?? null,
        backend,
      }
    })
    return {
      host: rule?.host ?? null,
      paths,
    }
  })

  const hosts = rules
    .map((r: any) => r?.host)
    .filter((v: any) => typeof v === 'string' && v.length > 0)

  return {
    name: metadata?.name ?? '',
    namespace: metadata?.namespace ?? '',
    hosts,
    class: ingressClass,
    class_source: classSource,
    backends: [...backends],
    addresses,
    tls,
    default_backend: defaultBackend,
    rules,
    labels,
    annotations,
    created_at: metadata?.creationTimestamp ?? null,
  }
}

function applyIngressWatchEvent(prev: IngressInfo[] | undefined, event: { type?: string; object?: any }): IngressInfo[] {
  const items = Array.isArray(prev) ? [...prev] : []
  const obj = event?.object
  if (!obj) return items

  const normalized = normalizeWatchIngressObject(obj)
  const name = normalized?.name
  const namespace = normalized?.namespace
  if (!name || !namespace) return items

  const key = `${namespace}/${name}`
  const index = items.findIndex((item) => `${item.namespace}/${item.name}` === key)

  if (event.type === 'DELETED') {
    if (index >= 0) items.splice(index, 1)
    return items
  }

  if (index >= 0) items[index] = normalized
  else items.push(normalized)

  return items
}

function ingressToRawJson(ing: IngressInfo): Record<string, unknown> {
  return {
    apiVersion: 'networking.k8s.io/v1',
    kind: 'Ingress',
    metadata: {
      name: ing.name,
      namespace: ing.namespace,
      labels: ing.labels || {},
      annotations: ing.annotations || {},
      creationTimestamp: ing.created_at,
    },
    spec: {
      ingressClassName: ing.class || undefined,
      defaultBackend: ing.default_backend || undefined,
      tls: (ing.tls || []).map((t) => ({
        secretName: t.secret_name,
        hosts: t.hosts || [],
      })),
      rules: (ing.rules || []).map((rule) => ({
        host: rule.host || undefined,
        http: {
          paths: (rule.paths || []).map((p) => ({
            path: p.path || undefined,
            pathType: p.path_type || undefined,
            backend: p.backend || undefined,
          })),
        },
      })),
    },
    status: {
      loadBalancer: {
        ingress: (ing.addresses || []).map((a) => ({
          ip: a?.ip,
          hostname: a?.hostname,
        })),
      },
    },
    class_source: ing.class_source,
    class_controller: ing.class_controller,
    class_is_default: ing.class_is_default,
  }
}

export default function Ingresses() {
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
  const tableContainerRef = useRef<HTMLDivElement>(null)

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

  const rowsPerPage = useAdaptiveRowsPerPage(tableContainerRef, {
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

      <div className="grid grid-cols-1 xl:grid-cols-3 gap-3 shrink-0">
        <div className="xl:col-span-2">
          <div className="relative">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-5 h-5 text-slate-400" />
            <input
              type="text"
              placeholder={tr('ingressesPage.searchPlaceholder', 'Search ingresses by name...')}
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
              {selectedNamespace === 'all' ? tr('ingressesPage.allNamespaces', 'All namespaces') : selectedNamespace}
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
                <span className={selectedNamespace === 'all' ? 'font-medium' : ''}>{tr('ingressesPage.allNamespaces', 'All namespaces')}</span>
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

      <div ref={tableContainerRef} className="card flex-1 min-h-0 flex flex-col">
        <div className="overflow-x-auto flex-1 min-h-0">
          <table className="w-full text-sm min-w-[1320px] table-fixed">
            <thead className="text-slate-400">
              <tr>
                {showNamespaceColumn && (
                  <th className="text-left py-3 px-4 w-[150px] cursor-pointer" onClick={() => handleSort('namespace')}>
                    <span className="inline-flex items-center gap-1">{tr('ingressesPage.table.namespace', 'Namespace')}{renderSortIcon('namespace')}</span>
                  </th>
                )}
                <th className="text-left py-3 px-4 w-[220px] cursor-pointer" onClick={() => handleSort('name')}>
                  <span className="inline-flex items-center gap-1">{tr('ingressesPage.table.name', 'Name')}{renderSortIcon('name')}</span>
                </th>
                <th className="text-left py-3 px-4 w-[150px] cursor-pointer" onClick={() => handleSort('class')}>
                  <span className="inline-flex items-center gap-1">{tr('ingressesPage.table.class', 'Class')}{renderSortIcon('class')}</span>
                </th>
                <th className="text-left py-3 px-4 w-[270px] cursor-pointer" onClick={() => handleSort('hosts')}>
                  <span className="inline-flex items-center gap-1">{tr('ingressesPage.table.hosts', 'Hosts')}{renderSortIcon('hosts')}</span>
                </th>
                <th className="text-left py-3 px-4 w-[260px] cursor-pointer" onClick={() => handleSort('backends')}>
                  <span className="inline-flex items-center gap-1">{tr('ingressesPage.table.routes', 'Routes')}{renderSortIcon('backends')}</span>
                </th>
                <th className="text-left py-3 px-4 w-[210px] cursor-pointer" onClick={() => handleSort('addresses')}>
                  <span className="inline-flex items-center gap-1">{tr('ingressesPage.table.addresses', 'Address')}{renderSortIcon('addresses')}</span>
                </th>
                <th className="text-left py-3 px-4 w-[90px] cursor-pointer" onClick={() => handleSort('age')}>
                  <span className="inline-flex items-center gap-1">{tr('ingressesPage.table.age', 'Age')}{renderSortIcon('age')}</span>
                </th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-700">
              {pagedIngresses.map((ing) => (
                <tr
                  key={`${ing.namespace}/${ing.name}`}
                  className="text-slate-200 hover:bg-slate-800/60 cursor-pointer"
                  onClick={() => openDetail({
                    kind: 'Ingress',
                    name: ing.name,
                    namespace: ing.namespace,
                    rawJson: ingressToRawJson(ing),
                  })}
                >
                  {showNamespaceColumn && <td className="py-3 px-4 text-xs font-mono">{ing.namespace}</td>}
                  <td className="py-3 px-4 font-medium text-white"><span className="block truncate">{ing.name}</span></td>
                  <td className="py-3 px-4 text-xs font-mono"><span className="block truncate">{ing.class || '-'}</span></td>
                  <td className="py-3 px-4 text-xs font-mono"><span className="block truncate">{formatHosts(ing)}</span></td>
                  <td className="py-3 px-4 text-xs font-mono"><span className="block truncate">{formatRules(ing)}</span></td>
                  <td className="py-3 px-4 text-xs font-mono"><span className="block truncate">{formatAddresses(ing)}</span></td>
                  <td className="py-3 px-4 text-xs font-mono">{formatAge(ing.created_at)}</td>
                </tr>
              ))}
              {isLoading && (
                <tr>
                  <td colSpan={showNamespaceColumn ? 8 : 7} className="py-10 px-4 text-center text-slate-400">
                    <div className="inline-flex items-center gap-2">
                      <Loader2 className="w-4 h-4 animate-spin" />
                      Loading...
                    </div>
                  </td>
                </tr>
              )}

              {sortedIngresses.length === 0 && !isLoading && (
                <tr>
                  <td colSpan={showNamespaceColumn ? 8 : 7} className="py-6 px-4 text-center text-slate-400">
                    {tr('ingressesPage.noResults', 'No ingresses found.')}
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>

        {totalPages > 1 && (
          <div className="flex items-center justify-between text-xs text-slate-400 px-4 py-3 border-t border-slate-700 shrink-0">
            <span>
              {(() => {
                const total = sortedIngresses.length
                if (total === 0) return tr('common.pagination.empty', '0')
                const from = (currentPage - 1) * rowsPerPage + 1
                const to = Math.min(currentPage * rowsPerPage, total)
                return tr('common.pagination.range', '{{from}}-{{to}} / {{total}}', { from, to, total })
              })()}
            </span>
            <div className="flex items-center gap-2">
              <button
                type="button"
                className="btn btn-secondary px-2 py-1 disabled:opacity-50"
                disabled={currentPage === 1}
                onClick={() => setCurrentPage((p) => Math.max(1, p - 1))}
              >
                {tr('common.pagination.prev', 'Prev')}
              </button>
              <span>{currentPage} / {totalPages}</span>
              <button
                type="button"
                className="btn btn-secondary px-2 py-1 disabled:opacity-50"
                disabled={currentPage === totalPages}
                onClick={() => setCurrentPage((p) => Math.min(totalPages, p + 1))}
              >
                {tr('common.pagination.next', 'Next')}
              </button>
            </div>
          </div>
        )}
      </div>

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
