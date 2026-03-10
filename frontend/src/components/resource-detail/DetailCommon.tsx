import type { ReactNode } from 'react'

/* ── Shared UI primitives for resource detail views ── */

export function InfoSection({ title, children, actions }: { title: string; children: ReactNode; actions?: ReactNode }) {
  return (
    <div className="rounded-lg border border-slate-700 bg-slate-900/40 p-4">
      <div className="flex items-center justify-between mb-2">
        <p className="text-xs text-slate-400">{title}</p>
        {actions}
      </div>
      {children}
    </div>
  )
}

export function InfoRow({ label, value }: { label: string; value: ReactNode }) {
  return (
    <div className="grid grid-cols-1 md:grid-cols-[140px_1fr] gap-1 text-xs text-slate-200">
      <span className="text-slate-400 shrink-0">{label}</span>
      <span className="text-white font-medium break-all">{typeof value === 'string' || typeof value === 'number' ? value : value ?? '-'}</span>
    </div>
  )
}

export function InfoGrid({ children }: { children: ReactNode }) {
  return <div className="grid grid-cols-1 md:grid-cols-2 gap-3 text-xs text-slate-200">{children}</div>
}

export function StatusBadge({ status }: { status: string }) {
  const lower = (status || '').toLowerCase()
  let cls = 'badge-info'
  if (['active', 'running', 'ready', 'bound', 'available', 'true', 'succeeded', 'completed'].some(s => lower.includes(s))) cls = 'badge-success'
  else if (['pending', 'warning', 'terminating', 'unknown'].some(s => lower.includes(s))) cls = 'badge-warning'
  else if (['failed', 'error', 'crashloopbackoff', 'false', 'notready', 'lost'].some(s => lower.includes(s))) cls = 'badge-error'
  return <span className={`badge ${cls}`}>{status || '-'}</span>
}

export function SummaryBadge({ label, value, color }: { label: string; value: string | number; color?: 'green' | 'amber' | 'red' | 'default' }) {
  const c = {
    green: 'border-emerald-500/60 text-emerald-300',
    amber: 'border-amber-500/60 text-amber-300',
    red: 'border-red-500/60 text-red-300',
    default: 'border-slate-600 text-slate-300',
  }
  return (
    <span className={`inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[11px] font-medium ${c[color || 'default']}`}>
      {label}: {value}
    </span>
  )
}

export function KeyValueTags({ data, emptyText = '(none)' }: { data?: Record<string, string>; emptyText?: string }) {
  const entries = data ? Object.entries(data) : []
  if (entries.length === 0) return <span className="text-slate-400 text-xs">{emptyText}</span>
  return (
    <div className="flex flex-wrap gap-2 text-xs text-slate-200">
      {entries.map(([key, value]) => (
        <span key={`${key}=${value}`} className="relative inline-flex items-center rounded-full border border-slate-700 bg-slate-800/80 px-2 py-1 max-w-full group">
          <span className="font-mono text-slate-300 max-w-[160px] truncate">{key}</span>
          <span className="mx-1 text-slate-500">:</span>
          <span className="max-w-[260px] truncate">{value}</span>
          <span className="pointer-events-none absolute left-0 top-full mt-1 z-20 w-max max-w-[520px] rounded-md border border-slate-700 bg-slate-950 px-2 py-1 text-[11px] text-slate-200 shadow-lg opacity-0 group-hover:opacity-100 transition-opacity">
            <span className="break-words">{`${key}: ${value}`}</span>
          </span>
        </span>
      ))}
    </div>
  )
}

