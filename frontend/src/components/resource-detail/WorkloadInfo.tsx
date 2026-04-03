import { type ReactNode, useMemo } from 'react'
import { useQuery } from '@tanstack/react-query'
import { useTranslation } from 'react-i18next'
import { api } from '@/services/api'
import { usePrometheusQueries } from '@/hooks/usePrometheusQuery'
import { PrometheusSection, MetricCard } from './PrometheusMetrics'
import {
  InfoSection,
  InfoRow,
  InfoGrid,
  KeyValueTags,
  ConditionsTable,
  EventsTable,
  SummaryBadge,
  fmtRel,
  fmtTs,
} from './DetailCommon'

interface Props {
  name: string
  namespace?: string
  kind: string
  rawJson?: Record<string, unknown>
}

function boolText(value: unknown): string {
  return value ? 'Yes' : 'No'
}

function formatContainerCommand(command: unknown, args: unknown): string {
  const cmd = Array.isArray(command) ? command : []
  const argv = Array.isArray(args) ? args : []
  const merged = [...cmd, ...argv].filter(Boolean)
  return merged.length > 0 ? merged.join(' ') : '-'
}

function toEntryPairs(value: unknown): Array<[string, string]> {
  if (!value || typeof value !== 'object') return []
  return Object.entries(value as Record<string, unknown>).map(([k, v]) => [k, String(v)])
}

function toPorts(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  return value
    .map((p: any) => `${p?.container_port ?? p?.containerPort ?? '-'} / ${p?.protocol || 'TCP'}`)
    .filter((v: string) => v.trim() !== '- / TCP')
}

function toMounts(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  return value
    .map((m: any) => `${m?.name || '-'} -> ${m?.mount_path ?? m?.mountPath ?? '-'}`)
    .filter((v: string) => v.trim() !== '- -> -')
}

function ContainerKvRow({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="grid grid-cols-[110px_1fr] gap-3 items-start py-1.5">
      <span className="text-[11px] uppercase tracking-wide text-slate-500">{label}</span>
      <div className="text-xs text-slate-100">{children}</div>
    </div>
  )
}

function formatToleration(tol: any): string {
  const key = tol?.key || '*'
  const operator = tol?.operator || 'Equal'
  const value = tol?.value || ''
  const effect = tol?.effect || ''
  const seconds = tol?.toleration_seconds ?? tol?.tolerationSeconds
  return `${key} ${operator} ${value} ${effect}${seconds != null ? ` (${seconds}s)` : ''}`.trim()
}

function formatProbe(probe: any): string {
  if (!probe || typeof probe !== 'object') return ''
  const parts: string[] = []

  if (probe.httpGet) {
    const h = probe.httpGet
    parts.push(`httpGet ${h.scheme ?? 'HTTP'}://:${h.port ?? '?'}${h.path ?? '/'}`)
  } else if (probe.tcpSocket) {
    parts.push(`tcpSocket :${probe.tcpSocket.port ?? '?'}`)
  } else if (probe.exec) {
    const cmd = Array.isArray(probe.exec.command) ? probe.exec.command.join(' ') : ''
    parts.push(`exec [${cmd}]`)
  } else if (probe.grpc) {
    parts.push(`grpc :${probe.grpc.port ?? '?'}${probe.grpc.service ? ` svc=${probe.grpc.service}` : ''}`)
  }

  const timings: string[] = []
  if (probe.initialDelaySeconds != null) timings.push(`delay=${probe.initialDelaySeconds}s`)
  if (probe.periodSeconds != null) timings.push(`period=${probe.periodSeconds}s`)
  if (probe.timeoutSeconds != null) timings.push(`timeout=${probe.timeoutSeconds}s`)
  if (probe.successThreshold != null) timings.push(`success=${probe.successThreshold}`)
  if (probe.failureThreshold != null) timings.push(`failure=${probe.failureThreshold}`)
  if (timings.length > 0) parts.push(timings.join(' '))

  return parts.join(' | ')
}

function formatCapabilities(caps: any): string {
  if (!caps || typeof caps !== 'object') return ''
  const parts: string[] = []
  if (Array.isArray(caps.add) && caps.add.length > 0) parts.push(`add: ${caps.add.join(', ')}`)
  if (Array.isArray(caps.drop) && caps.drop.length > 0) parts.push(`drop: ${caps.drop.join(', ')}`)
  return parts.join(' | ')
}

