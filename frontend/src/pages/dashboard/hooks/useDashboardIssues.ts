import { useMemo } from 'react'
import type { TFunction } from 'i18next'
import type { IssueItem, IssueKind, IssueSeverity } from '../types'
import { parseReady, formatAge } from '../utils'

interface Params {
  allPods: any
  nodes: any
  allPVCs: any
  allDeployments: any
  topResources: any
  includeRestartHistory: boolean
  issuesSearchQuery: string
  isIssuesModalOpen: boolean
  isLoadingPods: boolean
  isLoadingPVCs: boolean
  isLoadingAllNamespaces: boolean
  isLoadingDeployments: boolean
  tr: (key: string, fallback: string) => string
}

interface Result {
  sortedIssues: IssueItem[]
  issuesByKind: Record<IssueKind, IssueItem[]>
  issuesSummary: { total: number; critical: number; warning: number; info: number }
  isIssuesLoading: boolean
}

// Dashboard.tsx 의 issues derived computation 270줄 분리.
// Pod / Node / PVC / Deployment / Metrics 5 source 에서 IssueItem 추출 →
// filter(검색) + sort(severity → kind → id) → group + summary.
// includeRestartHistory 토글에 따라 Pod 의 과거 재시작 표시 여부 변경.
export function useDashboardIssues({
  allPods,
  nodes,
  allPVCs,
  allDeployments,
  topResources,
  includeRestartHistory,
  issuesSearchQuery,
  isIssuesModalOpen,
  isLoadingPods,
  isLoadingPVCs,
  isLoadingAllNamespaces,
  isLoadingDeployments,
  tr,
}: Params): Result {
  return useMemo(() => {
    const allPodsArray = Array.isArray(allPods) ? allPods : []
    const allNodesArray = Array.isArray(nodes) ? nodes : []
    const allPVCsArray = Array.isArray(allPVCs) ? allPVCs : []
    const allDeploymentsArray = Array.isArray(allDeployments) ? allDeployments : []

    const issuesFromPods: IssueItem[] = allPodsArray.flatMap((pod: any) => {
      const phase = String(pod?.phase ?? pod?.status ?? '')
      const ready = parseReady(pod?.ready)
      const isRunningNotReady = phase === 'Running' && ready != null && ready.ready < ready.total
      const restartCount = Number(pod?.restart_count ?? 0)

      const reasons: string[] = []
      let severity: IssueSeverity | null = null

      const containers = Array.isArray(pod?.containers) ? pod.containers : []
      const criticalWaitingReasons = new Set([
        'CrashLoopBackOff', 'ImagePullBackOff', 'ErrImagePull',
        'CreateContainerConfigError', 'CreateContainerError', 'RunContainerError',
      ])

      const waitingReasons: string[] = []
      const terminatedReasons: string[] = []
      let hasCriticalWaitingReason = false
      let hasCriticalTerminatedState = false
      let latestTerminationMs: number | null = null
      let latestTerminationReason: string | null = null

      for (const container of containers) {
        const waitingReason = container?.state?.waiting?.reason
        if (waitingReason) {
          const wr = String(waitingReason)
          waitingReasons.push(wr)
          if (criticalWaitingReasons.has(wr)) hasCriticalWaitingReason = true
        }
        const terminatedReason = container?.state?.terminated?.reason
        if (terminatedReason) {
          terminatedReasons.push(String(terminatedReason))
          hasCriticalTerminatedState = true
        }
        const lastTerminated = container?.last_state?.terminated
        const finishedAt = lastTerminated?.finished_at
        const ms = typeof finishedAt === 'string' ? Date.parse(finishedAt) : NaN
        if (Number.isFinite(ms)) {
          if (latestTerminationMs == null || ms > latestTerminationMs) {
            latestTerminationMs = ms
            latestTerminationReason = lastTerminated?.reason ? String(lastTerminated.reason) : null
          }
        }
      }

      const uniqueReasons = (items: string[]) => Array.from(new Set(items)).slice(0, 3)
      const waitingReasonsUnique = uniqueReasons(waitingReasons)
      const terminatedReasonsUnique = uniqueReasons(terminatedReasons)

      if (waitingReasonsUnique.length > 0) {
        reasons.push(`Reason: ${waitingReasonsUnique.join(', ')}${waitingReasons.length > 3 ? '…' : ''}`)
        severity = hasCriticalWaitingReason ? 'critical' : 'warning'
      }
      if (terminatedReasonsUnique.length > 0) {
        reasons.push(`Reason: ${terminatedReasonsUnique.join(', ')}${terminatedReasons.length > 3 ? '…' : ''}`)
        severity = 'critical'
      }

      if (['Pending', 'Failed', 'Unknown'].includes(phase)) {
        severity = 'critical'
        reasons.push(`Phase: ${phase}`)
      } else if (isRunningNotReady) {
        if (severity == null) severity = 'warning'
        reasons.push(`Ready: ${pod.ready}`)
      }

      const nowMs = Date.now()
      const restartAgeMs = latestTerminationMs == null ? null : nowMs - latestTerminationMs
      const hasAnyCurrentIssue =
        hasCriticalWaitingReason || hasCriticalTerminatedState ||
        ['Pending', 'Failed', 'Unknown'].includes(phase) || isRunningNotReady

      const hasRestartEvidence = Number.isFinite(restartCount) && restartCount > 0
      const hasRestartTimestamp =
        restartAgeMs != null && Number.isFinite(restartAgeMs) && restartAgeMs >= 0
      const isRecentRestart =
        hasRestartTimestamp && (restartAgeMs as number) <= 24 * 60 * 60 * 1000
      const shouldSurfaceRestartHistory =
        hasRestartEvidence && phase === 'Running' && !hasAnyCurrentIssue &&
        (includeRestartHistory || isRecentRestart)

      if (shouldSurfaceRestartHistory) {
        if (isRecentRestart) {
          if (restartAgeMs != null && restartAgeMs <= 60 * 60 * 1000) severity = 'warning'
          else severity = 'info'
        } else {
          severity = 'info'
        }
        if (latestTerminationReason) reasons.push(`Reason: ${latestTerminationReason}`)
        if (hasRestartTimestamp && restartAgeMs != null) reasons.push(`Last restart: ${formatAge(restartAgeMs)}`)
        reasons.push(`Restarts: ${restartCount}`)
      } else if (hasRestartEvidence && (hasAnyCurrentIssue || hasCriticalWaitingReason || hasCriticalTerminatedState)) {
        reasons.push(`Restarts: ${restartCount}`)
      }

      if (severity == null || reasons.length === 0) return []

      const namespace = String(pod?.namespace ?? '')
      const name = String(pod?.name ?? '')
      return [{
        id: `pod:${namespace}:${name}`,
        kind: 'Pod' as IssueKind,
        severity,
        title: name,
        subtitle: reasons.join(' · '),
        namespace,
        name,
      }]
    })

    const issuesFromNodes: IssueItem[] = allNodesArray.flatMap((node: any) => {
      const status = String(node?.status ?? '')
      if (!status || status === 'Ready') return []
      const name = String(node?.name ?? '')
      return [{
        id: `node:${name}`,
        kind: 'Node' as IssueKind,
        severity: 'critical' as IssueSeverity,
        title: name,
        subtitle: `Status: ${status}`,
        name,
      }]
    })

    const issuesFromPVCs: IssueItem[] = allPVCsArray.flatMap((pvc: any) => {
      const status = String(pvc?.status ?? '')
      if (!status || status === 'Bound') return []
      const namespace = String(pvc?.namespace ?? '')
      const name = String(pvc?.name ?? '')
      const severity: IssueSeverity = ['Lost', 'Pending'].includes(status) ? 'critical' : 'warning'
      return [{
        id: `pvc:${namespace}:${name}`,
        kind: 'PVC' as IssueKind,
        severity,
        title: name,
        subtitle: `Status: ${status}`,
        namespace,
        name,
      }]
    })

    const issuesFromDeployments: IssueItem[] = allDeploymentsArray.flatMap((deploy: any) => {
      const replicas = Number(deploy?.replicas ?? 0)
      const readyReplicas = Number(deploy?.ready_replicas ?? 0)
      const availableReplicas = Number(deploy?.available_replicas ?? 0)
      if (!Number.isFinite(replicas) || replicas <= 0) return []
      if (readyReplicas >= replicas && availableReplicas >= replicas) return []
      const namespace = String(deploy?.namespace ?? '')
      const name = String(deploy?.name ?? '')
      const severity: IssueSeverity = readyReplicas === 0 ? 'critical' : 'warning'
      return [{
        id: `deploy:${namespace}:${name}`,
        kind: 'Deployment' as IssueKind,
        severity,
        title: name,
        subtitle: `Ready: ${readyReplicas}/${replicas} · Available: ${availableReplicas}/${replicas}`,
        namespace,
        name,
      }]
    })

    const issuesFromMetrics: IssueItem[] = (() => {
      const items: IssueItem[] = []
      if (topResources?.pod_error) {
        items.push({
          id: 'metrics:pod_error',
          kind: 'Metrics',
          severity: 'info',
          title: tr('dashboard.issues.metricsPodTitle', 'Pod metrics collection failed'),
          subtitle: tr('dashboard.metricsServerHint', 'Check metrics-server status'),
        })
      }
      if (topResources?.node_error) {
        items.push({
          id: 'metrics:node_error',
          kind: 'Metrics',
          severity: 'info',
          title: tr('dashboard.issues.metricsNodeTitle', 'Node metrics collection failed'),
          subtitle: tr('dashboard.metricsServerHint', 'Check metrics-server status'),
        })
      }
      return items
    })()

    const allIssues: IssueItem[] = [
      ...issuesFromNodes,
      ...issuesFromDeployments,
      ...issuesFromPVCs,
      ...issuesFromPods,
      ...issuesFromMetrics,
    ]

    const severityRank: Record<IssueSeverity, number> = { critical: 0, warning: 1, info: 2 }
    const kindRank: Record<IssueKind, number> = { Node: 0, Deployment: 1, PVC: 2, Pod: 3, Metrics: 4 }

    const normalizedQuery = issuesSearchQuery.trim().toLowerCase()
    const filteredIssues = normalizedQuery
      ? allIssues.filter((issue) => {
          const haystack = [
            issue.kind, issue.severity, issue.namespace, issue.name, issue.title, issue.subtitle,
          ].filter(Boolean).join(' ').toLowerCase()
          return haystack.includes(normalizedQuery)
        })
      : allIssues

    const sortedIssues = [...filteredIssues].sort((a, b) => {
      const bySeverity = severityRank[a.severity] - severityRank[b.severity]
      if (bySeverity !== 0) return bySeverity
      const byKind = kindRank[a.kind] - kindRank[b.kind]
      if (byKind !== 0) return byKind
      return a.id.localeCompare(b.id)
    })

    const issuesByKind = sortedIssues.reduce<Record<IssueKind, IssueItem[]>>((acc, issue) => {
      acc[issue.kind] = acc[issue.kind] ?? []
      acc[issue.kind].push(issue)
      return acc
    }, {} as Record<IssueKind, IssueItem[]>)

    const issuesSummary = sortedIssues.reduce(
      (acc, issue) => {
        acc.total += 1
        acc[issue.severity] += 1
        return acc
      },
      { total: 0, critical: 0, warning: 0, info: 0 },
    )

    const isIssuesLoading =
      isIssuesModalOpen &&
      (isLoadingPods || isLoadingPVCs || isLoadingAllNamespaces || isLoadingDeployments)

    return { sortedIssues, issuesByKind, issuesSummary, isIssuesLoading }
  }, [
    allPods, nodes, allPVCs, allDeployments, topResources,
    includeRestartHistory, issuesSearchQuery,
    isIssuesModalOpen, isLoadingPods, isLoadingPVCs, isLoadingAllNamespaces, isLoadingDeployments,
    tr,
  ])
}

// type-only re-export to satisfy bundler if needed elsewhere
export type { TFunction }
