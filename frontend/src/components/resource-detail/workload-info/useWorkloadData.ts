import { useMemo, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useTranslation } from 'react-i18next'
import { useAIContext } from '@/hooks/useAIContext'
import { buildResourceLink } from '@/utils/resourceLink'
import { api } from '@/services/api'
import { usePrometheusQueries } from '@/hooks/usePrometheusQuery'
import { usePermission } from '@/hooks/usePermission'

interface UseWorkloadDataParams {
  name: string
  namespace?: string
  kind: string
  rawJson?: Record<string, unknown>
}

export function useWorkloadData({ name, namespace, kind, rawJson }: UseWorkloadDataParams) {
  const { t } = useTranslation()
  const tr = (key: string, fallback: string, o?: Record<string, any>) => t(key, { defaultValue: fallback, ...o })
  const qc = useQueryClient()
  const { has } = usePermission()

  const needsDescribe = (kind === 'Deployment' || kind === 'StatefulSet' || kind === 'DaemonSet' || kind === 'ReplicaSet' || kind === 'Job' || kind === 'CronJob') && !!namespace && !!name
  const { data: describe, isLoading, isError } = useQuery({
    queryKey: ['workload-describe', kind, namespace, name],
    queryFn: () => {
      if (kind === 'Deployment') return api.describeDeployment(namespace as string, name)
      if (kind === 'StatefulSet') return api.describeStatefulSet(namespace as string, name)
      if (kind === 'DaemonSet') return api.describeDaemonSet(namespace as string, name)
      if (kind === 'ReplicaSet') return api.describeReplicaSet(namespace as string, name)
      if (kind === 'CronJob') return api.describeCronJob(namespace as string, name)
      return api.describeJob(namespace as string, name)
    },
    enabled: needsDescribe,
    retry: false,
  })

  const [triggerDialogOpen, setTriggerDialogOpen] = useState(false)
  const [triggerToast, setTriggerToast] = useState<{ type: 'success' | 'error'; message: string } | null>(null)
  const [rollbackDialogOpen, setRollbackDialogOpen] = useState(false)
  const [selectedRevision, setSelectedRevision] = useState<number | null>(null)

  const meta = (rawJson?.metadata ?? {}) as Record<string, unknown>
  const spec = (rawJson?.spec ?? {}) as Record<string, unknown>
  const status = (rawJson?.status ?? {}) as Record<string, unknown>

  const isJob = kind === 'Job'
  const isCronJob = kind === 'CronJob'
  const isDeployment = kind === 'Deployment'
  const isStatefulSet = kind === 'StatefulSet'
  const isDaemonSet = kind === 'DaemonSet'
  const isReplicaSet = kind === 'ReplicaSet'

  const labels = ((describe?.labels as Record<string, string> | undefined) ?? (meta.labels as Record<string, string> | undefined) ?? {})
  const annotations = ((describe?.annotations as Record<string, string> | undefined) ?? (meta.annotations as Record<string, string> | undefined) ?? {})

  const createdAt = (describe?.created_at as string | undefined) ?? (meta.creationTimestamp as string | undefined)

  const selector = useMemo(() => {
    if (describe?.selector && typeof describe.selector === 'object') {
      return describe.selector as Record<string, string>
    }
    const fromRaw = (spec.selector as Record<string, any> | undefined)?.matchLabels
    return (fromRaw as Record<string, string> | undefined) ?? {}
  }, [describe?.selector, spec.selector])

  // Prometheus workload-level metrics
  const podPrefix = name ? `${name}-` : ''
  const nsFilter = namespace ? `namespace="${namespace}"` : ''
  const promWorkloadMetrics = usePrometheusQueries(
    ['workload-detail', kind, namespace ?? '', name],
    [
      { name: 'cpu', promql: `sum(rate(container_cpu_usage_seconds_total{${nsFilter},pod=~"${podPrefix}.+",container!="",container!="POD"}[5m])) * 1000` },
      { name: 'memory', promql: `sum(container_memory_working_set_bytes{${nsFilter},pod=~"${podPrefix}.+",container!="",container!="POD"})` },
      { name: 'cpu_per_pod', promql: `sum by(pod)(rate(container_cpu_usage_seconds_total{${nsFilter},pod=~"${podPrefix}.+",container!="",container!="POD"}[5m])) * 1000` },
      { name: 'mem_per_pod', promql: `sum by(pod)(container_memory_working_set_bytes{${nsFilter},pod=~"${podPrefix}.+",container!="",container!="POD"})` },
      { name: 'restarts', promql: `sum(kube_pod_container_status_restarts_total{${nsFilter},pod=~"${podPrefix}.+"})` },
    ],
    { enabled: !!name && !!namespace && !isJob && !isCronJob },
  )

  const getWorkloadMetric = (metricName: string): number | null => {
    const resp = promWorkloadMetrics.data[metricName]
    if (!resp?.available || !resp.results?.length) return null
    return resp.results[0].value
  }

  // CronJob owned jobs
  const { data: ownedJobs } = useQuery({
    queryKey: ['cronjob-owned-jobs', namespace, name],
    queryFn: () => api.getCronJobOwnedJobs(namespace as string, name),
    enabled: isCronJob && !!namespace && !!name,
    staleTime: 10_000,
  })

  // AI 위젯 overlay
  const aiSnapshot = useMemo(() => {
    if (!name || !kind) return null
    const desc = describe as Record<string, unknown> | undefined
    const events = (desc?.events as Array<{ type?: string; reason?: string; message?: string; last_timestamp?: string }>) ?? []
    const conditions = (desc?.conditions as Array<{ type?: string; status?: string; reason?: string }>) ?? []
    const pods = (desc?.pods as Array<{ name?: string; phase?: string; restart_count?: number }>) ?? []
    const notRunning = pods.filter((p) => p.phase && p.phase !== 'Running' && p.phase !== 'Succeeded').length
    const replicas = (desc?.replicas as number | undefined) ?? (status.replicas as number | undefined)
    const ready = (desc?.ready_replicas as number | undefined) ?? (status.readyReplicas as number | undefined)
    const prefix = notRunning > 0 || (replicas && ready !== undefined && ready < replicas) ? '⚠️ ' : ''
    const summary = `${prefix}${kind} ${name} (${namespace}) — replicas ${ready ?? '?'}/${replicas ?? '?'}, Pod ${pods.length}개${notRunning ? ` (NotRunning ${notRunning})` : ''}`

    return {
      source: 'WorkloadInfo' as const,
      summary,
      data: {
        kind,
        name,
        namespace,
        _link: buildResourceLink(kind, namespace, name),
        replicas,
        ready_replicas: ready,
        updated_replicas: desc?.updated_replicas ?? status.updatedReplicas,
        available_replicas: desc?.available_replicas ?? status.availableReplicas,
        unavailable_replicas: desc?.unavailable_replicas ?? status.unavailableReplicas,
        strategy: desc?.strategy ?? spec.strategy,
        selector,
        conditions: conditions.slice(0, 8),
        pods: pods.slice(0, 20).map((p: any) => ({
          name: p.name,
          phase: p.phase,
          restart_count: p.restart_count,
          ready: p.ready,
          node_name: p.node_name,
          _link: namespace && p.name ? buildResourceLink('Pod', namespace, p.name) : undefined,
        })),
        recent_events: events.slice(0, 10),
        ...(isCronJob && Array.isArray(ownedJobs)
          ? {
              owned_jobs: (ownedJobs as Array<{ name: string; status?: string; start_time?: string }>)
                .slice(0, 10)
                .map((j) => ({ name: j.name, status: j.status, start_time: j.start_time })),
            }
          : {}),
      },
    }
  }, [name, namespace, kind, describe, spec, status, selector, ownedJobs, isCronJob])

  useAIContext(aiSnapshot, [aiSnapshot])

  const suspendMut = useMutation({
    mutationFn: (suspend: boolean) => api.suspendCronJob(namespace as string, name, suspend),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['workload-describe', kind, namespace, name] })
      qc.invalidateQueries({ queryKey: ['workloads', 'cronjobs'] })
    },
  })

  const triggerMut = useMutation({
    mutationFn: () => api.triggerCronJob(namespace as string, name),
    onSuccess: (data) => {
      setTriggerDialogOpen(false)
      setTriggerToast({ type: 'success', message: tr('cronjob.runNowSuccess', 'Job {{name}} created', { name: data.job_name }) })
      qc.invalidateQueries({ queryKey: ['cronjob-owned-jobs', namespace, name] })
      qc.invalidateQueries({ queryKey: ['workload-describe', kind, namespace, name] })
      setTimeout(() => setTriggerToast(null), 3000)
    },
    onError: () => {
      setTriggerDialogOpen(false)
      setTriggerToast({ type: 'error', message: 'Failed to trigger job' })
      setTimeout(() => setTriggerToast(null), 3000)
    },
  })

  // Rollback
  const isRollbackKind = kind === 'Deployment' || kind === 'DaemonSet' || kind === 'StatefulSet'
  const { data: revisions } = useQuery({
    queryKey: ['workload-revisions', kind, namespace, name],
    queryFn: () => api.getWorkloadRevisions(namespace as string, name, kind),
    enabled: rollbackDialogOpen && isRollbackKind && !!namespace && !!name,
  })

  const rollbackMut = useMutation({
    mutationFn: (revision: number) => api.rollbackWorkload(namespace as string, name, kind, revision),
    onSuccess: () => {
      setRollbackDialogOpen(false)
      setSelectedRevision(null)
      qc.invalidateQueries({ queryKey: ['workload-describe', kind, namespace, name] })
    },
  })

  const selectorExpressions = useMemo(() => {
    if (Array.isArray(describe?.selector_expressions)) return describe.selector_expressions
    const fromRaw = (spec.selector as Record<string, any> | undefined)?.matchExpressions
    return Array.isArray(fromRaw) ? fromRaw : []
  }, [describe?.selector_expressions, spec.selector])

  const podTemplate = useMemo(() => {
    const fromDescribe = describe?.pod_template
    if (fromDescribe && typeof fromDescribe === 'object') return fromDescribe as Record<string, any>
    const rawTemplateSpec = isCronJob
      ? (spec.jobTemplate as Record<string, any> | undefined)?.spec?.template?.spec
      : (spec.template as Record<string, any> | undefined)?.spec
    const fromRaw = rawTemplateSpec
    if (fromRaw && typeof fromRaw === 'object') {
      return {
        service_account_name: fromRaw.serviceAccountName,
        node_selector: fromRaw.nodeSelector || {},
        priority_class_name: fromRaw.priorityClassName,
        containers: fromRaw.containers || [],
        tolerations: fromRaw.tolerations || [],
        securityContext: fromRaw.securityContext,
        affinity: fromRaw.affinity,
        topologySpreadConstraints: fromRaw.topologySpreadConstraints,
      }
    }

    return {
      service_account_name: undefined,
      node_selector: {},
      priority_class_name: undefined,
      containers: [],
      tolerations: [],
      securityContext: undefined,
      affinity: undefined,
      topologySpreadConstraints: undefined,
    }
  }, [describe?.pod_template, isCronJob, spec.jobTemplate, spec.template])

  const containers = useMemo(() => {
    return Array.isArray(podTemplate.containers) ? podTemplate.containers : []
  }, [podTemplate.containers])

  const tolerations = Array.isArray(podTemplate.tolerations) ? podTemplate.tolerations : []
  const nodeSelector = (podTemplate.node_selector as Record<string, string> | undefined) ?? {}
  const serviceAccountName = podTemplate.service_account_name as string | undefined
  const priorityClassName = podTemplate.priority_class_name as string | undefined
  const podSecurityContext = (podTemplate.securityContext as Record<string, any> | undefined)
  const affinity = (podTemplate.affinity as Record<string, any> | undefined)
  const topologySpreadConstraints = Array.isArray(podTemplate.topologySpreadConstraints) ? podTemplate.topologySpreadConstraints : []

  const replicaView = useMemo(() => {
    if (describe?.replicas_status && typeof describe.replicas_status === 'object') {
      return {
        desired: describe.replicas_status.desired ?? 0,
        current: describe.replicas_status.current ?? 0,
        ready: describe.replicas_status.ready ?? 0,
        updated: describe.replicas_status.updated ?? 0,
        available: describe.replicas_status.available ?? 0,
      }
    }

    if (describe?.replicas && typeof describe.replicas === 'object') {
      return {
        desired: describe.replicas.desired ?? 0,
        current: describe.replicas.current ?? 0,
        ready: describe.replicas.ready ?? 0,
        updated: describe.replicas.updated ?? 0,
        available: describe.replicas.available ?? 0,
      }
    }

    return {
      desired: isDaemonSet ? (status.desiredNumberScheduled as number | undefined) ?? 0 : spec.replicas ?? '-',
      current: isDaemonSet ? (status.currentNumberScheduled as number | undefined) ?? 0 : status.replicas ?? '-',
      ready: isDaemonSet ? (status.numberReady as number | undefined) ?? 0 : status.readyReplicas ?? 0,
      updated: isDaemonSet ? (status.updatedNumberScheduled as number | undefined) ?? 0 : status.updatedReplicas ?? 0,
      available: isDaemonSet ? (status.numberAvailable as number | undefined) ?? 0 : status.availableReplicas ?? 0,
    }
  }, [
    describe?.replicas_status,
    describe?.replicas,
    isDaemonSet,
    spec.replicas,
    status.replicas,
    status.readyReplicas,
    status.updatedReplicas,
    status.availableReplicas,
    status.desiredNumberScheduled,
    status.currentNumberScheduled,
    status.numberReady,
    status.updatedNumberScheduled,
    status.numberAvailable,
  ])

  const daemonSetStatus = useMemo(() => {
    if (describe?.daemonset_status && typeof describe.daemonset_status === 'object') {
      return {
        misscheduled: describe.daemonset_status.misscheduled ?? 0,
        unavailable: describe.daemonset_status.unavailable ?? 0,
      }
    }
    return {
      misscheduled: (status.numberMisscheduled as number | undefined) ?? 0,
      unavailable: (status.numberUnavailable as number | undefined) ?? Math.max(Number(replicaView.desired) - Number(replicaView.ready), 0),
    }
  }, [describe?.daemonset_status, status.numberMisscheduled, status.numberUnavailable, replicaView.desired, replicaView.ready])

  const strategyType = useMemo(() => {
    if (isDaemonSet) {
      return (describe?.update_strategy?.type as string | undefined)
        ?? ((spec.updateStrategy as Record<string, any> | undefined)?.type as string | undefined)
        ?? '-'
    }

    if (isStatefulSet) {
      return (describe?.update_strategy?.type as string | undefined)
        ?? ((spec.updateStrategy as Record<string, any> | undefined)?.type as string | undefined)
        ?? '-'
    }

    if (isDeployment) {
      return (describe?.strategy?.type as string | undefined)
        ?? ((spec.strategy as Record<string, any> | undefined)?.type as string | undefined)
        ?? '-'
    }

    return ((spec.strategy as Record<string, any> | undefined)?.type as string | undefined)
      ?? ((spec.updateStrategy as Record<string, any> | undefined)?.type as string | undefined)
      ?? '-'
  }, [describe?.update_strategy?.type, describe?.strategy?.type, isDaemonSet, isStatefulSet, isDeployment, spec.strategy, spec.updateStrategy])

  const strategyRolling = useMemo(() => {
    if (isDaemonSet) {
      return (describe?.update_strategy?.rolling_update as Record<string, any> | undefined)
        ?? ((spec.updateStrategy as Record<string, any> | undefined)?.rollingUpdate as Record<string, any> | undefined)
    }

    if (isStatefulSet) {
      return (describe?.update_strategy?.rolling_update as Record<string, any> | undefined)
        ?? ((spec.updateStrategy as Record<string, any> | undefined)?.rollingUpdate as Record<string, any> | undefined)
    }

    if (isDeployment) {
      return (describe?.strategy?.rolling_update as Record<string, any> | undefined)
        ?? ((spec.strategy as Record<string, any> | undefined)?.rollingUpdate as Record<string, any> | undefined)
    }

    return ((spec.strategy as Record<string, any> | undefined)?.rollingUpdate as Record<string, any> | undefined)
      ?? ((spec.updateStrategy as Record<string, any> | undefined)?.rollingUpdate as Record<string, any> | undefined)
  }, [describe?.update_strategy?.rolling_update, describe?.strategy?.rolling_update, isDaemonSet, isStatefulSet, isDeployment, spec.strategy, spec.updateStrategy])

  const conditions = Array.isArray(describe?.conditions)
    ? describe.conditions
    : (Array.isArray(status.conditions) ? status.conditions : [])

  const events = Array.isArray(describe?.events) ? describe.events : []

  const volumeClaimTemplates = Array.isArray(describe?.volume_claim_templates)
    ? describe.volume_claim_templates
    : (Array.isArray(spec.volumeClaimTemplates) ? spec.volumeClaimTemplates : [])

  const showStrategy =
    strategyType !== '-' ||
    strategyRolling?.max_unavailable != null ||
    strategyRolling?.maxUnavailable != null ||
    strategyRolling?.max_surge != null ||
    strategyRolling?.maxSurge != null ||
    strategyRolling?.partition != null

  const showDeploymentSettings =
    isDeployment && (
      describe?.revision != null ||
      describe?.paused != null ||
      describe?.min_ready_seconds != null ||
      describe?.progress_deadline_seconds != null ||
      describe?.revision_history_limit != null
    )

  const showStatefulSetSettings =
    isStatefulSet && (
      describe?.service_name != null ||
      spec.serviceName != null ||
      describe?.pod_management_policy != null ||
      spec.podManagementPolicy != null ||
      describe?.min_ready_seconds != null ||
      describe?.revision_history_limit != null ||
      describe?.current_revision != null ||
      describe?.update_revision != null ||
      describe?.collision_count != null
    )

  const showDaemonSetSettings =
    isDaemonSet && (
      describe?.min_ready_seconds != null ||
      describe?.revision_history_limit != null ||
      describe?.collision_count != null ||
      daemonSetStatus.misscheduled > 0 ||
      daemonSetStatus.unavailable > 0
    )

  const showReplicaSetSettings =
    isReplicaSet && (
      describe?.owner != null ||
      describe?.revision != null ||
      describe?.min_ready_seconds != null ||
      describe?.fully_labeled_replicas != null
    )

  const showWorkloadSettings = showDeploymentSettings || showStatefulSetSettings || showDaemonSetSettings || showReplicaSetSettings

  return {
    // queries
    describe,
    isLoading,
    isError,
    needsDescribe,
    ownedJobs,
    revisions,
    // mutations
    suspendMut,
    triggerMut,
    rollbackMut,
    // permissions
    has,
    // state
    triggerDialogOpen,
    setTriggerDialogOpen,
    triggerToast,
    setTriggerToast,
    rollbackDialogOpen,
    setRollbackDialogOpen,
    selectedRevision,
    setSelectedRevision,
    // raw refs
    spec,
    status,
    // kind flags
    isJob,
    isCronJob,
    isDeployment,
    isStatefulSet,
    isDaemonSet,
    isReplicaSet,
    isRollbackKind,
    // derived metadata
    labels,
    annotations,
    createdAt,
    // selector
    selector,
    selectorExpressions,
    // pod template
    containers,
    tolerations,
    nodeSelector,
    serviceAccountName,
    priorityClassName,
    podSecurityContext,
    affinity,
    topologySpreadConstraints,
    // workload status
    replicaView,
    daemonSetStatus,
    strategyType,
    strategyRolling,
    conditions,
    events,
    volumeClaimTemplates,
    // prometheus
    promWorkloadMetrics,
    getWorkloadMetric,
    // show flags
    showStrategy,
    showDeploymentSettings,
    showStatefulSetSettings,
    showDaemonSetSettings,
    showReplicaSetSettings,
    showWorkloadSettings,
  }
}
