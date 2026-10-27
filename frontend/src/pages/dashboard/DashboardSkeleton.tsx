// Dashboard skeleton — rendered while the cluster overview query is
// loading. The shape exactly mirrors the real Dashboard layout so the
// page doesn't reflow when isLoading flips false. Extracted from
// Dashboard.tsx (the `if (isLoading) return ...` branch + its
// `skeletonStats` table) — props-less, so the parent just mounts it.

import { useTranslation } from 'react-i18next'
import {
  AlertCircle,
  Box,
  Database,
  HardDrive,
  RefreshCw,
  Server,
  TrendingUp,
} from 'lucide-react'

export function DashboardSkeleton() {
  const { t } = useTranslation()
  const tr = (key: string, fallback: string, options?: Record<string, any>) =>
    t(key, { defaultValue: fallback, ...options })

  /* ── skeleton stat definitions (static text + icon, only value pulses) ── */
  const skeletonStats = [
    { label: tr('dashboard.stats.namespaces', 'Namespaces'), icon: Server },
    { label: tr('dashboard.stats.pods', 'Pods'), icon: Box },
    { label: tr('dashboard.stats.services', 'Services'), icon: Database },
    { label: tr('dashboard.stats.deployments', 'Deployments'), icon: TrendingUp },
    { label: tr('dashboard.stats.pvcs', 'PVCs'), icon: HardDrive },
    { label: tr('dashboard.stats.nodes', 'Nodes'), icon: Server },
  ]

  return (
    <div className="space-y-8">
      {/* Header — identical to real, version line is a pulse placeholder */}
      <div className="flex items-start justify-between">
        <div>
          <h1 className="text-3xl font-bold text-white">{tr('dashboard.title', 'Cluster Dashboard')}</h1>
          <p className="mt-2 text-slate-400">
            {tr('dashboard.subtitle', 'Get a quick overview of your Kubernetes cluster.')}
          </p>
          <p className="mt-1 text-sm text-slate-500">
            {tr('dashboard.clusterVersion', 'Cluster version: {{version}}', { version: '' })}
            <span className="inline-block h-3.5 w-20 align-middle ml-0.5 rounded-sm bg-slate-700/60 animate-pulse" />
          </p>
        </div>
        <button disabled className="btn btn-secondary flex items-center gap-2 opacity-50 cursor-not-allowed">
          <RefreshCw className="w-4 h-4" />
          {tr('dashboard.refresh', 'Refresh')}
        </button>
      </div>

      {/* Stats grid — exact same card markup, value replaced with pulse */}
      <div className="grid grid-cols-1 gap-6 sm:grid-cols-2 lg:grid-cols-3">
        {skeletonStats.map((s) => (
          <div key={s.label} className="card">
            <div className="flex items-start justify-between">
              <div>
                <p className="text-sm font-medium text-slate-400">{s.label}</p>
                {/* same as: <p className="mt-2 text-2xl font-semibold text-white">12</p> */}
                <p className="mt-2 text-2xl font-semibold leading-none">
                  <span className="inline-block h-[1em] w-[1.6em] rounded-sm bg-slate-700 animate-pulse align-baseline" />
                </p>
              </div>
              <s.icon className="w-5 h-5 text-slate-500" aria-hidden="true" />
            </div>
          </div>
        ))}
      </div>

      {/* Charts — flat bars at the real chart's size */}
      <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
        {[
          { title: tr('dashboard.podStatus.title', 'Pod status'), sub: tr('dashboard.podStatus.subtitle', 'Click to view pods in each status'), bars: [50, 85, 12, 40, 6] },
          { title: tr('dashboard.nodeStatus.title', 'Node status'), sub: tr('dashboard.nodeStatus.subtitle', 'Click to view nodes in each status'), bars: [75, 20] },
        ].map((chart) => (
          <div key={chart.title} className="card">
            <h2 className="text-lg font-semibold text-white">{chart.title}</h2>
            <p className="text-sm text-slate-400 mt-1 mb-4">{chart.sub}</p>
            <svg width="100%" height={340} viewBox="0 0 540 340" preserveAspectRatio="xMidYMid meet" aria-hidden="true">
              <line x1={40} y1={304} x2={524} y2={304} stroke="#475569" strokeWidth={1} />
              {chart.bars.map((pct, j) => {
                const groupW = 484 / chart.bars.length
                const bw = Math.min(groupW * 0.5, 48)
                const bx = 40 + j * groupW + (groupW - bw) / 2
                const barH = (pct / 100) * 280
                return <rect key={j} className="animate-pulse" x={bx} y={304 - barH} width={bw} height={barH} rx={3} fill="#334155" />
              })}
            </svg>
          </div>
        ))}
      </div>

      {/* Top resources — exact same card headers */}
      <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
        <div className="card">
          <div className="flex items-center justify-between mb-4">
            <h2 className="text-lg font-semibold text-white">
              {tr('dashboard.topPods.title', 'Top 5 pods by resource usage')}
            </h2>
            <p className="text-xs text-slate-400">{tr('dashboard.autoRefresh', 'Auto refresh every 5 seconds')}</p>
          </div>
          <div className="divide-y divide-slate-700/60">
            {[...Array(5)].map((_, i) => (
              <div key={i} className="px-2 py-3">
                <div className="flex items-center gap-3">
                  <span className="w-5 shrink-0 text-sm text-slate-500 tabular-nums">#{i + 1}</span>
                  <div className="flex-1 min-w-0 space-y-2">
                    <div className="h-4 bg-slate-700 rounded-sm w-3/4 animate-pulse" />
                    <div className="h-3.5 bg-slate-700/70 rounded-sm w-1/3 animate-pulse" />
                  </div>
                </div>
                <div className="flex items-center justify-end gap-5 mt-1 text-sm">
                  <span className="text-slate-400">{tr('dashboard.cpu', 'CPU')}: <span className="inline-block h-3.5 w-10 align-middle rounded-sm bg-slate-700 animate-pulse" /></span>
                  <span className="text-slate-400">{tr('dashboard.memory', 'Memory')}: <span className="inline-block h-3.5 w-12 align-middle rounded-sm bg-slate-700 animate-pulse" /></span>
                </div>
              </div>
            ))}
          </div>
        </div>
        <div className="card">
          <div className="flex items-center justify-between mb-4">
            <h2 className="text-lg font-semibold text-white">
              {tr('dashboard.topNodes.title', 'Top 3 nodes by resource usage')}
            </h2>
            <p className="text-xs text-slate-400">{tr('dashboard.autoRefresh', 'Auto refresh every 5 seconds')}</p>
          </div>
          <div className="space-y-4">
            {[...Array(3)].map((_, i) => (
              <div key={i} className="space-y-3">
                <div className="flex items-center gap-3">
                  <span className="w-5 shrink-0 text-sm text-slate-500 tabular-nums">#{i + 1}</span>
                  <div className="flex-1">
                    <div className="h-4 bg-slate-700 rounded-sm w-1/2 animate-pulse mb-1.5" />
                    <div className="flex items-center gap-4 text-sm text-slate-400">
                      <span>{tr('dashboard.cpu', 'CPU')}: <span className="inline-block h-3 w-12 align-middle rounded-sm bg-slate-700 animate-pulse" /></span>
                      <span>{tr('dashboard.memory', 'Memory')}: <span className="inline-block h-3 w-14 align-middle rounded-sm bg-slate-700 animate-pulse" /></span>
                    </div>
                  </div>
                </div>
                <div className="space-y-1 pl-8">
                  <div className="flex items-center justify-between text-xs">
                    <span className="text-slate-400">{tr('dashboard.cpu', 'CPU')}</span>
                    <span className="inline-block h-3 w-10 rounded-sm bg-slate-700 animate-pulse" />
                  </div>
                  <div className="w-full h-2 bg-slate-700 rounded-full" />
                </div>
                <div className="space-y-1 pl-8">
                  <div className="flex items-center justify-between text-xs">
                    <span className="text-slate-400">{tr('dashboard.memory', 'Memory')}</span>
                    <span className="inline-block h-3 w-10 rounded-sm bg-slate-700 animate-pulse" />
                  </div>
                  <div className="w-full h-2 bg-slate-700 rounded-full" />
                </div>
              </div>
            ))}
          </div>
        </div>
      </div>

      {/* Nodes — real title, card shape matches real layout */}
      <div className="card">
        <h2 className="text-lg font-semibold text-white mb-4">{tr('dashboard.nodes.title', 'Nodes')}</h2>
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-4 max-h-[400px] overflow-y-auto">
          {[...Array(4)].map((_, i) => (
            <div key={i} className="p-3 border border-slate-700 rounded-md">
              <div className="flex items-start gap-2 mb-2">
                <div className="w-4 h-4 rounded-full bg-slate-700 mt-0.5 animate-pulse" />
                <div className="flex-1 min-w-0">
                  <div className="h-4 bg-slate-700 rounded-sm w-2/3 animate-pulse" />
                </div>
              </div>
              <div className="space-y-1">
                <p className="text-xs text-slate-400">
                  <span className="font-medium">{tr('dashboard.nodeCard.versionLabel', 'Version')}:</span>{' '}
                  <span className="inline-block h-3 w-16 align-middle rounded-sm bg-slate-700 animate-pulse" />
                </p>
                <p className="text-xs text-slate-400">
                  <span className="font-medium">{tr('dashboard.nodeCard.rolesLabel', 'Roles')}:</span>{' '}
                  <span className="inline-block h-3 w-20 align-middle rounded-sm bg-slate-700 animate-pulse" />
                </p>
                <p className="text-xs text-slate-400">
                  <span className="font-medium">{tr('dashboard.nodeCard.ipLabel', 'IP')}:</span>{' '}
                  <span className="inline-block h-3 w-24 align-middle rounded-sm bg-slate-700 animate-pulse" />
                </p>
              </div>
              <div className="mt-2">
                <span className="inline-block h-5 w-14 rounded-sm bg-slate-700 animate-pulse" />
              </div>
            </div>
          ))}
        </div>
      </div>

      {/* Quick actions — real text & icons, just disabled */}
      <div className="card">
        <h2 className="text-lg font-semibold text-white mb-4">{tr('dashboard.quickActions.title', 'Quick actions')}</h2>
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
          <div className="btn btn-secondary text-left opacity-50 pointer-events-none">
            <div className="flex items-center gap-3">
              <AlertCircle className="w-5 h-5 text-slate-400" aria-hidden="true" />
              <div>
                <div className="font-medium">{tr('dashboard.quickActions.issues.title', 'Check issues')}</div>
                <div className="text-xs text-slate-400">{tr('dashboard.quickActions.issues.subtitle', 'Find resources with problems')}</div>
              </div>
            </div>
          </div>
          <div className="btn btn-secondary text-left opacity-50 pointer-events-none">
            <div className="flex items-center gap-3">
              <TrendingUp className="w-5 h-5 text-slate-400" aria-hidden="true" />
              <div>
                <div className="font-medium">{tr('dashboard.quickActions.optimization.title', 'Optimization suggestions')}</div>
                <div className="text-xs text-slate-400">{tr('dashboard.quickActions.optimization.subtitle', 'AI-powered resource optimization')}</div>
              </div>
            </div>
          </div>
          <div className="btn btn-secondary text-left opacity-50 pointer-events-none">
            <div className="flex items-center gap-3">
              <Database className="w-5 h-5 text-slate-400" aria-hidden="true" />
              <div>
                <div className="font-medium">{tr('dashboard.quickActions.storage.title', 'Storage analysis')}</div>
                <div className="text-xs text-slate-400">{tr('dashboard.quickActions.storage.subtitle', 'PV/PVC usage status')}</div>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}
