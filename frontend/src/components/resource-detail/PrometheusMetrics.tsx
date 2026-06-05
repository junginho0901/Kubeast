import type { PrometheusQueryResponse } from '@/services/api'

/**
 * A horizontal metric bar with label, value text, and color-coded progress bar.
 */
export function MetricBar({
  label,
  value,
  max = 100,
  unit = '%',
  thresholds = { warn: 60, danger: 80 },
}: {
  label: string
  value: number
  max?: number
  unit?: string
  thresholds?: { warn: number; danger: number }
}) {
  const pct = max > 0 ? Math.min((value / max) * 100, 100) : 0
  const displayVal = unit === '%' ? Math.round(value) : value.toFixed(1)
  const color =
    pct >= thresholds.danger ? 'bg-red-500'
    : pct >= thresholds.warn ? 'bg-amber-500'
    : 'bg-emerald-500'

  return (
    <div className="space-y-1">
      <div className="flex items-center justify-between text-xs">
        <span className="text-slate-400">{label}</span>
        <span className="font-mono text-slate-300">{displayVal}{unit}</span>
      </div>
      <div className="h-2 w-full overflow-hidden rounded-full bg-slate-800">
        <div
          className={`h-full rounded-full transition-all ${color}`}
          style={{ width: `${pct}%` }}
        />
      </div>
    </div>
  )
}

/**
 * A compact metric card showing a single value with a bar.
 */
export function MetricCard({
  label,
  value,
  unit = '%',
  subtext,
  thresholds,
}: {
  label: string
  value: number
  unit?: string
  subtext?: string
  thresholds?: { warn: number; danger: number }
}) {
  const t = thresholds ?? { warn: 60, danger: 80 }
  const color =
    value >= t.danger ? 'text-red-400 border-red-700/40 bg-red-900/10'
    : value >= t.warn ? 'text-amber-400 border-amber-700/40 bg-amber-900/10'
    : 'text-emerald-400 border-emerald-700/40 bg-emerald-900/10'

  return (
    <div className={`rounded-lg border px-3 py-2.5 ${color}`}>
      <div className="text-[11px] text-slate-400">{label}</div>
      <div className="mt-1 text-lg font-semibold">
        {unit === '%' ? Math.round(value) : value.toFixed(1)}{unit}
      </div>
      {subtext && <div className="text-[10px] text-slate-500">{subtext}</div>}
    </div>
  )
}

/**
 * Section wrapper that only renders if Prometheus data is available.
 * Children are hidden entirely if `available` is false.
 */
export function PrometheusSection({
  available,
  title,
  children,
}: {
  available: boolean
  title: string
  children: React.ReactNode
}) {
  if (!available) return null
  return (
    <div className="mt-4 rounded-lg border border-slate-700/50 bg-slate-800/30 p-4">
      <div className="flex items-center gap-2 mb-3">
        <div className="h-2 w-2 rounded-full bg-emerald-400 animate-pulse" />
        <h3 className="text-xs font-semibold text-slate-300 uppercase tracking-wider">{title}</h3>
      </div>
      {children}
    </div>
  )
}

/**
 * Extract a single value from a Prometheus query response, optionally filtering by a label.
 */
export function extractValue(
  resp: PrometheusQueryResponse | undefined,
  filter?: { label: string; value: string },
): number | null {
  if (!resp?.available || !resp.results?.length) return null
  if (filter) {
    const match = resp.results.find((r) => r.metric?.[filter.label] === filter.value)
    return match ? match.value : null
  }
  return resp.results[0]?.value ?? null
}

/**
 * Sum all values from a Prometheus query response.
 */
export function sumValues(resp: PrometheusQueryResponse | undefined): number | null {
  if (!resp?.available || !resp.results?.length) return null
  return resp.results.reduce((sum, r) => sum + r.value, 0)
}

/**
 * Lightweight inline-SVG sparkline. Renders one series with a stroked line
 * and an optional gradient fill underneath. No external chart library so the
 * detail modal bundle stays small.
 *
 * `points` is a chronologically-ordered list of (t, v) where t is unix
 * seconds (ignored by the renderer — used by callers for tooltips later).
 * If `min` / `max` are not given they're derived from the data.
 */
export function Sparkline({
  points,
  width = 240,
  height = 48,
  stroke = '#10b981',
  fillFrom = 'rgba(16, 185, 129, 0.25)',
  fillTo = 'rgba(16, 185, 129, 0)',
  min,
  max,
}: {
  points: Array<{ t: number; v: number }>
  width?: number
  height?: number
  stroke?: string
  fillFrom?: string
  fillTo?: string
  min?: number
  max?: number
}) {
  if (!points || points.length === 0) {
    return <div className="text-[10px] text-slate-500">(no data)</div>
  }

  const vs = points.map((p) => p.v)
  const yMin = min ?? Math.min(...vs)
  const yMaxRaw = max ?? Math.max(...vs)
  const yMax = yMaxRaw === yMin ? yMin + 1 : yMaxRaw
  const w = width
  const h = height
  const pad = 2
  const stepX = points.length > 1 ? (w - pad * 2) / (points.length - 1) : 0
  const yScale = (v: number) => {
    const ratio = (v - yMin) / (yMax - yMin)
    return h - pad - ratio * (h - pad * 2)
  }
  const coords = points.map((p, i) => ({ x: pad + i * stepX, y: yScale(p.v) }))
  const linePath = coords.map((c, i) => `${i === 0 ? 'M' : 'L'} ${c.x.toFixed(1)} ${c.y.toFixed(1)}`).join(' ')
  const fillPath = `${linePath} L ${coords[coords.length - 1].x.toFixed(1)} ${h - pad} L ${coords[0].x.toFixed(1)} ${h - pad} Z`
  const gradientId = `spark-grad-${Math.random().toString(36).slice(2, 9)}`

  return (
    <svg width={w} height={h} viewBox={`0 0 ${w} ${h}`} className="block">
      <defs>
        <linearGradient id={gradientId} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor={fillFrom} />
          <stop offset="100%" stopColor={fillTo} />
        </linearGradient>
      </defs>
      <path d={fillPath} fill={`url(#${gradientId})`} stroke="none" />
      <path d={linePath} fill="none" stroke={stroke} strokeWidth="1.5" strokeLinejoin="round" strokeLinecap="round" />
    </svg>
  )
}
