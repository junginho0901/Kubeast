import { useEffect, useMemo, useRef, useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { useTranslation } from 'react-i18next'
import { api, type CronJobInfo } from '@/services/api'
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

type SortKey =
  | null
  | 'name'
  | 'schedule'
  | 'suspend'
  | 'active'
  | 'lastSchedule'
  | 'containers'
  | 'images'
  | 'age'

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

function formatTimestamp(ts?: string | null): string {
  if (!ts) return '-'
  const ms = new Date(ts)
  if (!Number.isFinite(ms.getTime())) return '-'
  return ms.toLocaleString()
}

function normalizeWatchCronJobObject(obj: any): CronJobInfo {
  if (
    typeof obj?.name === 'string'
    && typeof obj?.namespace === 'string'
    && typeof obj?.schedule === 'string'
  ) {
    return {
      ...obj,
      suspend: Boolean(obj?.suspend),
      active: Number(obj?.active || 0),
      containers: Array.isArray(obj?.containers) ? obj.containers : [],
      images: Array.isArray(obj?.images) ? obj.images : [],
    } as CronJobInfo
  }

  const metadata = obj?.metadata ?? {}
  const spec = obj?.spec ?? {}
  const status = obj?.status ?? {}
  const templateSpec = spec?.jobTemplate?.spec?.template?.spec ?? {}
  const containers = Array.isArray(templateSpec?.containers) ? templateSpec.containers : []

  return {
    name: metadata?.name ?? obj?.name ?? '',
    namespace: metadata?.namespace ?? obj?.namespace ?? '',
    schedule: spec?.schedule ?? obj?.schedule ?? '-',
    suspend: Boolean(spec?.suspend ?? obj?.suspend ?? false),
    concurrency_policy: spec?.concurrencyPolicy ?? obj?.concurrency_policy ?? null,
    active: Array.isArray(status?.active) ? status.active.length : Number(obj?.active || 0),
    last_schedule_time: status?.lastScheduleTime ?? obj?.last_schedule_time ?? null,
    last_successful_time: status?.lastSuccessfulTime ?? obj?.last_successful_time ?? null,
    containers: containers.map((container: any) => container?.name).filter(Boolean),
    images: containers.map((container: any) => container?.image).filter(Boolean),
    created_at: metadata?.creationTimestamp ?? obj?.created_at ?? null,
  }
}

function applyCronJobWatchEvent(
  prev: CronJobInfo[] | undefined,
  event: { type?: string; object?: any },
): CronJobInfo[] {
  const items = Array.isArray(prev) ? [...prev] : []
  const obj = event?.object
  if (!obj) return items

  const normalized = normalizeWatchCronJobObject(obj)
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

function cronJobToWorkloadRawJson(cronjob: CronJobInfo): Record<string, unknown> {
  const labels = { app: cronjob.name }
  const containers = (cronjob.images || []).map((image, idx) => ({
    name: cronjob.containers?.[idx] || `container-${idx + 1}`,
    image,
  }))

  return {
    apiVersion: 'batch/v1',
    kind: 'CronJob',
    metadata: {
      name: cronjob.name,
      namespace: cronjob.namespace,
      labels,
      creationTimestamp: cronjob.created_at,
    },
    spec: {
      schedule: cronjob.schedule,
      suspend: cronjob.suspend,
      concurrencyPolicy: cronjob.concurrency_policy,
      jobTemplate: {
        spec: {
          template: {
            metadata: { labels },
            spec: {
              restartPolicy: 'OnFailure',
              containers,
            },
          },
        },
      },
    },
    status: {
      lastScheduleTime: cronjob.last_schedule_time,
      lastSuccessfulTime: cronjob.last_successful_time,
      active: Array.from({ length: Number(cronjob.active || 0) }, (_, idx) => ({
        kind: 'Job',
        name: `active-${idx + 1}`,
      })),
    },
  }
}

export default function CronJobs() {
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

  const { data: cronjobs, isLoading } = useQuery({
    queryKey: ['workloads', 'cronjobs', selectedNamespace],
    queryFn: () => (
      selectedNamespace === 'all'
        ? api.getAllCronJobs(false)
        : api.getCronJobs(selectedNamespace, false)
    ),
  })
  const { has } = usePermission()
  const canCreate = has('resource.cronjob.create')

  useKubeWatchList({
    enabled: true,
    queryKey: ['workloads', 'cronjobs', selectedNamespace],
    path: selectedNamespace === 'all'
      ? '/api/v1/cronjobs'
      : `/api/v1/namespaces/${selectedNamespace}/cronjobs`,
    query: 'watch=1',
    applyEvent: (prev, event) => applyCronJobWatchEvent(prev as CronJobInfo[] | undefined, event),
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

  const filteredCronJobs = useMemo(() => {
    if (!Array.isArray(cronjobs)) return [] as CronJobInfo[]
    if (!searchQuery.trim()) return cronjobs
    const q = searchQuery.toLowerCase()
    return cronjobs.filter((cronjob) => {
      const containersText = (cronjob.containers || []).join(',')
      const imagesText = (cronjob.images || []).join(',')
      return cronjob.name.toLowerCase().includes(q)
        || cronjob.namespace.toLowerCase().includes(q)
        || cronjob.schedule.toLowerCase().includes(q)
        || String(cronjob.concurrency_policy || '').toLowerCase().includes(q)
        || containersText.toLowerCase().includes(q)
        || imagesText.toLowerCase().includes(q)
    })
  }, [cronjobs, searchQuery])

  const summary = useMemo(() => {
    const total = filteredCronJobs.length
    let active = 0
    let suspended = 0
    let scheduled = 0

    for (const cronjob of filteredCronJobs) {
      if ((cronjob.active || 0) > 0) active += 1
      if (cronjob.suspend) suspended += 1
      if (cronjob.last_schedule_time) scheduled += 1
    }

    return { total, active, suspended, scheduled }
  }, [filteredCronJobs])

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

  const sortedCronJobs = useMemo(() => {
    if (!sortKey) return filteredCronJobs
    const list = [...filteredCronJobs]

    const getValue = (cronjob: CronJobInfo): string | number => {
      switch (sortKey) {
        case 'name':
          return cronjob.name
        case 'schedule':
          return cronjob.schedule
        case 'suspend':
          return cronjob.suspend ? 1 : 0
        case 'active':
          return cronjob.active || 0
        case 'lastSchedule':
          return cronjob.last_schedule_time ? new Date(cronjob.last_schedule_time).getTime() : 0
        case 'containers':
          return (cronjob.containers || []).join(',')
        case 'images':
          return (cronjob.images || []).join(',')
        case 'age':
          return parseAgeSeconds(cronjob.created_at)
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
  }, [filteredCronJobs, sortDir, sortKey])

  const { containerRef: tableContainerRef, bodyRef: tableBodyRef, theadRef, firstRowRef, rowsPerPage } = useAdaptiveTable({
    recalculationKey: sortedCronJobs.length,
  })
  const totalPages = Math.max(1, Math.ceil(sortedCronJobs.length / rowsPerPage))

  useEffect(() => {
    setCurrentPage(1)
  }, [searchQuery, selectedNamespace])

  useEffect(() => {
    if (currentPage > totalPages) {
      setCurrentPage(totalPages)
    }
  }, [currentPage, totalPages])

  const pagedCronJobs = useMemo(() => {
    const start = (currentPage - 1) * rowsPerPage
    return sortedCronJobs.slice(start, start + rowsPerPage)
  }, [sortedCronJobs, currentPage, rowsPerPage])

  // 플로팅 AI 위젯용 스냅샷
  const aiSnapshot = useMemo(() => {
    if (!Array.isArray(cronjobs) || cronjobs.length === 0) return null
    const nsLabel = selectedNamespace === 'all' ? '전체 네임스페이스' : selectedNamespace
    const total = cronjobs.length
    const suspended = cronjobs.filter((c) => c.suspend).length
    const active = cronjobs.filter((c) => c.active > 0).length
    return {
      source: 'base' as const,
      summary: `${nsLabel} CronJob ${total}개 (실행중 ${active}, 일시중지 ${suspended})`,
      data: {
        filters: { namespace: selectedNamespace, search: searchQuery || undefined },
        stats: { total, active, suspended },
        ...summarizeList(pagedCronJobs as unknown as Record<string, unknown>[], {
          total: sortedCronJobs.length,
          currentPage,
          pageSize: rowsPerPage,
          topN: rowsPerPage,
          pickFields: ['name', 'namespace', 'schedule', 'suspend', 'active', 'last_schedule_time', 'last_successful_time'],
          linkBuilder: (c) => {
            const cj = c as unknown as CronJobInfo
            return buildResourceLink('CronJob', cj.namespace, cj.name)
          },
        }),
      },
    }
  }, [cronjobs, pagedCronJobs, sortedCronJobs.length, currentPage, rowsPerPage, selectedNamespace, searchQuery])

  useAIContext(aiSnapshot, [aiSnapshot])

  const handleRefresh = async () => {
    if (isRefreshing) return
    setIsRefreshing(true)
    try {
      const data = selectedNamespace === 'all'
        ? await api.getAllCronJobs(true)
        : await api.getCronJobs(selectedNamespace, true)
      queryClient.removeQueries({ queryKey: ['workloads', 'cronjobs', selectedNamespace] })
      queryClient.setQueryData(['workloads', 'cronjobs', selectedNamespace], data)
    } catch (error) {
      console.error('CronJobs refresh failed:', error)
    }
    setTimeout(() => setIsRefreshing(false), 500)
  }

  const createCronJobYamlTemplate = useMemo(() => {
    const ns = selectedNamespace !== 'all' ? selectedNamespace : 'default'
    return `apiVersion: batch/v1
kind: CronJob
metadata:
  name: sample-cronjob
  namespace: ${ns}
spec:
  schedule: "*/5 * * * *"
  concurrencyPolicy: Forbid
  successfulJobsHistoryLimit: 3
  failedJobsHistoryLimit: 1
  jobTemplate:
    spec:
      template:
        spec:
          restartPolicy: OnFailure
          containers:
            - name: sample
              image: busybox:1.36
              command: ["sh", "-c", "date; echo hello from cronjob"]
`
  }, [selectedNamespace])

  const showNamespaceColumn = selectedNamespace === 'all'

  return (
    <div className="flex flex-col h-[calc(100vh-4rem)] gap-4">
      <div className="flex items-center justify-between shrink-0">
        <div>
          <h1 className="text-3xl font-bold text-white">{tr('cronjobs.title', 'CronJobs')}</h1>
          <p className="mt-2 text-slate-400">{tr('cronjobs.subtitle', 'Inspect and manage CronJobs across namespaces.')}</p>
        </div>
        <div className="flex items-center gap-2">
          {canCreate && (
            <button
              type="button"
              onClick={() => setCreateDialogOpen(true)}
              className="btn btn-primary flex items-center gap-2"
            >
              <Plus className="w-4 h-4" />
              {tr('cronjobs.create', 'Create CronJob')}
            </button>
          )}
          <button
            type="button"
            onClick={handleRefresh}
            disabled={isRefreshing}
            title={tr('cronjobs.refreshTitle', 'Force refresh')}
            className="btn btn-primary flex items-center gap-2 disabled:opacity-50 disabled:cursor-not-allowed"
          >
            <RefreshCw className={`w-4 h-4 ${isRefreshing ? 'animate-spin' : ''}`} />
            {tr('cronjobs.refresh', 'Refresh')}
          </button>
        </div>
      </div>

      <div className="grid grid-cols-1 xl:grid-cols-3 gap-3 shrink-0">
        <div className="xl:col-span-2">
          <div className="relative">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-5 h-5 text-slate-400" />
            <input
              type="text"
              placeholder={tr('cronjobs.searchPlaceholder', 'Search cronjobs by name...')}
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
              {selectedNamespace === 'all' ? tr('cronjobs.allNamespaces', 'All namespaces') : selectedNamespace}
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
                <span className={selectedNamespace === 'all' ? 'font-medium' : ''}>{tr('cronjobs.allNamespaces', 'All namespaces')}</span>
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
          <p className="text-[11px] sm:text-xs leading-4 whitespace-nowrap text-slate-400">{tr('cronjobs.stats.total', 'Total')}</p>
          <p className="text-lg text-white font-semibold mt-1">{summary.total}</p>
        </div>
        <div className="rounded-lg border border-emerald-700/40 bg-emerald-900/10 px-4 py-3">
          <p className="text-[11px] sm:text-xs leading-4 whitespace-nowrap text-emerald-300">{tr('cronjobs.stats.active', 'Active')}</p>
          <p className="text-lg text-white font-semibold mt-1">{summary.active}</p>
        </div>
        <div className="rounded-lg border border-amber-700/40 bg-amber-900/10 px-4 py-3">
          <p className="text-[11px] sm:text-xs leading-4 whitespace-nowrap text-amber-300">{tr('cronjobs.stats.suspended', 'Suspended')}</p>
          <p className="text-lg text-white font-semibold mt-1">{summary.suspended}</p>
        </div>
        <div className="rounded-lg border border-indigo-700/40 bg-indigo-900/10 px-4 py-3">
          <p className="text-[11px] sm:text-xs leading-4 whitespace-nowrap text-indigo-300">{tr('cronjobs.stats.scheduled', 'Scheduled')}</p>
          <p className="text-lg text-white font-semibold mt-1">{summary.scheduled}</p>
        </div>
      </div>

      {searchQuery && (
        <p className="text-sm text-slate-400 shrink-0">
          {tr('cronjobs.matchCount', '{{count}} cronjob{{suffix}} match.', {
            count: filteredCronJobs.length,
            suffix: filteredCronJobs.length === 1 ? '' : 's',
          })}
        </p>
      )}

      <div ref={tableContainerRef} className="card flex-1 min-h-0 flex flex-col">
        <div ref={tableBodyRef} className="overflow-x-auto flex-1 min-h-0">
          <table className="w-full text-sm min-w-[1320px] table-fixed">
            <thead ref={theadRef} className="text-slate-400">
              <tr>
                {showNamespaceColumn && <th className="text-left py-3 px-4 w-[140px]">{tr('cronjobs.table.namespace', 'Namespace')}</th>}
                <th className="text-left py-3 px-4 w-[220px] cursor-pointer" onClick={() => handleSort('name')}>
                  <span className="inline-flex items-center gap-1">{tr('cronjobs.table.name', 'Name')}{renderSortIcon('name')}</span>
                </th>
                <th className="text-left py-3 px-4 w-[170px] cursor-pointer" onClick={() => handleSort('schedule')}>
                  <span className="inline-flex items-center gap-1">{tr('cronjobs.table.schedule', 'Schedule')}{renderSortIcon('schedule')}</span>
                </th>
                <th className="text-left py-3 px-4 w-[120px] cursor-pointer" onClick={() => handleSort('suspend')}>
                  <span className="inline-flex items-center gap-1">{tr('cronjobs.table.suspend', 'Suspend')}{renderSortIcon('suspend')}</span>
                </th>
                <th className="text-left py-3 px-4 w-[100px] cursor-pointer" onClick={() => handleSort('active')}>
                  <span className="inline-flex items-center gap-1">{tr('cronjobs.table.active', 'Active')}{renderSortIcon('active')}</span>
                </th>
                <th className="text-left py-3 px-4 w-[180px] cursor-pointer" onClick={() => handleSort('lastSchedule')}>
                  <span className="inline-flex items-center gap-1">{tr('cronjobs.table.lastSchedule', 'Last Schedule')}{renderSortIcon('lastSchedule')}</span>
                </th>
                <th className="text-left py-3 px-4 w-[220px] cursor-pointer" onClick={() => handleSort('containers')}>
                  <span className="inline-flex items-center gap-1">{tr('cronjobs.table.containers', 'Containers')}{renderSortIcon('containers')}</span>
                </th>
                <th className="text-left py-3 px-4 w-[240px] cursor-pointer" onClick={() => handleSort('images')}>
                  <span className="inline-flex items-center gap-1">{tr('cronjobs.table.images', 'Images')}{renderSortIcon('images')}</span>
                </th>
                <th className="text-left py-3 px-4 w-[90px] cursor-pointer" onClick={() => handleSort('age')}>
                  <span className="inline-flex items-center gap-1">{tr('cronjobs.table.age', 'Age')}{renderSortIcon('age')}</span>
                </th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-700">
              {pagedCronJobs.map((cronjob, idx) => (
                <tr
                      ref={idx === 0 ? firstRowRef : undefined}
                  key={`${cronjob.namespace}/${cronjob.name}`}
                  className="text-slate-200 hover:bg-slate-800/60 cursor-pointer"
                  onClick={() => openDetail({
                    kind: 'CronJob',
                    name: cronjob.name,
                    namespace: cronjob.namespace,
                    rawJson: cronJobToWorkloadRawJson(cronjob),
                  })}
                >
                  {showNamespaceColumn && <td className="py-3 px-4 text-xs font-mono">{cronjob.namespace}</td>}
                  <td className="py-3 px-4 font-medium text-white"><span className="block truncate">{cronjob.name}</span></td>
                  <td className="py-3 px-4 text-xs font-mono"><span className="block truncate">{cronjob.schedule || '-'}</span></td>
                  <td className="py-3 px-4">
                    <span className={`badge ${cronjob.suspend ? 'badge-warning' : 'badge-success'}`}>
                      {cronjob.suspend ? tr('common.yes', 'Yes') : tr('common.no', 'No')}
                    </span>
                  </td>
                  <td className="py-3 px-4 text-xs font-mono">{cronjob.active || 0}</td>
                  <td className="py-3 px-4 text-xs font-mono"><span className="block truncate">{formatTimestamp(cronjob.last_schedule_time)}</span></td>
                  <td className="py-3 px-4 text-xs font-mono"><span className="block truncate">{(cronjob.containers || []).join(', ') || '-'}</span></td>
                  <td className="py-3 px-4 text-xs font-mono"><span className="block truncate">{(cronjob.images || []).join(', ') || '-'}</span></td>
                  <td className="py-3 px-4 text-xs font-mono">{formatAge(cronjob.created_at)}</td>
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

              {sortedCronJobs.length === 0 && !isLoading && (
                <tr>
                  <td colSpan={showNamespaceColumn ? 9 : 8} className="py-6 px-4 text-center text-slate-400">
                    {tr('cronjobs.noResults', 'No cronjobs found.')}
                  </td>
                </tr>
              )}
            </tbody>
              <AdaptiveTableFillerRows count={rowsPerPage - pagedCronJobs.length} columnCount={8 + (showNamespaceColumn ? 1 : 0)} />
          </table>
        </div>

        {sortedCronJobs.length > 0 && (
          <div className="flex items-center justify-between px-4 py-3 border-t border-slate-700 shrink-0">
            <div className="text-xs text-slate-400">
              {tr('common.paginationRange', 'Showing {{start}}-{{end}} of {{total}}', {
                start: (currentPage - 1) * rowsPerPage + 1,
                end: Math.min(currentPage * rowsPerPage, sortedCronJobs.length),
                total: sortedCronJobs.length,
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
          title={tr('cronjobs.createTitle', 'Create CronJob from YAML')}
          initialYaml={createCronJobYamlTemplate}
          namespace={selectedNamespace !== 'all' ? selectedNamespace : undefined}
          onClose={() => setCreateDialogOpen(false)}
          onCreated={() => {
            queryClient.invalidateQueries({ queryKey: ['workloads', 'cronjobs'] })
          }}
        />
      )}
    </div>
  )
}
