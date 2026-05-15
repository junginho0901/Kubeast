import { useEffect, useMemo, useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { useTranslation } from 'react-i18next'
import { api, type JobInfo } from '@/services/api'
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
  computeJobStatus,
  type SortKey,
} from './jobs/jobHelpers'
import { applyJobWatchEvent } from './jobs/jobWatchNormalize'
import { JobFilters } from './jobs/JobFilters'
import { JobTable } from './jobs/JobTable'

export default function Jobs() {
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

  const { data: jobs, isLoading } = useQuery({
    queryKey: ['workloads', 'jobs', selectedNamespace],
    queryFn: () => (
      selectedNamespace === 'all'
        ? api.getAllJobs(false)
        : api.getJobs(selectedNamespace, false)
    ),
  })
  const { has } = usePermission()
  const canCreate = has('resource.job.create')

  useKubeWatchList({
    enabled: true,
    queryKey: ['workloads', 'jobs', selectedNamespace],
    path: selectedNamespace === 'all'
      ? '/api/v1/jobs'
      : `/api/v1/namespaces/${selectedNamespace}/jobs`,
    query: 'watch=1',
    applyEvent: (prev, event) => applyJobWatchEvent(prev as JobInfo[] | undefined, event),
  })

  const normalizedJobs = useMemo(
    () => (Array.isArray(jobs) ? jobs.map((job) => ({ ...job, status: computeJobStatus(job) })) : []),
    [jobs],
  )

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
      // backend workloads_job.go 는 condition 기반으로 "Active" / "Complete" /
      // "Failed" 를 보냄. "Active" 가 running 카드에 잡혀야 함 (기존엔 어디에도
      // 매칭 안 되어 running 0 으로 표시되던 버그).
      if (status.includes('complete') || status.includes('succeed')) completed += 1
      else if (status.includes('fail')) failed += 1
      else if (status.includes('active') || status.includes('run') || status.includes('pending') || status.includes('suspend')) running += 1
    }
    return { total, completed, running, failed }
  }, [filteredJobs])

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

  const { containerRef: tableContainerRef, bodyRef: tableBodyRef, theadRef, firstRowRef, rowsPerPage } = useAdaptiveTable({
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

  // 플로팅 AI 위젯용 스냅샷
  const aiSnapshot = useMemo(() => {
    if (!Array.isArray(jobs) || jobs.length === 0) return null
    const nsLabel = selectedNamespace === 'all' ? '전체 네임스페이스' : selectedNamespace
    const total = jobs.length
    const failed = jobs.filter((j) => j.failed > 0).length
    const running = jobs.filter((j) => j.active > 0).length
    const succeeded = jobs.filter((j) => j.succeeded > 0 && j.active === 0 && j.failed === 0).length
    const prefix = failed > 0 ? '⚠️ ' : ''
    return {
      source: 'base' as const,
      summary: `${prefix}${nsLabel} Job ${total}개 (성공 ${succeeded}, 실행중 ${running}, 실패 ${failed})`,
      data: {
        filters: { namespace: selectedNamespace, search: searchQuery || undefined },
        stats: { total, running, succeeded, failed },
        ...summarizeList(pagedJobs as unknown as Record<string, unknown>[], {
          total: sortedJobs.length,
          currentPage,
          pageSize: rowsPerPage,
          topN: rowsPerPage,
          pickFields: ['name', 'namespace', 'completions', 'active', 'succeeded', 'failed', 'status', 'duration_seconds'],
          filterProblematic: (j) => {
            const job = j as unknown as JobInfo
            return job.failed > 0
          },
          interpret: (items) => {
            const out: string[] = []
            const arr = items as unknown as JobInfo[]
            const failures = arr.filter((j) => j.failed > 0).length
            if (failures > 0) out.push(`⚠️ ${failures}개 Job 이 실패 상태`)
            return out
          },
          linkBuilder: (j) => {
            const job = j as unknown as JobInfo
            return buildResourceLink('Job', job.namespace, job.name)
          },
        }),
      },
    }
  }, [jobs, pagedJobs, sortedJobs.length, currentPage, rowsPerPage, selectedNamespace, searchQuery])

  useAIContext(aiSnapshot, [aiSnapshot])

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
    <div className="flex flex-col h-[calc(100vh-4rem)] gap-4">
      <div className="flex items-center justify-between shrink-0">
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

      <JobFilters
        searchQuery={searchQuery}
        setSearchQuery={setSearchQuery}
        selectedNamespace={selectedNamespace}
        setSelectedNamespace={setSelectedNamespace}
        namespaces={namespaces}
        searchPlaceholder={tr('jobs.searchPlaceholder', 'Search jobs by name...')}
        allNamespacesLabel={tr('jobs.allNamespaces', 'All namespaces')}
      />

      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3 shrink-0">
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
        <p className="text-sm text-slate-400 shrink-0">
          {tr('jobs.matchCount', '{{count}} job{{suffix}} match.', {
            count: filteredJobs.length,
            suffix: filteredJobs.length === 1 ? '' : 's',
          })}
        </p>
      )}

      <JobTable
        pagedJobs={pagedJobs}
        sortedJobsLength={sortedJobs.length}
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
