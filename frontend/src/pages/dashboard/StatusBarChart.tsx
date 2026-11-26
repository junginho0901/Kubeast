import { useState } from 'react'

// Dashboard status counts, with one clickable row per state.

interface StatusBarChartProps {
  data: { name: string; value: number }[]
  colorFor: (name: string) => string
  chartHeight?: number
  onBarClick?: (name: string) => void
}

export function StatusBarChart({ data, colorFor, chartHeight = 180, onBarClick }: StatusBarChartProps) {
  const [hovered, setHovered] = useState<number | null>(null)

  const VW = 540, VH = 180
  const M = { t: 8, r: 36, b: 8, l: 100 }
  const CW = VW - M.l - M.r
  const CH = VH - M.t - M.b

  const maxVal = Math.max(...data.map(d => d.value), 1)
  const niceMax = Math.ceil(maxVal / 10) * 10 || 10
  const rowHeight = CH / data.length
  const barHeight = 6

  return (
    <svg width="100%" height={chartHeight} viewBox={`0 0 ${VW} ${VH}`} preserveAspectRatio="xMidYMid meet">
      {data.map((d, i) => {
        const barWidth = d.value > 0 ? Math.max((d.value / niceMax) * CW, 3) : 0
        const y = M.t + i * rowHeight + rowHeight / 2
        return (
          <g
            key={d.name}
            style={{ cursor: 'pointer' }}
            opacity={hovered !== null && hovered !== i ? 0.55 : 1}
            onMouseEnter={() => setHovered(i)}
            onMouseLeave={() => setHovered(null)}
            onClick={() => onBarClick?.(d.name)}
          >
            <title>{`${d.name}: ${d.value}`}</title>
            <rect x={0} y={M.t + i * rowHeight} width={VW} height={rowHeight} fill="transparent" />
            <rect x={M.l} y={y - barHeight / 2} width={CW} height={barHeight} rx={3} fill="var(--color-slate-700)" />
            {barWidth > 0 && <rect x={M.l} y={y - barHeight / 2} width={barWidth} height={barHeight} rx={3} fill={colorFor(d.name)} />}
            <text x={VW - 2} y={y + 4} textAnchor="end" fill="var(--color-slate-200)" fontSize={12} fontWeight={500}>{d.value}</text>
          </g>
        )
      })}

      {data.map((d, i) => (
        <text
          key={`xl-${d.name}`}
          x={0}
          y={M.t + i * rowHeight + rowHeight / 2 + 4}
          textAnchor="start"
          fill="var(--color-slate-400)"
          fontSize={12}
          fontWeight={500}
          style={{ cursor: 'pointer' }}
          onClick={() => onBarClick?.(d.name)}
        >
          {d.name}
        </text>
      ))}
    </svg>
  )
}
