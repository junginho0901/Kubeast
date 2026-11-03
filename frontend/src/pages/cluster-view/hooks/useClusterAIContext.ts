import { useMemo } from 'react'
import { useAIContext } from '@/hooks/useAIContext'
import type { PodNodeSummary } from '@/services/api'
import { nodeReadiness } from '@/utils/nodeStatus'

// 플로팅 AI 위젯의 cluster view snapshot. node ready 수 / 주의·오류 pod 수 /
// pod_by_node top 20 를 표현 (노드 지도 요약에서). 검색 중이면 노드 지도는 검색된 pod 만 세므로
// 주의·오류·노드별 수도 검색된 pod 기준 — 전체 수(total_pods)와 함께 검색어·검색된 수를 넘긴다.

interface Params {
  nodes: any[] | undefined
  summary: PodNodeSummary | undefined
  selectedNamespace: string
  search?: string
}

export function buildClusterViewSnapshot({ nodes, summary, selectedNamespace, search = '' }: Params) {
  if (!Array.isArray(nodes) || !summary) return null
  const totalNodes = nodes.length
  const totalPods = summary.all
  const nodeReady = (nodes as Array<{ status: string }>).filter((n) => nodeReadiness(n.status) === 'Ready').length
  const warn = summary.nodes.reduce((n, c) => n + c.warn, 0)
  const error = summary.nodes.reduce((n, c) => n + c.error, 0)
  const prefix = error > 0 ? '⚠️ ' : ''
  const alert = [error ? `오류 ${error}` : '', warn ? `주의 ${warn}` : ''].filter(Boolean).join(', ')
  const searched = search ? ` · 검색 '${search}' ${summary.total}개` : ''
  return {
    source: 'base' as const,
    summary: `${prefix}클러스터 뷰 · 노드 ${totalNodes}개 (Ready ${nodeReady}), Pod ${totalPods}개${searched}${alert ? ` (${alert})` : ''}`,
    data: {
      filters: search ? { namespace: selectedNamespace, search } : { namespace: selectedNamespace },
      stats: {
        total_nodes: totalNodes,
        ready_nodes: nodeReady,
        total_pods: totalPods,
        ...(search ? { matched_pods: summary.total } : {}),
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
}

export function useClusterAIContext({ nodes, summary, selectedNamespace, search = '' }: Params) {
  const aiSnapshot = useMemo(
    () => buildClusterViewSnapshot({ nodes, summary, selectedNamespace, search }),
    [nodes, summary, selectedNamespace, search],
  )

  useAIContext(aiSnapshot, [aiSnapshot])
}
