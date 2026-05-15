import { useEffect, useMemo, useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { useTranslation } from 'react-i18next'
import { api, type CronJobInfo } from '@/services/api'
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
  type SortKey,
} from './cronjobs/cronJobHelpers'
import { applyCronJobWatchEvent } from './cronjobs/cronJobWatchNormalize'
import { CronJobFilters } from './cronjobs/CronJobFilters'
import { CronJobTable } from './cronjobs/CronJobTable'

export default function CronJobs() {
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

      <CronJobFilters
        searchQuery={searchQuery}
        setSearchQuery={setSearchQuery}
        selectedNamespace={selectedNamespace}
        setSelectedNamespace={setSelectedNamespace}
        namespaces={namespaces}
        searchPlaceholder={tr('cronjobs.searchPlaceholder', 'Search cronjobs by name...')}
        allNamespacesLabel={tr('cronjobs.allNamespaces', 'All namespaces')}
      />

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

      <CronJobTable
        pagedCronJobs={pagedCronJobs}
        sortedCronJobsLength={sortedCronJobs.length}
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
