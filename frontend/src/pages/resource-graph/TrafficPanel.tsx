import { useTranslation } from 'react-i18next'
import { X } from 'lucide-react'
import type { TrafficEnd, TrafficLine, TrafficResult } from '@/services/api'
import { endLabel } from '@/components/resource-detail/netflowText'
import { formatTime } from '@/utils/time'
import { checkFor, endText, lineColor, lineState, openableEnd, type LineCheck } from './traffic'

// The window a traffic line opens on the right: its ends, what was counted, the ports, the drop reasons and the
// policies that denied it, and (recent flows) its latest connections — with the NetworkPolicy check for a
// dropped line and the ends' drawers, whose "Recent Flows" read more.

export function TrafficPanel({ line, result, onClose, onWhy, onOpen }: {
  line: TrafficLine
  result: TrafficResult
  onClose: () => void
  onWhy: (c: LineCheck) => void
  onOpen: (e: TrafficEnd) => void
}) {
  const { t } = useTranslation()
  const tr = (key: string, fallback: string, options?: Record<string, unknown>) => t(key, { defaultValue: fallback, ...options })
  const state = lineState(line)
  const check = checkFor(line)
  const relay = result.source === 'relay'
  const win = relay ? result.since ?? '' : result.range ?? ''
  const end = (e: TrafficEnd) => (
    <span className="min-w-0">
      {e.kind && <span className="text-slate-400 mr-1">{e.kind}</span>}
      <span className="font-mono text-white break-all">{endText(e)}</span>
    </span>
  )
  return (
    <div className="absolute top-3 right-3 bottom-3 z-20 w-[360px] max-w-[calc(100%-24px)] overflow-y-auto rounded-lg border border-slate-600 bg-slate-800/95 p-3 text-xs shadow-2xl backdrop-blur-xs" data-testid="traffic-panel">
      <div className="flex items-start justify-between gap-2 mb-2">
        <div className="font-semibold text-slate-200">{tr('resourceGraph.traffic.panelTitle', 'Traffic')}</div>
        <button type="button" onClick={onClose} className="text-slate-400 hover:text-white" aria-label={tr('common.close', 'Close')} data-testid="traffic-panel-close">
          <X className="w-4 h-4" />
        </button>
      </div>
      <div className="space-y-1 mb-3">
        <div className="flex gap-1.5"><span className="text-slate-500 w-10 shrink-0">{tr('resourceGraph.traffic.from', 'From')}</span>{end(line.from)}</div>
        <div className="flex gap-1.5"><span className="text-slate-500 w-10 shrink-0">{tr('resourceGraph.traffic.to', 'To')}</span>{end(line.to)}</div>
      </div>
      <p className="mb-2" style={{ color: lineColor[state] }} data-testid="traffic-panel-counts">
        {relay
          ? tr('resourceGraph.traffic.countsRelay', '{{allowed}} flows allowed · {{dropped}} dropped in the last {{w}}', { allowed: line.allowed, dropped: line.dropped, w: win })
          : tr('resourceGraph.traffic.countsMetrics', '{{allowed}} TCP connections opened · {{dropped}} packets dropped in the last {{w}}', { allowed: line.allowed, dropped: line.dropped, w: win })}
      </p>
      {(line.ports?.length ?? 0) > 0 && (
        <p className="mb-2 text-slate-300"><span className="text-slate-500">{tr('resourceGraph.traffic.ports', 'Ports')}: </span>
          <span className="font-mono" data-testid="traffic-panel-ports">{line.ports!.map((p) => `${p.protocol ?? ''} ${p.port ?? ''}`.trim()).join(', ')}</span>
        </p>
      )}
      {(line.reasons?.length ?? 0) > 0 && (
        <div className="mb-2">
          <div className="text-slate-500">{tr('resourceGraph.traffic.reasons', 'Drop reasons')}</div>
          <ul className="ml-3 list-disc list-inside text-slate-300" data-testid="traffic-panel-reasons">
            {line.reasons!.map((r) => <li key={r.reason}><span className="font-mono">{r.reason || '-'}</span> {r.count}</li>)}
          </ul>
        </div>
      )}
      {(line.denied_by?.length ?? 0) > 0 && (
        <p className="mb-2 text-slate-300"><span className="text-slate-500">{tr('resourceGraph.traffic.deniedBy', 'Denied by')}: </span>
          <span className="font-mono">{line.denied_by!.map((p) => (p.namespace ? `${p.namespace}/${p.name}` : p.name)).join(', ')}</span>
        </p>
      )}
      {line.last && <p className="mb-2 text-slate-400">{tr('resourceGraph.traffic.last', 'Last seen {{time}}', { time: formatTime(line.last) })}</p>}
      <div className="flex flex-wrap gap-2 mb-3">
        {check && (
          <button type="button" onClick={() => onWhy(check)} className="h-7 px-2.5 rounded-lg border border-red-500/50 bg-red-900/30 text-red-200 hover:bg-red-900/50" data-testid="traffic-panel-why">
            {tr('netdrops.why', 'Why?')}
          </button>
        )}
        {[line.from, line.to].filter(openableEnd).map((e) => (
          <button key={`${e.kind}/${e.namespace}/${e.name}`} type="button" onClick={() => onOpen(e)} className="h-7 px-2.5 rounded-lg border border-slate-600 bg-slate-700 text-slate-200 hover:bg-slate-600" data-testid="traffic-panel-open">
            {tr('resourceGraph.traffic.open', 'Open {{name}}', { name: e.name })}
          </button>
        ))}
      </div>
      {relay && (line.connections?.length ?? 0) > 0 && (
        <div>
          <div className="text-slate-500 mb-1">{tr('resourceGraph.traffic.connections', 'Latest connections')}</div>
          <ul className="space-y-1" data-testid="traffic-panel-connections">
            {line.connections!.map((g, i) => (
              <li key={i} className="rounded-sm border border-slate-700 bg-slate-900/60 px-2 py-1">
                <div className="font-mono text-slate-200 break-all">{endLabel(g.source, '')} → {endLabel(g.destination, '')}{g.destination.port ? `:${g.destination.port}` : ''}</div>
                <div className="text-slate-400">
                  <span className={g.verdict === 'DROPPED' ? 'text-red-300' : 'text-emerald-300'}>{g.verdict}</span>
                  {g.drop_reason ? ` ${g.drop_reason}` : ''} · {tr('resourceGraph.traffic.flowsCount', '{{n}} flows', { n: g.count + g.replies })} · {formatTime(g.last)}
                </div>
              </li>
            ))}
          </ul>
        </div>
      )}
      <p className="mt-3 text-slate-500">
        {!relay
          ? tr('resourceGraph.traffic.aboutMetrics', "From the Hubble metrics in the cluster's Prometheus: TCP connections opened (SYN) and dropped packets. UDP traffic such as DNS is not counted.")
          : result.provider === 'calico'
            ? tr('resourceGraph.traffic.aboutCalico', "From Calico's Whisker: the flows Calico's Goldmane aggregated, read once and counted in packets. Each end's drawer shows its recent flows.")
            : tr('resourceGraph.traffic.aboutRelay', "From the cluster's Hubble Relay: the latest flows it keeps, read once. Each end's drawer shows its recent flows.")}
      </p>
    </div>
  )
}
