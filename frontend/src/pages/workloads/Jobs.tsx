import { useEffect, useMemo, useRef, useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { useTranslation } from 'react-i18next'
import { api, type JobInfo } from '@/services/api'
import { useKubeWatchList } from '@/services/useKubeWatchList'
import { useResourceDetail } from '@/components/ResourceDetailContext'
import ResourceYamlCreateDialog from '@/components/ResourceYamlCreateDialog'
import { useAdaptiveRowsPerPage } from '@/hooks/useAdaptiveRowsPerPage'
import { CheckCircle, ChevronDown, ChevronUp, Plus, RefreshCw, Search } from 'lucide-react'

type SortKey = null | 'name' | 'completions' | 'status' | 'duration' | 'containers' | 'images' | 'age'

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

function formatDuration(durationSeconds?: number | null): string {
  if (durationSeconds == null || durationSeconds < 0) return '-'
  const sec = Math.floor(durationSeconds)
  const h = Math.floor(sec / 3600)
  const m = Math.floor((sec % 3600) / 60)
  const s = sec % 60
  if (h > 0) return `${h}h ${m}m`
  if (m > 0) return `${m}m ${s}s`
  return `${s}s`
}

function computeJobStatus(job: {
  status?: string
  active?: number
  failed?: number
  succeeded?: number
}): string {
  const explicit = String(job.status || '')
  if (explicit) return explicit
  if ((job.failed || 0) > 0) return 'Failed'
  if ((job.succeeded || 0) > 0) return 'Complete'
  if ((job.active || 0) > 0) return 'Running'
  return 'Pending'
}

function getJobStatusColor(status: string): string {
  const lower = String(status || '').toLowerCase()
  if (lower.includes('complete') || lower.includes('succeeded')) return 'badge-success'
  if (lower.includes('running') || lower.includes('pending') || lower.includes('suspend')) return 'badge-warning'
  if (lower.includes('fail') || lower.includes('error')) return 'badge-error'
  return 'badge-info'
}

function normalizeWatchJobObject(obj: any): JobInfo {
  if (typeof obj?.name === 'string' && typeof obj?.namespace === 'string' && typeof obj?.status === 'string') {
    return obj as JobInfo
  }

  const metadata = obj?.metadata ?? {}
  const spec = obj?.spec ?? {}
  const status = obj?.status ?? {}
  const templateSpec = spec?.template?.spec ?? {}
  const containers = Array.isArray(templateSpec?.containers) ? templateSpec.containers : []

  let durationSeconds: number | null = null
  const startTime = status?.startTime ? String(status.startTime) : null
  const completionTime = status?.completionTime ? String(status.completionTime) : null
  if (startTime && completionTime) {
    const start = new Date(startTime).getTime()
    const end = new Date(completionTime).getTime()
    if (Number.isFinite(start) && Number.isFinite(end) && end >= start) {
      durationSeconds = Math.floor((end - start) / 1000)
    }
  }

  const normalized: JobInfo = {
    name: metadata?.name ?? obj?.name ?? '',
    namespace: metadata?.namespace ?? obj?.namespace ?? '',
    completions: spec?.completions ?? obj?.completions ?? null,
    parallelism: spec?.parallelism ?? obj?.parallelism ?? null,
    active: status?.active ?? obj?.active ?? 0,
    succeeded: status?.succeeded ?? obj?.succeeded ?? 0,
    failed: status?.failed ?? obj?.failed ?? 0,
    status: '',
    containers: containers.map((container: any) => container?.name).filter(Boolean),
    images: containers.map((container: any) => container?.image).filter(Boolean),
    start_time: startTime ?? obj?.start_time ?? null,
    completion_time: completionTime ?? obj?.completion_time ?? null,
    duration_seconds: durationSeconds ?? obj?.duration_seconds ?? null,
    created_at: metadata?.creationTimestamp ?? obj?.created_at ?? null,
  }

  normalized.status = computeJobStatus(normalized)
  return normalized
}

function applyJobWatchEvent(
  prev: JobInfo[] | undefined,
  event: { type?: string; object?: any },
): JobInfo[] {
  const items = Array.isArray(prev) ? [...prev] : []
  const obj = event?.object
  if (!obj) return items

  const normalized = normalizeWatchJobObject(obj)
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

function jobToWorkloadRawJson(job: JobInfo): Record<string, unknown> {
  const labels = { app: job.name }
  const containers = (job.images || []).map((image, idx) => ({
    name: job.containers?.[idx] || `container-${idx + 1}`,
    image,
  }))

  return {
    apiVersion: 'batch/v1',
    kind: 'Job',
    metadata: {
      name: job.name,
      namespace: job.namespace,
      labels,
      creationTimestamp: job.created_at,
    },
    spec: {
      completions: job.completions,
      parallelism: job.parallelism,
      template: {
        metadata: { labels },
        spec: {
          restartPolicy: 'Never',
          containers,
        },
      },
    },
    status: {
      active: job.active,
      succeeded: job.succeeded,
      failed: job.failed,
      startTime: job.start_time,
      completionTime: job.completion_time,
    },
  }
}

export default function Jobs() {
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

  const { data: jobs, isLoading } = useQuery({
    queryKey: ['workloads', 'jobs', selectedNamespace],
    queryFn: () => (
      selectedNamespace === 'all'
        ? api.getAllJobs(false)
        : api.getJobs(selectedNamespace, false)
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
    queryKey: ['workloads', 'jobs', selectedNamespace],
    path: selectedNamespace === 'all'
      ? '/api/v1/jobs'
      : `/api/v1/namespaces/${selectedNamespace}/jobs`,
    query: 'watch=1',
    applyEvent: (prev, event) => applyJobWatchEvent(prev as JobInfo[] | undefined, event),
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

  const normalizedJobs = useMemo(() => (Array.isArray(jobs) ? jobs.map((job) => ({ ...job, status: computeJobStatus(job) })) : []), [jobs])

  const filteredJobs = useMemo(() => {
    if (!searchQuery.trim()) return normalizedJobs
    const q = searchQuery.toLowerCase()
    return normalizedJobs.filter((job) => {
      const containers = (job.containers || []).join(',')
      const images = (job.images || []).join(',')
      return job.name.toLowerCase().includes(q)
        || job.namespace.toLowerCase().includes(q)
        || job.status.toLowerCase().includes(q)
        || containers.toLowerCase().includes(q)
        || images.toLowerCase().includes(q)
    })
  }, [normalizedJobs, searchQuery])

  const summary = useMemo(() => {
    const total = filteredJobs.length
    let completed = 0
    let running = 0
    let failed = 0
    for (const job of filteredJobs) {
      const status = job.status.toLowerCase()
      if (status.includes('complete') || status.includes('succeed')) completed += 1
      else if (status.includes('fail')) failed += 1
      else if (status.includes('run') || status.includes('pending') || status.includes('suspend')) running += 1
    }
    return { total, completed, running, failed }
  }, [filteredJobs])

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

  const sortedJobs = useMemo(() => {
    if (!sortKey) return filteredJobs
    const list = [...filteredJobs]

    const getValue = (job: JobInfo): string | number => {
      switch (sortKey) {
        case 'name':
          return job.name
        case 'completions':
          return Number(job.succeeded || 0)
        case 'status':
          return job.status || ''
        case 'duration':
          return Number(job.duration_seconds || -1)
        case 'containers':
          return (job.containers || []).join(',')
        case 'images':
          return (job.images || []).join(',')
        case 'age':
          return parseAgeSeconds(job.created_at)
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
  }, [filteredJobs, sortDir, sortKey])

  const rowsPerPage = useAdaptiveRowsPerPage(tableContainerRef, {
    recalculationKey: sortedJobs.length,
  })
  const totalPages = Math.max(1, Math.ceil(sortedJobs.length / rowsPerPage))

  useEffect(() => {
    setCurrentPage(1)
  }, [searchQuery, selectedNamespace])

  useEffect(() => {
    if (currentPage > totalPages) {
      setCurrentPage(totalPages)
    }
  }, [currentPage, totalPages])

  const pagedJobs = useMemo(() => {
    const start = (currentPage - 1) * rowsPerPage
    return sortedJobs.slice(start, start + rowsPerPage)
  }, [sortedJobs, currentPage, rowsPerPage])

  const handleRefresh = async () => {
    if (isRefreshing) return
    setIsRefreshing(true)
    try {
      const data = selectedNamespace === 'all'
        ? await api.getAllJobs(true)
        : await api.getJobs(selectedNamespace, true)
      queryClient.removeQueries({ queryKey: ['workloads', 'jobs', selectedNamespace] })
      queryClient.setQueryData(['workloads', 'jobs', selectedNamespace], data)
    } catch (error) {
      console.error('Jobs refresh failed:', error)
    }
    setTimeout(() => setIsRefreshing(false), 500)
  }

  const createJobYamlTemplate = useMemo(() => {
    const ns = selectedNamespace !== 'all' ? selectedNamespace : 'default'
    return `apiVersion: batch/v1
kind: Job
metadata:
  name: sample-job
  namespace: ${ns}
spec:
  completions: 1
  parallelism: 1
  backoffLimit: 1
  template:
    spec:
      restartPolicy: Never
      containers:
        - name: sample
          image: busybox:1.36
          command: ["sh", "-c", "echo hello from job && sleep 3"]
`
  }, [selectedNamespace])

  const showNamespaceColumn = selectedNamespace === 'all'

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-3xl font-bold text-white">{tr('jobs.title', 'Jobs')}</h1>
          <p className="mt-2 text-slate-400">{tr('jobs.subtitle', 'Inspect and manage Jobs across namespaces.')}</p>
        </div>
        <div className="flex items-center gap-2">
          {canCreate && (
            <button
              type="button"
              onClick={() => setCreateDialogOpen(true)}
              className="btn btn-primary flex items-center gap-2"
            >
              <Plus className="w-4 h-4" />
              {tr('jobs.create', 'Create Job')}
            </button>
          )}
          <button
            type="button"
            onClick={handleRefresh}
            disabled={isRefreshing}
            title={tr('jobs.refreshTitle', 'Force refresh')}
            className="btn btn-primary flex items-center gap-2 disabled:opacity-50 disabled:cursor-not-allowed"
          >
            <RefreshCw className={`w-4 h-4 ${isRefreshing ? 'animate-spin' : ''}`} />
            {tr('jobs.refresh', 'Refresh')}
          </button>
        </div>
      </div>

      <div className="grid grid-cols-1 xl:grid-cols-3 gap-3">
        <div className="xl:col-span-2">
          <div className="relative">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-5 h-5 text-slate-400" />
            <input
              type="text"
              placeholder={tr('jobs.searchPlaceholder', 'Search jobs by name...')}
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              className="w-full pl-10 pr-4 py-3 bg-slate-700 border border-slate-600 rounded-lg text-white placeholder-slate-400 focus:outline-none focus:ring-2 focus:ring-primary-500 focus:border-transparent"
            />
          </div>
        </div>

        <div className="relative" ref={namespaceDropdownRef}>
          <button
            type="button"
            onClick={() => setIsNamespaceDropdownOpen((v) => !v)}
            className="w-full py-3 px-3 bg-slate-700 border border-slate-600 rounded-lg text-white focus:outline-none focus:ring-2 focus:ring-primary-500 focus:border-transparent flex items-center justify-between gap-2"
          >
            <span className="text-sm font-medium">
              {selectedNamespace === 'all' ? tr('jobs.allNamespaces', 'All namespaces') : selectedNamespace}
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
                <span className={selectedNamespace === 'all' ? 'font-medium' : ''}>{tr('jobs.allNamespaces', 'All namespaces')}</span>
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

      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
        <div className="rounded-lg border border-slate-700 bg-slate-900/50 px-4 py-3">
          <p className="text-[11px] sm:text-xs leading-4 whitespace-nowrap text-slate-400">{tr('jobs.stats.total', 'Total')}</p>
          <p className="text-lg text-white font-semibold mt-1">{summary.total}</p>
        </div>
        <div className="rounded-lg border border-emerald-700/40 bg-emerald-900/10 px-4 py-3">
          <p className="text-[11px] sm:text-xs leading-4 whitespace-nowrap text-emerald-300">{tr('jobs.stats.completed', 'Completed')}</p>
          <p className="text-lg text-white font-semibold mt-1">{summary.completed}</p>
        </div>
        <div className="rounded-lg border border-amber-700/40 bg-amber-900/10 px-4 py-3">
          <p className="text-[11px] sm:text-xs leading-4 whitespace-nowrap text-amber-300">{tr('jobs.stats.running', 'Running')}</p>
          <p className="text-lg text-white font-semibold mt-1">{summary.running}</p>
        </div>
        <div className="rounded-lg border border-red-700/40 bg-red-900/10 px-4 py-3">
          <p className="text-[11px] sm:text-xs leading-4 whitespace-nowrap text-red-300">{tr('jobs.stats.failed', 'Failed')}</p>
          <p className="text-lg text-white font-semibold mt-1">{summary.failed}</p>
        </div>
      </div>

      {searchQuery && (
        <p className="text-sm text-slate-400">
          {tr('jobs.matchCount', '{{count}} job{{suffix}} match.', {
            count: filteredJobs.length,
            suffix: filteredJobs.length === 1 ? '' : 's',
          })}
        </p>
      )}

      <div ref={tableContainerRef} className="card">
        <div className="overflow-x-auto">
          <table className="w-full text-sm min-w-[1260px] table-fixed">
            <thead className="text-slate-400">
              <tr>
                {showNamespaceColumn && <th className="text-left py-3 px-4 w-[140px]">{tr('jobs.table.namespace', 'Namespace')}</th>}
                <th className="text-left py-3 px-4 w-[220px] cursor-pointer" onClick={() => handleSort('name')}>
                  <span className="inline-flex items-center gap-1">{tr('jobs.table.name', 'Name')}{renderSortIcon('name')}</span>
                </th>
                <th className="text-left py-3 px-4 w-[130px] cursor-pointer" onClick={() => handleSort('completions')}>
                  <span className="inline-flex items-center gap-1">{tr('jobs.table.completions', 'Completions')}{renderSortIcon('completions')}</span>
                </th>
                <th className="text-left py-3 px-4 w-[130px] cursor-pointer" onClick={() => handleSort('status')}>
                  <span className="inline-flex items-center gap-1">{tr('jobs.table.status', 'Status')}{renderSortIcon('status')}</span>
                </th>
                <th className="text-left py-3 px-4 w-[120px] cursor-pointer" onClick={() => handleSort('duration')}>
                  <span className="inline-flex items-center gap-1">{tr('jobs.table.duration', 'Duration')}{renderSortIcon('duration')}</span>
                </th>
                <th className="text-left py-3 px-4 w-[220px] cursor-pointer" onClick={() => handleSort('containers')}>
                  <span className="inline-flex items-center gap-1">{tr('jobs.table.containers', 'Containers')}{renderSortIcon('containers')}</span>
                </th>
                <th className="text-left py-3 px-4 w-[240px] cursor-pointer" onClick={() => handleSort('images')}>
                  <span className="inline-flex items-center gap-1">{tr('jobs.table.images', 'Images')}{renderSortIcon('images')}</span>
                </th>
                <th className="text-left py-3 px-4 w-[90px] cursor-pointer" onClick={() => handleSort('age')}>
                  <span className="inline-flex items-center gap-1">{tr('jobs.table.age', 'Age')}{renderSortIcon('age')}</span>
                </th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-700">
              {pagedJobs.map((job) => (
                <tr
                  key={`${job.namespace}/${job.name}`}
                  className="text-slate-200 hover:bg-slate-800/60 cursor-pointer"
                  onClick={() => openDetail({
                    kind: 'Job',
                    name: job.name,
                    namespace: job.namespace,
                    rawJson: jobToWorkloadRawJson(job),
                  })}
                >
                  {showNamespaceColumn && <td className="py-3 px-4 text-xs font-mono">{job.namespace}</td>}
                  <td className="py-3 px-4 font-medium text-white"><span className="block truncate">{job.name}</span></td>
                  <td className="py-3 px-4 text-xs font-mono">
                    {(job.succeeded ?? 0)}/{(job.completions ?? '-')}
                  </td>
                  <td className="py-3 px-4">
                    <span className={`badge ${getJobStatusColor(job.status)}`}>{job.status || '-'}</span>
                  </td>
                  <td className="py-3 px-4 text-xs font-mono">{formatDuration(job.duration_seconds)}</td>
                  <td className="py-3 px-4 text-xs font-mono"><span className="block truncate">{(job.containers || []).join(', ') || '-'}</span></td>
                  <td className="py-3 px-4 text-xs font-mono"><span className="block truncate">{(job.images || []).join(', ') || '-'}</span></td>
                  <td className="py-3 px-4 text-xs font-mono">{formatAge(job.created_at)}</td>
                </tr>
              ))}
              {sortedJobs.length === 0 && !isLoading && (
                <tr>
                  <td colSpan={showNamespaceColumn ? 8 : 7} className="py-6 px-4 text-slate-400">
                    {tr('jobs.noResults', 'No jobs found.')}
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>

        {sortedJobs.length > 0 && (
          <div className="flex items-center justify-between px-4 py-3 border-t border-slate-700">
            <div className="text-xs text-slate-400">
              {tr('common.paginationRange', 'Showing {{start}}-{{end}} of {{total}}', {
                start: (currentPage - 1) * rowsPerPage + 1,
                end: Math.min(currentPage * rowsPerPage, sortedJobs.length),
                total: sortedJobs.length,
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
          title={tr('jobs.createTitle', 'Create Job from YAML')}
          initialYaml={createJobYamlTemplate}
          namespace={selectedNamespace !== 'all' ? selectedNamespace : undefined}
          onClose={() => setCreateDialogOpen(false)}
          onCreated={() => {
            queryClient.invalidateQueries({ queryKey: ['workloads', 'jobs'] })
          }}
        />
      )}
    </div>
  )
}
