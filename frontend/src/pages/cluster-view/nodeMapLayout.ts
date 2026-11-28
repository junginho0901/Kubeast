import type { NodeEntry } from './hooks/useClusterDerived'
import type { ClusterViewNode } from './hooks/useClusterPodsQuery'

// The node map's cells: as large as fits about TARGET_HEIGHT for all the nodes, never smaller than the busiest node's
// dots need (a dot per pod, per × per in a cell), so no pod is left out.

export const GAP = 2
const MAX_CELL = 48
const MIN_CELL = 12
const TARGET_HEIGHT = 200

export interface Layout {
  cell: number
  cols: number
  per: number // dots per row inside a cell
  dot: number
  height: number
}

export function layoutMap(width: number, entries: NodeEntry[]): Layout {
  const n = Math.max(entries.length, 1)
  const maxPods = Math.max(1, ...entries.map((e) => e.counts.total))
  const per = Math.ceil(Math.sqrt(maxPods))
  const fit = Math.floor(Math.sqrt((width * TARGET_HEIGHT) / n)) - GAP
  const cell = Math.min(Math.max(fit, MIN_CELL, per + 4), Math.max(MAX_CELL, per + 4))
  const cols = Math.max(1, Math.floor((width + GAP) / (cell + GAP)))
  const rows = Math.ceil(n / cols)
  const dot = Math.max(1, Math.floor((cell - 4) / per))
  return { cell, cols, per, dot, height: rows * (cell + GAP) - GAP }
}

// A pod's dot is told apart by its shape as well as its colour (WCAG 1.4.1): a square for a healthy pod, a triangle for a
// warning, a cross for an error. A dot under DOT_SHAPE_MIN px is too small for a shape and stays a square.
export const DOT_SHAPE_MIN = 4
export type DotKind = 'ok' | 'warn' | 'error'
export type DotShape = 'square' | 'triangle' | 'cross'
export function dotShape(kind: DotKind, size: number): DotShape {
  if (kind === 'ok' || size < DOT_SHAPE_MIN) return 'square'
  return kind === 'warn' ? 'triangle' : 'cross'
}

// The cross's line width; half of it is kept inside the dot's box, so a cross covers no more than its square would.
export const crossWidth = (size: number): number => Math.max(1, Math.round(size / 3))

type Pen = { moveTo(x: number, y: number): void; lineTo(x: number, y: number): void; closePath(): void }

// Adds the triangle (filled) or the cross (stroked with crossWidth) of a dot of `size` at x, y to the pen's path, so the
// dots of one kind are one fill or one stroke.
export function traceDot(pen: Pen, shape: Exclude<DotShape, 'square'>, x: number, y: number, size: number): void {
  if (shape === 'triangle') {
    pen.moveTo(x + size / 2, y)
    pen.lineTo(x + size, y + size)
    pen.lineTo(x, y + size)
    pen.closePath()
    return
  }
  const m = crossWidth(size) / 2
  pen.moveTo(x + m, y + m)
  pen.lineTo(x + size - m, y + size - m)
  pen.moveTo(x + size - m, y + m)
  pen.lineTo(x + m, y + size - m)
}

// The cell the map's live region names when the canvas takes the focus: from the keyboard the cell the keys start from
// (the one the mouse reached, else the first), from a pointer none, so a mouse over the cells is never read out.
export function focusSpokenCell(byPointer: boolean, at: number | null, count: number): number | null {
  return byPointer || count === 0 ? null : Math.min(Math.max(0, at ?? 0), count - 1)
}

// Whether the canvas's next focus comes with a pointer, after one of its events: a pointer going down sets it; the
// focus, the blur and a pointer cancelled before any focus (a touch that turned into a scroll) clear it, so the next
// focus from the keyboard is read out. A pointer's up is not among them: a tap's focus comes after its pointerup.
export type MapPointerEvent = 'pointerdown' | 'pointercancel' | 'focus' | 'blur'
export function pointerFocusAfter(event: MapPointerEvent): boolean {
  return event === 'pointerdown'
}

