import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import type { NodeEntry } from './hooks/useClusterDerived'
import { GAP, layoutMap } from './nodeMapLayout'
import { nodeCordoned, nodeReadiness } from '@/utils/nodeStatus'

// Every node at a glance: a cell per node in the boxes' order, a dot per pod in the cards' colour (errors first, then
// warnings, then the rest, so a problem is never at the end of a cell). Canvas 2D, one fillRect per dot — static, so
// 100 000 dots draw in milliseconds. The cell is large enough to hold the busiest node's dots, so no pod is left out.
// While the boxes take more than one page, the cells of the page shown are outlined, and in a node's own view its cell.
// While a search is on, the nodes with no pod it matched are faded. A node not Ready (kubectl's NotReady or Unknown)
// has a red border, a cordoned one (SchedulingDisabled) a yellow one, from the live node list. A click opens that
// node's own view.

function cssColor(name: string, fallback: string): string {
  const v = getComputedStyle(document.documentElement).getPropertyValue(name).trim()
  return v || fallback
}

interface Props {
  entries: NodeEntry[]
  /** the cells of the boxes' page shown, [pageStart, pageEnd) in the map's order; equal when nothing is outlined */
  pageStart: number
  pageEnd: number
  onSelect: (index: number) => void
  tr: (key: string, fallback: string, options?: Record<string, any>) => string
}

export function ClusterNodeMap({ entries, pageStart, pageEnd, onSelect, tr }: Props) {
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
  // the node list's marks: not Ready first (red), else cordoned (yellow)
  const marks = useMemo(() => entries.map((e) => (!e.status ? null : nodeReadiness(e.status) !== 'Ready' ? 'notReady' : nodeCordoned(e.status) ? 'cordoned' : null)), [entries])

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
    // cells first, then each colour in one pass (fewer fillStyle changes); a node the search did not match is faded
    ctx.fillStyle = colors.cell
    entries.forEach((e, i) => {
      ctx.globalAlpha = e.dim ? 0.3 : 1
      ctx.fillRect((i % cols) * (cell + GAP), Math.floor(i / cols) * (cell + GAP), cell, cell)
    })
    ctx.globalAlpha = 1
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
    ctx.lineWidth = 2
    marks.forEach((m, i) => {
      if (!m) return
      ctx.strokeStyle = m === 'notReady' ? colors.error : colors.warn
      ctx.strokeRect((i % cols) * (cell + GAP) + 1, Math.floor(i / cols) * (cell + GAP) + 1, cell - 2, cell - 2)
    })
    if (pageEnd > pageStart) {
      ctx.strokeStyle = cssColor('--color-ink', '#fff')
      ctx.lineWidth = 1
      for (let i = pageStart; i < Math.min(pageEnd, entries.length); i++) {
        if (entries[i].dim) continue
        ctx.strokeRect((i % cols) * (cell + GAP) + 0.5, Math.floor(i / cols) * (cell + GAP) + 0.5, cell - 1, cell - 1)
      }
    }
    if (hover !== null && hover < entries.length) {
      ctx.strokeStyle = cssColor('--color-primary-400', '#38bdf8')
      ctx.lineWidth = 2
      ctx.strokeRect((hover % cols) * (cell + GAP) + 1, Math.floor(hover / cols) * (cell + GAP) + 1, cell - 2, cell - 2)
    }
  }, [entries, marks, layout, width, hover, mode, pageStart, pageEnd])

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
  const notReady = entries.filter((_, i) => marks[i] === 'notReady').length
  const cordoned = entries.filter((e) => !!e.status && nodeCordoned(e.status)).length
  const marked = Object.fromEntries(entries.filter((e, i) => marks[i] || (e.status && nodeCordoned(e.status))).map((e) => [e.node, e.status]))
  const aria = tr('clusterView.map.aria', 'Node map: {{nodes}} nodes, {{pods}} pods ({{error}} errors, {{warn}} warnings)', { nodes: entries.length, pods: totals.pods, error: totals.error, warn: totals.warn })

  return (
    <div className="card" data-testid="cluster-view-map" data-list-bounded="one canvas of every node: about 194 px tall at 1,000 nodes, about 1.5 screens at 5,000">
      <div ref={wrapRef} className="w-full">
        <canvas
          ref={canvasRef}
          role="img"
          aria-label={notReady + cordoned > 0 ? `${aria} ${tr('clusterView.map.ariaMarks', '{{notReady}} nodes not Ready, {{cordoned}} SchedulingDisabled.', { notReady, cordoned })}` : aria}
          data-cells={JSON.stringify(entries.map((e) => [e.node, e.counts.ok, e.counts.warn, e.counts.error]))}
          data-dim-cells={entries.some((e) => e.dim) ? entries.filter((e) => e.dim).length : undefined}
          data-node-marks={notReady + cordoned > 0 ? JSON.stringify(marked) : undefined}
          data-page-cells={pageEnd > pageStart ? `${pageStart},${pageEnd}` : undefined}
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
            {h.status && h.status !== 'Ready'
              ? tr('clusterView.map.hoverStatus', '{{node}} · {{status}} · {{total}} pods · {{error}} errors · {{warn}} warnings', { node: h.label, status: h.status, total: h.counts.total, error: h.counts.error, warn: h.counts.warn })
              : tr('clusterView.map.hover', '{{node}} · {{total}} pods · {{error}} errors · {{warn}} warnings', { node: h.label, total: h.counts.total, error: h.counts.error, warn: h.counts.warn })}
          </span>
        ) : (
          <>
            <span className="inline-flex items-center gap-1.5"><span className="inline-block h-2 w-2 rounded-sm bg-red-400" />{tr('clusterView.map.error', 'Error')} {totals.error}</span>
            <span className="inline-flex items-center gap-1.5"><span className="inline-block h-2 w-2 rounded-sm bg-yellow-400" />{tr('clusterView.map.warn', 'Warning')} {totals.warn}</span>
            <span className="inline-flex items-center gap-1.5"><span className="inline-block h-2 w-2 rounded-sm bg-green-400" />{tr('clusterView.map.ok', 'Healthy')} {totals.pods - totals.error - totals.warn}</span>
            {notReady > 0 && (
              <span className="inline-flex items-center gap-1.5" data-testid="cluster-view-map-not-ready"><span className="inline-block h-2 w-2 rounded-sm border-2 border-red-400" />{tr('clusterView.map.notReady', 'Node not Ready')} {notReady}</span>
            )}
            {cordoned > 0 && (
              <span className="inline-flex items-center gap-1.5" data-testid="cluster-view-map-cordoned"><span className="inline-block h-2 w-2 rounded-sm border-2 border-yellow-400" />{tr('clusterView.map.cordoned', 'SchedulingDisabled')} {cordoned}</span>
            )}
            <span>
              {pageEnd > pageStart
                ? tr('clusterView.map.hintPaged', 'A cell is a node, a dot a pod; the outlined cells are the boxes below. Click a cell to see all its pods.')
                : tr('clusterView.map.hint', 'A cell is a node, a dot a pod. Click a cell to see all its pods.')}
            </span>
          </>
        )}
      </div>
    </div>
  )
}
