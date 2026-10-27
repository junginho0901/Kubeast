// Dashboard pod / node status charts (one flat bar per status).
// Click a bar → drill into the matching list (handled by parent via
// onPodStatusClick / onNodeStatusClick). Each chart is hidden when
// its data array is empty.

import { useTranslation } from 'react-i18next'

import { StatusBarChart } from './StatusBarChart'

// colour by meaning: the normal state in the brand blue, failures red, waiting amber, the rest grey
const STATE_COLOR: Record<string, string> = {
  Running: 'var(--color-primary-400)',
  Ready: 'var(--color-primary-400)',
  Succeeded: 'var(--color-slate-400)',
  Pending: 'var(--color-amber-400)',
  Failed: 'var(--color-red-400)',
  NotReady: 'var(--color-red-400)',
}
const stateColor = (name: string) => STATE_COLOR[name] ?? 'var(--color-slate-500)'

interface BarDatum {
  name: string
  value: number
}

interface Props {
  podStatusData: BarDatum[]
  nodeStatusChartData: BarDatum[]
  onPodStatusClick: (status: string) => void
  onNodeStatusClick: (status: string) => void
}

export function DashboardPodNodeStatus({
  podStatusData,
  nodeStatusChartData,
  onPodStatusClick,
  onNodeStatusClick,
}: Props) {
  const { t } = useTranslation()
  const tr = (key: string, fallback: string, options?: Record<string, any>) =>
    t(key, { defaultValue: fallback, ...options })

  return (
    <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
      {podStatusData.length > 0 && (
        <div className="card">
          <h2 className="text-lg font-semibold text-ink">{tr('dashboard.podStatus.title', 'Pod status')}</h2>
          <p className="text-sm text-slate-400 mt-1 mb-4">
            {tr('dashboard.podStatus.subtitle', 'Click to view pods in each status')}
          </p>
          <StatusBarChart data={podStatusData} colorFor={stateColor} onBarClick={onPodStatusClick} />
        </div>
      )}

      {nodeStatusChartData.length > 0 && (
        <div className="card">
          <h2 className="text-lg font-semibold text-ink">{tr('dashboard.nodeStatus.title', 'Node status')}</h2>
          <p className="text-sm text-slate-400 mt-1 mb-4">
            {tr('dashboard.nodeStatus.subtitle', 'Click to view nodes in each status')}
          </p>
          <StatusBarChart data={nodeStatusChartData} colorFor={stateColor} onBarClick={onNodeStatusClick} />
        </div>
      )}
    </div>
  )
}