// A key on the focused map from cell `at` (null: none yet; past the cells: the last): the cell an arrow moves to (`end`
// when it stays, as the arrow could go no further), the cell Enter or Space opens, else null.
export function mapKey(key: string, at: number | null, count: number, cols: number): { hover: number; end: boolean } | { open: number } | null {
  if (count === 0) return null
  const from = Math.min(Math.max(0, at ?? 0), count - 1)
  const step: Record<string, number> = { ArrowRight: 1, ArrowLeft: -1, ArrowDown: cols, ArrowUp: -cols }
  if (Object.hasOwn(step, key)) {
    const to = Math.min(count - 1, Math.max(0, from + step[key]))
    return { hover: to, end: to === from }
  }
  return key === 'Enter' || key === ' ' ? { open: from } : null
}

// The nodes the map's name counts, as `kubectl get nodes` lists them: the node list once read (a node with no pod has
// no cell), else the cells that are a node (not the pods no node took).
export function mapNodeCount(entries: NodeEntry[], nodeList?: ClusterViewNode[]): number {
  return nodeList ? nodeList.length : entries.filter((e) => e.node !== '').length
}

// The live region's text and how many lines it was given: each line is a new node of the region, so a line said again
// (an arrow at the end, Enter twice) is read out again.
export interface MapSpoken {
  text: string
  said: number
}
export const spokenAfter = (prev: MapSpoken, text: string): MapSpoken => ({ text, said: prev.said + 1 })

type Tr = (key: string, fallback: string, options?: Record<string, any>) => string

// What the map says, in the screen's language: its name, a cell (the line under the legend and the live region), a
// cell an arrow could not leave, and a cell Enter opened. Each count is its own entry, so English says "1 pod".
export function mapSpeech(tr: Tr) {
  const pods = (count: number) => tr('clusterView.map.pods', '{{count}} pods', { count })
  const counts = (e: NodeEntry) => ({
    node: e.label, pods: pods(e.counts.total),
    errors: tr('clusterView.map.errors', '{{count}} errors', { count: e.counts.error }),
    warnings: tr('clusterView.map.warnings', '{{count}} warnings', { count: e.counts.warn }),
  })
  const cell = (e: NodeEntry) => e.status && e.status !== 'Ready'
    ? tr('clusterView.map.hoverStatus', '{{node}} · {{status}} · {{pods}} · {{errors}} · {{warnings}}', { ...counts(e), status: e.status })
    : tr('clusterView.map.hover', '{{node}} · {{pods}} · {{errors}} · {{warnings}}', counts(e))
  return {
    cell,
    end: (e: NodeEntry) => tr('clusterView.map.end', '{{cell}} (end)', { cell: cell(e) }),
    opened: (e: NodeEntry) => tr('clusterView.map.opened', '{{node}} opened · {{pods}}', { node: e.label, pods: pods(e.counts.total) }),
    name: (n: { nodes: number; pods: number; error: number; warn: number; notReady: number; cordoned: number }) => {
      const map = tr('clusterView.map.aria', 'Node map: {{nodes}}, {{pods}} ({{errors}}, {{warnings}}).', {
        nodes: tr('clusterView.map.nodes', '{{count}} nodes', { count: n.nodes }), pods: pods(n.pods),
        errors: tr('clusterView.map.errors', '{{count}} errors', { count: n.error }),
        warnings: tr('clusterView.map.warnings', '{{count}} warnings', { count: n.warn }),
      })
      if (n.notReady + n.cordoned === 0) return map
      const notReadyNodes = tr('clusterView.map.notReadyNodes', '{{count}} nodes not Ready', { count: n.notReady })
      return `${map} ${tr('clusterView.map.ariaMarks', '{{notReadyNodes}}, {{cordoned}} SchedulingDisabled.', { notReadyNodes, cordoned: n.cordoned })}`
    },
  }
}
