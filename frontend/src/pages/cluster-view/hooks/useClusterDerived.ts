import { useMemo } from 'react'
import type { PodNodeCount, PodNodeSummary } from '@/services/api'

// The node boxes and map cells in one order: control planes first, then workers, the pods not scheduled last, by name
// within each. Only nodes with a pod the search matched (the server counted them); while a search is on, the other
// nodes of the node list are cells too, marked `dim` (drawn faded, no box), so the map keeps its shape.

export interface NodeEntry {
  /** the node's name; '' for the pods not scheduled */
  node: string
  label: string
  counts: PodNodeCount
  /** a node of the node list with no pod the search matched */
  dim?: boolean
}

interface Params {
  summary: PodNodeSummary | undefined
  nodes: any[] | undefined
  search?: string
}

export const UNSCHEDULED = 'Unscheduled'

export function useClusterDerived({ summary, nodes, search = '' }: Params): NodeEntry[] {
  return useMemo(() => {
    const controlPlane = new Set((nodes ?? []).filter((n: any) => n?.roles?.includes('control-plane')).map((n: any) => n.name))
    const entries: NodeEntry[] = (summary?.nodes ?? []).map((c) => ({ node: c.node, label: c.node || UNSCHEDULED, counts: c }))
    if (search && summary) {
      const matched = new Set(entries.map((e) => e.node))
      for (const n of nodes ?? []) {
        const name = typeof n?.name === 'string' ? n.name : ''
        if (name && !matched.has(name)) entries.push({ node: name, label: name, counts: { node: name, total: 0, ok: 0, warn: 0, error: 0 }, dim: true })
      }
    }
    return entries.sort((a, b) => {
      if (a.node === '') return 1
      if (b.node === '') return -1
      const cpA = controlPlane.has(a.node)
      const cpB = controlPlane.has(b.node)
      if (cpA && !cpB) return -1
      if (!cpA && cpB) return 1
      return a.node.localeCompare(b.node)
    })
  }, [summary, nodes, search])
}