function formatLabelSelector(sel: any): string {
  if (!sel || typeof sel !== 'object') return '-'
  const parts: string[] = []
  if (sel.matchLabels && typeof sel.matchLabels === 'object') {
    Object.entries(sel.matchLabels).forEach(([k, v]) => parts.push(`${k}=${v}`))
  }
  if (Array.isArray(sel.matchExpressions)) {
    sel.matchExpressions.forEach((expr: any) => {
      const vals = Array.isArray(expr.values) ? expr.values.join(', ') : ''
      parts.push(`${expr.key || '?'} ${expr.operator || '?'} [${vals}]`)
    })
  }
  return parts.length > 0 ? parts.join(', ') : '-'
}

export default function WorkloadInfo({ name, namespace, kind, rawJson }: Props) {
  const { t } = useTranslation()
  const tr = (key: string, fallback: string) => t(key, { defaultValue: fallback })

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
  // Match pods by name prefix (e.g. "my-deploy-" matches "my-deploy-abc123-xyz")
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

  if (isLoading && needsDescribe) return <p className="text-slate-400">{tr('common.loading', 'Loading...')}</p>

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

  return (
    <div className="space-y-4">
      {!isJob && !isCronJob && (
        <div className="flex flex-wrap items-center gap-2">
          <SummaryBadge label="Desired" value={replicaView.desired as string | number} />
          <SummaryBadge label="Ready" value={replicaView.ready as string | number} color={Number(replicaView.ready) === Number(replicaView.desired) ? 'green' : 'amber'} />
          <SummaryBadge label="Updated" value={replicaView.updated as string | number} />
          <SummaryBadge label="Available" value={replicaView.available as string | number} />
          {isDaemonSet && <SummaryBadge label="Misscheduled" value={daemonSetStatus.misscheduled} color={daemonSetStatus.misscheduled > 0 ? 'amber' : 'default'} />}
          {isDaemonSet && <SummaryBadge label="Unavailable" value={daemonSetStatus.unavailable} color={daemonSetStatus.unavailable > 0 ? 'red' : 'default'} />}
        </div>
      )}

      <InfoSection title="Basic Info">
        <div className="space-y-2">
          <InfoRow label="Kind" value={kind} />
          <InfoRow label="Name" value={name} />
          {namespace && <InfoRow label="Namespace" value={namespace} />}
          <InfoRow label="Created" value={createdAt ? `${fmtTs(createdAt)} (${fmtRel(createdAt)})` : '-'} />
          {describe?.uid && <InfoRow label="UID" value={<span className="font-mono text-[11px] break-all">{describe.uid}</span>} />}
          {describe?.resource_version && <InfoRow label="Resource Version" value={<span className="font-mono text-[11px]">{describe.resource_version}</span>} />}
          {describe?.generation != null && <InfoRow label="Generation" value={String(describe.generation)} />}
          {describe?.observed_generation != null && <InfoRow label="Observed Generation" value={String(describe.observed_generation)} />}
        </div>
      </InfoSection>

      {!isJob && !isCronJob && (
        <InfoSection title="Replicas">
          <InfoGrid>
            <InfoRow label="Desired" value={String(replicaView.desired ?? '-')} />
            <InfoRow label="Current" value={String(replicaView.current ?? '-')} />
            <InfoRow label="Ready" value={String(replicaView.ready ?? '-')} />
            <InfoRow label="Up to date" value={String(replicaView.updated ?? '-')} />
            <InfoRow label="Available" value={String(replicaView.available ?? '-')} />
          </InfoGrid>
        </InfoSection>
      )}

      {/* Prometheus Workload Metrics */}
      {!isJob && !isCronJob && (
        <PrometheusSection available={promWorkloadMetrics.available} title="Real-time Resource Usage">
          <div className="grid grid-cols-2 md:grid-cols-3 gap-3 mb-3">
            {getWorkloadMetric('cpu') !== null && (
              <MetricCard label="Total CPU" value={getWorkloadMetric('cpu')!} unit="m" thresholds={{ warn: 1000, danger: 2000 }} />
            )}
            {getWorkloadMetric('memory') !== null && (
              <MetricCard label="Total Memory" value={getWorkloadMetric('memory')! / (1024 * 1024)} unit=" MiB" thresholds={{ warn: 2048, danger: 4096 }} />
            )}
            {getWorkloadMetric('restarts') !== null && (
              <MetricCard label="Total Restarts" value={getWorkloadMetric('restarts')!} unit="" thresholds={{ warn: 5, danger: 20 }} />
            )}
          </div>
          {/* Per-pod breakdown */}
          {promWorkloadMetrics.data['cpu_per_pod']?.results && promWorkloadMetrics.data['cpu_per_pod'].results.length > 0 && (
            <div className="space-y-2">
              <div className="text-[11px] text-slate-400 font-medium">Per-Pod CPU (millicores)</div>
              {promWorkloadMetrics.data['cpu_per_pod']!.results.map((r) => (
                <div key={r.metric?.pod} className="flex items-center gap-3">
                  <span className="text-xs text-slate-400 w-48 truncate">{r.metric?.pod}</span>
                  <div className="flex-1 h-2 bg-slate-800 rounded-full overflow-hidden">
                    <div
                      className={`h-full rounded-full ${r.value >= 500 ? 'bg-red-500' : r.value >= 200 ? 'bg-amber-500' : 'bg-emerald-500'}`}
                      style={{ width: `${Math.min((r.value / 1000) * 100, 100)}%` }}
                    />
                  </div>
                  <span className="text-[10px] font-mono text-slate-300 w-14 text-right">{r.value.toFixed(0)}m</span>
                </div>
              ))}
            </div>
          )}
        </PrometheusSection>
      )}

      {showStrategy && (
        <InfoSection title="Strategy">
          <div className="space-y-2">
            <InfoRow label="Type" value={strategyType} />
            {strategyRolling?.max_unavailable != null && <InfoRow label="Max Unavailable" value={String(strategyRolling.max_unavailable)} />}
            {strategyRolling?.maxUnavailable != null && <InfoRow label="Max Unavailable" value={String(strategyRolling.maxUnavailable)} />}
            {strategyRolling?.max_surge != null && <InfoRow label="Max Surge" value={String(strategyRolling.max_surge)} />}
            {strategyRolling?.maxSurge != null && <InfoRow label="Max Surge" value={String(strategyRolling.maxSurge)} />}
            {strategyRolling?.partition != null && <InfoRow label="Partition" value={String(strategyRolling.partition)} />}
          </div>
        </InfoSection>
      )}

      {showWorkloadSettings && (
        <InfoSection title="Workload Settings">
          <div className="space-y-2">
            {showDeploymentSettings && (
              <>
                {describe?.revision && <InfoRow label="Revision" value={String(describe.revision)} />}
                {describe?.paused != null && <InfoRow label="Paused" value={boolText(describe.paused)} />}
                {describe?.min_ready_seconds != null && <InfoRow label="Min Ready Seconds" value={String(describe.min_ready_seconds)} />}
                {describe?.progress_deadline_seconds != null && <InfoRow label="Progress Deadline" value={`${String(describe.progress_deadline_seconds)}s`} />}
                {describe?.revision_history_limit != null && <InfoRow label="Revision History Limit" value={String(describe.revision_history_limit)} />}
              </>
            )}
            {showStatefulSetSettings && (
              <>
                {(describe?.service_name || spec.serviceName) && <InfoRow label="Service Name" value={String(describe?.service_name || spec.serviceName)} />}
                {(describe?.pod_management_policy || spec.podManagementPolicy) && <InfoRow label="Pod Management Policy" value={String(describe?.pod_management_policy || spec.podManagementPolicy)} />}
                {describe?.min_ready_seconds != null && <InfoRow label="Min Ready Seconds" value={String(describe.min_ready_seconds)} />}
                {describe?.revision_history_limit != null && <InfoRow label="Revision History Limit" value={String(describe.revision_history_limit)} />}
                {describe?.current_revision && <InfoRow label="Current Revision" value={String(describe.current_revision)} />}
                {describe?.update_revision && <InfoRow label="Update Revision" value={String(describe.update_revision)} />}
                {describe?.collision_count != null && <InfoRow label="Collision Count" value={String(describe.collision_count)} />}
              </>
            )}
            {showDaemonSetSettings && (
              <>
                {describe?.min_ready_seconds != null && <InfoRow label="Min Ready Seconds" value={String(describe.min_ready_seconds)} />}
                {describe?.revision_history_limit != null && <InfoRow label="Revision History Limit" value={String(describe.revision_history_limit)} />}
                {describe?.collision_count != null && <InfoRow label="Collision Count" value={String(describe.collision_count)} />}
                <InfoRow label="Misscheduled Pods" value={String(daemonSetStatus.misscheduled)} />
                <InfoRow label="Unavailable Pods" value={String(daemonSetStatus.unavailable)} />
              </>
            )}
            {showReplicaSetSettings && (
              <>
                {describe?.owner && <InfoRow label="Owner" value={String(describe.owner)} />}
                {describe?.revision && <InfoRow label="Revision" value={String(describe.revision)} />}
                {describe?.min_ready_seconds != null && <InfoRow label="Min Ready Seconds" value={String(describe.min_ready_seconds)} />}
                {describe?.fully_labeled_replicas != null && <InfoRow label="Fully Labeled Replicas" value={String(describe.fully_labeled_replicas)} />}
              </>
            )}
          </div>
        </InfoSection>
      )}

      {needsDescribe && isError && (
        <p className="text-xs text-amber-300">
          {tr('common.describeUnavailable', 'Some detailed fields are unavailable right now.')}
        </p>
      )}

      {isJob && (
        <InfoSection title="Job Info">
          <div className="space-y-2">
            <InfoRow label="Completions" value={String(describe?.completions ?? spec.completions ?? '-')} />
            <InfoRow label="Parallelism" value={String(describe?.parallelism ?? spec.parallelism ?? '-')} />
            <InfoRow label="Active" value={String(describe?.active ?? status.active ?? 0)} />
            <InfoRow label="Succeeded" value={String(describe?.succeeded ?? status.succeeded ?? 0)} />
            <InfoRow label="Failed" value={String(describe?.failed ?? status.failed ?? 0)} />
            {describe?.status && <InfoRow label="Status" value={String(describe.status)} />}
            {describe?.start_time && <InfoRow label="Start Time" value={`${fmtTs(String(describe.start_time))} (${fmtRel(String(describe.start_time))})`} />}
            {describe?.completion_time && <InfoRow label="Completion Time" value={`${fmtTs(String(describe.completion_time))} (${fmtRel(String(describe.completion_time))})`} />}
            {describe?.duration_seconds != null && <InfoRow label="Duration" value={`${String(describe.duration_seconds)}s`} />}
            {describe?.backoff_limit != null && <InfoRow label="Backoff Limit" value={String(describe.backoff_limit)} />}
            {describe?.active_deadline_seconds != null && <InfoRow label="Active Deadline" value={`${String(describe.active_deadline_seconds)}s`} />}
            {describe?.ttl_seconds_after_finished != null && <InfoRow label="TTL After Finished" value={`${String(describe.ttl_seconds_after_finished)}s`} />}
            {describe?.completion_mode && <InfoRow label="Completion Mode" value={String(describe.completion_mode)} />}
            {describe?.suspend != null && <InfoRow label="Suspend" value={describe.suspend ? 'Yes' : 'No'} />}
            {describe?.manual_selector != null && <InfoRow label="Manual Selector" value={describe.manual_selector ? 'Yes' : 'No'} />}
          </div>
        </InfoSection>
      )}

      {isCronJob && (
        <InfoSection title="CronJob Info">
          <div className="space-y-2">
            <InfoRow label="Schedule" value={String(describe?.schedule ?? spec.schedule ?? '-')} />
            <InfoRow label="Suspend" value={(describe?.suspend ?? spec.suspend) ? 'Yes' : 'No'} />
            <InfoRow label="Concurrency Policy" value={String(describe?.concurrency_policy ?? spec.concurrencyPolicy ?? '-')} />
            {(describe?.starting_deadline_seconds ?? spec.startingDeadlineSeconds) != null && (
              <InfoRow
                label="Starting Deadline"
                value={`${String(describe?.starting_deadline_seconds ?? spec.startingDeadlineSeconds)}s`}
              />
            )}
            {describe?.successful_jobs_history_limit != null && (
              <InfoRow label="Successful Jobs History" value={String(describe.successful_jobs_history_limit)} />
            )}
            {describe?.failed_jobs_history_limit != null && (
              <InfoRow label="Failed Jobs History" value={String(describe.failed_jobs_history_limit)} />
            )}
            {describe?.time_zone && <InfoRow label="Time Zone" value={String(describe.time_zone)} />}
            <InfoRow label="Active Jobs" value={String(describe?.active ?? (Array.isArray(status.active) ? status.active.length : 0))} />
            {(describe?.last_schedule_time ?? status.lastScheduleTime) != null && (
              <InfoRow label="Last Schedule" value={fmtTs(String(describe?.last_schedule_time ?? status.lastScheduleTime))} />
            )}
            {(describe?.last_successful_time ?? status.lastSuccessfulTime) != null && (
              <InfoRow label="Last Successful" value={fmtTs(String(describe?.last_successful_time ?? status.lastSuccessfulTime))} />
            )}
          </div>
        </InfoSection>
      )}

      {Object.keys(selector).length > 0 && (
        <InfoSection title="Selector">
          <KeyValueTags data={selector} />
        </InfoSection>
      )}

      {selectorExpressions.length > 0 && (
        <InfoSection title="Selector Expressions">
          <div className="space-y-1 text-xs text-slate-200">
            {selectorExpressions.map((expr: any, idx: number) => (
              <div key={`${expr.key || 'expr'}-${idx}`}>
                {expr.key || '-'} {expr.operator || '-'} {Array.isArray(expr.values) && expr.values.length > 0 ? expr.values.join(', ') : ''}
              </div>
            ))}
          </div>
        </InfoSection>
      )}

      {(serviceAccountName || priorityClassName) && (
        <InfoSection title="Pod Template">
          <div className="space-y-2">
            {serviceAccountName && <InfoRow label="Service Account" value={serviceAccountName} />}
            {priorityClassName && <InfoRow label="Priority Class" value={priorityClassName} />}
          </div>
        </InfoSection>
      )}

      {Object.keys(nodeSelector).length > 0 && (
        <InfoSection title="Node Selector">
          <KeyValueTags data={nodeSelector} />
        </InfoSection>
      )}

      {containers.length > 0 && (
        <InfoSection title="Containers">
          <div className="space-y-2">
            {containers.map((container: any, idx: number) => (
              <div key={`${container.name || 'container'}-${idx}`} className="rounded border border-slate-800 bg-slate-900/40 p-3 space-y-2">
                <div className="pb-2 border-b border-slate-800">
                  <div className="text-sm font-semibold text-white break-words">{container.name || `container-${idx + 1}`}</div>
                </div>
                <div className="divide-y divide-slate-800/70">
                  <ContainerKvRow label="Image">
                    <span className="font-mono break-all">{container.image || '-'}</span>
                  </ContainerKvRow>
                  <ContainerKvRow label="Command">
                    <span className="font-mono break-words whitespace-pre-wrap">{formatContainerCommand(container.command, container.args)}</span>
                  </ContainerKvRow>
                  {toPorts(container.ports).length > 0 && (
                    <ContainerKvRow label="Ports">
                      <div className="flex flex-wrap gap-1.5">
                        {toPorts(container.ports).map((port, portIdx) => (
                          <span key={`${port}-${portIdx}`} className="inline-flex rounded border border-slate-700 bg-slate-800 px-2 py-0.5 text-[11px] text-slate-100 font-mono">
                            {port}
                          </span>
                        ))}
                      </div>
                    </ContainerKvRow>
                  )}
                  {toEntryPairs(container.requests).length > 0 && (
                    <ContainerKvRow label="Requests">
                      <div className="flex flex-wrap gap-1.5">
                        {toEntryPairs(container.requests).map(([k, v]) => (
                          <span key={`req-${k}`} className="inline-flex rounded border border-slate-700 bg-slate-800 px-2 py-0.5 text-[11px] text-slate-100 font-mono">
                            {k}={v}
                          </span>
                        ))}
                      </div>
                    </ContainerKvRow>
                  )}
                  {toEntryPairs(container.limits).length > 0 && (
                    <ContainerKvRow label="Limits">
                      <div className="flex flex-wrap gap-1.5">
                        {toEntryPairs(container.limits).map(([k, v]) => (
                          <span key={`lim-${k}`} className="inline-flex rounded border border-slate-700 bg-slate-800 px-2 py-0.5 text-[11px] text-slate-100 font-mono">
                            {k}={v}
                          </span>
                        ))}
                      </div>
                    </ContainerKvRow>
                  )}
                  {typeof container.env_count === 'number' && (
                    <ContainerKvRow label="Env">
                      <span className="font-mono">{container.env_count}</span>
                    </ContainerKvRow>
                  )}
                  {toMounts(container.volume_mounts).length > 0 && (
                    <ContainerKvRow label="Mounts">
                      <div className="flex flex-wrap gap-1.5">
                        {toMounts(container.volume_mounts).map((mount, mountIdx) => (
                          <span key={`${mount}-${mountIdx}`} className="inline-flex rounded border border-slate-700 bg-slate-800 px-2 py-0.5 text-[11px] text-slate-100 font-mono">
                            {mount}
                          </span>
                        ))}
                      </div>
                    </ContainerKvRow>
                  )}
                  {container.livenessProbe && (
                    <ContainerKvRow label="Liveness">
                      <span className="font-mono break-words whitespace-pre-wrap">{formatProbe(container.livenessProbe)}</span>
                    </ContainerKvRow>
                  )}
                  {container.readinessProbe && (
                    <ContainerKvRow label="Readiness">
                      <span className="font-mono break-words whitespace-pre-wrap">{formatProbe(container.readinessProbe)}</span>
                    </ContainerKvRow>
                  )}
                  {container.startupProbe && (
                    <ContainerKvRow label="Startup">
                      <span className="font-mono break-words whitespace-pre-wrap">{formatProbe(container.startupProbe)}</span>
                    </ContainerKvRow>
                  )}
                  {container.securityContext && (
                    <>
                      {container.securityContext.privileged != null && (
                        <ContainerKvRow label="Privileged">
                          <span>{boolText(container.securityContext.privileged)}</span>
                        </ContainerKvRow>
                      )}
                      {container.securityContext.runAsUser != null && (
                        <ContainerKvRow label="Run As User">
                          <span className="font-mono">{String(container.securityContext.runAsUser)}</span>
                        </ContainerKvRow>
                      )}
                      {container.securityContext.runAsNonRoot != null && (
                        <ContainerKvRow label="Non-Root">
                          <span>{boolText(container.securityContext.runAsNonRoot)}</span>
                        </ContainerKvRow>
                      )}
                      {container.securityContext.readOnlyRootFilesystem != null && (
                        <ContainerKvRow label="RO Root FS">
                          <span>{boolText(container.securityContext.readOnlyRootFilesystem)}</span>
                        </ContainerKvRow>
                      )}
                      {container.securityContext.allowPrivilegeEscalation != null && (
                        <ContainerKvRow label="Priv Escalation">
                          <span>{boolText(container.securityContext.allowPrivilegeEscalation)}</span>
                        </ContainerKvRow>
                      )}
                      {formatCapabilities(container.securityContext.capabilities) && (
                        <ContainerKvRow label="Capabilities">
                          <span className="font-mono break-words whitespace-pre-wrap">{formatCapabilities(container.securityContext.capabilities)}</span>
                        </ContainerKvRow>
                      )}
                    </>
                  )}
                </div>
              </div>
            ))}
          </div>
        </InfoSection>
      )}

      {isStatefulSet && volumeClaimTemplates.length > 0 && (
        <InfoSection title="Volume Claim Templates">
          <div className="space-y-2 text-xs text-slate-200">
            {volumeClaimTemplates.map((vct: any, idx: number) => (
              <div key={`${vct.name || 'vct'}-${idx}`} className="rounded border border-slate-800 p-2 space-y-1">
                <div className="font-medium text-white">{vct.name || '-'}</div>
                <div>StorageClass: {vct.storage_class_name || vct.spec?.storageClassName || '-'}</div>
                <div>
                  Access Modes: {Array.isArray(vct.access_modes || vct.spec?.accessModes)
                    ? (vct.access_modes || vct.spec?.accessModes).join(', ')
                    : '-'}
                </div>
                <div>
                  Requests: {(() => {
                    const requests = (vct.requests as Record<string, string> | undefined)
                      ?? ((vct.spec?.resources?.requests as Record<string, string> | undefined) || {})
                    const entries = Object.entries(requests)
                    return entries.length > 0 ? entries.map(([k, v]) => `${k}=${v}`).join(', ') : '-'
                  })()}
                </div>
              </div>
            ))}
          </div>
        </InfoSection>
      )}

      {tolerations.length > 0 && (
        <InfoSection title="Tolerations">
          <div className="space-y-1 text-xs text-slate-200">
            {tolerations.map((tol: any, idx: number) => (
              <div key={`${tol.key || 'tol'}-${idx}`}>{formatToleration(tol)}</div>
            ))}
          </div>
        </InfoSection>
      )}

      {podSecurityContext && Object.keys(podSecurityContext).length > 0 && (
        <InfoSection title="Pod Security Context">
          <div className="space-y-2">
            {podSecurityContext.runAsUser != null && <InfoRow label="Run As User" value={String(podSecurityContext.runAsUser)} />}
            {podSecurityContext.runAsGroup != null && <InfoRow label="Run As Group" value={String(podSecurityContext.runAsGroup)} />}
            {podSecurityContext.fsGroup != null && <InfoRow label="FS Group" value={String(podSecurityContext.fsGroup)} />}
            {podSecurityContext.runAsNonRoot != null && <InfoRow label="Run As Non-Root" value={boolText(podSecurityContext.runAsNonRoot)} />}
            {podSecurityContext.fsGroupChangePolicy != null && <InfoRow label="FS Group Change Policy" value={String(podSecurityContext.fsGroupChangePolicy)} />}
            {podSecurityContext.seccompProfile?.type != null && <InfoRow label="Seccomp Profile" value={String(podSecurityContext.seccompProfile.type)} />}
            {Array.isArray(podSecurityContext.supplementalGroups) && podSecurityContext.supplementalGroups.length > 0 && (
              <InfoRow label="Supplemental Groups" value={podSecurityContext.supplementalGroups.join(', ')} />
            )}
          </div>
        </InfoSection>
      )}

      {affinity && Object.keys(affinity).length > 0 && (
        <InfoSection title="Affinity">
          <div className="space-y-3">
            {affinity.nodeAffinity && (
              <div className="space-y-1">
                <div className="text-xs font-medium text-slate-300">Node Affinity</div>
                {affinity.nodeAffinity.requiredDuringSchedulingIgnoredDuringExecution?.nodeSelectorTerms && (
                  <div className="space-y-1">
                    <div className="text-[11px] uppercase tracking-wide text-slate-500">Required</div>
                    {(affinity.nodeAffinity.requiredDuringSchedulingIgnoredDuringExecution.nodeSelectorTerms as any[]).map((term: any, tIdx: number) => (
                      <div key={`req-term-${tIdx}`} className="text-xs text-slate-200 pl-2">
                        {Array.isArray(term.matchExpressions) && term.matchExpressions.map((expr: any, eIdx: number) => (
                          <div key={`req-expr-${eIdx}`}>
                            {expr.key || '?'} {expr.operator || '?'} [{Array.isArray(expr.values) ? expr.values.join(', ') : ''}]
                          </div>
                        ))}
                        {Array.isArray(term.matchFields) && term.matchFields.map((field: any, fIdx: number) => (
                          <div key={`req-field-${fIdx}`}>
                            {field.key || '?'} {field.operator || '?'} [{Array.isArray(field.values) ? field.values.join(', ') : ''}]
                          </div>
                        ))}
                      </div>
                    ))}
                  </div>
                )}
                {Array.isArray(affinity.nodeAffinity.preferredDuringSchedulingIgnoredDuringExecution) && affinity.nodeAffinity.preferredDuringSchedulingIgnoredDuringExecution.length > 0 && (
                  <div className="space-y-1">
                    <div className="text-[11px] uppercase tracking-wide text-slate-500">Preferred</div>
                    {(affinity.nodeAffinity.preferredDuringSchedulingIgnoredDuringExecution as any[]).map((pref: any, pIdx: number) => (
                      <div key={`pref-${pIdx}`} className="text-xs text-slate-200 pl-2">
                        <span className="text-slate-400">weight={pref.weight ?? '?'}</span>{' '}
                        {Array.isArray(pref.preference?.matchExpressions) && pref.preference.matchExpressions.map((expr: any, eIdx: number) => (
                          <span key={`pref-expr-${eIdx}`}>
                            {expr.key || '?'} {expr.operator || '?'} [{Array.isArray(expr.values) ? expr.values.join(', ') : ''}]
                          </span>
                        ))}
                      </div>
                    ))}
                  </div>
                )}
              </div>
            )}
            {affinity.podAffinity && (
              <div className="space-y-1">
                <div className="text-xs font-medium text-slate-300">Pod Affinity</div>
                {Array.isArray(affinity.podAffinity.requiredDuringSchedulingIgnoredDuringExecution) && affinity.podAffinity.requiredDuringSchedulingIgnoredDuringExecution.length > 0 && (
                  <div className="space-y-1">
                    <div className="text-[11px] uppercase tracking-wide text-slate-500">Required</div>
                    {(affinity.podAffinity.requiredDuringSchedulingIgnoredDuringExecution as any[]).map((term: any, tIdx: number) => (
                      <div key={`pa-req-${tIdx}`} className="text-xs text-slate-200 pl-2">
                        <div>topologyKey: {term.topologyKey || '-'}</div>
                        <div>selector: {formatLabelSelector(term.labelSelector)}</div>
                      </div>
                    ))}
                  </div>
                )}
                {Array.isArray(affinity.podAffinity.preferredDuringSchedulingIgnoredDuringExecution) && affinity.podAffinity.preferredDuringSchedulingIgnoredDuringExecution.length > 0 && (
                  <div className="space-y-1">
                    <div className="text-[11px] uppercase tracking-wide text-slate-500">Preferred</div>
                    {(affinity.podAffinity.preferredDuringSchedulingIgnoredDuringExecution as any[]).map((pref: any, pIdx: number) => (
                      <div key={`pa-pref-${pIdx}`} className="text-xs text-slate-200 pl-2">
                        <span className="text-slate-400">weight={pref.weight ?? '?'}</span>{' '}
                        topologyKey: {pref.podAffinityTerm?.topologyKey || '-'}, selector: {formatLabelSelector(pref.podAffinityTerm?.labelSelector)}
                      </div>
                    ))}
                  </div>
                )}
              </div>
            )}
            {affinity.podAntiAffinity && (
              <div className="space-y-1">
                <div className="text-xs font-medium text-slate-300">Pod Anti-Affinity</div>
                {Array.isArray(affinity.podAntiAffinity.requiredDuringSchedulingIgnoredDuringExecution) && affinity.podAntiAffinity.requiredDuringSchedulingIgnoredDuringExecution.length > 0 && (
                  <div className="space-y-1">
                    <div className="text-[11px] uppercase tracking-wide text-slate-500">Required</div>
                    {(affinity.podAntiAffinity.requiredDuringSchedulingIgnoredDuringExecution as any[]).map((term: any, tIdx: number) => (
                      <div key={`paa-req-${tIdx}`} className="text-xs text-slate-200 pl-2">
                        <div>topologyKey: {term.topologyKey || '-'}</div>
                        <div>selector: {formatLabelSelector(term.labelSelector)}</div>
                      </div>
                    ))}
                  </div>
                )}
                {Array.isArray(affinity.podAntiAffinity.preferredDuringSchedulingIgnoredDuringExecution) && affinity.podAntiAffinity.preferredDuringSchedulingIgnoredDuringExecution.length > 0 && (
                  <div className="space-y-1">
                    <div className="text-[11px] uppercase tracking-wide text-slate-500">Preferred</div>
                    {(affinity.podAntiAffinity.preferredDuringSchedulingIgnoredDuringExecution as any[]).map((pref: any, pIdx: number) => (
                      <div key={`paa-pref-${pIdx}`} className="text-xs text-slate-200 pl-2">
                        <span className="text-slate-400">weight={pref.weight ?? '?'}</span>{' '}
                        topologyKey: {pref.podAffinityTerm?.topologyKey || '-'}, selector: {formatLabelSelector(pref.podAffinityTerm?.labelSelector)}
                      </div>
                    ))}
                  </div>
                )}
              </div>
            )}
          </div>
        </InfoSection>
      )}

      {topologySpreadConstraints.length > 0 && (
        <InfoSection title="Topology Spread Constraints">
          <div className="overflow-x-auto">
            <table className="w-full text-xs text-left">
              <thead>
                <tr className="text-[11px] uppercase tracking-wide text-slate-500 border-b border-slate-800">
                  <th className="py-1.5 pr-3">Max Skew</th>
                  <th className="py-1.5 pr-3">Topology Key</th>
                  <th className="py-1.5 pr-3">When Unsatisfiable</th>
                  <th className="py-1.5">Label Selector</th>
                </tr>
              </thead>
              <tbody className="text-slate-200">
                {topologySpreadConstraints.map((tsc: any, idx: number) => (
                  <tr key={`tsc-${idx}`} className="border-b border-slate-800/50">
                    <td className="py-1.5 pr-3 font-mono">{tsc.maxSkew ?? '-'}</td>
                    <td className="py-1.5 pr-3 font-mono">{tsc.topologyKey || '-'}</td>
                    <td className="py-1.5 pr-3">{tsc.whenUnsatisfiable || '-'}</td>
                    <td className="py-1.5 font-mono">{formatLabelSelector(tsc.labelSelector)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </InfoSection>
      )}

      {conditions.length > 0 && (
        <InfoSection title="Conditions">
          <ConditionsTable conditions={conditions} />
        </InfoSection>
      )}

      {Object.keys(labels).length > 0 && (
        <InfoSection title="Labels">
          <KeyValueTags data={labels} />
        </InfoSection>
      )}
      {Object.keys(annotations).length > 0 && (
        <InfoSection title="Annotations">
          <KeyValueTags data={annotations} />
        </InfoSection>
      )}

      {events.length > 0 && (
        <InfoSection title="Events">
          <EventsTable events={events} />
        </InfoSection>
      )}
    </div>
  )
}
