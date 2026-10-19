// A graph the AI asked to show under its answer (prometheus_query chart=true, ai-service app/services/ai/charts.py):
// the data, and the scale, tick and value helpers the chat's ChatChart draws with.

export interface ChatChartSeries {
  label: string
  points: [number, number][] // [unix seconds, value]
}

export interface ChatChartData {
  title: string
  unit: '' | 'bytes' | 'percent' | 'cores' | 'seconds' | 'count' | 'rate'
  promql: string
  start?: string
  end?: string
  step_seconds?: number
  common_labels?: Record<string, string>
  series: ChatChartSeries[]
  hidden_series?: number
  truncated?: boolean
}

// The charts of a message's tool calls, in call order; anything not shaped like one is skipped, and a chart the AI
// redid under the same title replaces the earlier one.
export function chartsOf(toolCalls: unknown[] | undefined): ChatChartData[] {
  const charts = (toolCalls ?? [])
    .map((tc) => (tc && typeof tc === 'object' ? (tc as { chart?: unknown }).chart : undefined))
    .filter((c): c is ChatChartData => {
      const s = (c as ChatChartData | undefined)?.series
      return Array.isArray(s) && s.some((x) => Array.isArray(x?.points) && x.points.length > 0)
    })
  return charts.filter((c, i) => !charts.slice(i + 1).some((later) => later.title === c.title))
}

// Series colours: distinct on the dark chat bubbles, in this order.
export const SERIES_COLORS = ['#38bdf8', '#a78bfa', '#34d399', '#fbbf24', '#f87171', '#f472b6', '#22d3ee', '#a3e635', '#fb923c', '#c084fc']

export function extent(series: ChatChartSeries[]): { t0: number; t1: number; v0: number; v1: number } {
  let t0 = Infinity, t1 = -Infinity, v0 = Infinity, v1 = -Infinity
  for (const s of series) {
    for (const [t, v] of s.points) {
      if (!Number.isFinite(t) || !Number.isFinite(v)) continue
      t0 = Math.min(t0, t); t1 = Math.max(t1, t)
      v0 = Math.min(v0, v); v1 = Math.max(v1, v)
    }
  }
  if (!Number.isFinite(t0)) return { t0: 0, t1: 1, v0: 0, v1: 1 }
  if (t1 === t0) t1 = t0 + 1
  // The value axis starts at zero unless every value is below it; a flat line gets room above.
  v0 = Math.min(0, v0)
  if (v1 <= v0) v1 = v0 + 1
  return { t0, t1, v0, v1 }
}

// About `count` round ticks covering [min, max] (1, 2, 2.5 or 5 times a power of ten apart).
export function niceTicks(min: number, max: number, count = 4): number[] {
  const span = max - min
  if (!(span > 0)) return [min]
  const raw = span / Math.max(1, count)
  const mag = Math.pow(10, Math.floor(Math.log10(raw)))
  const step = [1, 2, 2.5, 5, 10].map((m) => m * mag).find((s) => s >= raw) ?? 10 * mag
  const out: number[] = []
  for (let v = Math.ceil(min / step) * step; v <= max + step * 1e-9; v += step) out.push(Number(v.toFixed(10)))
  return out
}

const BYTE_UNITS = ['B', 'KiB', 'MiB', 'GiB', 'TiB', 'PiB']

function short(v: number): string {
  const a = Math.abs(v)
  if (a >= 100) return v.toFixed(0)
  if (a >= 10) return v.toFixed(1).replace(/\.0$/, '')
  return v.toFixed(2).replace(/\.?0+$/, '')
}

export function formatValue(v: number, unit: ChatChartData['unit']): string {
  if (!Number.isFinite(v)) return '-'
  switch (unit) {
    case 'bytes': {
      let i = 0
      let x = v
      while (Math.abs(x) >= 1024 && i < BYTE_UNITS.length - 1) { x /= 1024; i++ }
      return `${short(x)} ${BYTE_UNITS[i]}`
    }
    case 'percent':
      return `${short(v)}%`
    case 'cores':
      return Math.abs(v) < 1 && v !== 0 ? `${short(v * 1000)}m` : short(v)
    case 'seconds':
      return Math.abs(v) < 1 && v !== 0 ? `${short(v * 1000)} ms` : `${short(v)} s`
    case 'rate':
      return `${short(v)}/s`
    default: {
      const a = Math.abs(v)
      if (a >= 1e9) return `${short(v / 1e9)}G`
      if (a >= 1e6) return `${short(v / 1e6)}M`
      if (a >= 1e3) return `${short(v / 1e3)}k`
      return short(v)
    }
  }
}

// A time tick in the viewer's zone: HH:mm within a day, MM-DD HH:mm across days.
export function formatTimeTick(t: number, spanSeconds: number): string {
  const d = new Date(t * 1000)
  const p = (n: number) => String(n).padStart(2, '0')
  const hm = `${p(d.getHours())}:${p(d.getMinutes())}`
  return spanSeconds > 86400 ? `${p(d.getMonth() + 1)}-${p(d.getDate())} ${hm}` : hm
}

// The point of a series nearest to time t (points are in time order).
export function nearest(points: [number, number][], t: number): [number, number] | null {
  if (points.length === 0) return null
  let lo = 0, hi = points.length - 1
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1
    if (points[mid][0] <= t) lo = mid
    else hi = mid
  }
  return Math.abs(points[lo][0] - t) <= Math.abs(points[hi][0] - t) ? points[lo] : points[hi]
}
