import type { NodeEntry } from './hooks/useClusterDerived'

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

// A key on the focused map from cell `at` (null: none yet; past the cells: the last): the cell an arrow moves to, the cell Enter or Space opens, else null.
export function mapKey(key: string, at: number | null, count: number, cols: number): { hover: number } | { open: number } | null {
  if (count === 0) return null
  const from = Math.min(Math.max(0, at ?? 0), count - 1)
  const step: Record<string, number> = { ArrowRight: 1, ArrowLeft: -1, ArrowDown: cols, ArrowUp: -cols }
  if (Object.hasOwn(step, key)) return { hover: Math.min(count - 1, Math.max(0, from + step[key])) }
  return key === 'Enter' || key === ' ' ? { open: from } : null
}
