import { useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from 'react'
import type { NodeEntry } from './hooks/useClusterDerived'
import type { ClusterViewNode } from './hooks/useClusterPodsQuery'
import { GAP, layoutMap, mapKey } from './nodeMapLayout'
import { nodeCordoned, nodeReadiness } from '@/utils/nodeStatus'

// Every node at a glance: a cell per node in the boxes' order, a dot per pod in the cards' colour (errors first, then
// warnings, then the rest, so a problem is never at the end of a cell). Canvas 2D, one fillRect per dot — static, so
// 100 000 dots draw in milliseconds. The cell is large enough to hold the busiest node's dots, so no pod is left out.
// While the boxes take more than one page, the cells of the page shown are outlined, and in a node's own view its cell.
// While a search is on, the nodes with no pod it matched are faded. A node not Ready (kubectl's NotReady or Unknown)
// has a solid red border, a cordoned one (SchedulingDisabled) a dashed yellow one, drawn over the page's outline, from
// the live node list; the legend counts both from that list and each count opens the first such node. A click, or
// Enter on the cell the arrow keys reach, opens that node's own view; the line under the legend names that cell. The
// canvas is an `application` (WAI-ARIA 1.2), so a screen reader in browse mode passes the arrow keys and Enter to it;
// the cell's line is a live region only while the canvas has the keyboard focus, so a mouse passing over the cells
// is not read out, and the hint is the canvas's description, outside that region.

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
  /** the live node list, which the legend's NotReady and SchedulingDisabled counts are of */
  nodeList?: ClusterViewNode[]
  /** opens a node's own view by name (the legend's counts) */
  onOpenNode?: (name: string) => void
  tr: (key: string, fallback: string, options?: Record<string, any>) => string
}

// The nodes of the list in the map's order: control planes first, then by name.
const inMapOrder = (list: ClusterViewNode[]) => [...list].sort((a, b) => {
  const cpA = a.roles.includes('control-plane')
  const cpB = b.roles.includes('control-plane')
  return cpA === cpB ? a.name.localeCompare(b.name) : cpA ? -1 : 1
})

