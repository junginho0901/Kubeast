import type { Node } from '@xyflow/react'
import type { ResourceGraphNode } from '@/services/api'

type BoxElement = { focus(): void; isConnected: boolean; getAttribute(name: string): string | null }

// The box a key opens: Enter on a box with the keyboard focus (React Flow's node `div`, tabIndex 0, `data-id`) opens
// what a press on it opens. React Flow itself only selects the box on Enter and Space, and onNodeClick hears presses only.
export function nodeForKey(
  e: { key: string; isComposing?: boolean; target: unknown },
  nodes: Node[],
): { raw: ResourceGraphNode; element: BoxElement } | null {
  if (e.key !== 'Enter' || e.isComposing) return null
  const target = e.target as { closest?(selector: string): BoxElement | null } | null
  const element = target?.closest?.('.react-flow__node')
  // the box itself has the focus, not something drawn inside it
  if (!element || element !== target) return null
  const id = element.getAttribute('data-id')
  const raw = (id ? nodes.find((n) => n.id === id) : undefined)?.data?.raw as ResourceGraphNode | undefined
  return raw ? { raw, element } : null
}

/**
 * As the drawer a box opened with Enter closes: the focus goes back to that box, as the drawer gives it back to the row
 * that opened it, unless it was put somewhere else meanwhile or the box is gone.
 */
export function focusBoxBack(doc: { activeElement?: unknown; body?: unknown }, box: { focus(): void; isConnected: boolean } | null): 'box' | 'stay' | 'none' {
  const active = doc.activeElement
  if (active && active !== doc.body) return 'stay'
  if (!box?.isConnected) return 'none'
  box.focus()
  return 'box'
}
