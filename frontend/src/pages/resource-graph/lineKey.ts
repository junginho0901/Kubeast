import type { Edge } from '@xyflow/react'
import type { TrafficLine } from '@/services/api'

type LineElement = { focus(): void; getAttribute(name: string): string | null }

// The traffic line a key opens: Enter on a line with the keyboard focus (React Flow's edge `g`, tabIndex 0, `data-id`)
// opens its panel as a press does. React Flow itself only selects the line on Enter, and onEdgeClick hears presses only.
export function lineForKey(
  e: { key: string; isComposing?: boolean; target: unknown },
  edges: Edge[],
): { id: string; line: TrafficLine; element: LineElement } | null {
  if (e.key !== 'Enter' || e.isComposing) return null
  const element = (e.target as { closest?(selector: string): LineElement | null } | null)?.closest?.('.react-flow__edge')
  const id = element?.getAttribute('data-id')
  const edge = id ? edges.find((x) => x.id === id) : undefined
  const line = edge?.data?.line as TrafficLine | undefined
  return element && edge && line ? { id: edge.id, line, element } : null
}
