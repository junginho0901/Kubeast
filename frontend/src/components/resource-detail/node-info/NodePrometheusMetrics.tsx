import { usePrometheusQueries } from '@/hooks/usePrometheusQuery'
import { PrometheusSection, MetricCard } from '../PrometheusMetrics'

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
