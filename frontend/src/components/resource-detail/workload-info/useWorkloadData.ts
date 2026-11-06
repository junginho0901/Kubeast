import { useMemo, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useTranslation } from 'react-i18next'
import { useAIContext } from '@/hooks/useAIContext'
import { api } from '@/services/api'
import { usePrometheusQueries } from '@/hooks/usePrometheusQuery'
import { usePermission } from '@/hooks/usePermission'
import { replicaSetOwnerRow } from '../netstoreDetail'
import { useDrawerFollowsObject } from '../useDrawerFollowsObject'
import { useOwnedWatchedResources } from './useOwnedWatchedResources'
import { workloadDaemonSetStatus, workloadLayer, workloadReplicaView, workloadStrategy } from './workloadLayer'

// The list each kind's drawer watches its one object on.
const WATCHED_LIST: Record<string, [apiVersion: string, plural: string]> = {
  Deployment: ['apps/v1', 'deployments'],
  StatefulSet: ['apps/v1', 'statefulsets'],
  DaemonSet: ['apps/v1', 'daemonsets'],
  ReplicaSet: ['apps/v1', 'replicasets'],
  Job: ['batch/v1', 'jobs'],
  CronJob: ['batch/v1', 'cronjobs'],
}

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
  const [watchedApi, watchedPlural] = WATCHED_LIST[kind] ?? []
  useDrawerFollowsObject({
    enabled: needsDescribe && !!watchedApi,
    describeKey: ['workload-describe', kind, namespace, name],
    path: `/apis/${watchedApi}/namespaces/${namespace}/${watchedPlural}`,
    name,
  })

  const [triggerDialogOpen, setTriggerDialogOpen] = useState(false)
  const [triggerToast, setTriggerToast] = useState<{ type: 'success' | 'error'; message: string } | null>(null)
  const [rollbackDialogOpen, setRollbackDialogOpen] = useState(false)
  const [selectedRevision, setSelectedRevision] = useState<number | null>(null)

  const meta = (rawJson?.metadata ?? {}) as Record<string, unknown>
  const spec = useMemo(() => (rawJson?.spec ?? {}) as Record<string, unknown>, [rawJson?.spec])
  const status = useMemo(() => (rawJson?.status ?? {}) as Record<string, unknown>, [rawJson?.status])

  const isJob = kind === 'Job'
  const isCronJob = kind === 'CronJob'
  const isDeployment = kind === 'Deployment'
  const isStatefulSet = kind === 'StatefulSet'
  const isDaemonSet = kind === 'DaemonSet'
  const isReplicaSet = kind === 'ReplicaSet'

  const labels = useMemo(
    () => ((describe?.labels as Record<string, string> | undefined) ?? (meta.labels as Record<string, string> | undefined) ?? {}),
    [describe?.labels, meta.labels],
  )
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

  const volumeClaimTemplates = useMemo(() => {
    if (Array.isArray(describe?.volume_claim_templates)) return describe.volume_claim_templates
    return Array.isArray(spec.volumeClaimTemplates) ? spec.volumeClaimTemplates : []
  }, [describe?.volume_claim_templates, spec.volumeClaimTemplates])

  // Held here so the window's table and the floating chat read one list; asked for once the describe answer has come, as
  // when the table asked for it.
  const owned = useOwnedWatchedResources({
    kind,
    namespace,
    name,
    selector: isLoading && needsDescribe ? undefined : selector,
    volumeClaimTemplates,
  })
  const { pods: ownedPods, podsEnabled, podsLoaded, jobs: liveJobs, jobsEnabled } = owned

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

  const replicaView = useMemo(() => workloadReplicaView(kind, describe, spec, status), [kind, describe, spec, status])
  const daemonSetStatus = useMemo(() => workloadDaemonSetStatus(describe, status, replicaView), [describe, status, replicaView])
  const { type: strategyType, rolling: strategyRolling } = useMemo(() => workloadStrategy(kind, describe, spec), [kind, describe, spec])

  const conditions = Array.isArray(describe?.conditions)
    ? describe.conditions
    : (Array.isArray(status.conditions) ? status.conditions : [])

  // AI 위젯 overlay
  const controllerZone = tr('cronjobs.controllerZone', "the controller's time zone (not set; computed in this browser's zone)")
  const aiSnapshot = useMemo(() => {
    if (!name || !kind) return null
    return workloadLayer({
      kind, name, namespace, describe, spec, status, selector, ownedJobs, controllerZone, createdAt, labels, selectorExpressions, podTemplate, volumeClaimTemplates,
      owned: { pods: ownedPods, podsEnabled, podsLoaded, jobs: liveJobs, jobsEnabled },
    })
  }, [name, namespace, kind, describe, spec, status, selector, ownedJobs, controllerZone, createdAt, labels, selectorExpressions, podTemplate, volumeClaimTemplates, ownedPods, podsEnabled, podsLoaded, liveJobs, jobsEnabled])

  useAIContext(aiSnapshot, [aiSnapshot])

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
      replicaSetOwnerRow(describe) != null ||
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
    owned,
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
