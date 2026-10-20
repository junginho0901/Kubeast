import type { AlertInboxItem, AlertStoreAlert } from '@/services/api/alertInbox'
import type { ResourceDetailTarget } from '@/components/ResourceDetailContext'

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
