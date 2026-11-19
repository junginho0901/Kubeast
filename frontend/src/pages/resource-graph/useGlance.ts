import { useCallback } from 'react'
import type { Node } from '@xyflow/react'
import type { ResourceGraphNode } from '@/services/api'
import { useHoverTip } from '@/hooks/useHoverTip'
import { isPeer } from './traffic'

export interface Glanced { node: ResourceGraphNode; x: number; y: number }

type Boxed = { getBoundingClientRect(): { right: number; top: number } }
type Found = { closest?(selector: string): (Boxed & { getAttribute(name: string): string | null }) | null }

// A box's glance beside it (Glance), on the pointer or on the keyboard focus — React Flow makes every box focusable —
// held to WCAG 2.2 1.4.13 by useHoverTip: Escape hides it, the pointer can move onto it, and it stays while either
// holds it. A box standing for an end outside the graph (a peer) has none.
export function glanceAt(node: Node | undefined, box: Boxed | null): Glanced | null {
  const raw = node?.data?.raw as ResourceGraphNode | undefined
  if (!raw || isPeer(raw) || !box) return null
  const rect = box.getBoundingClientRect()
  return { node: raw, x: rect.right, y: rect.top }
}

export function useGlance(nodes: Node[]) {
  const tip = useHoverTip<Glanced>()
  const { enter, leave, focus, blur } = tip
  // the box React Flow handed the handler, not the part of it the pointer came in over
  const onNodeMouseEnter = useCallback((e: { currentTarget: unknown }, node: Node) => {
    const at = glanceAt(node, e.currentTarget as Boxed | null)
    if (at) enter(at)
  }, [enter])
  const onFocus = useCallback((e: { target: unknown }) => {
    const box = (e.target as Found | null)?.closest?.('.react-flow__node') ?? null
    const id = box?.getAttribute('data-id')
    const at = glanceAt(id ? nodes.find((n) => n.id === id) : undefined, box)
    if (at) focus(at)
  }, [nodes, focus])
  return { shown: tip.shown, onNodeMouseEnter, onNodeMouseLeave: leave, onFocus, onBlur: blur, tip: tip.tip }
}
