import { useMemo } from 'react'
import type { PodNodeCount, PodNodeSummary } from '@/services/api'

// The node boxes and map cells in one order: control planes first, then workers, the pods not scheduled last, by name
// within each. Only nodes with a pod the search matched (the server counted them).

export interface NodeEntry {
  /** the node's name; '' for the pods not scheduled */
  node: string
  label: string
  counts: PodNodeCount
}

interface Params {
  summary: PodNodeSummary | undefined
  nodes: any[] | undefined
}

export const UNSCHEDULED = 'Unscheduled'

export function useClusterDerived({ summary, nodes }: Params): NodeEntry[] {
  return useMemo(() => {
    const controlPlane = new Set((nodes ?? []).filter((n: any) => n?.roles?.includes('control-plane')).map((n: any) => n.name))
    const entries = (summary?.nodes ?? []).map((c) => ({ node: c.node, label: c.node || UNSCHEDULED, counts: c }))
    return entries.sort((a, b) => {
      if (a.node === '') return 1
      if (b.node === '') return -1
      const cpA = controlPlane.has(a.node)
      const cpB = controlPlane.has(b.node)
      if (cpA && !cpB) return -1
      if (!cpA && cpB) return 1
      return a.node.localeCompare(b.node)
    })
  }, [summary?.nodes, nodes])
}
