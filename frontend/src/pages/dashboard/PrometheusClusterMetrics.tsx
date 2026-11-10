// Dashboard 의 Prometheus cluster-wide metrics 카드 (CPU / Memory / Disk / Pods).
// promCluster.available 일 때만 mount. Every slot is drawn: a metric the store does not answer is "-" with why, so
// the row keeps its four places. Pods is a bar like the others: the pods the store counts (kube-state-metrics, each
// namespace/pod once) of the pods the nodes can take (their allocatable "pods" summed), as Rancher's Capacity reads.
// 색상 threshold: >=80 red / >=60 amber / else 정상색(브랜드 하늘색 하나).

import { useTranslation } from 'react-i18next'

import { podsShown } from './podsShown'

interface Props {
  title: string
  cpu: number | null
  memory: number | null
  disk: number | null
  podCount: number | null
  // the pods the nodes can take: sum of kube_node_status_allocatable{resource="pods"}
  podCapacity?: number | null
}

function threshold(v: number, normalClass: string): string {
  if (v >= 80) return 'bg-red-500'
  if (v >= 60) return 'bg-amber-500'
  return normalClass
}

function Slot({ label, title, value, figure, normalClass, missing, testId }: {
  label: string
  title?: string
  value: number | null
  figure?: string
  normalClass: string
  missing: string
  testId: string
}) {
  return (
    <div className="space-y-2" data-testid={testId}>
      <div className="flex items-center justify-between text-xs">
        <span className="text-slate-400" title={title}>{label}</span>
        <span className="font-mono text-slate-300" title={value === null && !figure ? missing : undefined}>
          {figure ?? (value === null ? '-' : `${Math.round(value)}%`)}
        </span>
      </div>
      <div className="h-2 w-full overflow-hidden rounded-full bg-slate-700">
        {value !== null && (
          <div
            className={`h-full rounded-full transition-[width] duration-200 ${threshold(value, normalClass)}`}
            style={{ width: `${Math.min(value, 100)}%` }}
          />
        )}
      </div>
      {value === null && !figure && <p className="text-[11px] text-slate-500 truncate" title={missing}>{missing}</p>}
    </div>
  )
}

export function PrometheusClusterMetrics({ title, cpu, memory, disk, podCount, podCapacity = null }: Props) {
  const { t } = useTranslation()
  const missing = (what: string) => t('dashboard.metricMissing', { defaultValue: 'No {{what}} data from Prometheus', what })
  const pods = podsShown(podCount, podCapacity)
  return (
    <div className="card">
      <div className="flex items-center gap-2 mb-4">
        <div className="h-2 w-2 rounded-full bg-emerald-400" />
        <h2 className="text-lg font-semibold text-ink">{title}</h2>
        <span className="text-xs text-slate-500">{t('dashboard.live', 'Live')}</span>
      </div>
      <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
        <Slot testId="cluster-metric-cpu" label="CPU" value={cpu} normalClass="bg-primary-bright" missing={missing('CPU')} />
        <Slot testId="cluster-metric-memory" label={t('dashboard.memory', 'Memory')} value={memory} normalClass="bg-primary-bright" missing={missing(t('dashboard.memory', 'Memory'))} />
        <Slot testId="cluster-metric-disk" label={t('dashboard.disk', 'Disk')} value={disk} normalClass="bg-primary-bright" missing={missing(t('dashboard.disk', 'Disk'))} />
        <Slot
          testId="cluster-metric-pods"
          label={t('dashboard.pods', 'Pods')}
          title={t('dashboard.podsSource', { defaultValue: "Pods the cluster's Prometheus counts (kube-state-metrics kube_pod_info, each namespace/pod once) of the pods its nodes can take (allocatable). The Pods card above counts the Kubernetes API." })}
          value={pods?.percent ?? null}
          figure={pods?.text}
          normalClass="bg-primary-bright"
          missing={missing(t('dashboard.pods', 'Pods'))}
        />
      </div>
    </div>
  )
}
