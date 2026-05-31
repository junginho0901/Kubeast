// Dashboard 의 Prometheus cluster-wide metrics 카드 (CPU / Memory / Disk / Pods).
// promCluster.available 일 때만 mount. 4개 metric 모두 null 이면 빈 grid 만.
// 색상 threshold 는 기존 inline 과 동일: >=80 red / >=60 amber / else 정상색.

interface Props {
  title: string
  cpu: number | null
  memory: number | null
  disk: number | null
  podCount: number | null
}

function threshold(v: number, normalClass: string): string {
  if (v >= 80) return 'bg-red-500'
  if (v >= 60) return 'bg-amber-500'
  return normalClass
}

function MetricBar({ label, value, normalClass }: { label: string; value: number; normalClass: string }) {
  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between text-xs">
        <span className="text-slate-400">{label}</span>
        <span className="font-mono text-slate-300">{Math.round(value)}%</span>
      </div>
      <div className="h-3 w-full overflow-hidden rounded-full bg-slate-800">
        <div
          className={`h-full rounded-full transition-all ${threshold(value, normalClass)}`}
          style={{ width: `${Math.min(value, 100)}%` }}
        />
      </div>
    </div>
  )
}

export function PrometheusClusterMetrics({ title, cpu, memory, disk, podCount }: Props) {
  return (
    <div className="card">
      <div className="flex items-center gap-2 mb-4">
        <div className="h-2 w-2 rounded-full bg-emerald-400 animate-pulse" />
        <h2 className="text-xl font-bold text-white">{title}</h2>
        <span className="text-xs text-slate-500">Live</span>
      </div>
      <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
        {cpu !== null && <MetricBar label="CPU" value={cpu} normalClass="bg-emerald-500" />}
        {memory !== null && <MetricBar label="Memory" value={memory} normalClass="bg-blue-500" />}
        {disk !== null && <MetricBar label="Disk" value={disk} normalClass="bg-violet-500" />}
        {podCount !== null && (
          <div className="space-y-2">
            <div className="flex items-center justify-between text-xs">
              <span className="text-slate-400">Pods</span>
              <span className="font-mono text-slate-300">{Math.round(podCount)}</span>
            </div>
            <div className="text-2xl font-bold text-white">{Math.round(podCount)}</div>
          </div>
        )}
      </div>
    </div>
  )
}
