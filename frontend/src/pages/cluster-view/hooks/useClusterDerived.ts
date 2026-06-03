import { useMemo } from 'react'
import type { PodInfo } from '@/services/api'

// filteredPods / podsByNode / sortedNodeEntries 의 derived 계산. useMemo 안정화.
// 정렬: control-plane 먼저 → 워커 → Unscheduled 마지막, 같은 그룹 내 이름 순.

interface Params {
  allPods: PodInfo[] | undefined
  nodes: any[] | undefined
  searchQuery: string
}

interface Result {
  filteredPods: PodInfo[]
  sortedNodeEntries: Array<[string, PodInfo[]]>
}

export function useClusterDerived({ allPods, nodes, searchQuery }: Params): Result {
  return useMemo(() => {
    const list = Array.isArray(allPods) ? allPods : []
    const q = searchQuery.trim().toLowerCase()
    const filteredPods = q
      ? list.filter((pod) => pod.name.toLowerCase().includes(q) || pod.namespace.toLowerCase().includes(q))
      : list

    const podsByNode = filteredPods.reduce((acc, pod) => {
      const nodeName = pod.node_name || 'Unscheduled'
      if (!acc[nodeName]) acc[nodeName] = []
      acc[nodeName].push(pod)
      return acc
    }, {} as Record<string, PodInfo[]>)

    const sortedNodeEntries = Object.entries(podsByNode).sort(([a], [b]) => {
      const nodeInfoA = nodes?.find((n: any) => n.name === a)
      const nodeInfoB = nodes?.find((n: any) => n.name === b)
      if (a === 'Unscheduled') return 1
      if (b === 'Unscheduled') return -1
      const cpA = nodeInfoA?.roles?.includes('control-plane') || false
      const cpB = nodeInfoB?.roles?.includes('control-plane') || false
      if (cpA && !cpB) return -1
      if (!cpA && cpB) return 1
      return a.localeCompare(b)
    })

    return { filteredPods, sortedNodeEntries }
  }, [allPods, nodes, searchQuery])
}
