// Dashboard pod / node status charts (Iso3D bar chart per status).
// Click a bar → drill into the matching list (handled by parent via
// onPodStatusClick / onNodeStatusClick). Each chart is hidden when
// its data array is empty.

import { useTranslation } from 'react-i18next'

import { Iso3DChart } from './Iso3DChart'

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
        <div className="card relative overflow-hidden">
          <div className="absolute inset-0 bg-linear-to-br from-sky-500/5 via-transparent to-blue-500/5 pointer-events-none" />
          <h2 className="text-xl font-bold text-white mb-4 relative">{tr('dashboard.podStatus.title', 'Pod status')}</h2>
          <p className="text-sm text-slate-400 mb-4 relative">
            {tr('dashboard.podStatus.subtitle', 'Click to view pods in each status')}
          </p>
          <Iso3DChart
            data={podStatusData}
            uid="pod"
            colors={{
              front: ['#38bdf8', '#0369a1'],
              side: '#0c4a6e',
              top: '#7dd3fc',
              accent: '#38bdf8',
            }}
            onBarClick={onPodStatusClick}
          />
        </div>
      )}

      {nodeStatusChartData.length > 0 && (
        <div className="card relative overflow-hidden">
          <div className="absolute inset-0 bg-linear-to-br from-cyan-500/5 via-transparent to-teal-500/5 pointer-events-none" />
          <h2 className="text-xl font-bold text-white mb-4 relative">{tr('dashboard.nodeStatus.title', 'Node status')}</h2>
          <p className="text-sm text-slate-400 mb-4 relative">
            {tr('dashboard.nodeStatus.subtitle', 'Click to view nodes in each status')}
          </p>
          <Iso3DChart
            data={nodeStatusChartData}
            uid="node"
            colors={{
              front: ['#22d3ee', '#0e7490'],
              side: '#164e63',
              top: '#a5f3fc',
              accent: '#22d3ee',
            }}
            onBarClick={onNodeStatusClick}
          />
        </div>
      )}
    </div>
  )
}
