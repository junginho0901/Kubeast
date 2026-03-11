import { useMemo } from 'react'
import { useQuery } from '@tanstack/react-query'
import { useTranslation } from 'react-i18next'
import { api } from '@/services/api'
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

function formatToleration(tol: any): string {
  const key = tol?.key || '*'
  const operator = tol?.operator || 'Equal'
  const value = tol?.value || ''
  const effect = tol?.effect || ''
  const seconds = tol?.toleration_seconds ?? tol?.tolerationSeconds
  return `${key} ${operator} ${value} ${effect}${seconds != null ? ` (${seconds}s)` : ''}`.trim()
}

export default function WorkloadInfo({ name, namespace, kind, rawJson }: Props) {
  const { t } = useTranslation()
  const tr = (key: string, fallback: string) => t(key, { defaultValue: fallback })

  const needsDescribe = (kind === 'Deployment' || kind === 'StatefulSet' || kind === 'DaemonSet') && !!namespace && !!name
  const { data: describe, isLoading, isError } = useQuery({
    queryKey: ['workload-describe', kind, namespace, name],
    queryFn: () => {
      if (kind === 'Deployment') return api.describeDeployment(namespace as string, name)
      if (kind === 'StatefulSet') return api.describeStatefulSet(namespace as string, name)
      return api.describeDaemonSet(namespace as string, name)
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

  const selectorExpressions = useMemo(() => {
    if (Array.isArray(describe?.selector_expressions)) return describe.selector_expressions
    const fromRaw = (spec.selector as Record<string, any> | undefined)?.matchExpressions
    return Array.isArray(fromRaw) ? fromRaw : []
  }, [describe?.selector_expressions, spec.selector])

  const podTemplate = useMemo(() => {
    const fromDescribe = describe?.pod_template
    if (fromDescribe && typeof fromDescribe === 'object') return fromDescribe as Record<string, any>

    const fromRaw = (spec.template as Record<string, any> | undefined)?.spec
    if (fromRaw && typeof fromRaw === 'object') {
      return {
        service_account_name: fromRaw.serviceAccountName,
        node_selector: fromRaw.nodeSelector || {},
        priority_class_name: fromRaw.priorityClassName,
        containers: fromRaw.containers || [],
        tolerations: fromRaw.tolerations || [],
      }
    }

    return {
      service_account_name: undefined,
      node_selector: {},
      priority_class_name: undefined,
      containers: [],
      tolerations: [],
    }
  }, [describe?.pod_template, spec.template])

  const containers = useMemo(() => {
    if (isCronJob) {
      const cronSpec = (spec.jobTemplate as Record<string, any> | undefined)?.spec
      const cronContainers = (cronSpec?.template as Record<string, any> | undefined)?.spec?.containers
      return Array.isArray(cronContainers) ? cronContainers : []
    }
    return Array.isArray(podTemplate.containers) ? podTemplate.containers : []
  }, [isCronJob, spec.jobTemplate, podTemplate.containers])

  const tolerations = Array.isArray(podTemplate.tolerations) ? podTemplate.tolerations : []
  const nodeSelector = (podTemplate.node_selector as Record<string, string> | undefined) ?? {}
  const serviceAccountName = podTemplate.service_account_name as string | undefined
  const priorityClassName = podTemplate.priority_class_name as string | undefined

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

  const showWorkloadSettings = showDeploymentSettings || showStatefulSetSettings || showDaemonSetSettings

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
            <InfoRow label="Completions" value={String(spec.completions ?? '-')} />
            <InfoRow label="Parallelism" value={String(spec.parallelism ?? '-')} />
            <InfoRow label="Active" value={String((status.active as number) ?? 0)} />
            <InfoRow label="Succeeded" value={String((status.succeeded as number) ?? 0)} />
            <InfoRow label="Failed" value={String((status.failed as number) ?? 0)} />
          </div>
        </InfoSection>
      )}

      {isCronJob && (
        <InfoSection title="CronJob Info">
          <div className="space-y-2">
            <InfoRow label="Schedule" value={String(spec.schedule ?? '-')} />
            <InfoRow label="Suspend" value={spec.suspend ? 'Yes' : 'No'} />
            <InfoRow label="Concurrency Policy" value={String(spec.concurrencyPolicy ?? '-')} />
            {spec.startingDeadlineSeconds != null && <InfoRow label="Starting Deadline" value={`${String(spec.startingDeadlineSeconds)}s`} />}
            {status.lastScheduleTime != null && <InfoRow label="Last Schedule" value={fmtTs(String(status.lastScheduleTime))} />}
            {status.lastSuccessfulTime != null && <InfoRow label="Last Successful" value={fmtTs(String(status.lastSuccessfulTime))} />}
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
          <div className="space-y-3">
            {containers.map((container: any, idx: number) => (
              <div key={`${container.name || 'container'}-${idx}`} className="rounded border border-slate-800 p-3 space-y-1">
                <div className="text-xs font-medium text-white">{container.name}</div>
                <div className="text-xs text-slate-400 space-y-0.5">
                  <div>Image: <span className="text-slate-300 font-mono break-all">{container.image || '-'}</span></div>
                  <div>Command: <span className="text-slate-300 font-mono break-all">{formatContainerCommand(container.command, container.args)}</span></div>
                  {Array.isArray(container.ports) && container.ports.length > 0 && (
                    <div>Ports: {container.ports.map((p: any) => `${p.container_port ?? p.containerPort}/${p.protocol || 'TCP'}`).join(', ')}</div>
                  )}
                  {container.requests && Object.keys(container.requests).length > 0 && (
                    <div>Requests: {Object.entries(container.requests).map(([k, v]) => `${k}=${v}`).join(', ')}</div>
                  )}
                  {container.limits && Object.keys(container.limits).length > 0 && (
                    <div>Limits: {Object.entries(container.limits).map(([k, v]) => `${k}=${v}`).join(', ')}</div>
                  )}
                  {typeof container.env_count === 'number' && <div>Env: {container.env_count}</div>}
                  {Array.isArray(container.volume_mounts) && container.volume_mounts.length > 0 && (
                    <div>Mounts: {container.volume_mounts.map((m: any) => `${m.name}→${m.mount_path ?? m.mountPath}`).join(', ')}</div>
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
