import { InfoSection, InfoRow, InfoGrid, SummaryBadge } from '../DetailCommon'
import { PrometheusSection, MetricCard } from '../PrometheusMetrics'

interface ReplicaView {
  desired: string | number
  current: string | number
  ready: string | number
  updated: string | number
  available: string | number
}

interface DaemonSetStatus {
  misscheduled: number
  unavailable: number
}

interface PromMetrics {
  available: boolean
  data: Record<string, { available: boolean; results?: Array<{ value: number; metric?: Record<string, string> }> } | undefined>
}

interface Props {
  isJob: boolean
  isCronJob: boolean
  isDaemonSet: boolean
  replicaView: ReplicaView
  daemonSetStatus: DaemonSetStatus
  promWorkloadMetrics: PromMetrics
  getWorkloadMetric: (name: string) => number | null
}

export default function WorkloadReplicasSection({
  isJob,
  isCronJob,
  isDaemonSet,
  replicaView,
  daemonSetStatus,
  promWorkloadMetrics,
  getWorkloadMetric,
}: Props) {
  if (isJob || isCronJob) return null

  return (
    <>
      <div className="flex flex-wrap items-center gap-2">
        <SummaryBadge label="Desired" value={replicaView.desired as string | number} />
        <SummaryBadge
          label="Ready"
          value={replicaView.ready as string | number}
          color={Number(replicaView.ready) === Number(replicaView.desired) ? 'green' : 'amber'}
        />
        <SummaryBadge label="Updated" value={replicaView.updated as string | number} />
        <SummaryBadge label="Available" value={replicaView.available as string | number} />
        {isDaemonSet && (
          <SummaryBadge
            label="Misscheduled"
            value={daemonSetStatus.misscheduled}
            color={daemonSetStatus.misscheduled > 0 ? 'amber' : 'default'}
          />
        )}
        {isDaemonSet && (
          <SummaryBadge
            label="Unavailable"
            value={daemonSetStatus.unavailable}
            color={daemonSetStatus.unavailable > 0 ? 'red' : 'default'}
          />
        )}
      </div>

      <InfoSection title="Replicas">
        <InfoGrid>
          <InfoRow label="Desired" value={String(replicaView.desired ?? '-')} />
          <InfoRow label="Current" value={String(replicaView.current ?? '-')} />
          <InfoRow label="Ready" value={String(replicaView.ready ?? '-')} />
          <InfoRow label="Up to date" value={String(replicaView.updated ?? '-')} />
          <InfoRow label="Available" value={String(replicaView.available ?? '-')} />
        </InfoGrid>
      </InfoSection>

      <PrometheusSection available={promWorkloadMetrics.available} title="Real-time Resource Usage">
        <div className="grid grid-cols-2 md:grid-cols-3 gap-3 mb-3">
          {getWorkloadMetric('cpu') !== null && (
            <MetricCard label="Total CPU" value={getWorkloadMetric('cpu')!} unit="m" thresholds={{ warn: 1000, danger: 2000 }} />
          )}
          {getWorkloadMetric('memory') !== null && (
            <MetricCard
              label="Total Memory"
              value={getWorkloadMetric('memory')! / (1024 * 1024)}
              unit=" MiB"
              thresholds={{ warn: 2048, danger: 4096 }}
            />
          )}
          {getWorkloadMetric('restarts') !== null && (
            <MetricCard label="Total Restarts" value={getWorkloadMetric('restarts')!} unit="" thresholds={{ warn: 5, danger: 20 }} />
          )}
        </div>
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
    </>
  )
}
