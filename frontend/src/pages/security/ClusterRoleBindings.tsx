import { useEffect, useMemo, useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { useTranslation } from 'react-i18next'
import { api, type ClusterRoleBindingInfo } from '@/services/api'
import { useKubeWatchList } from '@/services/useKubeWatchList'
import { useResourceDetail } from '@/components/ResourceDetailContext'
import ResourceYamlCreateDialog from '@/components/ResourceYamlCreateDialog'
import { useAdaptiveTable } from '@/hooks/useAdaptiveTable'
import { AdaptiveTableFillerRows } from '@/components/AdaptiveTableFillerRows'
import { useAIContext } from '@/hooks/useAIContext'
import { usePermission } from '@/hooks/usePermission'
import { summarizeList } from '@/utils/aiContext/summarizeList'
import { buildResourceLink } from '@/utils/resourceLink'
import { Loader2, ChevronDown, ChevronUp, Plus, RefreshCw, Search } from 'lucide-react'

type SortKey = null | 'name' | 'roleRef' | 'subjects' | 'age'
type SummaryCard = [label: string, value: number, boxClass: string, labelClass: string]

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

function normalizeWatchClusterRoleBindingObject(obj: any): ClusterRoleBindingInfo {
  if (
    typeof obj?.name === 'string' &&
    typeof obj?.subjects_count === 'number'
  ) {
    return obj as ClusterRoleBindingInfo
  }

  const metadata = obj?.metadata ?? {}
  const subjects = Array.isArray(obj?.subjects) ? obj.subjects : []
  const roleRef = obj?.roleRef ?? {}

  return {
    name: metadata?.name ?? obj?.name ?? '',
    role_ref_kind: roleRef?.kind ?? obj?.role_ref_kind ?? '',
    role_ref_name: roleRef?.name ?? obj?.role_ref_name ?? '',
    subjects_count: subjects.length,
    created_at: metadata?.creationTimestamp ?? obj?.created_at ?? '',
    labels: metadata?.labels ?? obj?.labels ?? null,
    annotations: metadata?.annotations ?? obj?.annotations ?? null,
  }
}

function applyClusterRoleBindingWatchEvent(
  prev: ClusterRoleBindingInfo[] | undefined,
  event: { type?: string; object?: any },
): ClusterRoleBindingInfo[] {
  const items = Array.isArray(prev) ? [...prev] : []
  const obj = event?.object
  if (!obj) return items

  const normalized = normalizeWatchClusterRoleBindingObject(obj)
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

export default function ClusterRoleBindings() {
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

  const { data: clusterRoleBindings, isLoading } = useQuery({
    queryKey: ['security', 'clusterrolebindings'],
    queryFn: () => api.getClusterRoleBindings(false),
  })
  const { has } = usePermission()
  const canCreate = has('resource.clusterrolebinding.create')

  useKubeWatchList({
    enabled: true,
    queryKey: ['security', 'clusterrolebindings'],
    path: '/apis/rbac.authorization.k8s.io/v1/clusterrolebindings',
    query: 'watch=1',
    applyEvent: (prev, event) => applyClusterRoleBindingWatchEvent(prev as ClusterRoleBindingInfo[] | undefined, event),
    onEvent: (event) => {
      if (event?.type === 'DELETED') return
      const name = event?.object?.name || event?.object?.metadata?.name
      if (name) {
        queryClient.invalidateQueries({ queryKey: ['clusterrolebinding-describe', name] })
      }
    },
  })

  const filteredItems = useMemo(() => {
    if (!Array.isArray(clusterRoleBindings)) return [] as ClusterRoleBindingInfo[]
    if (!searchQuery.trim()) return clusterRoleBindings
    const q = searchQuery.toLowerCase()
    return clusterRoleBindings.filter(
      (crb) =>
        crb.name.toLowerCase().includes(q) ||
        crb.role_ref_name.toLowerCase().includes(q),
    )
  }, [clusterRoleBindings, searchQuery])

  const summary = useMemo(() => {
    const total = filteredItems.length
    let totalSubjects = 0
    for (const crb of filteredItems) totalSubjects += crb.subjects_count
    return { total, totalSubjects }
  }, [filteredItems])

  const summaryCards = useMemo<SummaryCard[]>(
    () => [
      [tr('clusterRoleBindingsPage.stats.total', 'Total'), summary.total, 'border-slate-700 bg-slate-900/50', 'text-slate-400'],
      [tr('clusterRoleBindingsPage.stats.totalSubjects', 'Total Subjects'), summary.totalSubjects, 'border-cyan-700/40 bg-cyan-900/10', 'text-cyan-300'],
    ],
    [summary.total, summary.totalSubjects, tr],
  )

  const handleSort = (key: NonNullable<SortKey>) => {
    if (sortKey !== key) { setSortKey(key); setSortDir('asc'); return }
    if (sortDir === 'asc') { setSortDir('desc'); return }
    setSortKey(null)
  }

  const renderSortIcon = (key: NonNullable<SortKey>) => {
    if (sortKey !== key) return null
    return sortDir === 'asc'
      ? <ChevronUp className="w-3.5 h-3.5 text-slate-300" />
      : <ChevronDown className="w-3.5 h-3.5 text-slate-300" />
  }

  const sortedItems = useMemo(() => {
    if (!sortKey) return filteredItems
    const list = [...filteredItems]
    const getValue = (crb: ClusterRoleBindingInfo): string | number => {
      switch (sortKey) {
        case 'name': return crb.name
        case 'roleRef': return `${crb.role_ref_kind}/${crb.role_ref_name}`
        case 'subjects': return crb.subjects_count
        case 'age': return parseAgeSeconds(crb.created_at)
        default: return ''
      }
    }
    list.sort((a, b) => {
      const av = getValue(a)
      const bv = getValue(b)
      if (typeof av === 'number' && typeof bv === 'number') return sortDir === 'asc' ? av - bv : bv - av
      return sortDir === 'asc' ? String(av).localeCompare(String(bv)) : String(bv).localeCompare(String(av))
    })
    return list
  }, [filteredItems, sortDir, sortKey])

  const { containerRef: tableContainerRef, bodyRef: tableBodyRef, theadRef, firstRowRef, rowsPerPage } = useAdaptiveTable({ recalculationKey: sortedItems.length })
  const totalPages = Math.max(1, Math.ceil(sortedItems.length / rowsPerPage))

  useEffect(() => { setCurrentPage(1) }, [searchQuery])
  useEffect(() => { if (currentPage > totalPages) setCurrentPage(totalPages) }, [currentPage, totalPages])

  const pagedItems = useMemo(() => {
    const start = (currentPage - 1) * rowsPerPage
    return sortedItems.slice(start, start + rowsPerPage)
  }, [sortedItems, currentPage, rowsPerPage])

  // 플로팅 AI 위젯용 스냅샷 (cluster-scoped)
  const aiSnapshot = useMemo(() => {
    if (!Array.isArray(clusterRoleBindings) || clusterRoleBindings.length === 0) return null
    const total = clusterRoleBindings.length
    return {
      source: 'base' as const,
      summary: `ClusterRoleBinding ${total}개`,
      data: {
        filters: { search: searchQuery || undefined },
        stats: { total },
        ...summarizeList(pagedItems as unknown as Record<string, unknown>[], {
          total: sortedItems.length,
          currentPage,
          pageSize: rowsPerPage,
          topN: rowsPerPage,
          pickFields: ['name', 'role_ref_kind', 'role_ref_name', 'subjects_count'],
          linkBuilder: (r) => {
            const rb = r as unknown as ClusterRoleBindingInfo
            return buildResourceLink('ClusterRoleBinding', undefined, rb.name)
          },
        }),
      },
    }
  }, [clusterRoleBindings, pagedItems, sortedItems.length, currentPage, rowsPerPage, searchQuery])

  useAIContext(aiSnapshot, [aiSnapshot])

  const handleRefresh = async () => {
    if (isRefreshing) return
    setIsRefreshing(true)
    try {
      const data = await api.getClusterRoleBindings(true)
      queryClient.removeQueries({ queryKey: ['security', 'clusterrolebindings'] })
      queryClient.setQueryData(['security', 'clusterrolebindings'], data)
    } catch (error) {
      console.error('ClusterRoleBindings refresh failed:', error)
    }
    setTimeout(() => setIsRefreshing(false), 500)
  }

  const createYamlTemplate = `apiVersion: rbac.authorization.k8s.io/v1
kind: ClusterRoleBinding
metadata:
  name: sample-clusterrolebinding
roleRef:
  apiGroup: rbac.authorization.k8s.io
  kind: ClusterRole
  name: sample-clusterrole
subjects:
  - kind: ServiceAccount
    name: default
    namespace: default
`

  return (
    <div className="flex flex-col h-[calc(100vh-4rem)] gap-4">
      <div className="flex items-center justify-between shrink-0">
        <div>
          <h1 className="text-3xl font-bold text-white">{tr('clusterRoleBindingsPage.title', 'Cluster Role Bindings')}</h1>
          <p className="mt-2 text-slate-400">{tr('clusterRoleBindingsPage.subtitle', 'Manage ClusterRoleBindings across the cluster.')}</p>
        </div>
        <div className="flex items-center gap-2">
          {canCreate && (
            <button type="button" onClick={() => setCreateDialogOpen(true)} className="btn btn-primary flex items-center gap-2">
              <Plus className="w-4 h-4" />
              {tr('clusterRoleBindingsPage.create', 'Create ClusterRoleBinding')}
            </button>
          )}
          <button type="button" onClick={handleRefresh} disabled={isRefreshing} title={tr('clusterRoleBindingsPage.refreshTitle', 'Force refresh')} className="btn btn-primary flex items-center gap-2 disabled:opacity-50 disabled:cursor-not-allowed">
            <RefreshCw className={`w-4 h-4 ${isRefreshing ? 'animate-spin' : ''}`} />
            {tr('clusterRoleBindingsPage.refresh', 'Refresh')}
          </button>
        </div>
      </div>

      <div className="shrink-0">
        <div className="relative">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-5 h-5 text-slate-400" />
          <input type="text" placeholder={tr('clusterRoleBindingsPage.searchPlaceholder', 'Search by name or role ref...')} value={searchQuery} onChange={(e) => setSearchQuery(e.target.value)} className="h-12 w-full pl-10 pr-4 bg-slate-700 border border-slate-600 rounded-lg text-sm text-white placeholder-slate-400 focus:outline-none focus:ring-2 focus:ring-primary-500 focus:border-transparent" />
        </div>
      </div>

      <div className="grid grid-cols-2 gap-3 shrink-0">
        {summaryCards.map(([label, value, boxClass, labelClass]) => (
          <div key={label} className={`rounded-lg border px-4 py-3 ${boxClass}`}>
            <p className={`text-[11px] sm:text-xs leading-4 whitespace-nowrap ${labelClass}`}>{label}</p>
            <p className="text-lg text-white font-semibold mt-1">{value}</p>
          </div>
        ))}
      </div>

      {searchQuery && (
        <p className="text-sm text-slate-400 shrink-0">
          {tr('clusterRoleBindingsPage.matchCount', '{{count}} result(s) match.', { count: filteredItems.length })}
        </p>
      )}

      <div ref={tableContainerRef} className="card flex-1 min-h-0 flex flex-col">
        <div ref={tableBodyRef} className="overflow-x-auto flex-1 min-h-0">
          <table className="w-full text-sm min-w-[700px] table-fixed">
            <thead ref={theadRef} className="text-slate-400">
              <tr>
                <th className="text-left py-3 px-4 cursor-pointer" onClick={() => handleSort('name')}>
                  <span className="inline-flex items-center gap-1">{tr('clusterRoleBindingsPage.table.name', 'Name')}{renderSortIcon('name')}</span>
                </th>
                <th className="text-left py-3 px-4 cursor-pointer" onClick={() => handleSort('roleRef')}>
                  <span className="inline-flex items-center gap-1">{tr('clusterRoleBindingsPage.table.roleRef', 'Role Ref')}{renderSortIcon('roleRef')}</span>
                </th>
                <th className="text-left py-3 px-4 w-[90px] cursor-pointer" onClick={() => handleSort('subjects')}>
                  <span className="inline-flex items-center gap-1">{tr('clusterRoleBindingsPage.table.subjects', 'Subjects')}{renderSortIcon('subjects')}</span>
                </th>
                <th className="text-left py-3 px-4 w-[90px] cursor-pointer" onClick={() => handleSort('age')}>
                  <span className="inline-flex items-center gap-1">{tr('clusterRoleBindingsPage.table.age', 'Age')}{renderSortIcon('age')}</span>
                </th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-700">
              {pagedItems.map((crb, idx) => (
                <tr
                      ref={idx === 0 ? firstRowRef : undefined} key={crb.name} className="text-slate-200 hover:bg-slate-800/60 cursor-pointer" onClick={() => openDetail({ kind: 'ClusterRoleBinding', name: crb.name })}>
                  <td className="py-3 px-4 font-medium text-white"><span className="block truncate">{crb.name}</span></td>
                  <td className="py-3 px-4 text-xs font-mono truncate" title={`${crb.role_ref_kind}/${crb.role_ref_name}`}>
                    <span className="text-slate-400">{crb.role_ref_kind}/</span>{crb.role_ref_name}
                  </td>
                  <td className="py-3 px-4 text-xs font-mono">{crb.subjects_count}</td>
                  <td className="py-3 px-4 text-xs font-mono">{formatAge(crb.created_at)}</td>
                </tr>
              ))}
              {isLoading && (
                <tr>
                  <td colSpan={4} className="py-10 px-4 text-center text-slate-400">
                    <div className="inline-flex items-center gap-2">
                      <Loader2 className="w-4 h-4 animate-spin" />
                      Loading...
                    </div>
                  </td>
                </tr>
              )}

              {sortedItems.length === 0 && !isLoading && (
                <tr>
                  <td colSpan={4} className="py-6 px-4 text-center text-slate-400">
                    {tr('clusterRoleBindingsPage.noResults', 'No cluster role bindings found.')}
                  </td>
                </tr>
              )}
            </tbody>
              <AdaptiveTableFillerRows count={rowsPerPage - pagedItems.length} columnCount={4} />
          </table>
        </div>

        {sortedItems.length > 0 && (
          <div className="flex items-center justify-between px-4 py-3 border-t border-slate-700 shrink-0">
            <div className="text-xs text-slate-400">
              {tr('common.paginationRange', 'Showing {{start}}-{{end}} of {{total}}', {
                start: (currentPage - 1) * rowsPerPage + 1,
                end: Math.min(currentPage * rowsPerPage, sortedItems.length),
                total: sortedItems.length,
              })}
            </div>
            <div className="flex items-center gap-2">
              <button type="button" onClick={() => setCurrentPage((prev) => Math.max(1, prev - 1))} disabled={currentPage <= 1} className="px-3 py-1.5 text-xs rounded border border-slate-600 text-slate-300 disabled:opacity-40 disabled:cursor-not-allowed hover:text-white hover:border-slate-500">
                {tr('common.prev', 'Prev')}
              </button>
              <span className="text-xs text-slate-300 min-w-[72px] text-center">{currentPage} / {totalPages}</span>
              <button type="button" onClick={() => setCurrentPage((prev) => Math.min(totalPages, prev + 1))} disabled={currentPage >= totalPages} className="px-3 py-1.5 text-xs rounded border border-slate-600 text-slate-300 disabled:opacity-40 disabled:cursor-not-allowed hover:text-white hover:border-slate-500">
                {tr('common.next', 'Next')}
              </button>
            </div>
          </div>
        )}
      </div>

      {createDialogOpen && (
        <ResourceYamlCreateDialog
          title={tr('clusterRoleBindingsPage.createTitle', 'Create ClusterRoleBinding from YAML')}
          initialYaml={createYamlTemplate}
          onClose={() => setCreateDialogOpen(false)}
          onCreated={() => {
            queryClient.invalidateQueries({ queryKey: ['security', 'clusterrolebindings'] })
          }}
        />
      )}
    </div>
  )
}
