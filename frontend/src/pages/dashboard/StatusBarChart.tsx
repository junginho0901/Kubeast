import { useState } from 'react'

// Bar chart for the dashboard's pod / node status counts. One clickable <g> per
// bar (the dashboard e2e clicks the first one); a bar's colour comes from
// colorFor(name) so a state reads the same everywhere on the page. A bar has a
// thin top and side of its own colour, lighter and darker (DESIGN.md Charts):
// no gradient, glow or animation, and the axes stay flat.

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
  const DEPTH_X = 4.25, DEPTH_Y = -2.75

  return (
    <svg width="100%" height={chartHeight} viewBox={`0 0 ${VW} ${VH}`} preserveAspectRatio="xMidYMid meet">
      {ticks.map(tick => {
        const y = baseY - (tick / niceMax) * CH
        return (
          <g key={`yt-${tick}`}>
            <line x1={M.l} y1={y} x2={M.l + CW} y2={y} stroke={tick === 0 ? 'var(--color-slate-600)' : 'var(--color-slate-700)'} strokeWidth={tick === 0 ? 1 : 0.5} />
            <text x={M.l - 8} y={y + 3.5} textAnchor="end" fill="var(--color-slate-400)" fontSize={10}>{tick}</text>
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
            {barH > 0 && (
              <>
                <rect x={bx} y={by} width={barW} height={barH} fill={colorFor(d.name)} />
                <polygon
                  points={`${bx},${by} ${bx + DEPTH_X},${by + DEPTH_Y} ${bx + barW + DEPTH_X},${by + DEPTH_Y} ${bx + barW},${by}`}
                  fill={`color-mix(in oklab, ${colorFor(d.name)} 68%, white)`}
                />
                <polygon
                  points={`${bx + barW},${by} ${bx + barW + DEPTH_X},${by + DEPTH_Y} ${bx + barW + DEPTH_X},${baseY + DEPTH_Y} ${bx + barW},${baseY}`}
                  fill={`color-mix(in oklab, ${colorFor(d.name)} 62%, black)`}
                />
              </>
            )}
            <text x={bx + barW / 2 + 2} y={by - 9} textAnchor="middle" fill="var(--color-slate-200)" fontSize={11} fontWeight={600}>{d.value}</text>
          </g>
        )
      })}

      {data.map((d, i) => (
        <text
          key={`xl-${d.name}`}
          x={M.l + i * groupW + groupW / 2}
          y={baseY + 20}
          textAnchor="middle"
          fill="var(--color-slate-400)"
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
