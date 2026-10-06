import type { ReactNode, ThHTMLAttributes } from 'react'
import type { LabelValues } from './detailLabel'
import { fmtRel } from './detailFormat'
import { useDetailLabel } from './useDetailLabel'

/* ── Shared UI primitives for resource detail views ── */

// Table header whose string child goes through the detail label catalog
// (see useDetailLabel: descriptive labels in Korean, Kubernetes names unchanged).
export function Th({ children, ...rest }: ThHTMLAttributes<HTMLTableCellElement>) {
  const dl = useDetailLabel()
  return <th {...rest}>{typeof children === 'string' ? dl(children) : children}</th>
}

// Drawer text through the same catalog: <Tx>No data</Tx>, or with placeholders
// <Tx text="Showing first {{n}} of {{total}}" values={{ n, total }} />.
export function Tx({ children, text, values }: { children?: string; text?: string; values?: LabelValues }) {
  const dl = useDetailLabel()
  return <>{dl(text ?? children ?? '', values)}</>
}

// "(none)" placeholder through the catalog ("(없음)" in Korean).
export function NoneText({ className = 'text-slate-400 text-xs' }: { className?: string }) {
  const dl = useDetailLabel()
  return <span className={className}>{dl('(none)')}</span>
}

// titleValues fill {{placeholders}} in the title ("Used By Pods ({{n}})").
export function InfoSection({ title, titleValues, children, actions }: { title: string; titleValues?: LabelValues; children: ReactNode; actions?: ReactNode }) {
  const dl = useDetailLabel()
  return (
    <div className="rounded-lg border border-slate-700 bg-slate-900/40 p-4">
      <div className="flex items-center justify-between mb-2">
        <p className="text-xs text-slate-400">{dl(title, titleValues)}</p>
        {actions}
      </div>
      {children}
    </div>
  )
}

// Values are data and stay as they are, except the Yes / No the views print for booleans.
const isYesNo = (v: unknown): v is 'Yes' | 'No' => v === 'Yes' || v === 'No'

export function InfoRow({ label, value }: { label: string; value: ReactNode }) {
  const dl = useDetailLabel()
  return (
    <div className="grid grid-cols-1 md:grid-cols-[140px_1fr] gap-1 text-xs text-slate-200">
      <span className="text-slate-400 shrink-0">{dl(label)}</span>
      <span className="text-white font-medium break-all">{isYesNo(value) ? dl(value) : typeof value === 'string' || typeof value === 'number' ? value : value ?? '-'}</span>
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
  const dl = useDetailLabel()
  const c = {
    green: 'border-emerald-500/60 text-emerald-300',
    amber: 'border-amber-500/60 text-amber-300',
    red: 'border-red-500/60 text-red-300',
    default: 'border-slate-600 text-slate-300',
  }
  return (
    <span className={`inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[11px] font-medium ${c[color || 'default']}`}>
      {dl(label)}: {isYesNo(value) ? dl(value) : value}
    </span>
  )
}

export function KeyValueTags({ data, emptyText = '(none)' }: { data?: Record<string, string>; emptyText?: string }) {
  const dl = useDetailLabel()
  const entries = data ? Object.entries(data) : []
  if (entries.length === 0) return <span className="text-slate-400 text-xs">{dl(emptyText)}</span>
  return (
    <div className="flex flex-wrap gap-2 text-xs text-slate-200">
      {entries.map(([key, value]) => (
        <span key={`${key}=${value}`} className="relative inline-flex items-center rounded-full border border-slate-700 bg-slate-800/80 px-2 py-1 max-w-full group">
          <span className="font-mono text-slate-300 max-w-[160px] truncate">{key}</span>
          <span className="mx-1 text-slate-500">:</span>
          <span className="max-w-[260px] truncate">{value}</span>
          <span className="pointer-events-none absolute left-0 top-full mt-1 z-20 hidden w-max max-w-[520px] rounded-md border border-slate-700 bg-slate-950 px-2 py-1 text-[11px] text-slate-200 shadow-lg group-hover:block">
            <span className="wrap-break-word">{`${key}: ${value}`}</span>
          </span>
        </span>
      ))}
    </div>
  )
}

export function ConditionsTable({ conditions }: { conditions: any[] }) {
  const dl = useDetailLabel()
  if (!conditions || conditions.length === 0) return <span className="text-slate-400 text-xs">{dl('(none)')}</span>
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-xs table-fixed min-w-[700px]">
        <thead className="text-slate-400">
          <tr>
            <Th className="text-left py-2 w-[28%]">Type</Th>
            <Th className="text-left py-2 w-[10%]">Status</Th>
            <Th className="text-left py-2 w-[17%]">Reason</Th>
            <Th className="text-left py-2 w-[30%]">Message</Th>
            <Th className="text-left py-2 w-[15%]">Last Transition</Th>
          </tr>
        </thead>
        <tbody className="divide-y divide-slate-800">
          {conditions.map((c: any, idx: number) => (
            <tr key={`${c.type}-${idx}`} className="text-slate-200">
              <td className="py-2 pr-2 font-medium break-all whitespace-normal align-top">{c.type || '-'}</td>
              <td className="py-2 pr-2 whitespace-nowrap align-top"><StatusBadge status={c.status} /></td>
              <td className="py-2 pr-2 wrap-break-word whitespace-normal align-top">{c.reason || '-'}</td>
              <td className="py-2 pr-2 wrap-break-word whitespace-normal align-top">{c.message || '-'}</td>
              <td className="py-2 pr-2 whitespace-nowrap align-top">{fmtRel(c.lastTransitionTime || c.last_transition_time)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

export function EventsTable({ events }: { events: any[] }) {
  const dl = useDetailLabel()
  if (!events || events.length === 0) return <span className="text-slate-400 text-xs">{dl('(none)')}</span>
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
            <Th className="text-left py-2 w-[12%]">Type</Th>
            <Th className="text-left py-2 w-[18%]">Reason</Th>
            <Th className="text-left py-2 w-[44%]">Message</Th>
            <Th className="text-left py-2 w-[14%]">Last Seen</Th>
            <Th className="text-left py-2 w-[12%]">Count</Th>
          </tr>
        </thead>
        <tbody className="divide-y divide-slate-800">
          {events.slice(0, 50).map((e: any, idx: number) => (
            <tr key={`${e.reason}-${idx}`} className="text-slate-200">
              <td className="py-2 pr-2"><span className={`badge ${badge(e.type)}`}>{e.type || '-'}</span></td>
              <td className="py-2 pr-2 align-top"><span className="block wrap-break-word whitespace-normal">{e.reason || '-'}</span></td>
              <td className="py-2 pr-2 align-top"><span className="block wrap-break-word whitespace-normal">{e.message || '-'}</span></td>
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
  const dl = useDetailLabel()
  return (
    <div className="rounded-lg border border-slate-700 bg-slate-900/60 px-4 py-3">
      <p className="text-xs text-slate-400">{dl(label)}</p>
      <p className="text-base text-white mt-1">{value}</p>
      <div className="mt-3 w-full h-2.5 bg-slate-800 rounded-full overflow-hidden">
        <div className="h-full rounded-full" style={{ width: `${Math.min(Math.max(percent, 0), 100)}%`, backgroundColor: color }} />
      </div>
    </div>
  )
}
