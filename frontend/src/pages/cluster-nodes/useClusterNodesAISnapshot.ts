import { useMemo } from 'react'
import { useAIContext } from '@/hooks/useAIContext'
import { summarizeList } from '@/utils/aiContext/summarizeList'
import { buildResourceLink } from '@/utils/resourceLink'
import type { NodeInfo, NodeMetric } from './clusterNodeHelpers'

interface Params {
  nodes: NodeInfo[] | undefined
  pagedNodes: NodeInfo[]
  sortedNodesCount: number
  currentPage: number
  rowsPerPage: number
  searchQuery: string
  metricsMap: Map<string, NodeMetric>
}

const parsePercent = (v?: string | null): number | null => {
  if (!v) return null
  const m = String(v).match(/(-?\d+(?:\.\d+)?)/)
  return m ? Number(m[1]) : null
}

export function useClusterNodesAISnapshot({
  nodes,
  pagedNodes,
  sortedNodesCount,
  currentPage,
  rowsPerPage,
  searchQuery,
  metricsMap,
}: Params) {
  const aiSnapshot = useMemo(() => {
    if (!Array.isArray(nodes) || nodes.length === 0) return null

    const readyCount = nodes.filter((n) => /ready/i.test(n.status) && !/notready/i.test(n.status)).length
    const notReadyCount = nodes.length - readyCount

    const highCpu: string[] = []
    const highMem: string[] = []
    for (const n of nodes) {
      const metric = metricsMap.get(n.name)
      const cpu = parsePercent(metric?.cpu_percent)
      const mem = parsePercent(metric?.memory_percent)
      if (cpu !== null && cpu > 85) highCpu.push(n.name)
      if (mem !== null && mem > 85) highMem.push(n.name)
    }

    const prefix = notReadyCount > 0 || highCpu.length > 0 || highMem.length > 0 ? '⚠️ ' : ''
    const alerts: string[] = []
    if (notReadyCount > 0) alerts.push(`NotReady ${notReadyCount}`)
    if (highCpu.length > 0) alerts.push(`CPU 85%+ ${highCpu.length}`)
    if (highMem.length > 0) alerts.push(`Mem 85%+ ${highMem.length}`)
    const alertStr = alerts.length ? `, ${alerts.join(', ')}` : ''
    const summary = `${prefix}노드 ${nodes.length}개 (Ready ${readyCount}${alertStr})`

    const nodesWithMetric = pagedNodes.map((n) => {
      const metric = metricsMap.get(n.name)
      return {
        ...n,
        cpu_percent: metric?.cpu_percent,
        memory_percent: metric?.memory_percent,
      }
    })

    return {
      source: 'base' as const,
      summary,
      data: {
        filters: { search: searchQuery || undefined },
        stats: {
          total: nodes.length,
          ready: readyCount,
          not_ready: notReadyCount,
          high_cpu_count: highCpu.length,
          high_memory_count: highMem.length,
        },
        ...summarizeList(nodesWithMetric as unknown as Record<string, unknown>[], {
          total: sortedNodesCount,
          currentPage,
          pageSize: rowsPerPage,
          topN: rowsPerPage,
          pickFields: ['name', 'status', 'roles', 'version', 'age', 'cpu_percent', 'memory_percent', 'internal_ip'],
          filterProblematic: (n) => {
            const node = n as unknown as NodeInfo & { cpu_percent?: string; memory_percent?: string }
            if (!/ready/i.test(node.status) || /notready/i.test(node.status)) return true
            const cpu = parsePercent(node.cpu_percent)
            const mem = parsePercent(node.memory_percent)
            return (cpu !== null && cpu > 85) || (mem !== null && mem > 85)
          },
          interpret: () => {
            const out: string[] = []
            if (notReadyCount > 0) out.push(`⚠️ ${notReadyCount}개 노드가 Ready 상태 아님`)
            if (highCpu.length > 0) out.push(`⚠️ ${highCpu.length}개 노드 CPU 85% 초과: ${highCpu.slice(0, 5).join(', ')}`)
            if (highMem.length > 0) out.push(`⚠️ ${highMem.length}개 노드 메모리 85% 초과: ${highMem.slice(0, 5).join(', ')}`)
            return out
          },
          linkBuilder: (n) => {
            const node = n as unknown as NodeInfo
            return buildResourceLink('Node', undefined, node.name)
          },
        }),
      },
    }
  }, [nodes, pagedNodes, sortedNodesCount, currentPage, rowsPerPage, searchQuery, metricsMap])

  useAIContext(aiSnapshot, [aiSnapshot])
}
