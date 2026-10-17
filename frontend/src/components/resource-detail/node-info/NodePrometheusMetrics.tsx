import { usePrometheusQueries, usePrometheusRangeQuery } from '@/hooks/usePrometheusQuery'
import { PrometheusSection, MetricCard, Sparkline } from '../PrometheusMetrics'
import { Tx } from '../DetailCommon'
import { nodeQueries } from '@/utils/nodeMetrics'

interface NodePrometheusMetricsProps {
  name: string
  // The node's InternalIP / ExternalIP: node-exporter's instance is often <IP>:9100.
  addresses?: string[]
  tr: (key: string, fallback: string, opts?: Record<string, any>) => string
}

export default function NodePrometheusMetrics({ name, addresses = [], tr }: NodePrometheusMetricsProps) {
  const queries = nodeQueries(name, addresses)
  const promNodeMetrics = usePrometheusQueries(
    ['node-detail', name, ...addresses],
    Object.entries(queries).map(([metric, promql]) => ({ name: metric, promql })),
    { enabled: !!name },
  )

  // The queries select this node already; no series means no value (never another node's).
  const findNodeValue = (metricName: string): number | null => {
    const resp = promNodeMetrics.data[metricName]
    if (!resp?.available || !resp.results?.length) return null
    return resp.results[0].value
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
      <NodeResourceTrend name={name} cpuQuery={queries.cpu} memoryQuery={queries.memory} />

      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        {(findNodeValue('disk_read') !== null || findNodeValue('disk_write') !== null) && (
          <div className="space-y-2">
            <div className="text-[11px] text-slate-400 font-medium"><Tx>Disk I/O</Tx></div>
            {findNodeValue('disk_read') !== null && (
              <div className="flex items-center justify-between text-xs">
                <span className="text-slate-400"><Tx>Read</Tx></span>
                <span className="font-mono text-slate-300">{(findNodeValue('disk_read')! / 1024 / 1024).toFixed(1)} MB/s</span>
              </div>
            )}
            {findNodeValue('disk_write') !== null && (
              <div className="flex items-center justify-between text-xs">
                <span className="text-slate-400"><Tx>Write</Tx></span>
                <span className="font-mono text-slate-300">{(findNodeValue('disk_write')! / 1024 / 1024).toFixed(1)} MB/s</span>
              </div>
            )}
          </div>
        )}
        {(findNodeValue('network_rx') !== null || findNodeValue('network_tx') !== null) && (
          <div className="space-y-2">
            <div className="text-[11px] text-slate-400 font-medium"><Tx>Network I/O</Tx></div>
            {findNodeValue('network_rx') !== null && (
              <div className="flex items-center justify-between text-xs">
                <span className="text-slate-400"><Tx>Receive</Tx></span>
                <span className="font-mono text-slate-300">{(findNodeValue('network_rx')! / 1024 / 1024).toFixed(2)} MB/s</span>
              </div>
            )}
            {findNodeValue('network_tx') !== null && (
              <div className="flex items-center justify-between text-xs">
                <span className="text-slate-400"><Tx>Transmit</Tx></span>
                <span className="font-mono text-slate-300">{(findNodeValue('network_tx')! / 1024 / 1024).toFixed(2)} MB/s</span>
              </div>
            )}
          </div>
        )}
      </div>
    </PrometheusSection>
  )
}

// NodeResourceTrend — last-24h CPU% / Memory% sparklines for the selected node. Hidden if there's no data.
function NodeResourceTrend({ name, cpuQuery, memoryQuery }: { name: string; cpuQuery: string; memoryQuery: string }) {
  const cpu = usePrometheusRangeQuery(['node-cpu-24h', name, cpuQuery], cpuQuery, { step: 300 })
  const mem = usePrometheusRangeQuery(['node-mem-24h', name, memoryQuery], memoryQuery, { step: 300 })

  const pickSeries = (resp: typeof cpu.data) => {
    if (!resp?.available || !resp.results?.length) return null
    return resp.results[0].points ?? null
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
          <span><Tx>24h CPU%</Tx></span>
          {cpuStats && (
            <span className="font-mono"><Tx text="avg {{avg}} · max {{max}}" values={{ avg: cpuStats.avg.toFixed(1), max: cpuStats.max.toFixed(1) }} /></span>
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
          <div className="text-[10px] text-slate-500"><Tx>(no data)</Tx></div>
        )}
      </div>
      <div>
        <div className="flex items-center justify-between text-[11px] text-slate-400 mb-1">
          <span><Tx>24h Memory%</Tx></span>
          {memStats && (
            <span className="font-mono"><Tx text="avg {{avg}} · max {{max}}" values={{ avg: memStats.avg.toFixed(1), max: memStats.max.toFixed(1) }} /></span>
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
          <div className="text-[10px] text-slate-500"><Tx>(no data)</Tx></div>
        )}
      </div>
    </div>
  )
}
