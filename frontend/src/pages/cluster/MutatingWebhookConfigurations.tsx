import { useEffect, useMemo, useRef, useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { useTranslation } from 'react-i18next'
import { api, type WebhookConfigInfo } from '@/services/api'
import { useKubeWatchList } from '@/services/useKubeWatchList'
import { useResourceDetail } from '@/components/ResourceDetailContext'
import ResourceYamlCreateDialog from '@/components/ResourceYamlCreateDialog'
import { useAdaptiveRowsPerPage } from '@/hooks/useAdaptiveRowsPerPage'
import { ChevronDown, ChevronUp, Plus, RefreshCw, Search } from 'lucide-react'

type SortKey = null | 'name' | 'webhooksCount' | 'age'

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

function normalizeWatchObject(obj: any): WebhookConfigInfo {
  if (typeof obj?.name === 'string' && typeof obj?.webhooks_count === 'number') {
    return obj as WebhookConfigInfo
  }
  const metadata = obj?.metadata ?? {}
  return {
    name: metadata?.name ?? obj?.name ?? '',
    webhooks_count: obj?.webhooks?.length ?? obj?.webhooks_count ?? 0,
    labels: metadata?.labels ?? obj?.labels ?? {},
    created_at: metadata?.creationTimestamp ?? obj?.created_at ?? '',
  }
}

function applyWatchEvent(
  prev: WebhookConfigInfo[] | undefined,
  event: { type?: string; object?: any },
): WebhookConfigInfo[] {
  const items = Array.isArray(prev) ? [...prev] : []
  const obj = event?.object
  if (!obj) return items

  const normalized = normalizeWatchObject(obj)
  const name = normalized?.name
  if (!name) return items

  const index = items.findIndex((item) => item.name === name)

  if (event.type === 'DELETED') {
    if (index >= 0) items.splice(index, 1)
    return items
  }

  if (index >= 0) items[index] = normalized
  else items.push(normalized)

  return items
}

function toRawJson(item: WebhookConfigInfo): Record<string, unknown> {
  return {
    apiVersion: 'admissionregistration.k8s.io/v1',
    kind: 'MutatingWebhookConfiguration',
    metadata: {
      name: item.name,
      labels: item.labels || {},
      creationTimestamp: item.created_at,
    },
    webhooks: [],
  }
}

export default function MutatingWebhookConfigurations() {
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
  const tableContainerRef = useRef<HTMLDivElement>(null)

  const { data: items, isLoading } = useQuery({
    queryKey: ['cluster', 'mutatingwebhookconfigurations'],
    queryFn: () => api.getMutatingWebhookConfigurations(false),
  })

  const { data: me } = useQuery({
    queryKey: ['me'],
    queryFn: api.me,
    staleTime: 30000,
  })
  const canCreate = me?.role === 'admin'

  useKubeWatchList({
    enabled: true,
    queryKey: ['cluster', 'mutatingwebhookconfigurations'],
    path: '/apis/admissionregistration.k8s.io/v1/mutatingwebhookconfigurations',
    query: 'watch=1',
    applyEvent: (prev, event) => applyWatchEvent(prev as WebhookConfigInfo[] | undefined, event),
  })

  const filtered = useMemo(() => {
    if (!Array.isArray(items)) return [] as WebhookConfigInfo[]
    if (!searchQuery.trim()) return items
    const q = searchQuery.toLowerCase()
    return items.filter((item) => item.name.toLowerCase().includes(q))
  }, [items, searchQuery])

  const summary = useMemo(() => {
    const total = filtered.length
    let totalWebhooks = 0
    for (const item of filtered) {
      totalWebhooks += item.webhooks_count
    }
    return { total, totalWebhooks }
  }, [filtered])

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

  const sorted = useMemo(() => {
    if (!sortKey) return filtered
    const list = [...filtered]

    const getValue = (item: WebhookConfigInfo): string | number => {
      switch (sortKey) {
        case 'name': return item.name
        case 'webhooksCount': return item.webhooks_count
        case 'age': return parseAgeSeconds(item.created_at)
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
  }, [filtered, sortDir, sortKey])

  const rowsPerPage = useAdaptiveRowsPerPage(tableContainerRef, {
    recalculationKey: sorted.length,
  })
  const totalPages = Math.max(1, Math.ceil(sorted.length / rowsPerPage))

  useEffect(() => {
    setCurrentPage(1)
  }, [searchQuery])

  useEffect(() => {
    if (currentPage > totalPages) {
      setCurrentPage(totalPages)
    }
  }, [currentPage, totalPages])

  const paged = useMemo(() => {
    const start = (currentPage - 1) * rowsPerPage
    return sorted.slice(start, start + rowsPerPage)
  }, [sorted, currentPage, rowsPerPage])

  const handleRefresh = async () => {
    if (isRefreshing) return
    setIsRefreshing(true)
    try {
      const data = await api.getMutatingWebhookConfigurations(true)
      queryClient.removeQueries({ queryKey: ['cluster', 'mutatingwebhookconfigurations'] })
      queryClient.setQueryData(['cluster', 'mutatingwebhookconfigurations'], data)
    } catch (error) {
      console.error('MutatingWebhookConfigurations refresh failed:', error)
    }
    setTimeout(() => setIsRefreshing(false), 500)
  }

  const createYamlTemplate = `apiVersion: admissionregistration.k8s.io/v1
kind: MutatingWebhookConfiguration
metadata:
  name: sample-mutating-webhook
webhooks:
  - name: sample.webhook.example.com
    admissionReviewVersions: ["v1"]
    sideEffects: None
    clientConfig:
      service:
        name: webhook-service
        namespace: default
        path: /mutate
    rules:
      - operations: ["CREATE", "UPDATE"]
        apiGroups: [""]
        apiVersions: ["v1"]
        resources: ["pods"]
`

  return (
    <div className="flex flex-col h-[calc(100vh-4rem)] gap-4">
      <div className="flex items-center justify-between shrink-0">
        <div>
          <h1 className="text-3xl font-bold text-white">{tr('mutatingWebhooks.title', 'Mutating Webhook Configurations')}</h1>
          <p className="mt-2 text-slate-400">
            {tr('mutatingWebhooks.subtitle', 'Manage mutating admission webhook configurations in the cluster.')}
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
              {tr('mutatingWebhooks.create', 'Create')}
            </button>
          )}
          <button
            type="button"
            onClick={handleRefresh}
            disabled={isRefreshing}
            title={tr('mutatingWebhooks.refreshTitle', 'Force refresh')}
            className="btn btn-primary flex items-center gap-2 disabled:opacity-50 disabled:cursor-not-allowed"
          >
            <RefreshCw className={`w-4 h-4 ${isRefreshing ? 'animate-spin' : ''}`} />
            {tr('mutatingWebhooks.refresh', 'Refresh')}
          </button>
        </div>
      </div>

      <div className="shrink-0">
        <div className="relative">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-5 h-5 text-slate-400" />
          <input
            type="text"
            placeholder={tr('mutatingWebhooks.searchPlaceholder', 'Search by name...')}
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            className="h-12 w-full pl-10 pr-4 bg-slate-700 border border-slate-600 rounded-lg text-sm text-white placeholder-slate-400 focus:outline-none focus:ring-2 focus:ring-primary-500 focus:border-transparent"
          />
        </div>
      </div>

      <div className="grid grid-cols-2 gap-3 shrink-0">
        <div className="rounded-lg border border-slate-700 bg-slate-900/50 px-4 py-3">
          <p className="text-[11px] sm:text-xs leading-4 whitespace-nowrap text-slate-400">{tr('mutatingWebhooks.stats.total', 'Total Configurations')}</p>
          <p className="text-lg text-white font-semibold mt-1">{summary.total}</p>
        </div>
        <div className="rounded-lg border border-slate-700 bg-slate-900/50 px-4 py-3">
          <p className="text-[11px] sm:text-xs leading-4 whitespace-nowrap text-slate-400">{tr('mutatingWebhooks.stats.totalWebhooks', 'Total Webhooks')}</p>
          <p className="text-lg text-white font-semibold mt-1">{summary.totalWebhooks}</p>
        </div>
      </div>

      {searchQuery && (
        <p className="text-sm text-slate-400 shrink-0">
          {tr('mutatingWebhooks.matchCount', '{{count}} configuration{{suffix}} match.', {
            count: filtered.length,
            suffix: filtered.length === 1 ? '' : 's',
          })}
        </p>
      )}

      <div ref={tableContainerRef} className="card flex-1 min-h-0 flex flex-col">
        <div className="overflow-x-auto flex-1 min-h-0">
          <table className="w-full text-sm min-w-[600px] table-fixed">
            <thead className="text-slate-400">
              <tr>
                <th className="text-left py-3 px-4 w-[400px] cursor-pointer" onClick={() => handleSort('name')}>
                  <span className="inline-flex items-center gap-1">
                    {tr('mutatingWebhooks.table.name', 'Name')}{renderSortIcon('name')}
                  </span>
                </th>
                <th className="text-left py-3 px-4 w-[120px] cursor-pointer" onClick={() => handleSort('webhooksCount')}>
                  <span className="inline-flex items-center gap-1">
                    {tr('mutatingWebhooks.table.webhooks', 'Webhooks')}{renderSortIcon('webhooksCount')}
                  </span>
                </th>
                <th className="text-left py-3 px-4 w-[100px] cursor-pointer" onClick={() => handleSort('age')}>
                  <span className="inline-flex items-center gap-1">
                    {tr('mutatingWebhooks.table.age', 'Age')}{renderSortIcon('age')}
                  </span>
                </th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-700">
              {paged.map((item) => (
                <tr
                  key={item.name}
                  className="text-slate-200 hover:bg-slate-800/60 cursor-pointer"
                  onClick={() => openDetail({
                    kind: 'MutatingWebhookConfiguration',
                    name: item.name,
                    rawJson: toRawJson(item),
                  })}
                >
                  <td className="py-3 px-4 font-medium text-white"><span className="block truncate">{item.name}</span></td>
                  <td className="py-3 px-4 text-xs font-mono">{item.webhooks_count}</td>
                  <td className="py-3 px-4 text-xs font-mono">{formatAge(item.created_at)}</td>
                </tr>
              ))}
              {sorted.length === 0 && !isLoading && (
                <tr>
                  <td colSpan={3} className="py-6 px-4 text-center text-slate-400">
                    {tr('mutatingWebhooks.noResults', 'No mutating webhook configurations found.')}
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
        {sorted.length > 0 && (
          <div className="flex items-center justify-between px-4 py-3 border-t border-slate-700 shrink-0">
            <div className="text-xs text-slate-400">
              {tr('common.paginationRange', 'Showing {{start}}-{{end}} of {{total}}', {
                start: (currentPage - 1) * rowsPerPage + 1,
                end: Math.min(currentPage * rowsPerPage, sorted.length),
                total: sorted.length,
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
          title={tr('mutatingWebhooks.createTitle', 'Create Mutating Webhook Configuration from YAML')}
          initialYaml={createYamlTemplate}
          onClose={() => setCreateDialogOpen(false)}
          onCreated={() => {
            queryClient.invalidateQueries({ queryKey: ['cluster', 'mutatingwebhookconfigurations'] })
          }}
        />
      )}
    </div>
  )
}
