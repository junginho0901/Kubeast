import { useEffect, useMemo, useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { useTranslation } from 'react-i18next'
import { api, type PodInfo } from '@/services/api'
import { useKubeWatchList } from '@/services/useKubeWatchList'
import { useResourceDetail } from '@/components/ResourceDetailContext'
import ResourceYamlCreateDialog from '@/components/ResourceYamlCreateDialog'
import { useAdaptiveTable } from '@/hooks/useAdaptiveTable'
import { useAIContext } from '@/hooks/useAIContext'
import { usePermission } from '@/hooks/usePermission'
import { summarizeList } from '@/utils/aiContext/summarizeList'
import { buildResourceLink } from '@/utils/resourceLink'
import { Plus, RefreshCw } from 'lucide-react'
import { parseAgeSeconds, parseReadyPair, pickPodDisplayStatus, type SortKey, type SummaryCard } from './pods/podHelpers'
import { applyPodWatchEvent } from './pods/podWatchNormalize'
import { PodFilters } from './pods/PodFilters'
import { PodTable } from './pods/PodTable'

export default function Pods() {
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

  const { data: pods, isLoading: isLoadingPods } = useQuery({
    queryKey: ['workloads', 'pods', selectedNamespace],
    queryFn: () => (selectedNamespace === 'all'
      ? api.getAllPods(false)
      : api.getPods(selectedNamespace, undefined, false)),
  })
  const { has } = usePermission()
  const canCreate = has('resource.pod.create')

  useKubeWatchList({
    enabled: true,
    queryKey: ['workloads', 'pods', selectedNamespace],
    path: selectedNamespace === 'all' ? '/api/v1/pods' : `/api/v1/namespaces/${selectedNamespace}/pods`,
    query: 'watch=1',
    applyEvent: (prev, event) => applyPodWatchEvent(prev as PodInfo[] | undefined, event),
    onEvent: (event) => {
      if (event?.type === 'DELETED') return
      const obj = event?.object
      const name = obj?.name || obj?.metadata?.name
      const namespace = obj?.namespace || obj?.metadata?.namespace
      if (name && namespace) {
        queryClient.invalidateQueries({ queryKey: ['pod-describe', namespace, name] })
      }
    },
  })

  const filteredPods = useMemo(() => {
    if (!Array.isArray(pods)) return [] as PodInfo[]
    if (!searchQuery.trim()) return pods
    const q = searchQuery.toLowerCase()
    return pods.filter((pod) =>
      pod.name.toLowerCase().includes(q) ||
      pod.namespace.toLowerCase().includes(q) ||
      (pod.node_name || '').toLowerCase().includes(q) ||
      (pod.pod_ip || '').toLowerCase().includes(q)
    )
  }, [pods, searchQuery])

  const podStats = useMemo(() => {
    const sourcePods = Array.isArray(pods) ? pods : []
    const total = sourcePods.length
    let ready = 0
    let notReady = 0
    let pending = 0
    let error = 0
    let restarting = 0
    let completed = 0
    const reasonMap = new Map<string, number>()

    for (const pod of sourcePods) {
      const phase = (pod.phase || pod.status || 'Unknown').toString()
      const statusText = pickPodDisplayStatus(pod)
      const [readyCount, totalCount] = parseReadyPair(pod.ready)

      if (phase === 'Pending') pending += 1
      if (pod.restart_count > 0) restarting += 1
      // Job/CronJob 의 종료된 pod (phase Succeeded). K8s 의 정상 종료 상태.
      // 이전엔 어느 카드에도 안 잡혀 total 과 카드 합이 어긋남.
      if (phase === 'Succeeded') completed += 1

      const isReadyRunning = phase === 'Running' && totalCount > 0 && readyCount === totalCount
      if (isReadyRunning) {
        ready += 1
      } else if (phase === 'Running') {
        notReady += 1
      }

      const lower = statusText.toLowerCase()
      const isError =
        phase === 'Failed' ||
        lower.includes('error') ||
        lower.includes('failed') ||
        lower.includes('backoff') ||
        lower.includes('errimagepull') ||
        lower.includes('oomkilled')
      if (isError) error += 1

      reasonMap.set(statusText, (reasonMap.get(statusText) || 0) + 1)
    }

    const topReasons = [...reasonMap.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 4)

    return { total, ready, notReady, pending, error, restarting, completed, topReasons }
  }, [pods])

  const summaryCards = useMemo<SummaryCard[]>(
    () => [
      [tr('pods.stats.total', 'Total'), podStats.total, 'border-slate-700 bg-slate-900/50', 'text-slate-400'],
      [tr('pods.stats.ready', 'Ready'), podStats.ready, 'border-emerald-700/40 bg-emerald-900/10', 'text-emerald-300'],
      [tr('pods.stats.notReady', 'Not Ready'), podStats.notReady, 'border-amber-700/40 bg-amber-900/10', 'text-amber-300'],
      [tr('pods.stats.pending', 'Pending'), podStats.pending, 'border-yellow-700/40 bg-yellow-900/10', 'text-yellow-300'],
      [tr('pods.stats.error', 'Error'), podStats.error, 'border-rose-700/40 bg-rose-900/10', 'text-rose-300'],
      [tr('pods.stats.restarting', 'Restarting'), podStats.restarting, 'border-cyan-700/40 bg-cyan-900/10', 'text-cyan-300'],
      [tr('pods.stats.completed', 'Completed'), podStats.completed, 'border-slate-600/50 bg-slate-800/30', 'text-slate-300'],
    ],
    [podStats.completed, podStats.error, podStats.notReady, podStats.pending, podStats.ready, podStats.restarting, podStats.total, tr],
  )

  const createPodYamlTemplate = useMemo(() => {
    const ns = selectedNamespace !== 'all' ? selectedNamespace : 'default'
    return `apiVersion: v1
kind: Pod
metadata:
  name: sample-pod
  namespace: ${ns}
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

  const sortedPods = useMemo(() => {
    if (!sortKey) return filteredPods
    const list = [...filteredPods]

    const getValue = (pod: PodInfo): string | number => {
      switch (sortKey) {
        case 'name':
          return pod.name
        case 'ready': {
          const [readyCount, total] = parseReadyPair(pod.ready)
          return total === 0 ? 0 : readyCount / total
        }
        case 'status':
          return pickPodDisplayStatus(pod)
        case 'restarts':
          return pod.restart_count || 0
        case 'pod_ip':
          return pod.pod_ip || ''
        case 'node_name':
          return pod.node_name || ''
        case 'age':
          return parseAgeSeconds(pod.created_at)
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
      const as = String(av)
      const bs = String(bv)
      return sortDir === 'asc' ? as.localeCompare(bs) : bs.localeCompare(as)
    })
    return list
  }, [filteredPods, sortDir, sortKey])

  const { containerRef: tableContainerRef, bodyRef: tableBodyRef, theadRef, firstRowRef, rowsPerPage } = useAdaptiveTable({
    recalculationKey: sortedPods.length,
  })
  const totalPages = Math.max(1, Math.ceil(sortedPods.length / rowsPerPage))

  useEffect(() => {
    setCurrentPage(1)
  }, [searchQuery, selectedNamespace])

  useEffect(() => {
    if (currentPage > totalPages) {
      setCurrentPage(totalPages)
    }
  }, [currentPage, totalPages])

  const pagedPods = useMemo(() => {
    const start = (currentPage - 1) * rowsPerPage
    return sortedPods.slice(start, start + rowsPerPage)
  }, [sortedPods, currentPage, rowsPerPage])

  // 플로팅 AI 위젯용 스냅샷 — Pod 목록 요약 + 문제 항목 + interpretations
  const aiSnapshot = useMemo(() => {
    if (!Array.isArray(pods) || pods.length === 0) return null
    const nsLabel = selectedNamespace === 'all' ? '전체 네임스페이스' : selectedNamespace
    const alertParts: string[] = []
    if (podStats.error > 0) alertParts.push(`오류 ${podStats.error}`)
    if (podStats.notReady > 0) alertParts.push(`Not Ready ${podStats.notReady}`)
    if (podStats.pending > 0) alertParts.push(`Pending ${podStats.pending}`)
    const prefix = podStats.error > 0 ? '⚠️ ' : ''
    const alert = alertParts.length ? `, ${alertParts.join(', ')}` : ''
    const summary = `${prefix}${nsLabel} Pod ${podStats.total}개 (Ready ${podStats.ready}${alert})`

    const problematic = (p: PodInfo) => {
      if (p.phase && p.phase !== 'Running') return true
      if ((p.restart_count ?? 0) > 5) return true
      const s = pickPodDisplayStatus(p)
      return /error|crashloop|oomkilled|errimagepull|backoff/i.test(s)
    }

    return {
      source: 'base' as const,
      summary,
      data: {
        filters: {
          namespace: selectedNamespace,
          search: searchQuery || undefined,
        },
        stats: {
          total: podStats.total,
          ready: podStats.ready,
          not_ready: podStats.notReady,
          pending: podStats.pending,
          error: podStats.error,
          restarting: podStats.restarting,
          top_reasons: podStats.topReasons.map(([reason, count]) => ({ reason, count })),
        },
        ...summarizeList(pagedPods as unknown as Record<string, unknown>[], {
          total: sortedPods.length,
          currentPage,
          pageSize: rowsPerPage,
          topN: rowsPerPage,
          pickFields: ['name', 'namespace', 'phase', 'status', 'ready', 'restart_count', 'node_name'],
          filterProblematic: (p) => problematic(p as unknown as PodInfo),
          interpret: (items) => {
            const out: string[] = []
            const podsArr = items as unknown as PodInfo[]
            const crashLoop = podsArr.filter((p) => /crashloop/i.test(pickPodDisplayStatus(p))).length
            if (crashLoop > 0) out.push(`⚠️ ${crashLoop}개 Pod 이 CrashLoopBackOff 상태`)
            const oom = podsArr.filter((p) => /oomkilled/i.test(pickPodDisplayStatus(p))).length
            if (oom > 0) out.push(`⚠️ ${oom}개 Pod 이 OOMKilled`)
            const highRestart = podsArr.filter((p) => (p.restart_count ?? 0) > 5).length
            if (highRestart > 0) out.push(`⚠️ ${highRestart}개 Pod 의 재시작 횟수 5회 초과`)
            return out
          },
          linkBuilder: (p) => {
            const pod = p as unknown as PodInfo
            return buildResourceLink('Pod', pod.namespace, pod.name)
          },
        }),
      },
    }
  }, [pods, pagedPods, sortedPods.length, currentPage, rowsPerPage, selectedNamespace, searchQuery, podStats])

  useAIContext(aiSnapshot, [aiSnapshot])

  const handleRefresh = async () => {
    if (isRefreshing) return
    setIsRefreshing(true)
    try {
      const data = selectedNamespace === 'all'
        ? await api.getAllPods(true)
        : await api.getPods(selectedNamespace, undefined, true)
      queryClient.removeQueries({ queryKey: ['workloads', 'pods', selectedNamespace] })
      queryClient.setQueryData(['workloads', 'pods', selectedNamespace], data)
    } catch (error) {
      console.error('Pods refresh failed:', error)
    }
    setTimeout(() => setIsRefreshing(false), 500)
  }

  const showNamespaceColumn = selectedNamespace === 'all'

  return (
    <div className="flex flex-col h-[calc(100vh-4rem)] gap-4">
      <div className="flex items-center justify-between shrink-0">
        <div>
          <h1 className="text-3xl font-bold text-white">{tr('pods.title', 'Pods')}</h1>
          <p className="mt-2 text-slate-400">
            {tr('pods.subtitle', 'Inspect pod health and placement across namespaces.')}
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
              {tr('pods.create', 'Create Pod')}
            </button>
          )}
          <button
            onClick={handleRefresh}
            disabled={isRefreshing}
            title={tr('pods.forceRefreshTitle', 'Force refresh')}
            className="btn btn-primary flex items-center gap-2 disabled:opacity-50 disabled:cursor-not-allowed"
          >
            <RefreshCw className={`w-4 h-4 ${isRefreshing ? 'animate-spin' : ''}`} />
            {tr('pods.refresh', 'Refresh')}
          </button>
        </div>
      </div>

      <PodFilters
        searchQuery={searchQuery}
        setSearchQuery={setSearchQuery}
        selectedNamespace={selectedNamespace}
        setSelectedNamespace={setSelectedNamespace}
        namespaces={namespaces}
        searchPlaceholder={tr('pods.searchPlaceholder', 'Search pods by name...')}
        allNamespacesLabel={tr('pods.allNamespaces', 'All namespaces')}
      />

      {searchQuery && (
        <p className="text-sm text-slate-400 shrink-0">
          {tr('pods.matchCount', '{{count}} pod{{suffix}} match.', {
            count: filteredPods.length,
            suffix: filteredPods.length === 1 ? '' : 's',
          })}
        </p>
      )}

      <div className="grid grid-cols-2 md:grid-cols-4 xl:grid-cols-7 gap-3 shrink-0">
        {summaryCards.map(([label, value, boxClass, labelColor]) => (
          <div key={label} className={`rounded-lg border px-3 py-2.5 ${boxClass}`}>
            <div className={`text-[11px] sm:text-xs leading-4 whitespace-nowrap ${labelColor}`}>{label}</div>
            <div className="mt-1 text-lg font-semibold text-white">{value}</div>
          </div>
        ))}
      </div>

      {podStats.topReasons.length > 0 && (
        <div className="rounded-lg border border-slate-700 bg-slate-900/40 p-3 shrink-0">
          <div className="text-xs text-slate-400 mb-2">Top status reasons</div>
          <div className="flex flex-wrap gap-2">
            {podStats.topReasons.map(([reason, count]) => (
              <span key={reason} className="badge badge-info font-mono">
                {reason}: {count}
              </span>
            ))}
          </div>
        </div>
      )}

      <PodTable
        pagedPods={pagedPods}
        sortedPodsLength={sortedPods.length}
        isLoadingPods={isLoadingPods}
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
          title={tr('pods.createTitle', 'Create Pod from YAML')}
          initialYaml={createPodYamlTemplate}
          namespace={selectedNamespace !== 'all' ? selectedNamespace : undefined}
          onClose={() => setCreateDialogOpen(false)}
          onCreated={() => {
            queryClient.invalidateQueries({ queryKey: ['workloads', 'pods'] })
          }}
        />
      )}
    </div>
  )
}
