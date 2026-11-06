import { cronJobDrawerInfo, cronJobLayerFields, cronJobLayerHeadline, cronJobLayerNeedsALook } from '@/pages/workloads/cronjobs/cronJobHelpers'
import { formatDuration, jobDrawerInfo, jobDurationSeconds, jobLayerFields, jobLayerHeadline, jobLayerNeedsALook } from '@/pages/workloads/jobs/jobHelpers'
import { buildResourceLink } from '@/utils/resourceLink'
import { replicaSetOwnerRow } from '../netstoreDetail'
import { boolText, formatToleration, toPorts } from './workloadInfoFormatters'
import { workloadPodsLayer } from './workloadPodsLayer'

type Fields = Record<string, any>

const OWNED_JOBS_TOLD = 10

// The Jobs a CronJob's window lists: the live list, else the one it asked for until that has some.
export function ownedDisplayJobs(owned: { jobs?: Fields[]; jobsEnabled?: boolean }, ownedJobs: unknown): Fields[] {
  if (owned.jobsEnabled && owned.jobs && owned.jobs.length > 0) return owned.jobs
  return Array.isArray(ownedJobs) ? ownedJobs : []
}

// The Replicas section's counts: the describe answer's, else the row's.
export function workloadReplicaView(kind: string, describe: Fields | undefined, spec: Fields, status: Fields) {
  const isDaemonSet = kind === 'DaemonSet'
  if (describe?.replicas_status && typeof describe.replicas_status === 'object') {
    return {
      desired: describe.replicas_status.desired ?? 0,
      current: describe.replicas_status.current ?? 0,
      ready: describe.replicas_status.ready ?? 0,
      updated: describe.replicas_status.updated ?? '-',
      available: describe.replicas_status.available ?? 0,
    }
  }

  if (isDaemonSet && describe?.daemonset_status && typeof describe.daemonset_status === 'object') {
    return {
      desired: describe.daemonset_status.desired ?? 0,
      current: describe.daemonset_status.current ?? 0,
      ready: describe.daemonset_status.ready ?? 0,
      updated: describe.daemonset_status.updated ?? 0,
      available: describe.daemonset_status.available ?? 0,
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
    desired: isDaemonSet ? status.desiredNumberScheduled ?? 0 : spec.replicas ?? '-',
    current: isDaemonSet ? status.currentNumberScheduled ?? 0 : status.replicas ?? '-',
    ready: isDaemonSet ? status.numberReady ?? 0 : status.readyReplicas ?? 0,
    updated: isDaemonSet ? status.updatedNumberScheduled ?? 0 : status.updatedReplicas ?? 0,
    available: isDaemonSet ? status.numberAvailable ?? 0 : status.availableReplicas ?? 0,
  }
}

// A DaemonSet's two counts of its own, the describe answer's, else the row's.
export function workloadDaemonSetStatus(describe: Fields | undefined, status: Fields, view: { desired: unknown; ready: unknown }) {
  if (describe?.daemonset_status && typeof describe.daemonset_status === 'object') {
    return {
      misscheduled: (describe.daemonset_status.misscheduled ?? 0) as number,
      unavailable: (describe.daemonset_status.unavailable ?? 0) as number,
    }
  }
  return {
    misscheduled: (status.numberMisscheduled ?? 0) as number,
    unavailable: (status.numberUnavailable ?? Math.max(Number(view.desired) - Number(view.ready), 0)) as number,
  }
}

// The Strategy section's type and rolling update, the describe answer's, else the object's.
export function workloadStrategy(kind: string, describe: Fields | undefined, spec: Fields): { type: string; rolling: Fields | undefined } {
  if (kind === 'DaemonSet' || kind === 'StatefulSet') {
    return {
      type: describe?.update_strategy?.type ?? spec.updateStrategy?.type ?? '-',
      rolling: describe?.update_strategy?.rolling_update ?? spec.updateStrategy?.rollingUpdate,
    }
  }
  if (kind === 'Deployment') {
    return {
      type: describe?.strategy?.type ?? spec.strategy?.type ?? '-',
      rolling: describe?.strategy?.rolling_update ?? spec.strategy?.rollingUpdate,
    }
  }
  return {
    type: spec.strategy?.type ?? spec.updateStrategy?.type ?? '-',
    rolling: spec.strategy?.rollingUpdate ?? spec.updateStrategy?.rollingUpdate,
  }
}

// The Workload Settings section's rows of each kind, none where the window has no row: the window draws these and the
// floating chat is told them.
export function workloadSettingsInfo(kind: string, describe: Fields | undefined, spec: Fields, daemonSetStatus: { misscheduled: number; unavailable: number }) {
  const text = (value: unknown, unit = '') => (value == null ? undefined : `${String(value)}${unit}`)
  const filled = (value: unknown) => (value ? String(value) : undefined)
  const minReady = text(describe?.min_ready_seconds)
  const historyLimit = text(describe?.revision_history_limit)
  const collisions = text(describe?.collision_count)
  const rows: Record<string, Record<string, string | undefined>> = {
    Deployment: {
      revision: filled(describe?.revision),
      paused: describe?.paused == null ? undefined : boolText(describe.paused),
      min_ready_seconds: minReady,
      progress_deadline: text(describe?.progress_deadline_seconds, 's'),
      revision_history_limit: historyLimit,
    },
    StatefulSet: {
      service_name: filled(describe?.service_name || spec.serviceName),
      pod_management_policy: filled(describe?.pod_management_policy || spec.podManagementPolicy),
      min_ready_seconds: minReady,
      revision_history_limit: historyLimit,
      current_revision: filled(describe?.current_revision),
      update_revision: filled(describe?.update_revision),
      collision_count: collisions,
    },
    DaemonSet: {
      min_ready_seconds: minReady,
      revision_history_limit: historyLimit,
      collision_count: collisions,
      misscheduled_pods: String(daemonSetStatus.misscheduled),
      unavailable_pods: String(daemonSetStatus.unavailable),
    },
    ReplicaSet: {
      owner: replicaSetOwnerRow(describe as never) ?? undefined,
      revision: filled(describe?.revision),
      min_ready_seconds: minReady,
      fully_labeled_replicas: text(describe?.fully_labeled_replicas),
    },
  }
  return Object.fromEntries(Object.entries(rows[kind] ?? {}).filter(([, value]) => value !== undefined)) as Record<string, string>
}

const nonEmpty = (value: unknown) => (value && typeof value === 'object' && Object.keys(value).length > 0 ? value : undefined)
const list = (value: unknown): Fields[] => (Array.isArray(value) ? value : [])
const listed = <T>(items: T[]) => (items.length > 0 ? items : undefined)

// The Strategy section's rows.
function strategyLayer({ type, rolling }: { type: string; rolling: Fields | undefined }) {
  if (type === '-') return undefined
  return {
    type,
    max_unavailable: rolling?.max_unavailable ?? rolling?.maxUnavailable,
    max_surge: rolling?.max_surge ?? rolling?.maxSurge,
    partition: rolling?.partition,
  }
}

// What the pods are made from, as the window's sections word it. A container's command, probes and mounts stay in the
// window: a command line can hold a credential, and a layer has a budget (utils/aiContext/tokenBudget).
function templateLayer(template: Fields | undefined, selectorExpressions: unknown, volumeClaimTemplates: unknown) {
  return {
    service_account: template?.service_account_name || undefined,
    priority_class: template?.priority_class_name || undefined,
    node_selector: nonEmpty(template?.node_selector),
    pod_security_context: nonEmpty(template?.securityContext),
    selector_expressions: listed(list(selectorExpressions).map((e) => `${e.key || '-'} ${e.operator || '-'} ${list(e.values).join(', ')}`.trim())),
    tolerations: listed(list(template?.tolerations).map(formatToleration)),
    volume_claim_templates: listed(list(volumeClaimTemplates).map((v) => ({
      name: v.name,
      storage_class: v.storage_class_name || v.spec?.storageClassName,
      access_modes: v.access_modes || v.spec?.accessModes,
      requests: v.requests ?? v.spec?.resources?.requests,
    }))),
    containers: listed(list(template?.containers).map((c) => ({
      name: c.name,
      image: c.image,
      ports: listed(toPorts(c.ports)),
      requests: nonEmpty(c.requests),
      limits: nonEmpty(c.limits),
      env_count: c.env_count,
    }))),
  }
}

// The Jobs a CronJob's window lists, the newest first.
function ownedJobsLayer(jobs: Fields[]) {
  const newest = [...jobs].sort((a, b) => String(b.start_time ?? '').localeCompare(String(a.start_time ?? '')))
  return {
    owned_jobs_total: jobs.length,
    owned_jobs: newest.slice(0, OWNED_JOBS_TOLD).map((j) => ({
      name: j.name,
      status: j.status,
      start_time: j.start_time,
      duration: formatDuration(jobDurationSeconds(j)),
    })),
  }
}

interface WorkloadLayerInput {
  kind: string
  name: string
  namespace?: string
  describe?: Fields
  spec: Fields
  status: Fields
  selector: Record<string, string>
  owned: { pods: Fields[]; podsEnabled: boolean; podsLoaded: boolean; jobs?: Fields[]; jobsEnabled?: boolean }
  ownedJobs?: unknown
  // the window's words for a CronJob with no time zone of its own
  controllerZone: string
  createdAt?: string
  labels?: Record<string, string>
  selectorExpressions?: unknown
  podTemplate?: Fields
  volumeClaimTemplates?: unknown
}

// What the floating chat is told of a workload's window: what each of its sections shows, from the functions the window
// draws them with. Labels are told, annotations are not: one value can pass a layer's whole budget (last-applied), which
// would leave the layer without its data.
export function workloadLayer({
  kind, name, namespace, describe: desc, spec, status, selector, owned, ownedJobs, controllerZone, createdAt, labels, selectorExpressions, podTemplate, volumeClaimTemplates,
}: WorkloadLayerInput) {
  const isJob = kind === 'Job'
  const isCronJob = kind === 'CronJob'
  const isDaemonSet = kind === 'DaemonSet'
  const events = (desc?.events as Array<{ type?: string; reason?: string; message?: string; last_timestamp?: string }>) ?? []
  const conditions = (Array.isArray(desc?.conditions) ? desc.conditions : Array.isArray(status.conditions) ? status.conditions : []) as Array<{ type?: string; status?: string; reason?: string }>
  const pods = workloadPodsLayer(desc, owned, namespace)

  const view = isJob || isCronJob ? null : workloadReplicaView(kind, desc, spec, status)
  const daemonSet = isDaemonSet && view ? workloadDaemonSetStatus(desc, status, view) : { misscheduled: 0, unavailable: 0 }
  // a row or describe answer has said how many, so a 0 is a count and not a default
  const counted = !!view && view.desired !== '-' && (!isDaemonSet || !!desc || status.desiredNumberScheduled != null)
  const job = isJob ? jobDrawerInfo(desc, spec, status) : null
  const cronJob = isCronJob ? cronJobDrawerInfo(desc, spec, status) : null

  const short = counted && Number(view.desired) > 0 && Number(view.ready) < Number(view.desired)
  const needsALook = pods.notRunning > 0 || short || (job && jobLayerNeedsALook(job)) || (cronJob && cronJobLayerNeedsALook(cronJob))
  const podCount = pods.known ? `, Pod ${pods.total}개${pods.notRunning ? ` (NotRunning ${pods.notRunning})` : ''}` : ''
  const headline = job ? jobLayerHeadline(job) : cronJob ? cronJobLayerHeadline(cronJob) : counted ? `replicas ${view.ready}/${view.desired}` : 'replicas ?/?'
  const summary = `${needsALook ? '⚠️ ' : ''}${kind} ${name} (${namespace}) — ${headline}${podCount}`

  const count = (value: unknown) => (counted && value !== '-' ? value : undefined)
  const liveJobs = owned.jobsEnabled && owned.jobs && owned.jobs.length > 0

  return {
    source: 'WorkloadInfo' as const,
    summary,
    data: {
      kind,
      name,
      namespace,
      _link: buildResourceLink(kind, namespace, name),
      created_at: createdAt ?? desc?.created_at,
      uid: desc?.uid,
      resource_version: desc?.resource_version,
      generation: desc?.generation,
      observed_generation: desc?.observed_generation,
      ...(view
        ? {
            replicas: count(view.desired),
            ready_replicas: count(view.ready),
            current_replicas: count(view.current),
            updated_replicas: count(view.updated),
            available_replicas: count(view.available),
            unavailable_replicas: isDaemonSet ? count(daemonSet.unavailable) : desc?.unavailable_replicas ?? status.unavailableReplicas,
            misscheduled_replicas: isDaemonSet ? count(daemonSet.misscheduled) : undefined,
          }
        : {}),
      strategy: strategyLayer(workloadStrategy(kind, desc, spec)),
      ...workloadSettingsInfo(kind, desc, spec, daemonSet),
      ...(job ? jobLayerFields(job) : {}),
      ...(cronJob ? cronJobLayerFields(cronJob, controllerZone) : {}),
      selector,
      labels: nonEmpty(labels),
      // a list the budget halves goes first: these ahead of the pods and events
      ...templateLayer(podTemplate, selectorExpressions, volumeClaimTemplates),
      conditions: conditions.slice(0, 8),
      pods: pods.items,
      recent_events: events.slice(0, 10),
      ...(isCronJob && (Array.isArray(ownedJobs) || liveJobs) ? ownedJobsLayer(ownedDisplayJobs(owned, ownedJobs)) : {}),
    } as Fields,
  }
}
