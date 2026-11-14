import type { AlertInboxItem, AlertStoreAlert } from '@/services/api/alertInbox'
import type { ClusterFeatures } from '@/services/api/types'
import type { ResourceDetailTarget } from '@/components/ResourceDetailContext'
import { detailTarget } from '@/components/resource-detail/crDetail'
import { aiEnabled, alertInvestigationEnabled } from '@/utils/features'

// The object an alert is about, from the labels kube-state-metrics and the kube-prometheus rules put on it:
// the most specific one first. `service` is left out (it names the scrape target there, not the object).
const NAMESPACED: [string, string][] = [
  ['pod', 'Pod'], ['deployment', 'Deployment'], ['statefulset', 'StatefulSet'], ['daemonset', 'DaemonSet'],
  ['job_name', 'Job'], ['cronjob', 'CronJob'], ['persistentvolumeclaim', 'PersistentVolumeClaim'],
  ['horizontalpodautoscaler', 'HorizontalPodAutoscaler'], ['replicaset', 'ReplicaSet'],
]
const CLUSTER_SCOPED: [string, string][] = [['node', 'Node'], ['persistentvolume', 'PersistentVolume']]

export function alertResource(labels: Record<string, string>): ResourceDetailTarget | null {
  const namespace = labels.namespace
  // a custom resource's: kube-state-metrics' custom resource state metrics label every series with
  // customresource_group, _version and _kind, and name the object as their config's labelsFromPath does — `name`, or
  // the kind in lower case as its own metrics do
  const crKind = labels.customresource_kind
  const crName = crKind ? labels[crKind.toLowerCase()] || labels.name : ''
  if (crKind && crName && labels.customresource_group && labels.customresource_version) {
    return detailTarget(crKind, crName, namespace, `${labels.customresource_group}/${labels.customresource_version}`)
  }
  if (namespace) {
    for (const [label, kind] of NAMESPACED) if (labels[label]) return { kind, namespace, name: labels[label] }
  }
  for (const [label, kind] of CLUSTER_SCOPED) if (labels[label]) return { kind, name: labels[label] }
  return null
}

// The conditions a silence of this alert starts from: its name, namespace and the object it is about — narrow, so
// it mutes this alert and not its neighbours. The cluster label is left out (the server adds it).
export function silenceStart(labels: Record<string, string>, clusterLabel = 'cluster'): Record<string, string> {
  const out: Record<string, string> = {}
  for (const key of ['alertname', 'namespace']) if (labels[key] && key !== clusterLabel) out[key] = labels[key]
  const object = [...(labels.namespace ? NAMESPACED : []), ...CLUSTER_SCOPED].find(([label]) => labels[label] && label !== clusterLabel)
  if (object) out[object[0]] = labels[object[0]]
  return out
}

// What the alert store says now about a firing inbox alert: "firing", "silenced", "inhibited", "absent" (the
// store holds no such alert — the resolved notification did not come) or null (no store for this cluster, not
// asked yet, or its list was cut short so absence proves nothing). A resolved alert is not asked about.
export type LiveState = 'firing' | 'silenced' | 'inhibited' | 'absent'

export function liveStateOf(
  item: Pick<AlertInboxItem, 'status' | 'fingerprint'>,
  store: { alerts: AlertStoreAlert[]; truncated: boolean } | undefined,
): LiveState | null {
  if (!store || item.status === 'resolved') return null
  const found = store.alerts.find((a) => a.fingerprint === item.fingerprint)
  if (!found) return store.truncated ? null : 'absent'
  if (found.state === 'silenced' || found.state === 'inhibited') return found.state
  return 'firing'
}

// The "Alertmanager now" line of a firing alert: the store's state, or why it is not known — the store's list was
// cut at its limit before this alert (with the answer's numbers), the store has not answered yet, it failed, or the
// cluster has no alert store. Null for a resolved alert, which the store is not asked about.
export type LiveLine =
  | { state: LiveState }
  | { unknown: 'cut'; listed: number; total: number }
  | { unknown: 'limited'; seconds: number }
  | { unknown: 'loading' | 'failed' | 'none' }

// how often the page reads the store while nothing refuses it
const STORE_READ_S = 60

// A read the server refused at the user's per-minute budget (alertStore.perUserPerMinute): the seconds its Retry-After
// names until the next is taken. Null for any other failure.
export function storeLimited(error: unknown): { retryAfter: number } | null {
  const res = (error as { response?: { status?: number; headers?: Record<string, unknown> } } | null)?.response
  if (res?.status !== 429) return null
  const seconds = Number(res.headers?.['retry-after'])
  return { retryAfter: seconds > 0 ? Math.ceil(seconds) : STORE_READ_S }
}

// When the page reads the store next: as the server said after a refusal, else on its minute.
export function storeRefetchMs(error: unknown): number {
  return (storeLimited(error)?.retryAfter ?? STORE_READ_S) * 1000
}

// The seconds left of a refusal's wait, for the screen: at least 1 until the next read has answered.
export function storeLimitedSeconds(until: number | null, now: number): number | null {
  return until === null ? null : Math.max(1, Math.ceil((until - now) / 1000))
}

export function liveLineOf(
  item: Pick<AlertInboxItem, 'status' | 'fingerprint'>,
  store: { on: boolean; answer?: { alerts: AlertStoreAlert[]; total: number; truncated: boolean }; failed: boolean; limited?: number | null },
): LiveLine | null {
  if (item.status === 'resolved') return null
  if (!store.on) return { unknown: 'none' }
  if (!store.answer && typeof store.limited === 'number') return { unknown: 'limited', seconds: store.limited }
  if (!store.answer) return { unknown: store.failed ? 'failed' : 'loading' }
  const state = liveStateOf(item, store.answer)
  if (state) return { state }
  return { unknown: 'cut', listed: store.answer.alerts.length, total: store.answer.total }
}

// The severity filter's values: the three every rule set uses, then any other the cluster's alerts carry (the inbox
// answer's severities — kube-prometheus' Watchdog is "none") and the one chosen.
export function severityChoices(carried: string[] | undefined, chosen: string): string[] {
  return [...new Set(['critical', 'warning', 'info', ...(carried ?? []), ...(chosen ? [chosen] : [])])]
}

// An alert store answer cut at its limit (alertStore.maxAlerts): how many alerts it listed and how many match in
// all. The limit itself is not in the answer; a cut list is as long as the limit. Null when nothing was cut.
export function storeCut(answer: { alerts: unknown[]; total: number; truncated: boolean } | undefined): { listed: number; total: number } | null {
  if (!answer?.truncated) return null
  return { listed: answer.alerts.length, total: answer.total }
}

// The inbox (ai-service) answers only with alert investigation on, which the server reports off with AI off; features that could not be read ask it.
export type InboxState = 'wait' | 'on' | 'off' | 'aiOff'
export function inboxState(features: ClusterFeatures | undefined, featuresPlaceholder: boolean): InboxState {
  if (featuresPlaceholder) return 'wait'
  if (!features || alertInvestigationEnabled(features)) return 'on'
  return aiEnabled(features) ? 'off' : 'aiOff'
}
