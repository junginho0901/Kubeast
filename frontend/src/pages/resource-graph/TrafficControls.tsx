import { useTranslation } from 'react-i18next'
import { RefreshCw } from 'lucide-react'
import type { GraphView, TrafficSource } from './traffic'

// The header's switch between the objects (structure), who talks to whom (traffic) and both, with the
// traffic's source and a refresh. Traffic is read when it is switched on and on refresh only.

const segment = (on: boolean) => `px-2.5 py-1.5 rounded-md text-xs transition-colors ${on ? 'bg-primary-600 text-white' : 'text-slate-400 hover:text-white'}`

export function TrafficControls({ view, setView, sources, source, setSource, onRefresh, fetching }: {
  view: GraphView
  setView: (v: GraphView) => void
  sources: TrafficSource[]
  source: TrafficSource
  setSource: (s: TrafficSource) => void
  onRefresh: () => void
  fetching: boolean
}) {
  const { t } = useTranslation()
  const views: [GraphView, string][] = [['structure', 'Structure'], ['traffic', 'Traffic'], ['both', 'Both']]
  const sourceLabel: Record<TrafficSource, string> = {
    relay: t('resourceGraph.traffic.sourceRelay', 'Recent flows'),
    '1h': t('resourceGraph.traffic.sourceMetrics', { defaultValue: 'Metrics {{w}}', w: '1h' }),
    '24h': t('resourceGraph.traffic.sourceMetrics', { defaultValue: 'Metrics {{w}}', w: '24h' }),
  }
  return (
    <>
      <div className="flex items-center gap-1 bg-slate-700 rounded-lg p-0.5" role="group" aria-label={t('resourceGraph.traffic.viewLabel', 'What the lines show')}>
        {views.map(([v, label]) => (
          <button key={v} type="button" onClick={() => setView(v)} className={segment(view === v)} aria-pressed={view === v} data-testid={`graph-view-${v}`}>
            {t(`resourceGraph.traffic.view.${v}`, label)}
          </button>
        ))}
      </div>
      {view !== 'structure' && (
        <>
          <div className="flex items-center gap-1 bg-slate-700 rounded-lg p-0.5" role="group" aria-label={t('resourceGraph.traffic.sourceLabel', 'Traffic source')}>
            {sources.map((s) => (
              <button key={s} type="button" onClick={() => setSource(s)} className={segment(source === s)} aria-pressed={source === s} data-testid={`traffic-source-${s}`}>
                {sourceLabel[s]}
              </button>
            ))}
          </div>
          <button
            type="button"
            onClick={onRefresh}
            className="h-9 w-9 inline-flex items-center justify-center rounded-lg border border-slate-600 bg-slate-700 text-slate-200 hover:bg-slate-600"
            aria-label={t('resourceGraph.traffic.refresh', 'Read the traffic again')}
            title={t('resourceGraph.traffic.refresh', 'Read the traffic again')}
            data-testid="traffic-refresh"
          >
            <RefreshCw className={`w-4 h-4 ${fetching ? 'animate-spin' : ''}`} />
          </button>
        </>
      )}
    </>
  )
}
