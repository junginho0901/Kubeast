import { useEffect, useMemo, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { api } from '@/services/api'
import { useNodeShellSettings } from '@/services/nodeShellSettings'
import { useKubeWatchList } from '@/services/useKubeWatchList'
import { useAIContext } from '@/hooks/useAIContext'
import { buildResourceLink } from '@/utils/resourceLink'

type DrainStatus = 'idle' | 'pending' | 'draining' | 'success' | 'error'

const PAGE_SIZE = 10

export function useNodeData(name: string) {
  const qc = useQueryClient()

  const [podFilter, setPodFilter] = useState('')
  const [podPage, setPodPage] = useState(1)
  const [drainDialogOpen, setDrainDialogOpen] = useState(false)
  const [drainId, setDrainId] = useState<string | null>(null)
  const [drainStatus, setDrainStatus] = useState<DrainStatus>('idle')
  const [drainError, setDrainError] = useState<string | null>(null)
  const [showNodeShell, setShowNodeShell] = useState(false)
  const [metricsAvailable] = useState(true)

  const { data: nodeDescribe, isLoading, isError } = useQuery({
    queryKey: ['cluster', 'nodes', 'describe', name],
    queryFn: () => api.describeNode(name),
    enabled: !!name,
  })

  const { data: metrics } = useQuery({
    queryKey: ['cluster', 'node-metrics'],
    queryFn: () => api.getNodeMetrics(),
    enabled: metricsAvailable,
  })

  const { data: nodePods } = useQuery({
    queryKey: ['cluster', 'nodes', 'pods', name],
    queryFn: () => api.getNodePods(name),
    enabled: !!name,
  })

  const { data: nodeEvents } = useQuery({
    queryKey: ['cluster', 'nodes', 'events', name],
    queryFn: () => api.getNodeEvents(name),
    enabled: !!name,
  })

  const { data: drainStatusData } = useQuery({
    queryKey: ['cluster', 'nodes', 'drain-status', drainId],
    queryFn: () => api.getNodeDrainStatus(name, drainId as string),
    enabled: Boolean(drainId),
    refetchInterval: drainId ? 1000 : false,
  })

  // 플로팅 AI 위젯용 overlay 스냅샷 — 노드 상세 + 이 노드의 Pod 목록 + 이벤트
  // pods 는 사용자가 화면에서 보고 있는 페이지(필터+페이지네이션)와 일치시켜
  // "지금 보이는 그 줄" 에 대한 답변이 가능하게 한다. 전체 통계는 도구 호출로 fallback.
  const aiSnapshot = useMemo(() => {
    if (!name) return null
    const podsArr = Array.isArray(nodePods) ? nodePods : []
    const eventsArr = Array.isArray(nodeEvents) ? nodeEvents : []
    const nodeMetric = Array.isArray(metrics)
      ? metrics.find((m: { name: string }) => m.name === name)
      : undefined

    const podsByNs: Record<string, number> = {}
    const podsByPhase: Record<string, number> = {}
    for (const p of podsArr as Array<{ namespace?: string; phase?: string; status?: string }>) {
      const ns = p.namespace || 'default'
      podsByNs[ns] = (podsByNs[ns] ?? 0) + 1
      const ph = p.phase || p.status || 'Unknown'
      podsByPhase[ph] = (podsByPhase[ph] ?? 0) + 1
    }
    const notRunning = podsArr.filter((p: { phase?: string; status?: string }) => {
      const ph = p.phase || p.status || ''
      return ph !== 'Running' && ph !== 'Succeeded'
    }).length

    const conditions = (nodeDescribe as { conditions?: Array<{ type?: string; status?: string; reason?: string }> } | undefined)?.conditions
    const taints = (nodeDescribe as { taints?: Array<{ key?: string; value?: string; effect?: string }> } | undefined)?.taints
    const unschedulable = (nodeDescribe as { unschedulable?: boolean } | undefined)?.unschedulable

    const prefix = unschedulable || notRunning > 0 ? '⚠️ ' : ''

    // 화면 페이지네이션과 일치하는 pod 목록만 LLM 에 전달.
    type PodLike = { name: string; namespace: string; phase?: string; status?: string; restart_count?: number }
    const filteredForView = podFilter.trim()
      ? (podsArr as PodLike[]).filter((p) =>
          p.name.toLowerCase().includes(podFilter.toLowerCase()) ||
          p.namespace.toLowerCase().includes(podFilter.toLowerCase()),
        )
      : (podsArr as PodLike[])
    const visibleStart = (podPage - 1) * PAGE_SIZE
    const visibleEnd = visibleStart + PAGE_SIZE
    const visiblePods = filteredForView.slice(visibleStart, visibleEnd)
    const visibleSummary = filteredForView.length === 0
      ? '(none)'
      : `${visibleStart + 1}-${Math.min(visibleEnd, filteredForView.length)} / ${filteredForView.length}`

    const summary = `${prefix}Node ${name} — Pod ${podsArr.length}개${notRunning ? ` (NotRunning ${notRunning})` : ''}, 화면 ${visibleSummary}, 이벤트 ${eventsArr.length}건${unschedulable ? ', cordoned' : ''}`

    return {
      source: 'NodeInfo' as const,
      summary,
      data: {
        kind: 'Node',
        name,
        _link: buildResourceLink('Node', undefined, name),
        unschedulable,
        cpu_percent: nodeMetric?.cpu_percent,
        memory_percent: nodeMetric?.memory_percent,
        conditions: Array.isArray(conditions)
          ? conditions
              .filter((c) => c.status !== 'False' || c.type === 'Ready')
              .slice(0, 6)
              .map((c) => ({ type: c.type, status: c.status, reason: c.reason }))
          : undefined,
        taints,
        pods_total: podsArr.length,
        pods_not_running: notRunning,
        pods_by_namespace: podsByNs,
        pods_by_phase: podsByPhase,
        pods_filter: podFilter || undefined,
        pods_page: { current: podPage, size: PAGE_SIZE, filtered_total: filteredForView.length },
        pods_visible: visiblePods.map((p) => ({
          name: p.name,
          namespace: p.namespace,
          phase: p.phase || p.status,
          restart_count: p.restart_count,
          _link: buildResourceLink('Pod', p.namespace, p.name),
        })),
        recent_events: (eventsArr as Array<{ type?: string; reason?: string; message?: string; last_timestamp?: string }>)
          .slice(0, 10)
          .map((e) => ({
            type: e.type,
            reason: e.reason,
            message: e.message,
            last_timestamp: e.last_timestamp,
          })),
      },
    }
  }, [name, nodePods, nodeEvents, metrics, nodeDescribe, podFilter, podPage])

  useAIContext(aiSnapshot, [aiSnapshot])

  const applyNodeEvent = (prev: any[] | undefined, event: { type?: string; object?: any }) => {
    const items = Array.isArray(prev) ? [...prev] : []
    const obj = event?.object
    if (!obj) return items
    const key = `${obj?.object?.kind || ''}:${obj?.object?.name || ''}:${obj?.reason || ''}:${obj?.message || ''}`
    const idx = items.findIndex(i => `${i?.object?.kind || ''}:${i?.object?.name || ''}:${i?.reason || ''}:${i?.message || ''}` === key)
    if (event.type === 'DELETED') { if (idx >= 0) items.splice(idx, 1); return items }
    if (idx >= 0) items[idx] = obj; else items.push(obj)
    return items
  }

  useKubeWatchList({
    enabled: !!name,
    queryKey: ['cluster', 'nodes', 'events', name],
    path: '/api/v1/events',
    query: `watch=1&fieldSelector=${encodeURIComponent(`involvedObject.kind=Node,involvedObject.name=${name}`)}`,
    applyEvent: applyNodeEvent,
  })

  const cordonMut = useMutation({
    mutationFn: (n: string) => api.cordonNode(n),
    onSuccess: async () => { await qc.invalidateQueries({ queryKey: ['cluster', 'nodes'] }); await qc.invalidateQueries({ queryKey: ['cluster', 'nodes', 'describe', name] }) },
  })
  const uncordonMut = useMutation({
    mutationFn: (n: string) => api.uncordonNode(n),
    onSuccess: async () => { await qc.invalidateQueries({ queryKey: ['cluster', 'nodes'] }); await qc.invalidateQueries({ queryKey: ['cluster', 'nodes', 'describe', name] }) },
  })
  const drainMut = useMutation({
    mutationFn: (n: string) => api.drainNode(n),
    onSuccess: (data) => { setDrainId(data.drain_id); setDrainStatus('draining'); setDrainError(null) },
    onError: (err: any) => { setDrainStatus('error'); setDrainError(err?.response?.data?.detail || err?.message || 'Failed') },
  })

  useEffect(() => {
    if (!drainStatusData) return
    const s = drainStatusData.status
    if (s === 'success') {
      setDrainStatus('success'); setDrainId(null)
      qc.invalidateQueries({ queryKey: ['cluster', 'nodes'] })
      qc.invalidateQueries({ queryKey: ['cluster', 'nodes', 'describe', name] })
      qc.invalidateQueries({ queryKey: ['cluster', 'nodes', 'pods', name] })
    } else if (s === 'error') {
      setDrainStatus('error'); setDrainError(drainStatusData.message || 'Failed'); setDrainId(null)
    } else {
      setDrainStatus(s as DrainStatus)
    }
  }, [drainStatusData, qc, name])

  useEffect(() => { setPodPage(1) }, [podFilter, name])

  const nodeShellSettings = useNodeShellSettings()
  const isLinuxNode = (nodeDescribe?.system_info?.operating_system || '').toLowerCase() === 'linux'
  const isSchedulingMut = cordonMut.isPending || uncordonMut.isPending
  const isDrainMut = drainMut.isPending || drainStatus === 'draining' || drainStatus === 'pending'

  const metricForNode = useMemo(() => {
    if (!Array.isArray(metrics)) return undefined
    return metrics.find((m: any) => m.name === name)
  }, [metrics, name])

  const cpuP = metricForNode ? parseFloat(metricForNode.cpu_percent) : 0
  const memP = metricForNode ? parseFloat(metricForNode.memory_percent) : 0

  const nodeRoles = useMemo(() => {
    const labels = nodeDescribe?.labels || {}
    return Object.keys(labels)
      .filter((key) => key.startsWith('node-role.kubernetes.io/'))
      .map((key) => key.split('/')[1])
      .filter(Boolean)
  }, [nodeDescribe?.labels])

  const capacityRows = useMemo(() => {
    const capacity = nodeDescribe?.capacity || {}
    const allocatable = nodeDescribe?.allocatable || {}
    const keys = new Set<string>([
      ...Object.keys(capacity),
      ...Object.keys(allocatable),
    ])
    return [...keys].sort().map((key) => ({
      key,
      capacity: capacity[key] ?? '-',
      allocatable: allocatable[key] ?? '-',
    }))
  }, [nodeDescribe?.capacity, nodeDescribe?.allocatable])

  const sortedEvents = useMemo(() => {
    if (!Array.isArray(nodeEvents)) return []
    return [...nodeEvents].sort((a: any, b: any) => {
      const ta = new Date(a.last_timestamp || a.first_timestamp || 0).getTime()
      const tb = new Date(b.last_timestamp || b.first_timestamp || 0).getTime()
      return tb - ta
    })
  }, [nodeEvents])

  const filteredPods = useMemo(() => {
    if (!Array.isArray(nodePods)) return []
    if (!podFilter.trim()) return nodePods
    const q = podFilter.toLowerCase()
    return nodePods.filter((p: any) => p.name.toLowerCase().includes(q) || p.namespace.toLowerCase().includes(q))
  }, [nodePods, podFilter])

  const totalPages = Math.max(1, Math.ceil(filteredPods.length / PAGE_SIZE))
  const pagedPods = filteredPods.slice((podPage - 1) * PAGE_SIZE, podPage * PAGE_SIZE)

  return {
    nodeDescribe,
    isLoading,
    isError,
    metricForNode,
    cpuP,
    memP,
    nodeRoles,
    capacityRows,
    sortedEvents,
    filteredPods,
    pagedPods,
    pageSize: PAGE_SIZE,
    totalPages,
    podFilter,
    setPodFilter,
    podPage,
    setPodPage,
    drainDialogOpen,
    setDrainDialogOpen,
    drainStatus,
    setDrainStatus,
    drainError,
    setDrainError,
    drainId,
    cordonMut,
    uncordonMut,
    drainMut,
    isSchedulingMut,
    isDrainMut,
    showNodeShell,
    setShowNodeShell,
    nodeShellSettings,
    isLinuxNode,
  }
}