export function ClusterNodeMap({ entries, pageStart, pageEnd, onSelect, nodeList, onOpenNode, tr }: Props) {
  const wrapRef = useRef<HTMLDivElement>(null)
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const [width, setWidth] = useState(0)
  const [hover, setHover] = useState<number | null>(null)
  const [focused, setFocused] = useState(false)
  const hintId = useId()
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
  // the cell pointed at or reached by the keys; the last when the cells have since become fewer
  const cur = hover === null || entries.length === 0 ? null : Math.min(hover, entries.length - 1)

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
    if (pageEnd > pageStart) {
      ctx.strokeStyle = cssColor('--color-ink', '#fff')
      ctx.lineWidth = 1
      for (let i = pageStart; i < Math.min(pageEnd, entries.length); i++) {
        // a faded cell inside a page's range has no box; a node's own view outlines its cell, faded or not
        if (entries[i].dim && pageEnd - pageStart > 1) continue
        ctx.strokeRect((i % cols) * (cell + GAP) + 0.5, Math.floor(i / cols) * (cell + GAP) + 0.5, cell - 1, cell - 1)
      }
    }
    // the node marks over the outline: not Ready solid red, cordoned dashed yellow
    ctx.lineWidth = 2
    marks.forEach((m, i) => {
      if (!m) return
      ctx.strokeStyle = m === 'notReady' ? colors.error : colors.warn
      ctx.setLineDash(m === 'notReady' ? [] : [2, 2])
      ctx.strokeRect((i % cols) * (cell + GAP) + 1, Math.floor(i / cols) * (cell + GAP) + 1, cell - 2, cell - 2)
    })
    ctx.setLineDash([])
    if (cur !== null) {
      ctx.strokeStyle = cssColor('--color-primary-400', '#38bdf8')
      ctx.lineWidth = 2
      ctx.strokeRect((cur % cols) * (cell + GAP) + 1, Math.floor(cur / cols) * (cell + GAP) + 1, cell - 2, cell - 2)
    }
  }, [entries, marks, layout, width, cur, mode, pageStart, pageEnd])

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
  const h = cur !== null ? entries[cur] : null
  // the legend's counts are of the node list (a node without pods has no cell but is counted), else of the cells
  const listed = nodeList ?? entries.filter((e) => e.status).map((e) => ({ name: e.node, roles: [], status: e.status ?? '' }))
  const notReadyNodes = inMapOrder(listed.filter((n) => nodeReadiness(n.status) !== 'Ready'))
  const cordonedNodes = inMapOrder(listed.filter((n) => nodeCordoned(n.status)))
  const notReady = notReadyNodes.length
  const cordoned = cordonedNodes.length
  const marked = Object.fromEntries(entries.filter((e, i) => marks[i] || (e.status && nodeCordoned(e.status))).map((e) => [e.node, e.status]))
  const legendButton = 'inline-flex items-center gap-1.5 hover:text-ink underline-offset-2 hover:underline'
  const aria = tr('clusterView.map.aria', 'Node map: {{nodes}} nodes, {{pods}} pods ({{error}} errors, {{warn}} warnings)', { nodes: entries.length, pods: totals.pods, error: totals.error, warn: totals.warn })

  return (
    <div className="card" data-testid="cluster-view-map" data-list-bounded="one canvas of every node: about 194 px tall at 1,000 nodes, about 1.5 screens at 5,000">
      <div ref={wrapRef} className="w-full">
        <canvas
          ref={canvasRef}
          role="application"
          aria-roledescription={tr('clusterView.map.roleDescription', 'Node map')}
          aria-label={notReady + cordoned > 0 ? `${aria} ${tr('clusterView.map.ariaMarks', '{{notReady}} nodes not Ready, {{cordoned}} SchedulingDisabled.', { notReady, cordoned })}` : aria}
          aria-describedby={hintId}
          data-cells={JSON.stringify(entries.map((e) => [e.node, e.counts.ok, e.counts.warn, e.counts.error]))}
          data-dim-cells={entries.some((e) => e.dim) ? entries.filter((e) => e.dim).length : undefined}
          data-node-marks={Object.keys(marked).length > 0 ? JSON.stringify(marked) : undefined}
          tabIndex={0}
          onFocus={() => {
            setFocused(true)
            setHover((h) => h ?? 0)
          }}
          onBlur={() => {
            setFocused(false)
            setHover(null)
          }}
          onKeyDown={(ev) => {
            const to = mapKey(ev.key, cur, entries.length, layout.cols)
            if (!to) return
            ev.preventDefault()
            if ('open' in to) onSelect(to.open)
            else setHover(to.hover)
          }}
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
      <div className="mt-3 space-y-1 text-xs text-slate-400" data-testid="cluster-view-map-legend">
        <div className="flex flex-wrap items-center gap-x-4 gap-y-1">
          <span className="inline-flex items-center gap-1.5"><span className="inline-block h-2 w-2 rounded-sm bg-red-400" />{tr('clusterView.map.error', 'Error')} {totals.error}</span>
          <span className="inline-flex items-center gap-1.5"><span className="inline-block h-2 w-2 rounded-sm bg-yellow-400" />{tr('clusterView.map.warn', 'Warning')} {totals.warn}</span>
          <span className="inline-flex items-center gap-1.5"><span className="inline-block h-2 w-2 rounded-sm bg-green-400" />{tr('clusterView.map.ok', 'Healthy')} {totals.pods - totals.error - totals.warn}</span>
          {notReady > 0 && (
            <button type="button" className={legendButton} data-testid="cluster-view-map-not-ready" onClick={() => onOpenNode?.(notReadyNodes[0].name)}
              title={tr('clusterView.map.openFirst', 'Open {{node}}, the first of them', { node: notReadyNodes[0].name })}>
              <span className="inline-block h-2 w-2 rounded-sm border-2 border-red-400" />{tr('clusterView.map.notReady', 'Node not Ready')} {notReady}
            </button>
          )}
          {cordoned > 0 && (
            <button type="button" className={legendButton} data-testid="cluster-view-map-cordoned" onClick={() => onOpenNode?.(cordonedNodes[0].name)}
              title={tr('clusterView.map.openFirst', 'Open {{node}}, the first of them', { node: cordonedNodes[0].name })}>
              <span className="inline-block h-2 w-2 rounded-sm border-2 border-dashed border-yellow-400" />{tr('clusterView.map.cordoned', 'SchedulingDisabled')} {cordoned}
            </button>
          )}
        </div>
        <div className="min-h-[16px]">
          <p className={h ? 'text-ink' : undefined} aria-live={focused ? 'polite' : 'off'} data-testid="cluster-view-map-hover">
            {h
              ? h.status && h.status !== 'Ready'
                ? tr('clusterView.map.hoverStatus', '{{node}} · {{status}} · {{total}} pods · {{error}} errors · {{warn}} warnings', { node: h.label, status: h.status, total: h.counts.total, error: h.counts.error, warn: h.counts.warn })
                : tr('clusterView.map.hover', '{{node}} · {{total}} pods · {{error}} errors · {{warn}} warnings', { node: h.label, total: h.counts.total, error: h.counts.error, warn: h.counts.warn })
              : ''}
          </p>
          <p id={hintId} hidden={!!h} data-testid="cluster-view-map-hint">
            {pageEnd > pageStart
              ? tr('clusterView.map.hintPaged', 'A cell is a Node, a dot a Pod; the outlined cells are the boxes below. Click a cell, or press Enter on it, to see all its Pods.')
              : tr('clusterView.map.hint', 'A cell is a Node, a dot a Pod. Click a cell, or press Enter on it, to see all its Pods.')}
          </p>
        </div>
      </div>
    </div>
  )
}
