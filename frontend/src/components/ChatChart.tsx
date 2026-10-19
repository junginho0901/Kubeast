import { useEffect, useMemo, useRef, useState } from 'react'
import { Maximize2 } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { ModalFrame } from '@/components/ModalFrame'
import { modalButton } from '@/components/modalStyles'
import {
  SERIES_COLORS, chartsOf, extent, formatTimeTick, formatValue, nearest, niceTicks, type ChatChartData,
} from '@/utils/chatChart'

// The graphs the AI asked to show under its answer (AI Chat and the floating chat draw the same thing). Size follows
// the box the answer sits in: a narrow one (the floating chat) gets a low graph and a short legend, and every graph
// opens larger in a window.

const NARROW = 520

function useWidth<T extends HTMLElement>() {
  const ref = useRef<T>(null)
  const [width, setWidth] = useState(0)
  useEffect(() => {
    const el = ref.current
    if (!el) return
    setWidth(el.clientWidth)
    const ro = new ResizeObserver(([entry]) => setWidth(Math.round(entry.contentRect.width)))
    ro.observe(el)
    return () => ro.disconnect()
  }, [])
  return { ref, width }
}

interface PlotProps {
  chart: ChatChartData
  width: number
  height: number
}

function Plot({ chart, width, height }: PlotProps) {
  const [hoverT, setHoverT] = useState<number | null>(null)
  const narrow = width < NARROW
  const m = { top: 6, right: 8, bottom: 18, left: narrow ? 44 : 60 }
  const w = Math.max(10, width - m.left - m.right)
  const h = Math.max(10, height - m.top - m.bottom)
  const { t0, t1, v0, v1 } = useMemo(() => extent(chart.series), [chart.series])
  const x = (t: number) => m.left + ((t - t0) / (t1 - t0)) * w
  const y = (v: number) => m.top + h - ((v - v0) / (v1 - v0)) * h
  const vTicks = niceTicks(v0, v1, narrow ? 3 : 4)
  const tTicks = niceTicks(t0, t1, Math.max(2, Math.floor(w / 90)))
  const hover = hoverT === null ? null : chart.series
    .map((s, i) => ({ label: s.label, color: SERIES_COLORS[i % SERIES_COLORS.length], p: nearest(s.points, hoverT) }))
    .filter((s) => s.p !== null)
    .sort((a, b) => (b.p![1] - a.p![1]))
  const hoverX = hover && hover[0] ? x(hover[0].p![0]) : 0

  return (
    <div className="relative" onMouseLeave={() => setHoverT(null)}>
      <svg
        width={width}
        height={height}
        role="img"
        aria-label={chart.title}
        data-testid="chat-chart-plot"
        className="block select-none"
        onMouseMove={(e) => {
          const rect = e.currentTarget.getBoundingClientRect()
          const px = e.clientX - rect.left
          setHoverT(px < m.left || px > m.left + w ? null : t0 + ((px - m.left) / w) * (t1 - t0))
        }}
      >
        {vTicks.map((v) => (
          <g key={`v${v}`}>
            <line x1={m.left} x2={m.left + w} y1={y(v)} y2={y(v)} stroke="currentColor" className="text-slate-600/50" />
            <text x={m.left - 6} y={y(v) + 3} textAnchor="end" className="fill-slate-400 text-[10px]">{formatValue(v, chart.unit)}</text>
          </g>
        ))}
        {tTicks.map((t) => (
          <text key={`t${t}`} x={x(t)} y={height - 4} textAnchor="middle" className="fill-slate-400 text-[10px]">
            {formatTimeTick(t, t1 - t0)}
          </text>
        ))}
        {chart.series.map((s, i) => (
          <polyline
            key={s.label + i}
            fill="none"
            stroke={SERIES_COLORS[i % SERIES_COLORS.length]}
            strokeWidth={1.5}
            strokeLinejoin="round"
            points={s.points.filter(([t, v]) => Number.isFinite(t) && Number.isFinite(v)).map(([t, v]) => `${x(t)},${y(v)}`).join(' ')}
          />
        ))}
        {hover && hover.length > 0 && <line x1={hoverX} x2={hoverX} y1={m.top} y2={m.top + h} stroke="currentColor" className="text-slate-400" />}
      </svg>
      {hover && hover.length > 0 && (
        <div
          className="pointer-events-none absolute top-1 z-10 max-w-[70%] rounded-md border border-slate-600 bg-slate-900/95 px-2 py-1.5 text-[11px] text-slate-200 shadow-lg"
          style={hoverX > width / 2 ? { right: width - hoverX + 8 } : { left: hoverX + 8 }}
          data-testid="chat-chart-tooltip"
        >
          <div className="mb-1 text-slate-400">{formatTimeTick(hover[0].p![0], 86401)}</div>
          {hover.slice(0, narrow ? 4 : 10).map((s) => (
            <div key={s.label} className="flex items-center gap-1.5 whitespace-nowrap">
              <span className="inline-block h-2 w-2 shrink-0 rounded-full" style={{ background: s.color }} />
              <span className="truncate">{s.label}</span>
              <span className="ml-auto pl-2 font-mono">{formatValue(s.p![1], chart.unit)}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

// One line needs no legend: the title names it.
function Legend({ chart, max }: { chart: ChatChartData; max: number }) {
  const { t } = useTranslation()
  const shown = chart.series.slice(0, max)
  const more = chart.series.length - shown.length + (chart.hidden_series ?? 0)
  if (chart.series.length === 1 && more === 0) return null
  return (
    <div className="mt-1.5 flex flex-wrap gap-x-3 gap-y-0.5 text-[11px] text-slate-300" data-testid="chat-chart-legend">
      {shown.map((s, i) => (
        <span key={s.label + i} className="flex min-w-0 max-w-full items-center gap-1" title={s.label}>
          <span className="inline-block h-2 w-2 shrink-0 rounded-full" style={{ background: SERIES_COLORS[i % SERIES_COLORS.length] }} />
          <span className="truncate">{s.label}</span>
        </span>
      ))}
      {more > 0 && <span className="text-slate-400">{t('aiChat.chart.moreSeries', { count: more })}</span>}
    </div>
  )
}

export function ChatChart({ chart }: { chart: ChatChartData }) {
  const { t } = useTranslation()
  const { ref, width } = useWidth<HTMLDivElement>()
  const [large, setLarge] = useState(false)
  const narrow = width > 0 && width < NARROW
  const common = Object.entries(chart.common_labels ?? {}).map(([k, v]) => `${k}=${v}`).join(', ')
  return (
    <div
      ref={ref}
      className="not-prose mt-3 rounded-lg border border-slate-600/70 bg-slate-900/40 p-2.5"
      data-testid="chat-chart"
      data-narrow={narrow ? 'true' : 'false'}
      data-series={chart.series.length}
    >
      <div className="mb-1 flex items-center gap-2">
        <span className="min-w-0 truncate text-xs font-semibold text-slate-200" title={chart.promql}>{chart.title}</span>
        <button
          type="button"
          onClick={() => setLarge(true)}
          className="ml-auto flex shrink-0 items-center gap-1 rounded-sm px-1.5 py-0.5 text-[11px] text-slate-300 hover:bg-slate-700 hover:text-white"
          data-testid="chat-chart-enlarge"
        >
          <Maximize2 className="h-3 w-3" />
          {t('aiChat.chart.viewLarger')}
        </button>
      </div>
      {width > 0 && <Plot chart={chart} width={width - 20} height={narrow ? 140 : 220} />}
      <Legend chart={chart} max={narrow ? 3 : 10} />
      {large && (
        <ModalFrame
          title={chart.title}
          subtitle={<span className="font-mono text-[11px]">{chart.promql}</span>}
          size="lg"
          zIndex={1400}
          onClose={() => setLarge(false)}
          testId="chat-chart-large"
          footer={<button type="button" className={modalButton.cancel} onClick={() => setLarge(false)}>{t('common.close')}</button>}
        >
          <LargePlot chart={chart} />
          {common && <p className="mt-2 text-[11px] text-slate-400">{common}</p>}
        </ModalFrame>
      )}
    </div>
  )
}

function LargePlot({ chart }: { chart: ChatChartData }) {
  const { ref, width } = useWidth<HTMLDivElement>()
  return (
    <div ref={ref}>
      {width > 0 && <Plot chart={chart} width={width} height={360} />}
      <Legend chart={chart} max={chart.series.length} />
    </div>
  )
}

// Every graph of a message's tool calls, in call order.
export function ChatCharts({ toolCalls }: { toolCalls?: unknown[] }) {
  const charts = chartsOf(toolCalls)
  if (charts.length === 0) return null
  return (
    <div data-testid="chat-charts">
      {charts.map((c, i) => <ChatChart key={`${c.promql}-${i}`} chart={c} />)}
    </div>
  )
}
