import { usePrometheusQueries, usePrometheusRangeQuery } from '@/hooks/usePrometheusQuery'
import { PrometheusSection, MetricCard, Sparkline } from '../PrometheusMetrics'

interface NodePrometheusMetricsProps {
  name: string
  tr: (key: string, fallback: string, opts?: Record<string, any>) => string
}

export default function NodePrometheusMetrics({ name, tr }: NodePrometheusMetricsProps) {
  const promNodeMetrics = usePrometheusQueries(
    ['node-detail', name],
    [
      { name: 'cpu', promql: `100 - (avg by(instance)(rate(node_cpu_seconds_total{mode="idle"}[5m])) * 100)` },
      { name: 'memory', promql: `(1 - node_memory_MemAvailable_bytes / node_memory_MemTotal_bytes) * 100` },
      { name: 'disk_read', promql: `rate(node_disk_read_bytes_total[5m])` },
      { name: 'disk_write', promql: `rate(node_disk_written_bytes_total[5m])` },
      { name: 'network_rx', promql: `rate(node_network_receive_bytes_total{device!="lo"}[5m])` },
      { name: 'network_tx', promql: `rate(node_network_transmit_bytes_total{device!="lo"}[5m])` },
      { name: 'load1', promql: `node_load1` },
      { name: 'filesystem', promql: `(1 - node_filesystem_avail_bytes{mountpoint="/"} / node_filesystem_size_bytes{mountpoint="/"}) * 100` },
    ],
    { enabled: !!name },
  )

  // Find this node's metrics from Prometheus results (match by hostname/instance containing node name)
  const findNodeValue = (metricName: string): number | null => {
    const resp = promNodeMetrics.data[metricName]
    if (!resp?.available || !resp.results?.length) return null
    // Try to match by instance label containing the node name
    const match = resp.results.find((r) => {
      const instance = r.metric?.instance || r.metric?.nodename || ''
      return instance.includes(name)
    })
    // If only one result or no match, use first
    return match ? match.value : (resp.results.length === 1 ? resp.results[0].value : null)
  }

  return (
    <PrometheusSection available={promNodeMetrics.available} title={tr('nodes.detail.prometheus', 'Real-time Metrics')}>
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3 mb-3">
        {findNodeValue('cpu') !== null && (
          <MetricCard label="CPU Usage" value={findNodeValue('cpu')!} unit="%" />
        )}
        {findNodeValue('memory') !== null && (
          <MetricCard label="Memory Usage" value={findNodeValue('memory')!} unit="%" />
        )}
        {findNodeValue('filesystem') !== null && (
          <MetricCard label="Disk Usage" value={findNodeValue('filesystem')!} unit="%" />
        )}
        {findNodeValue('load1') !== null && (
          <MetricCard label="Load (1m)" value={findNodeValue('load1')!} unit="" thresholds={{ warn: 4, danger: 8 }} />
        )}
      </div>
      <NodeResourceTrend name={name} />

      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        {(findNodeValue('disk_read') !== null || findNodeValue('disk_write') !== null) && (
          <div className="space-y-2">
            <div className="text-[11px] text-slate-400 font-medium">Disk I/O</div>
            {findNodeValue('disk_read') !== null && (
              <div className="flex items-center justify-between text-xs">
                <span className="text-slate-400">Read</span>
                <span className="font-mono text-slate-300">{(findNodeValue('disk_read')! / 1024 / 1024).toFixed(1)} MB/s</span>
              </div>
            )}
            {findNodeValue('disk_write') !== null && (
              <div className="flex items-center justify-between text-xs">
                <span className="text-slate-400">Write</span>
                <span className="font-mono text-slate-300">{(findNodeValue('disk_write')! / 1024 / 1024).toFixed(1)} MB/s</span>
              </div>
            )}
          </div>
        )}
        {(findNodeValue('network_rx') !== null || findNodeValue('network_tx') !== null) && (
          <div className="space-y-2">
            <div className="text-[11px] text-slate-400 font-medium">Network I/O</div>
            {findNodeValue('network_rx') !== null && (
              <div className="flex items-center justify-between text-xs">
                <span className="text-slate-400">Receive</span>
                <span className="font-mono text-slate-300">{(findNodeValue('network_rx')! / 1024 / 1024).toFixed(2)} MB/s</span>
              </div>
            )}
            {findNodeValue('network_tx') !== null && (
              <div className="flex items-center justify-between text-xs">
                <span className="text-slate-400">Transmit</span>
                <span className="font-mono text-slate-300">{(findNodeValue('network_tx')! / 1024 / 1024).toFixed(2)} MB/s</span>
              </div>
            )}
          </div>
        )}
      </div>
    </PrometheusSection>
  )
}

