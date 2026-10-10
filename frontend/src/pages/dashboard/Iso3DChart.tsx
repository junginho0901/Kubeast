import { useState } from 'react'

interface Iso3DChartColors {
  front: [string, string]
  side: string
  top: string
  accent: string
}

interface Iso3DChartProps {
  data: { name: string; value: number }[]
  chartHeight?: number
  colors: Iso3DChartColors
  uid: string
  onBarClick?: (name: string) => void
}

export function Iso3DChart({
  data,
  chartHeight = 340,
  colors,
  uid,
  onBarClick,
}: Iso3DChartProps) {
  const [hovered, setHovered] = useState<number | null>(null)

  const VW = 540, VH = 340
  const M = { t: 30, r: 55, b: 40, l: 48 }
  const CW = VW - M.l - M.r
  const CH = VH - M.t - M.b

  const DX = 22, DY = -11
  const BDX = 16, BDY = -8

  const maxVal = Math.max(...data.map(d => d.value), 1)
  const niceMax = Math.ceil(maxVal / 10) * 10 || 10

  const n = data.length
  const groupW = CW / n
  const barW = Math.min(groupW * 0.48, 52)

  const baseY = M.t + CH
  const yTicks = 5
  const ticks = Array.from({ length: yTicks + 1 }, (_, i) =>
    Math.round(niceMax * i / yTicks)
  )

  const gF = `iso-f-${uid}`
  const gW = `iso-w-${uid}`

  return (
    <div style={{ width: '100%' }}>
      <style>{`
        @keyframes iso-grow-${uid} {
          from { transform: scaleY(0); }
          to   { transform: scaleY(1); }
        }
      `}</style>
      <svg
        width="100%"
        height={chartHeight}
        viewBox={`0 0 ${VW} ${VH}`}
        preserveAspectRatio="xMidYMid meet"
      >
        <defs>
          <linearGradient id={gF} x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor={colors.front[0]} />
            <stop offset="100%" stopColor={colors.front[1]} />
          </linearGradient>
          <linearGradient id={`${gF}-floor`} x1="0" y1="0" x2="0.3" y2="1">
            <stop offset="0%" stopColor={colors.accent} stopOpacity={0.07} />
            <stop offset="100%" stopColor={colors.accent} stopOpacity={0.02} />
          </linearGradient>
          <linearGradient id={gW} x1="1" y1="0" x2="0" y2="0">
            <stop offset="0%" stopColor={colors.accent} stopOpacity={0.05} />
            <stop offset="100%" stopColor={colors.accent} stopOpacity={0.01} />
          </linearGradient>
        </defs>

        {/* ═══ LEFT WALL ═══ */}
        <polygon
          points={`${M.l},${baseY} ${M.l + DX},${baseY + DY} ${M.l + DX},${M.t + DY} ${M.l},${M.t}`}
          fill={`url(#${gW})`}
        />
        {ticks.map(tick => {
          if (tick === 0) return null
          const y = baseY - (tick / niceMax) * CH
          return (
            <line key={`lw-${tick}`}
              x1={M.l} y1={y} x2={M.l + DX} y2={y + DY}
              stroke={colors.accent} strokeWidth={0.5} opacity={0.1}
            />
          )
        })}
        <line x1={M.l} y1={M.t} x2={M.l} y2={baseY}
          stroke={colors.accent} strokeWidth={0.6} opacity={0.12} />

        {/* ═══ BACK WALL (no dashed lines, just subtle fill) ═══ */}
        <polygon
          points={`${M.l + DX},${baseY + DY} ${M.l + CW + DX},${baseY + DY} ${M.l + CW + DX},${M.t + DY} ${M.l + DX},${M.t + DY}`}
          fill={`url(#${gW})`}
        />

        {/* ═══ FLOOR PLANE ═══ */}
        <polygon
          points={`${M.l},${baseY} ${M.l + CW},${baseY} ${M.l + CW + DX},${baseY + DY} ${M.l + DX},${baseY + DY}`}
          fill={`url(#${gF}-floor)`}
        />
        {data.map((_, i) => {
          const x = M.l + i * groupW + groupW / 2
          return (
            <line key={`fd-${i}`}
              x1={x} y1={baseY} x2={x + DX} y2={baseY + DY}
              stroke={colors.accent} strokeWidth={0.4} opacity={0.08}
            />
          )
        })}
        {[0.5, 1].map(t => (
          <line key={`fc-${t}`}
            x1={M.l + DX * t} y1={baseY + DY * t}
            x2={M.l + CW + DX * t} y2={baseY + DY * t}
            stroke={colors.accent} strokeWidth={0.3} opacity={0.06}
          />
        ))}

        {/* Floor edges */}
        <line x1={M.l} y1={baseY} x2={M.l + CW} y2={baseY}
          stroke={colors.accent} strokeWidth={1.2} opacity={0.2} />
        <line x1={M.l + CW} y1={baseY} x2={M.l + CW + DX} y2={baseY + DY}
          stroke={colors.accent} strokeWidth={0.6} opacity={0.12} />
        <line x1={M.l} y1={baseY} x2={M.l + DX} y2={baseY + DY}
          stroke={colors.accent} strokeWidth={0.5} opacity={0.08} />

        {/* ═══ Y AXIS LABELS + subtle front lines ═══ */}
        {ticks.map(tick => {
          const y = baseY - (tick / niceMax) * CH
          return (
            <g key={`yt-${tick}`}>
              {tick > 0 && (
                <line x1={M.l} y1={y} x2={M.l + CW} y2={y}
                  stroke={colors.accent} strokeWidth={0.25} opacity={0.05} />
              )}
              <text x={M.l - 10} y={y + 3.5}
                textAnchor="end" fill="#64748b" fontSize={10}
              >
                {tick}
              </text>
            </g>
          )
        })}

        {/* ═══ 3D BARS (animated) ═══ */}
        {data.map((d, i) => {
          const rawH = (d.value / niceMax) * CH
          const barH = Math.max(rawH, d.value > 0 ? 5 : 0)
          const bx = M.l + i * groupW + (groupW - barW) / 2
          // the value stays readable without hovering, a 0 included
          const valueLabel = (y: number) => (
            <text x={bx + barW / 2 + BDX / 2} y={y} textAnchor="middle" fill="#e2e8f0" fontSize={11} fontWeight={600}>
              {d.value}
            </text>
          )
          if (barH <= 0) return <g key={d.name}>{valueLabel(baseY + BDY - 6)}</g>

          const by = baseY - barH
          const isHov = hovered === i
          const delay = i * 0.08

          return (
            <g key={d.name}
              style={{
                cursor: 'pointer',
                transition: 'opacity 0.2s',
                transformOrigin: `${bx + barW / 2}px ${baseY}px`,
                animation: `iso-grow-${uid} 0.7s cubic-bezier(0.34,1.56,0.64,1) ${delay}s both`,
              }}
              onMouseEnter={() => setHovered(i)}
              onMouseLeave={() => setHovered(null)}
              onClick={() => onBarClick?.(d.name)}
              opacity={hovered !== null && !isHov ? 0.5 : 1}
            >
              {/* Floor shadow */}
              <polygon
                points={`${bx + 2},${baseY} ${bx + barW + 2},${baseY} ${bx + barW + BDX + 2},${baseY + BDY} ${bx + BDX + 2},${baseY + BDY}`}
                fill="#000" opacity={0.08}
              />

              {/* FRONT FACE */}
              <rect x={bx} y={by} width={barW} height={barH}
                fill={`url(#${gF})`}
                stroke={isHov ? colors.front[0] : 'transparent'}
                strokeWidth={isHov ? 1.2 : 0}
              />

              {/* RIGHT SIDE FACE */}
              <polygon
                points={`${bx + barW},${by} ${bx + barW + BDX},${by + BDY} ${bx + barW + BDX},${baseY + BDY} ${bx + barW},${baseY}`}
                fill={colors.side}
              />

              {/* TOP FACE */}
              <polygon
                points={`${bx},${by} ${bx + BDX},${by + BDY} ${bx + barW + BDX},${by + BDY} ${bx + barW},${by}`}
                fill={colors.top}
              />

              {/* Top face front edge */}
              <line x1={bx} y1={by} x2={bx + barW} y2={by}
                stroke="#fff" strokeWidth={0.5} opacity={0.1} />

              {valueLabel(by + BDY - 6)}
            </g>
          )
        })}

        {/* ═══ X AXIS LABELS ═══ */}
        {data.map((d, i) => {
          const x = M.l + i * groupW + groupW / 2
          return (
            <text key={`xl-${i}`}
              x={x} y={baseY + 20}
              textAnchor="middle" fill="#94a3b8"
              fontSize={10.5} fontWeight={500}
              style={{ cursor: 'pointer' }}
              onClick={() => onBarClick?.(d.name)}
            >
              {d.name}
            </text>
          )
        })}
      </svg>
    </div>
  )
}

export type { Iso3DChartColors }