export function ConditionsTable({ conditions }: { conditions: any[] }) {
  if (!conditions || conditions.length === 0) return <span className="text-slate-400 text-xs">(none)</span>
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-xs table-fixed min-w-[700px]">
        <thead className="text-slate-400">
          <tr>
            <th className="text-left py-2 w-[28%]">Type</th>
            <th className="text-left py-2 w-[10%]">Status</th>
            <th className="text-left py-2 w-[17%]">Reason</th>
            <th className="text-left py-2 w-[30%]">Message</th>
            <th className="text-left py-2 w-[15%]">Last Transition</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-slate-800">
          {conditions.map((c: any, idx: number) => (
            <tr key={`${c.type}-${idx}`} className="text-slate-200">
              <td className="py-2 pr-2 font-medium break-all whitespace-normal align-top">{c.type || '-'}</td>
              <td className="py-2 pr-2 whitespace-nowrap align-top"><StatusBadge status={c.status} /></td>
              <td className="py-2 pr-2 break-words whitespace-normal align-top">{c.reason || '-'}</td>
              <td className="py-2 pr-2 break-words whitespace-normal align-top">{c.message || '-'}</td>
              <td className="py-2 pr-2 whitespace-nowrap align-top">{fmtRel(c.lastTransitionTime || c.last_transition_time)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

export function EventsTable({ events }: { events: any[] }) {
  if (!events || events.length === 0) return <span className="text-slate-400 text-xs">(none)</span>
  const badge = (type?: string | null) => {
    const t = (type || '').toLowerCase()
    if (t.includes('warning')) return 'badge-warning'
    if (t.includes('error') || t.includes('failed')) return 'badge-error'
    return 'badge-info'
  }
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-xs table-fixed min-w-[620px]">
        <thead className="text-slate-400">
          <tr>
            <th className="text-left py-2 w-[12%]">Type</th>
            <th className="text-left py-2 w-[18%]">Reason</th>
            <th className="text-left py-2 w-[44%]">Message</th>
            <th className="text-left py-2 w-[14%]">Last Seen</th>
            <th className="text-left py-2 w-[12%]">Count</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-slate-800">
          {events.slice(0, 50).map((e: any, idx: number) => (
            <tr key={`${e.reason}-${idx}`} className="text-slate-200">
              <td className="py-2 pr-2"><span className={`badge ${badge(e.type)}`}>{e.type || '-'}</span></td>
              <td className="py-2 pr-2 align-top"><span className="block break-words whitespace-normal">{e.reason || '-'}</span></td>
              <td className="py-2 pr-2 align-top"><span className="block break-words whitespace-normal">{e.message || '-'}</span></td>
              <td className="py-2 pr-2">{fmtRel(e.last_timestamp || e.lastTimestamp || e.first_timestamp || e.firstTimestamp)}</td>
              <td className="py-2 pr-2">{e.count ?? 1}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

export function UsageCard({ label, value, percent, color }: { label: string; value: string; percent: number; color: string }) {
  return (
    <div className="rounded-lg border border-slate-700 bg-slate-900/60 px-4 py-3">
      <p className="text-xs text-slate-400">{label}</p>
      <p className="text-base text-white mt-1">{value}</p>
      <div className="mt-3 w-full h-2.5 bg-slate-800 rounded-full overflow-hidden">
        <div className="h-full rounded-full" style={{ width: `${Math.min(Math.max(percent, 0), 100)}%`, backgroundColor: color }} />
      </div>
    </div>
  )
}

/* ── Time formatting helpers ── */

export function fmtRel(iso?: string | null): string {
  if (!iso) return '-'
  const d = new Date(iso)
  const ms = Date.now() - d.getTime()
  if (!Number.isFinite(ms) || ms < 0) return '-'
  const m = Math.floor(ms / 60000)
  const h = Math.floor(m / 60)
  const days = Math.floor(h / 24)
  if (days >= 30) return `${Math.floor(days / 30)}mo`
  if (days > 0) return `${days}d`
  if (h > 0) return `${h}h`
  return `${m}m`
}

export function fmtTs(iso?: string | null): string {
  if (!iso) return '-'
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return '-'
  return d.toLocaleString()
}

export function fmtPodAge(iso?: string | null): string {
  if (!iso) return '-'
  const sec = Math.max(0, Math.floor((Date.now() - new Date(iso).getTime()) / 1000))
  const d = Math.floor(sec / 86400)
  const h = Math.floor((sec % 86400) / 3600)
  const m = Math.floor((sec % 3600) / 60)
  if (d > 0) return `${d}d ${h}h`
  if (h > 0) return `${h}h ${m}m`
  return `${m}m`
}
