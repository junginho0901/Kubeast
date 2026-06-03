import { useMemo } from 'react'
import { useAIContext } from '@/hooks/useAIContext'
import type { PodInfo } from '@/services/api'

// 플로팅 AI 위젯의 cluster view snapshot. node ready 수 / pod NotRunning 수 /
// pod_by_node top 20 를 표현.

interface Params {
  nodes: any[] | undefined
  allPods: PodInfo[] | undefined
  selectedNamespace: string
}

export function useClusterAIContext({ nodes, allPods, selectedNamespace }: Params) {
  const aiSnapshot = useMemo(() => {
    if (!Array.isArray(nodes) || !Array.isArray(allPods)) return null
    const totalNodes = nodes.length
    const totalPods = allPods.length
    const nodeReady = (nodes as Array<{ status: string }>).filter((n) => /ready/i.test(n.status)).length
    const notRunning = (allPods as PodInfo[]).filter((p) => {
      const ph = p.phase || p.status || ''
      return ph !== 'Running' && ph !== 'Succeeded'
    }).length
    const prefix = notRunning > 0 ? '⚠️ ' : ''
    const podsByNode: Record<string, number> = {}
    for (const p of allPods as PodInfo[]) {
      const n = p.node_name || 'unscheduled'
      podsByNode[n] = (podsByNode[n] ?? 0) + 1
    }
    return {
      source: 'base' as const,
      summary: `${prefix}클러스터 뷰 · 노드 ${totalNodes}개 (Ready ${nodeReady}), Pod ${totalPods}개${notRunning ? ` (NotRunning ${notRunning})` : ''}`,
      data: {
        filters: { namespace: selectedNamespace },
        stats: {
          total_nodes: totalNodes,
          ready_nodes: nodeReady,
          total_pods: totalPods,
          not_running_pods: notRunning,
        },
        pods_by_node: Object.fromEntries(
          Object.entries(podsByNode).sort((a, b) => b[1] - a[1]).slice(0, 20),
        ),
      },
    }
  }, [nodes, allPods, selectedNamespace])

  useAIContext(aiSnapshot, [aiSnapshot])
}
