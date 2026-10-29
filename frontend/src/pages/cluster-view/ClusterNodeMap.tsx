import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import type { NodeEntry } from './hooks/useClusterDerived'
import { GAP, layoutMap } from './nodeMapLayout'

// Every node at a glance: a cell per node in the boxes' order, a dot per pod in the cards' colour (errors first, then
// warnings, then the rest, so a problem is never at the end of a cell). Canvas 2D, one fillRect per dot — static, so
// 100 000 dots draw in milliseconds. The cell is large enough to hold the busiest node's dots, so no pod is left out.
// A click scrolls to that node's box.

function cssColor(name: string, fallback: string): string {
  const v = getComputedStyle(document.documentElement).getPropertyValue(name).trim()
  return v || fallback
}

interface Props {
  entries: NodeEntry[]
  onSelect: (index: number) => void
  tr: (key: string, fallback: string, options?: Record<string, any>) => string
}

export function ClusterNodeMap({ entries, onSelect, tr }: Props) {
  const wrapRef = useRef<HTMLDivElement>(null)
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const [width, setWidth] = useState(0)
  const [hover, setHover] = useState<number | null>(null)
  const [mode, setMode] = useState(0) // bumps when the colour mode changes, to redraw

  useLayoutEffect(() => {
    const el = wrapRef.current
    if (!el) return
    setWidth(el.clientWidth)
    const ro = new ResizeObserver(() => setWidth(el.clientWidth))
    ro.observe(el)
    return () => ro.disconnect()
  }, [])
  useEffect(() => {
    const mo = new MutationObserver(() => setMode((m) => m + 1))
    mo.observe(document.documentElement, { attributes: true, attributeFilter: ['data-color-mode', 'class'] })
    return () => mo.disconnect()
  }, [])

  const layout = useMemo(() => layoutMap(width || 1, entries), [width, entries])

  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas || !width) return
    const ratio = window.devicePixelRatio || 1
    canvas.width = Math.round(width * ratio)
    canvas.height = Math.round(layout.height * ratio)
    const ctx = canvas.getContext('2d')
    if (!ctx) return
    ctx.setTransform(ratio, 0, 0, ratio, 0, 0)
    ctx.clearRect(0, 0, width, layout.height)
    const colors = {
      cell: cssColor('--color-slate-700', '#334155'), // the pod cards' ground
      error: cssColor('--color-red-400', '#f87171'),
      warn: cssColor('--color-yellow-400', '#facc15'),
      ok: cssColor('--color-green-400', '#4ade80'),
    }
    const { cell, cols, per, dot } = layout
    // cells first, then each colour in one pass (fewer fillStyle changes)
    ctx.fillStyle = colors.cell
    entries.forEach((_, i) => {
      ctx.fillRect((i % cols) * (cell + GAP), Math.floor(i / cols) * (cell + GAP), cell, cell)
    })
    for (const [key, color] of [['error', colors.error], ['warn', colors.warn], ['ok', colors.ok]] as const) {
      ctx.fillStyle = color
      entries.forEach((e, i) => {
        const x0 = (i % cols) * (cell + GAP) + 2
        const y0 = Math.floor(i / cols) * (cell + GAP) + 2
        const start = key === 'error' ? 0 : key === 'warn' ? e.counts.error : e.counts.error + e.counts.warn
        const count = e.counts[key]
        for (let k = start; k < start + count; k++) {
          ctx.fillRect(x0 + (k % per) * dot, y0 + Math.floor(k / per) * dot, Math.max(1, dot - (dot > 2 ? 1 : 0)), Math.max(1, dot - (dot > 2 ? 1 : 0)))
        }
      })
    }
    if (hover !== null && hover < entries.length) {
      ctx.strokeStyle = cssColor('--color-primary-400', '#38bdf8')
      ctx.lineWidth = 2
      ctx.strokeRect((hover % cols) * (cell + GAP) + 1, Math.floor(hover / cols) * (cell + GAP) + 1, cell - 2, cell - 2)
    }
  }, [entries, layout, width, hover, mode])

  const indexAt = (ev: React.MouseEvent<HTMLCanvasElement>) => {
    const rect = ev.currentTarget.getBoundingClientRect()
    const x = ev.clientX - rect.left
    const y = ev.clientY - rect.top
    const col = Math.floor(x / (layout.cell + GAP))
    const row = Math.floor(y / (layout.cell + GAP))
    const inCell = x % (layout.cell + GAP) < layout.cell && y % (layout.cell + GAP) < layout.cell
    const i = row * layout.cols + col
    return inCell && col < layout.cols && i < entries.length ? i : null
  }

  if (entries.length === 0) return null
  const totals = entries.reduce((t, e) => ({ pods: t.pods + e.counts.total, error: t.error + e.counts.error, warn: t.warn + e.counts.warn }), { pods: 0, error: 0, warn: 0 })
  const h = hover !== null ? entries[hover] : null

  return (
    <div className="card" data-testid="cluster-view-map">
      <div ref={wrapRef} className="w-full">
        <canvas
          ref={canvasRef}
          role="img"
          aria-label={tr('clusterView.map.aria', 'Node map: {{nodes}} nodes, {{pods}} pods ({{error}} errors, {{warn}} warnings)', { nodes: entries.length, pods: totals.pods, error: totals.error, warn: totals.warn })}
          data-cells={JSON.stringify(entries.map((e) => [e.node, e.counts.ok, e.counts.warn, e.counts.error]))}
          style={{ width: '100%', height: layout.height, cursor: h ? 'pointer' : 'default' }}
          onMouseMove={(ev) => setHover(indexAt(ev))}
          onMouseLeave={() => setHover(null)}
          onClick={(ev) => {
            const i = indexAt(ev)
            if (i !== null) onSelect(i)
          }}
        />
      </div>
      <div className="mt-3 flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-slate-400 min-h-[16px]" data-testid="cluster-view-map-legend">
        {h ? (
          <span className="text-ink">
            {tr('clusterView.map.hover', '{{node}} · {{total}} pods · {{error}} errors · {{warn}} warnings', { node: h.label, total: h.counts.total, error: h.counts.error, warn: h.counts.warn })}
          </span>
        ) : (
          <>
            <span className="inline-flex items-center gap-1.5"><span className="inline-block h-2 w-2 rounded-sm bg-red-400" />{tr('clusterView.map.error', 'Error')} {totals.error}</span>
            <span className="inline-flex items-center gap-1.5"><span className="inline-block h-2 w-2 rounded-sm bg-yellow-400" />{tr('clusterView.map.warn', 'Warning')} {totals.warn}</span>
            <span className="inline-flex items-center gap-1.5"><span className="inline-block h-2 w-2 rounded-sm bg-green-400" />{tr('clusterView.map.ok', 'Healthy')} {totals.pods - totals.error - totals.warn}</span>
            <span>{tr('clusterView.map.hint', 'A cell is a node, a dot a pod. Click a cell to go to the node.')}</span>
          </>
        )}
      </div>
    </div>
  )
}