// NodeResourceTrend — last-24h CPU% / Memory% sparklines for the selected node.
// node_exporter's `instance` label varies across deployments (sometimes
// `<nodeName>:9100`, sometimes just `<nodeName>`); we render the first
// matching series in the response. Gracefully hidden if there's no data.
function NodeResourceTrend({ name }: { name: string }) {
  const esc = name.replace(/"/g, '\\"')
  // We don't pin to a single `instance="<node>:9100"` here — different
  // node-exporter deployments expose 9100 / 9101 / no-port. Instead we ask
  // Prometheus for *all* series and the JS layer picks the one whose
  // `instance` contains the node name (matches the existing pattern used by
  // findNodeValue() above).
  const cpuQ = `100 - (avg by(instance) (rate(node_cpu_seconds_total{mode="idle"}[5m])) * 100)`
  const memQ = `(1 - (node_memory_MemAvailable_bytes / node_memory_MemTotal_bytes)) * 100`

  const cpu = usePrometheusRangeQuery(['node-cpu-24h', name], cpuQ, { step: 300 })
  const mem = usePrometheusRangeQuery(['node-mem-24h', name], memQ, { step: 300 })

  const pickSeries = (resp: typeof cpu.data) => {
    if (!resp?.available || !resp.results?.length) return null
    const match = resp.results.find((r) => {
      const inst = String(r.metric?.instance || r.metric?.nodename || '')
      return inst.includes(esc)
    })
    return (match ?? (resp.results.length === 1 ? resp.results[0] : null))?.points ?? null
  }

  const cpuPoints = pickSeries(cpu.data)
  const memPoints = pickSeries(mem.data)
  if (!cpuPoints && !memPoints) return null

  const ranges = (pts: { v: number }[] | null) => {
    if (!pts || pts.length === 0) return null
    const vs = pts.map((p) => p.v)
    return { min: Math.min(...vs), max: Math.max(...vs), avg: vs.reduce((a, b) => a + b, 0) / vs.length }
  }
  const cpuStats = ranges(cpuPoints)
  const memStats = ranges(memPoints)

  return (
    <div className="mt-3 grid grid-cols-1 md:grid-cols-2 gap-4">
      <div>
        <div className="flex items-center justify-between text-[11px] text-slate-400 mb-1">
          <span>24h CPU%</span>
          {cpuStats && (
            <span className="font-mono">avg {cpuStats.avg.toFixed(1)} · max {cpuStats.max.toFixed(1)}</span>
          )}
        </div>
        {cpuPoints ? (
          <Sparkline
            points={cpuPoints}
            width={420}
            height={50}
            stroke="#ef4444"
            fillFrom="rgba(239, 68, 68, 0.28)"
            fillTo="rgba(239, 68, 68, 0)"
            min={0}
            max={100}
          />
        ) : (
          <div className="text-[10px] text-slate-500">(no data)</div>
        )}
      </div>
      <div>
        <div className="flex items-center justify-between text-[11px] text-slate-400 mb-1">
          <span>24h Memory%</span>
          {memStats && (
            <span className="font-mono">avg {memStats.avg.toFixed(1)} · max {memStats.max.toFixed(1)}</span>
          )}
        </div>
        {memPoints ? (
          <Sparkline
            points={memPoints}
            width={420}
            height={50}
            stroke="#3b82f6"
            fillFrom="rgba(59, 130, 246, 0.28)"
            fillTo="rgba(59, 130, 246, 0)"
            min={0}
            max={100}
          />
        ) : (
          <div className="text-[10px] text-slate-500">(no data)</div>
        )}
      </div>
    </div>
  )
}
