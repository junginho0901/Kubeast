import { useMemo } from 'react'
import { useAIContext } from '@/hooks/useAIContext'
import type { PodNodeSummary } from '@/services/api'

// 플로팅 AI 위젯의 cluster view snapshot. node ready 수 / 주의·오류 pod 수 /
// pod_by_node top 20 를 표현 (노드 지도 요약에서).

interface Params {
  nodes: any[] | undefined
  summary: PodNodeSummary | undefined
  selectedNamespace: string
}

export function useClusterAIContext({ nodes, summary, selectedNamespace }: Params) {
  const aiSnapshot = useMemo(() => {
    if (!Array.isArray(nodes) || !summary) return null
    const totalNodes = nodes.length
    const totalPods = summary.all
    const nodeReady = (nodes as Array<{ status: string }>).filter((n) => /ready/i.test(n.status)).length
    const warn = summary.nodes.reduce((n, c) => n + c.warn, 0)
    const error = summary.nodes.reduce((n, c) => n + c.error, 0)
    const prefix = error > 0 ? '⚠️ ' : ''
    const alert = [error ? `오류 ${error}` : '', warn ? `주의 ${warn}` : ''].filter(Boolean).join(', ')
    return {
      source: 'base' as const,
      summary: `${prefix}클러스터 뷰 · 노드 ${totalNodes}개 (Ready ${nodeReady}), Pod ${totalPods}개${alert ? ` (${alert})` : ''}`,
      data: {
        filters: { namespace: selectedNamespace },
        stats: {
          total_nodes: totalNodes,
          ready_nodes: nodeReady,
          total_pods: totalPods,
          warning_pods: warn,
          error_pods: error,
        },
        pods_by_node: Object.fromEntries(
          [...summary.nodes].sort((a, b) => b.total - a.total).slice(0, 20).map((c) => [c.node || 'unscheduled', c.total]),
        ),
        problem_pods_by_node: Object.fromEntries(
          summary.nodes.filter((c) => c.error + c.warn > 0).sort((a, b) => b.error - a.error || b.warn - a.warn).slice(0, 20)
            .map((c) => [c.node || 'unscheduled', { error: c.error, warn: c.warn }]),
        ),
      },
    }
  }, [nodes, summary, selectedNamespace])

  useAIContext(aiSnapshot, [aiSnapshot])
}
