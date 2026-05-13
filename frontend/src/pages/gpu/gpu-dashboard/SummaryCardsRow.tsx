// GPU Dashboard 의 Summary Cards (Capacity/Allocatable/Used/AllocationRate) +
// Status Badges (Device Plugin / MIG / Time-Slicing) 묶음.
//
// 추출 출처: GPUDashboard.tsx (Phase 4.11) — Summary Cards 와 Status Badges 가
// 시각적으로 인접한 row 라서 한 컴포넌트로 묶음. StatusBadge 도 본체에서 더
// 안 쓰여 여기로 이동.

import { Monitor, Cpu, Activity, Gauge, CheckCircle, XCircle } from 'lucide-react'
import type { GPUDashboardData } from '@/services/api'

function StatusBadge({ enabled, label }: { enabled: boolean; label: string }) {
  return (
    <span
      className={`inline-flex items-center gap-1.5 rounded-full px-3 py-1 text-xs font-medium ${
        enabled
          ? 'bg-emerald-500/10 text-emerald-400 ring-1 ring-emerald-500/20'
          : 'bg-slate-500/10 text-slate-400 ring-1 ring-slate-500/20'
      }`}
    >
      {enabled ? <CheckCircle className="h-3 w-3" /> : <XCircle className="h-3 w-3" />}
      {label}
    </span>
  )
}

interface Props {
  data: GPUDashboardData
  allocationRate: number
  devicePluginHealthy: boolean
  tr: (key: string, fallback: string) => string
}

export function SummaryCardsRow({ data, allocationRate, devicePluginHealthy, tr }: Props) {
  const summaryCards = [
    {
      label: tr('gpuDashboardPage.summary.capacity', 'Total Capacity'),
      value: data.total_gpu_capacity,
      icon: Monitor,
      border: 'border-blue-500/30',
      iconBg: 'bg-blue-500/10',
      iconColor: 'text-blue-400',
    },
    {
      label: tr('gpuDashboardPage.summary.allocatable', 'Allocatable'),
      value: data.total_gpu_allocatable,
      icon: Cpu,
      border: 'border-cyan-500/30',
      iconBg: 'bg-cyan-500/10',
      iconColor: 'text-cyan-400',
    },
    {
      label: tr('gpuDashboardPage.summary.used', 'Used'),
      value: data.total_gpu_used,
      icon: Activity,
      border: 'border-violet-500/30',
      iconBg: 'bg-violet-500/10',
      iconColor: 'text-violet-400',
    },
    {
      label: tr('gpuDashboardPage.summary.allocationRate', 'Allocation Rate'),
      value: `${allocationRate}%`,
      icon: Gauge,
      border: allocationRate > 80 ? 'border-amber-500/30' : 'border-emerald-500/30',
      iconBg: allocationRate > 80 ? 'bg-amber-500/10' : 'bg-emerald-500/10',
      iconColor: allocationRate > 80 ? 'text-amber-400' : 'text-emerald-400',
      bar: true,
    },
  ]

  return (
    <>
      {/* Summary Cards */}
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
        {summaryCards.map((card) => {
          const Icon = card.icon
          return (
            <div
              key={card.label}
              className={`rounded-xl border ${card.border} bg-slate-800/50 p-5 transition-colors hover:bg-slate-800/80`}
            >
              <div className="flex items-center justify-between">
                <p className="text-sm font-medium text-slate-400">{card.label}</p>
                <div className={`rounded-lg p-2 ${card.iconBg}`}>
                  <Icon className={`h-4 w-4 ${card.iconColor}`} />
                </div>
              </div>
              <p className="mt-2 text-3xl font-bold text-white">{card.value}</p>
              {card.bar && (
                <div className="mt-3 h-2 w-full overflow-hidden rounded-full bg-slate-700">
                  <div
                    className={`h-full rounded-full transition-all ${
                      allocationRate > 80
                        ? 'bg-amber-500'
                        : allocationRate > 50
                          ? 'bg-cyan-500'
                          : 'bg-emerald-500'
                    }`}
                    style={{ width: `${Math.min(allocationRate, 100)}%` }}
                  />
                </div>
              )}
            </div>
          )
        })}
      </div>

      {/* Status Badges */}
      <div className="flex flex-wrap items-center gap-3">
        <StatusBadge
          enabled={devicePluginHealthy}
          label={
            devicePluginHealthy
              ? tr('gpuDashboardPage.status.pluginHealthy', 'Device Plugin Healthy')
              : tr('gpuDashboardPage.status.pluginUnhealthy', 'Device Plugin Unhealthy')
          }
        />
        <StatusBadge
          enabled={data.mig_enabled}
          label={
            data.mig_enabled
              ? tr('gpuDashboardPage.status.migEnabled', 'MIG Enabled')
              : tr('gpuDashboardPage.status.migDisabled', 'MIG Disabled')
          }
        />
        <StatusBadge
          enabled={data.time_slicing_enabled}
          label={
            data.time_slicing_enabled
              ? tr('gpuDashboardPage.status.timeSlicingEnabled', 'Time-Slicing Enabled')
              : tr('gpuDashboardPage.status.timeSlicingDisabled', 'Time-Slicing Disabled')
          }
        />
        {data.device_plugin_status && (
          <span className="text-xs text-slate-500">
            {tr('gpuDashboardPage.status.pluginDetail', 'Plugin')}: {data.device_plugin_status.ready}/{data.device_plugin_status.desired}{' '}
            {tr('gpuDashboardPage.status.ready', 'ready')}
          </span>
        )}
      </div>
    </>
  )
}
