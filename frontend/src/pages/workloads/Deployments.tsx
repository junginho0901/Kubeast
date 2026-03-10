import { useEffect, useMemo, useRef, useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { useTranslation } from 'react-i18next'
import { api, type DeploymentInfo } from '@/services/api'
import { useKubeWatchList } from '@/services/useKubeWatchList'
import { useResourceDetail } from '@/components/ResourceDetailContext'
import ResourceYamlCreateDialog from '@/components/ResourceYamlCreateDialog'
import { useAdaptiveRowsPerPage } from '@/hooks/useAdaptiveRowsPerPage'
import { CheckCircle, ChevronDown, ChevronUp, Plus, RefreshCw, Search } from 'lucide-react'

type SortKey = null | 'name' | 'ready' | 'updated' | 'available' | 'status' | 'image' | 'age'

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

function computeDeploymentStatus(replicas: number, readyReplicas: number): string {
  if (readyReplicas === 0) return 'Unavailable'
  if (readyReplicas !== replicas) return 'Degraded'
  return 'Healthy'
}

function getDeploymentStatusColor(status: string): string {
  const lower = String(status || '').toLowerCase()
  if (lower.includes('healthy')) return 'badge-success'
  if (lower.includes('degraded') || lower.includes('progress')) return 'badge-warning'
  if (lower.includes('unavailable') || lower.includes('failed')) return 'badge-error'
  return 'badge-info'
}

function normalizeWatchDeploymentObject(obj: any): DeploymentInfo {
  if (
    typeof obj?.name === 'string' &&
    typeof obj?.namespace === 'string' &&
    typeof obj?.replicas === 'number'
  ) {
    return obj as DeploymentInfo
  }

  const metadata = obj?.metadata ?? {}
  const spec = obj?.spec ?? {}
  const status = obj?.status ?? {}

  const replicas = spec?.replicas ?? 0
  const readyReplicas = status?.readyReplicas ?? 0
  const availableReplicas = status?.availableReplicas ?? 0
  const updatedReplicas = status?.updatedReplicas ?? 0
  const image = spec?.template?.spec?.containers?.[0]?.image ?? ''

  return {
    name: metadata?.name ?? obj?.name ?? '',
    namespace: metadata?.namespace ?? obj?.namespace ?? '',
    replicas,
    ready_replicas: readyReplicas,
    available_replicas: availableReplicas,
    updated_replicas: updatedReplicas,
    image,
    labels: metadata?.labels ?? obj?.labels ?? {},
    selector: spec?.selector?.matchLabels ?? obj?.selector ?? {},
    created_at: metadata?.creationTimestamp ?? obj?.created_at ?? null,
    status: computeDeploymentStatus(replicas, readyReplicas),
  }
}

function applyDeploymentWatchEvent(
  prev: DeploymentInfo[] | undefined,
  event: { type?: string; object?: any },
): DeploymentInfo[] {
  const items = Array.isArray(prev) ? [...prev] : []
  const obj = event?.object
  if (!obj) return items

  const normalized = normalizeWatchDeploymentObject(obj)
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

function deploymentToWorkloadRawJson(deployment: DeploymentInfo): Record<string, unknown> {
  return {
    apiVersion: 'apps/v1',
    kind: 'Deployment',
    metadata: {
      name: deployment.name,
      namespace: deployment.namespace,
      labels: deployment.labels || {},
      creationTimestamp: deployment.created_at,
    },
    spec: {
      replicas: deployment.replicas,
      selector: { matchLabels: deployment.selector || {} },
      template: {
        metadata: { labels: deployment.selector || {} },
        spec: {
          containers: deployment.image
            ? [{ name: deployment.name, image: deployment.image }]
            : [],
        },
      },
    },
    status: {
      readyReplicas: deployment.ready_replicas,
      availableReplicas: deployment.available_replicas,
      updatedReplicas: deployment.updated_replicas,
    },
  }
}

export default function Deployments() {
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

  const { data: deployments, isLoading } = useQuery({
    queryKey: ['workloads', 'deployments', selectedNamespace],
    queryFn: () => (
      selectedNamespace === 'all'
        ? api.getAllDeployments(false)
        : api.getDeployments(selectedNamespace, false)
    ),
  })

  const { data: me } = useQuery({
    queryKey: ['me'],
    queryFn: api.me,
    staleTime: 30000,
  })
  const canCreate = me?.role === 'admin' || me?.role === 'write'

  useKubeWatchList({
    enabled: true,
    queryKey: ['workloads', 'deployments', selectedNamespace],
    path: selectedNamespace === 'all'
      ? '/apis/apps/v1/deployments'
      : `/apis/apps/v1/namespaces/${selectedNamespace}/deployments`,
    query: 'watch=1',
    applyEvent: (prev, event) => applyDeploymentWatchEvent(prev as DeploymentInfo[] | undefined, event),
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

  const rowsPerPage = useAdaptiveRowsPerPage(tableContainerRef, {
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
    <div className="space-y-6">
      <div className="flex items-center justify-between">
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

      <div className="grid grid-cols-1 xl:grid-cols-3 gap-3">
        <div className="xl:col-span-2">
          <div className="relative">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-5 h-5 text-slate-400" />
            <input
              type="text"
              placeholder={tr('deployments.searchPlaceholder', 'Search deployments by name...')}
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              className="w-full pl-10 pr-4 py-3 bg-slate-700 border border-slate-600 rounded-lg text-white placeholder-slate-400 focus:outline-none focus:ring-2 focus:ring-primary-500 focus:border-transparent"
            />
          </div>
        </div>

        <div className="relative" ref={namespaceDropdownRef}>
          <button
            type="button"
            onClick={() => setIsNamespaceDropdownOpen(!isNamespaceDropdownOpen)}
            className="w-full py-3 px-3 bg-slate-700 border border-slate-600 rounded-lg text-white focus:outline-none focus:ring-2 focus:ring-primary-500 focus:border-transparent flex items-center justify-between gap-2"
          >
            <span className="text-sm font-medium">
              {selectedNamespace === 'all' ? tr('deployments.allNamespaces', 'All namespaces') : selectedNamespace}
            </span>
            <ChevronDown
              className={`w-4 h-4 text-slate-400 transition-transform ${isNamespaceDropdownOpen ? 'rotate-180' : ''}`}
            />
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
                <span className={selectedNamespace === 'all' ? 'font-medium' : ''}>
                  {tr('deployments.allNamespaces', 'All namespaces')}
                </span>
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

      {searchQuery && (
        <p className="text-sm text-slate-400">
          {tr('deployments.matchCount', '{{count}} deployment{{suffix}} match.', {
            count: filteredDeployments.length,
            suffix: filteredDeployments.length === 1 ? '' : 's',
          })}
        </p>
      )}

      <div ref={tableContainerRef} className="card">
        <div className="overflow-x-auto">
          <table className="w-full text-sm min-w-[1040px] table-fixed">
            <thead className="text-slate-400">
              <tr>
                {showNamespaceColumn && (
                  <th className="text-left py-3 px-4 w-[150px]">{tr('deployments.table.namespace', 'Namespace')}</th>
                )}
                <th className="text-left py-3 px-4 w-[220px] cursor-pointer" onClick={() => handleSort('name')}>
                  <span className="inline-flex items-center gap-1">
                    {tr('deployments.table.name', 'Name')}{renderSortIcon('name')}
                  </span>
                </th>
                <th className="text-left py-3 px-4 w-[100px] cursor-pointer" onClick={() => handleSort('ready')}>
                  <span className="inline-flex items-center gap-1">
                    {tr('deployments.table.ready', 'Ready')}{renderSortIcon('ready')}
                  </span>
                </th>
                <th className="text-left py-3 px-4 w-[120px] cursor-pointer" onClick={() => handleSort('updated')}>
                  <span className="inline-flex items-center gap-1">
                    {tr('deployments.table.updated', 'Up to date')}{renderSortIcon('updated')}
                  </span>
                </th>
                <th className="text-left py-3 px-4 w-[110px] cursor-pointer" onClick={() => handleSort('available')}>
                  <span className="inline-flex items-center gap-1">
                    {tr('deployments.table.available', 'Available')}{renderSortIcon('available')}
                  </span>
                </th>
                <th className="text-left py-3 px-4 w-[130px] cursor-pointer" onClick={() => handleSort('status')}>
                  <span className="inline-flex items-center gap-1">
                    {tr('deployments.table.status', 'Status')}{renderSortIcon('status')}
                  </span>
                </th>
                <th className="text-left py-3 px-4 w-[240px] cursor-pointer" onClick={() => handleSort('image')}>
                  <span className="inline-flex items-center gap-1">
                    {tr('deployments.table.image', 'Image')}{renderSortIcon('image')}
                  </span>
                </th>
                <th className="text-left py-3 px-4 w-[100px] cursor-pointer" onClick={() => handleSort('age')}>
                  <span className="inline-flex items-center gap-1">
                    {tr('deployments.table.age', 'Age')}{renderSortIcon('age')}
                  </span>
                </th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-700">
              {pagedDeployments.map((dep) => (
                <tr
                  key={`${dep.namespace}/${dep.name}`}
                  className="text-slate-200 hover:bg-slate-800/60 cursor-pointer"
                  onClick={() => openDetail({
                    kind: 'Deployment',
                    name: dep.name,
                    namespace: dep.namespace,
                    rawJson: deploymentToWorkloadRawJson(dep),
                  })}
                >
                  {showNamespaceColumn && <td className="py-3 px-4 text-xs font-mono">{dep.namespace}</td>}
                  <td className="py-3 px-4 font-medium text-white"><span className="block truncate">{dep.name}</span></td>
                  <td className="py-3 px-4 text-xs font-mono">{dep.ready_replicas}/{dep.replicas}</td>
                  <td className="py-3 px-4 text-xs font-mono">{dep.updated_replicas ?? 0}</td>
                  <td className="py-3 px-4 text-xs font-mono">{dep.available_replicas ?? 0}</td>
                  <td className="py-3 px-4">
                    <span className={`badge ${getDeploymentStatusColor(dep.status)}`}>{dep.status}</span>
                  </td>
                  <td className="py-3 px-4 text-xs font-mono"><span className="block truncate">{dep.image || '-'}</span></td>
                  <td className="py-3 px-4 text-xs font-mono">{formatAge(dep.created_at)}</td>
                </tr>
              ))}
              {sortedDeployments.length === 0 && !isLoading && (
                <tr>
                  <td colSpan={showNamespaceColumn ? 9 : 8} className="py-6 px-4 text-slate-400">
                    {tr('deployments.noResults', 'No deployments found.')}
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
        {sortedDeployments.length > 0 && (
          <div className="flex items-center justify-between px-4 py-3 border-t border-slate-700">
            <div className="text-xs text-slate-400">
              {tr('common.paginationRange', 'Showing {{start}}-{{end}} of {{total}}', {
                start: (currentPage - 1) * rowsPerPage + 1,
                end: Math.min(currentPage * rowsPerPage, sortedDeployments.length),
                total: sortedDeployments.length,
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
              <span className="text-xs text-slate-300 min-w-[72px] text-center">
                {currentPage} / {totalPages}
              </span>
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

