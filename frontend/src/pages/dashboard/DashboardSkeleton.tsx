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
    { label: tr('dashboard.stats.namespaces', 'Namespaces'), icon: Server, color: 'text-blue-400', bg: 'bg-blue-500/10' },
    { label: tr('dashboard.stats.pods', 'Pods'), icon: Box, color: 'text-green-400', bg: 'bg-green-500/10' },
    { label: tr('dashboard.stats.services', 'Services'), icon: Database, color: 'text-purple-400', bg: 'bg-purple-500/10' },
    { label: tr('dashboard.stats.deployments', 'Deployments'), icon: TrendingUp, color: 'text-yellow-400', bg: 'bg-yellow-500/10' },
    { label: tr('dashboard.stats.pvcs', 'PVCs'), icon: HardDrive, color: 'text-pink-400', bg: 'bg-pink-500/10' },
    { label: tr('dashboard.stats.nodes', 'Nodes'), icon: Server, color: 'text-cyan-400', bg: 'bg-cyan-500/10' },
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
            <div className="flex items-center justify-between">
              <div>
                <p className="text-sm font-medium text-slate-400">{s.label}</p>
                {/* same as: <p className="mt-2 text-3xl font-bold text-white">12</p> */}
                <p className="mt-2 text-3xl font-bold leading-none">
                  <span className="inline-block h-[1em] w-[1.6em] rounded-sm bg-slate-700 animate-pulse align-baseline" />
                </p>
              </div>
              <div className={`p-3 rounded-lg ${s.bg}`}>
                <s.icon className={`w-6 h-6 ${s.color}`} />
              </div>
            </div>
          </div>
        ))}
      </div>

      {/* Charts — 3D skeleton */}
      <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
        {[
          { title: tr('dashboard.podStatus.title', 'Pod status'), sub: tr('dashboard.podStatus.subtitle', 'Click to view pods in each status'), accent: '#38bdf8' },
          { title: tr('dashboard.nodeStatus.title', 'Node status'), sub: tr('dashboard.nodeStatus.subtitle', 'Click to view nodes in each status'), accent: '#22d3ee' },
        ].map((chart, ci) => {
          const skelBars = ci === 0 ? [50, 85, 12, 40, 6] : [75, 20]
          const dx = 16, dy = -8
          return (
            <div key={chart.title} className="card relative overflow-hidden">
              <h2 className="text-xl font-bold text-white mb-4">{chart.title}</h2>
              <p className="text-sm text-slate-400 mb-4">{chart.sub}</p>
              <svg width="100%" height={300} viewBox="0 0 540 300" preserveAspectRatio="xMidYMid meet">
                <defs>
                  <linearGradient id={`skel-g-${ci}`} x1="0" y1="0" x2="0" y2="1">
                    <stop offset="0%" stopColor={chart.accent} stopOpacity={0.12} />
                    <stop offset="100%" stopColor={chart.accent} stopOpacity={0.04} />
                  </linearGradient>
                </defs>
                {/* floor */}
                <polygon points={`48,260 490,260 ${490 + dx},${260 + dy} ${48 + dx},${260 + dy}`}
                  fill={chart.accent} opacity={0.04} />
                <line x1={48} y1={260} x2={490} y2={260}
                  stroke={chart.accent} strokeWidth={1} opacity={0.12} />
                {/* left wall */}
                <polygon points={`48,260 ${48 + dx},${260 + dy} ${48 + dx},${30 + dy} 48,30`}
                  fill={chart.accent} opacity={0.03} />
                <line x1={48} y1={30} x2={48} y2={260}
                  stroke={chart.accent} strokeWidth={0.5} opacity={0.08} />
                {/* bars */}
                {skelBars.map((pct, j) => {
                  const groupW = 442 / skelBars.length
                  const bw = groupW * 0.48
                  const bx = 48 + j * groupW + (groupW - bw) / 2
                  const barH = (pct / 100) * 230
                  const by = 260 - barH
                  return (
                    <g key={j} className="animate-pulse" style={{ animationDelay: `${j * 0.15}s` }}>
                      <rect x={bx} y={by} width={bw} height={barH}
                        fill={`url(#skel-g-${ci})`} />
                      <polygon
                        points={`${bx + bw},${by} ${bx + bw + dx},${by + dy} ${bx + bw + dx},${260 + dy} ${bx + bw},${260}`}
                        fill={chart.accent} opacity={0.05} />
                      <polygon
                        points={`${bx},${by} ${bx + dx},${by + dy} ${bx + bw + dx},${by + dy} ${bx + bw},${by}`}
                        fill={chart.accent} opacity={0.08} />
                    </g>
                  )
                })}
              </svg>
            </div>
          )
        })}
      </div>

      {/* Top resources — exact same card headers */}
      <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
        <div className="card">
          <div className="flex items-center justify-between mb-4">
            <h2 className="text-xl font-bold text-white">
              {tr('dashboard.topPods.title', 'Top 5 pods by resource usage')}
            </h2>
            <p className="text-xs text-slate-400">{tr('dashboard.autoRefresh', 'Auto refresh every 5 seconds')}</p>
          </div>
          <div className="space-y-3">
            {[...Array(5)].map((_, i) => (
              <div key={i} className="p-4 bg-slate-700 rounded-lg">
                <div className="flex items-center gap-3 mb-2">
                  <div className="flex items-center justify-center w-8 h-8 rounded-full bg-primary-500/20">
                    <span className="text-primary-400 font-bold text-sm">#{i + 1}</span>
                  </div>
                  <div className="flex-1 min-w-0 space-y-2">
                    <div className="h-4 bg-slate-600/50 rounded-sm w-3/4 animate-pulse" />
                    <div className="h-3.5 bg-slate-600/30 rounded-sm w-1/2 animate-pulse" />
                  </div>
                </div>
                <div className="flex items-center justify-end gap-6 text-sm">
                  <div className="flex items-center gap-2">
                    <span className="text-slate-400">{tr('dashboard.cpu', 'CPU')}:</span>
                    <span className="inline-block h-3.5 w-12 rounded-sm bg-slate-600/40 animate-pulse" />
                  </div>
                  <div className="flex items-center gap-2">
                    <span className="text-slate-400">{tr('dashboard.memory', 'Memory')}:</span>
                    <span className="inline-block h-3.5 w-14 rounded-sm bg-slate-600/40 animate-pulse" />
                  </div>
                </div>
              </div>
            ))}
          </div>
        </div>
        <div className="card">
          <div className="flex items-center justify-between mb-4">
            <h2 className="text-xl font-bold text-white">
              {tr('dashboard.topNodes.title', 'Top 3 nodes by resource usage')}
            </h2>
            <p className="text-xs text-slate-400">{tr('dashboard.autoRefresh', 'Auto refresh every 5 seconds')}</p>
          </div>
          <div className="space-y-4">
            {[...Array(3)].map((_, i) => (
              <div key={i} className="space-y-3">
                <div className="flex items-center gap-3">
                  <div className="flex items-center justify-center w-8 h-8 rounded-full bg-cyan-500/20">
                    <span className="text-cyan-400 font-bold text-sm">#{i + 1}</span>
                  </div>
                  <div className="flex-1">
                    <div className="h-4 bg-slate-600/50 rounded-sm w-1/2 animate-pulse mb-1.5" />
                    <div className="flex items-center gap-4 text-sm text-slate-400">
                      <span>{tr('dashboard.cpu', 'CPU')}: <span className="inline-block h-3 w-12 align-middle rounded-sm bg-slate-600/40 animate-pulse" /></span>
                      <span>{tr('dashboard.memory', 'Memory')}: <span className="inline-block h-3 w-14 align-middle rounded-sm bg-slate-600/40 animate-pulse" /></span>
                    </div>
                  </div>
                </div>
                <div className="space-y-1 pl-11">
                  <div className="flex items-center justify-between text-xs">
                    <span className="text-slate-400">{tr('dashboard.cpu', 'CPU')}</span>
                    <span className="inline-block h-3 w-10 rounded-sm bg-slate-600/30 animate-pulse" />
                  </div>
                  <div className="w-full h-2.5 bg-slate-700 rounded-full overflow-hidden">
                    <div className="h-full rounded-full bg-slate-600/30 animate-pulse w-1/2" />
                  </div>
                </div>
                <div className="space-y-1 pl-11">
                  <div className="flex items-center justify-between text-xs">
                    <span className="text-slate-400">{tr('dashboard.memory', 'Memory')}</span>
                    <span className="inline-block h-3 w-10 rounded-sm bg-slate-600/30 animate-pulse" />
                  </div>
                  <div className="w-full h-2.5 bg-slate-700 rounded-full overflow-hidden">
                    <div className="h-full rounded-full bg-slate-600/30 animate-pulse w-1/3" />
                  </div>
                </div>
              </div>
            ))}
          </div>
        </div>
      </div>

      {/* Nodes — real title, card shape matches real layout */}
      <div className="card">
        <h2 className="text-xl font-bold text-white mb-4">{tr('dashboard.nodes.title', 'Nodes')}</h2>
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-4 max-h-[400px] overflow-y-auto">
          {[...Array(4)].map((_, i) => (
            <div key={i} className="p-3 bg-slate-700 rounded-lg">
              <div className="flex items-start gap-2 mb-2">
                <div className="w-4 h-4 rounded-full bg-slate-600/50 mt-0.5 animate-pulse" />
                <div className="flex-1 min-w-0">
                  <div className="h-4 bg-slate-600/50 rounded-sm w-2/3 animate-pulse" />
                </div>
              </div>
              <div className="space-y-1">
                <p className="text-xs text-slate-400">
                  <span className="font-medium">{tr('dashboard.nodeCard.versionLabel', 'Version')}:</span>{' '}
                  <span className="inline-block h-3 w-16 align-middle rounded-sm bg-slate-600/30 animate-pulse" />
                </p>
                <p className="text-xs text-slate-400">
                  <span className="font-medium">{tr('dashboard.nodeCard.rolesLabel', 'Roles')}:</span>{' '}
                  <span className="inline-block h-3 w-20 align-middle rounded-sm bg-slate-600/30 animate-pulse" />
                </p>
                <p className="text-xs text-slate-400">
                  <span className="font-medium">{tr('dashboard.nodeCard.ipLabel', 'IP')}:</span>{' '}
                  <span className="inline-block h-3 w-24 align-middle rounded-sm bg-slate-600/30 animate-pulse" />
                </p>
              </div>
              <div className="mt-2">
                <span className="inline-block h-5 w-14 rounded-sm bg-slate-600/30 animate-pulse" />
              </div>
            </div>
          ))}
        </div>
      </div>

      {/* Quick actions — real text & icons, just disabled */}
      <div className="card">
        <h2 className="text-xl font-bold text-white mb-4">{tr('dashboard.quickActions.title', 'Quick actions')}</h2>
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
          <div className="btn btn-secondary text-left opacity-50 pointer-events-none">
            <div className="flex items-center gap-3">
              <AlertCircle className="w-5 h-5 text-yellow-400" />
              <div>
                <div className="font-medium">{tr('dashboard.quickActions.issues.title', 'Check issues')}</div>
                <div className="text-xs text-slate-400">{tr('dashboard.quickActions.issues.subtitle', 'Find resources with problems')}</div>
              </div>
            </div>
          </div>
          <div className="btn btn-secondary text-left opacity-50 pointer-events-none">
            <div className="flex items-center gap-3">
              <TrendingUp className="w-5 h-5 text-green-400" />
              <div>
                <div className="font-medium">{tr('dashboard.quickActions.optimization.title', 'Optimization suggestions')}</div>
                <div className="text-xs text-slate-400">{tr('dashboard.quickActions.optimization.subtitle', 'AI-powered resource optimization')}</div>
              </div>
            </div>
          </div>
          <div className="btn btn-secondary text-left opacity-50 pointer-events-none">
            <div className="flex items-center gap-3">
              <Database className="w-5 h-5 text-blue-400" />
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
