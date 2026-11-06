// GPU Dashboard 의 Summary Cards (Capacity/Allocatable/Used/AllocationRate) +
// Status Badges (Device Plugin / MIG / Time-Slicing) 묶음.
//
// 추출 출처: GPUDashboard.tsx (Phase 4.11) — Summary Cards 와 Status Badges 가
// 시각적으로 인접한 row 라서 한 컴포넌트로 묶음. StatusBadge 도 본체에서 더
// 안 쓰여 여기로 이동.

import { Monitor, Cpu, Activity, Gauge, CheckCircle, XCircle } from 'lucide-react'
import type { GPUDashboardData } from '@/services/api'
import { missingPluginVendors, type DevicePluginBadge } from '../gpuNumbers'

function StatusBadge({ enabled, label, testId }: { enabled: boolean; label: string; testId?: string }) {
  return (
    <span
      data-testid={testId}
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
  devicePlugins: DevicePluginBadge[]
  tr: (key: string, fallback: string, options?: Record<string, unknown>) => string
}

export function SummaryCardsRow({ data, allocationRate, devicePlugins, tr }: Props) {
  // each company's GPUs on the nodes ("NVIDIA 12 · AMD 4")
  const vendors = (data.vendors ?? []).filter((v) => v.capacity > 0)
  const summaryCards = [
    {
      label: tr('gpuDashboardPage.summary.capacity', 'Total Capacity'),
      value: data.total_gpu_capacity,
      icon: Monitor,
      border: 'border-slate-700',
      iconBg: 'bg-slate-700/60',
      iconColor: 'text-slate-300',
      vendors: vendors.length > 0 ? vendors.map((v) => `${v.vendor} ${v.capacity}`).join(' · ') : undefined,
    },
    {
      label: tr('gpuDashboardPage.summary.allocatable', 'Allocatable'),
      value: data.total_gpu_allocatable,
      icon: Cpu,
      border: 'border-slate-700',
      iconBg: 'bg-slate-700/60',
      iconColor: 'text-slate-300',
    },
    {
      label: tr('gpuDashboardPage.summary.used', 'Used'),
      value: data.total_gpu_used,
      icon: Activity,
      border: 'border-slate-700',
      iconBg: 'bg-slate-700/60',
      iconColor: 'text-slate-300',
      // pods no node has taken yet: asked for, not counted in use
      note: data.total_gpu_waiting > 0
        ? tr('gpuDashboardPage.summary.waiting', '+{{n}} requested by pods waiting for a node', { n: data.total_gpu_waiting })
        : undefined,
    },
    {
      label: tr('gpuDashboardPage.summary.allocationRate', 'Allocation Rate'),
      value: `${allocationRate}%`,
      icon: Gauge,
      border: allocationRate > 80 ? 'border-amber-500/30' : 'border-slate-700',
      iconBg: allocationRate > 80 ? 'bg-amber-500/10' : 'bg-slate-700/60',
      iconColor: allocationRate > 80 ? 'text-amber-400' : 'text-slate-300',
      bar: true,
    },
  ]

  const pluginLabel = {
    healthy: tr('gpuDashboardPage.status.pluginHealthy', 'Device Plugin Healthy'),
    unhealthy: tr('gpuDashboardPage.status.pluginUnhealthy', 'Device Plugin Unhealthy'),
    missing: tr('gpuDashboardPage.status.pluginNotFound', 'Device Plugin Not Found'),
  }
  // the company before the badge's words when the badges are of more than one
  const named = (b: DevicePluginBadge, text: string) => (b.vendor ? `${b.vendor} ${text}` : text)
  const missing = missingPluginVendors(devicePlugins)

  return (
    <>
      {/* Summary Cards */}
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
        {summaryCards.map((card) => {
          const Icon = card.icon
          return (
            <div
              key={card.label}
              data-testid="gpu-summary-card"
              className={`rounded-xl border ${card.border} bg-slate-800/50 p-5 transition-colors hover:bg-slate-800/80`}
            >
              <div className="flex items-center justify-between">
                <p className="text-sm font-medium text-slate-400">{card.label}</p>
                <div className={`rounded-lg p-2 ${card.iconBg}`}>
                  <Icon className={`h-4 w-4 ${card.iconColor}`} />
                </div>
              </div>
              <p className="mt-2 text-3xl font-bold text-ink" data-testid="gpu-summary-value">{card.value}</p>
              {card.vendors && <p className="mt-1 text-xs text-slate-400" data-testid="gpu-summary-vendors">{card.vendors}</p>}
              {card.note && <p className="mt-1 text-xs text-slate-400" data-testid="gpu-summary-note">{card.note}</p>}
              {card.bar && (
                <div className="mt-3 h-2 w-full overflow-hidden rounded-full bg-slate-700">
                  <div
                    className={`h-full rounded-full transition-all ${
                      allocationRate > 80
                        ? 'bg-amber-500'
                        : allocationRate > 50
                          ? 'bg-primary-bright'
                          : 'bg-primary-bright'
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
        {devicePlugins.map((b) => (
          <StatusBadge key={b.vendor ?? 'plugin'} testId="gpu-badge-plugin" enabled={b.state === 'healthy'} label={named(b, pluginLabel[b.state])} />
        ))}
        <StatusBadge
          testId="gpu-badge-mig"
          enabled={data.mig_enabled}
          label={
            data.mig_enabled
              ? tr('gpuDashboardPage.status.migEnabled', 'MIG Enabled')
              : tr('gpuDashboardPage.status.migDisabled', 'MIG Disabled')
          }
        />
        <StatusBadge
          testId="gpu-badge-timeslicing"
          enabled={data.time_slicing_enabled}
          label={
            data.time_slicing_enabled
              ? tr('gpuDashboardPage.status.timeSlicingEnabled', 'Time-Slicing Enabled')
              : tr('gpuDashboardPage.status.timeSlicingDisabled', 'Time-Slicing Disabled')
          }
        />
        {devicePlugins.filter((b) => b.plugin?.found).map((b) => (
          <span key={b.vendor ?? 'plugin'} className="text-xs text-slate-500" data-testid="gpu-plugin-detail">
            {named(b, tr('gpuDashboardPage.status.pluginDetail', 'Plugin'))}: {b.plugin?.ready ?? 0}/{b.plugin?.desired ?? 0}{' '}
            {tr('gpuDashboardPage.status.ready', 'ready')}
          </span>
        ))}
        {devicePlugins.some((b) => b.state === 'missing') && (
          <span className="text-xs text-slate-500" data-testid="gpu-plugin-note">
            {missing.length > 0
              ? tr('gpuDashboardPage.status.pluginNotFoundNote', '{{vendors}} device plugin: not under the names Kubeast looks for. It may run under another name; the GPU counts come from the nodes.', { vendors: missing.join(', ') })
              : tr('gpuDashboardPage.status.pluginNotFoundNoteAny', 'Device plugin: not under the names Kubeast looks for. It may run under another name; the GPU counts come from the nodes.')}
          </span>
        )}
      </div>
    </>
  )
}
