import { useState } from 'react'

// Flat bar chart for the dashboard's pod / node status counts. One clickable
// <g> per bar (the dashboard e2e clicks the first one); a bar's colour comes
// from colorFor(name) so a state reads the same everywhere on the page.

interface StatusBarChartProps {
  data: { name: string; value: number }[]
  colorFor: (name: string) => string
  chartHeight?: number
  onBarClick?: (name: string) => void
}

export function StatusBarChart({ data, colorFor, chartHeight = 340, onBarClick }: StatusBarChartProps) {
  const [hovered, setHovered] = useState<number | null>(null)

  const VW = 540, VH = 340
  const M = { t: 24, r: 16, b: 36, l: 40 }
  const CW = VW - M.l - M.r
  const CH = VH - M.t - M.b

  const maxVal = Math.max(...data.map(d => d.value), 1)
  const niceMax = Math.ceil(maxVal / 10) * 10 || 10
  // five steps of a multiple of ten stay whole numbers (0, 2, 4 … 10 / 0, 8, 16 … 40)
  const ticks = Array.from({ length: 6 }, (_, i) => niceMax * i / 5)

  const groupW = CW / data.length
  const barW = Math.min(groupW * 0.5, 48)
  const baseY = M.t + CH

  return (
    <svg width="100%" height={chartHeight} viewBox={`0 0 ${VW} ${VH}`} preserveAspectRatio="xMidYMid meet">
      {ticks.map(tick => {
        const y = baseY - (tick / niceMax) * CH
        return (
          <g key={`yt-${tick}`}>
            <line x1={M.l} y1={y} x2={M.l + CW} y2={y} stroke={tick === 0 ? '#475569' : '#334155'} strokeWidth={tick === 0 ? 1 : 0.5} />
            <text x={M.l - 8} y={y + 3.5} textAnchor="end" fill="#94a3b8" fontSize={10}>{tick}</text>
          </g>
        )
      })}

      {data.map((d, i) => {
        const barH = d.value > 0 ? Math.max((d.value / niceMax) * CH, 3) : 0
        const bx = M.l + i * groupW + (groupW - barW) / 2
        const by = baseY - barH
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
            {/* the whole column takes the click, so a 0 is as easy to hit as a tall bar */}
            <rect x={M.l + i * groupW} y={M.t} width={groupW} height={CH} fill="transparent" />
            {barH > 0 && <rect x={bx} y={by} width={barW} height={barH} rx={3} fill={colorFor(d.name)} />}
            <text x={bx + barW / 2} y={by - 6} textAnchor="middle" fill="#e2e8f0" fontSize={11} fontWeight={600}>{d.value}</text>
          </g>
        )
      })}

      {data.map((d, i) => (
        <text
          key={`xl-${d.name}`}
          x={M.l + i * groupW + groupW / 2}
          y={baseY + 20}
          textAnchor="middle"
          fill="#94a3b8"
          fontSize={10.5}
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
